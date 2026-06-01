//! Shared-WebSocket mux client for `/zp/relay-mux`.
//!
//! Replaces the "1 WS per HTTP request" model. The kernel maintains a single
//! persistent WebSocket per location.host; concurrent kernel_fetch calls each
//! allocate a u32 stream ID and tag every frame with it. The server demuxes
//! and runs an independent goroutine per stream.
//!
//! Wire protocol (matches `relay.go` muxFrame* constants):
//!
//! ```text
//! [4-byte BE stream ID][1-byte type][payload...]
//! ```
//!
//! Types:
//! - 0x01 ENVELOPE   (client→server)
//! - 0x02 BODY_UP    (client→server, empty payload = EOF)
//! - 0x10 HEAD       (server→client)
//! - 0x11 BODY_DOWN  (server→client, empty payload = EOF)
//! - 0x20 ERROR      (server→client)
//! - 0x30 CANCEL     (client→server)

use js_sys::{Array, ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{BinaryType, CloseEvent, ErrorEvent, MessageEvent, WebSocket};

const FRAME_ENVELOPE: u8 = 0x01;
const FRAME_BODY_UP: u8 = 0x02;
const FRAME_HEAD: u8 = 0x10;
const FRAME_BODY_DOWN: u8 = 0x11;
const FRAME_ERROR: u8 = 0x20;
#[allow(dead_code)]
const FRAME_CANCEL: u8 = 0x30;

#[derive(Serialize)]
struct RelayRequest<'a> {
    url: &'a str,
    method: &'a str,
    headers: &'a [(String, String)],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    has_body: bool,
}

#[derive(Deserialize, Default)]
struct RelayResponseHead {
    ok: bool,
    #[serde(default)]
    status: u16,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(rename = "finalURL", default)]
    final_url: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    host: String,
}

/// Per-stream slot held by the mux session while the request is in flight.
/// The mux onmessage handler looks up by stream ID and dispatches to the
/// matching slot's resolver / controller.
struct StreamSlot {
    /// Resolves the kernel_fetch Promise with a Response (built lazily on HEAD).
    head_resolve: RefCell<Option<Function>>,
    /// Rejects the kernel_fetch Promise with an error code string.
    head_reject: RefCell<Option<Function>>,
    /// ReadableStream controller; populated once start() runs.
    controller: RefCell<Option<JsValue>>,
    /// True once HEAD has been delivered + Response resolved.
    head_built: Cell<bool>,
    /// True once close()/error() has been called on the controller.
    stream_closed: Cell<bool>,
}

impl StreamSlot {
    fn new() -> Self {
        Self {
            head_resolve: RefCell::new(None),
            head_reject: RefCell::new(None),
            controller: RefCell::new(None),
            head_built: Cell::new(false),
            stream_closed: Cell::new(false),
        }
    }
}

/// Mux session: one WebSocket, many concurrent streams.
pub struct MuxSession {
    ws: WebSocket,
    next_stream_id: Cell<u32>,
    streams: RefCell<HashMap<u32, Rc<StreamSlot>>>,
    /// Pending envelope/body frames queued until WS connects.
    pending: RefCell<Vec<Vec<u8>>>,
    /// True once WS reaches OPEN; pending frames flush at that point.
    open: Cell<bool>,
    /// True once WS has CLOSED or ERRORED — session is dead, do not reuse.
    dead: Cell<bool>,
}

thread_local! {
    static SESSION: RefCell<Option<Rc<MuxSession>>> = RefCell::new(None);
}

/// Get the singleton mux session, creating + connecting it on first call.
/// All concurrent callers share the same WS once it's up.
pub fn get_session() -> Result<Rc<MuxSession>, JsValue> {
    let existing = SESSION.with(|cell| cell.borrow().clone());
    if let Some(sess) = existing.as_ref() {
        if !sess.dead.get() {
            return Ok(sess.clone());
        }
    }
    // Either no session or the previous one died — spawn a fresh one.
    let url = pick_mux_url()?;
    let sess = MuxSession::new(&url)?;
    let sess_rc = Rc::new(sess);
    sess_rc.clone().install_handlers();
    SESSION.with(|cell| {
        *cell.borrow_mut() = Some(sess_rc.clone());
    });
    Ok(sess_rc)
}

fn pick_mux_url() -> Result<String, JsValue> {
    let global = js_sys::global();
    let location = Reflect::get(&global, &JsValue::from_str("location"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    if location.is_undefined() || location.is_null() {
        return Err(JsValue::from_str("SW_NOT_READY: no location"));
    }
    let host = get_string_prop(&location, "host").unwrap_or_default();
    let protocol =
        get_string_prop(&location, "protocol").unwrap_or_else(|| "http:".to_string());
    let scheme = if protocol == "https:" { "wss" } else { "ws" };
    if host.is_empty() {
        return Err(JsValue::from_str("SW_NOT_READY: empty host"));
    }
    Ok(format!("{}://{}/zp/relay-mux", scheme, host))
}

impl MuxSession {
    fn new(url: &str) -> Result<MuxSession, JsValue> {
        let ws = WebSocket::new(url).map_err(|_| {
            JsValue::from_str("TARGET_CONNECT_FAILED: mux-construct")
        })?;
        ws.set_binary_type(BinaryType::Arraybuffer);
        Ok(MuxSession {
            ws,
            next_stream_id: Cell::new(1),
            streams: RefCell::new(HashMap::new()),
            pending: RefCell::new(Vec::new()),
            open: Cell::new(false),
            dead: Cell::new(false),
        })
    }

    fn install_handlers(self: Rc<Self>) {
        let sess_open = self.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            sess_open.open.set(true);
            // Flush any frames queued while we waited for OPEN.
            let queued: Vec<Vec<u8>> = std::mem::take(&mut *sess_open.pending.borrow_mut());
            for frame in queued {
                let _ = sess_open.send_raw(&frame);
            }
        }) as Box<dyn FnMut(JsValue)>);
        self.ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        on_open.forget();

        let sess_msg = self.clone();
        let on_message = Closure::wrap(Box::new(move |ev: MessageEvent| {
            let data = ev.data();
            let ab = match data.dyn_ref::<ArrayBuffer>() {
                Some(b) => b,
                None => return,
            };
            let arr = Uint8Array::new(ab);
            if arr.length() < 5 {
                return;
            }
            let mut head = [0u8; 5];
            arr.subarray(0, 5).copy_to(&mut head);
            let stream_id = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
            let frame_type = head[4];
            let payload_len = arr.length() - 5;
            let payload = if payload_len > 0 {
                let p = arr.subarray(5, arr.length());
                let mut v = vec![0u8; payload_len as usize];
                p.copy_to(&mut v);
                v
            } else {
                Vec::new()
            };
            sess_msg.dispatch_frame(stream_id, frame_type, payload);
        })
            as Box<dyn FnMut(MessageEvent)>);
        self.ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        on_message.forget();

        let sess_close = self.clone();
        let on_close = Closure::wrap(Box::new(move |_: CloseEvent| {
            sess_close.mark_dead("MUX_CLOSED");
        }) as Box<dyn FnMut(CloseEvent)>);
        self.ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        on_close.forget();

        let sess_err = self.clone();
        let on_error = Closure::wrap(Box::new(move |_: ErrorEvent| {
            sess_err.mark_dead("TARGET_CONNECT_FAILED: mux-error");
        }) as Box<dyn FnMut(ErrorEvent)>);
        self.ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        on_error.forget();
    }

    fn mark_dead(&self, reason: &str) {
        if self.dead.replace(true) {
            return;
        }
        // Reject every still-pending stream so kernel_fetch callers don't hang.
        let slots: Vec<Rc<StreamSlot>> = {
            let mut m = self.streams.borrow_mut();
            m.drain().map(|(_, v)| v).collect()
        };
        for slot in slots {
            if !slot.head_built.get() {
                if let Some(reject) = slot.head_reject.borrow_mut().take() {
                    let _ = reject
                        .call1(&JsValue::UNDEFINED, &JsValue::from_str(reason));
                }
            } else if !slot.stream_closed.get() {
                if let Some(ctrl) = slot.controller.borrow_mut().take() {
                    let args = Array::new();
                    args.push(&JsValue::from_str(reason));
                    invoke_controller(&ctrl, "error", &args);
                }
            }
        }
    }

    fn allocate_stream_id(&self) -> u32 {
        // u32 wrap is fine — we'd need 4 billion concurrent in-flight requests
        // before the wrap could even theoretically collide with a live slot.
        let id = self.next_stream_id.get();
        self.next_stream_id.set(id.wrapping_add(1));
        id
    }

    fn dispatch_frame(&self, stream_id: u32, frame_type: u8, payload: Vec<u8>) {
        let slot = match self.streams.borrow().get(&stream_id).cloned() {
            Some(s) => s,
            None => return,
        };
        match frame_type {
            FRAME_HEAD => {
                if slot.head_built.get() {
                    return;
                }
                let txt = match std::str::from_utf8(&payload) {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let head: RelayResponseHead = match serde_json::from_str(txt) {
                    Ok(h) => h,
                    Err(_) => {
                        if let Some(reject) = slot.head_reject.borrow_mut().take() {
                            let _ = reject.call1(
                                &JsValue::UNDEFINED,
                                &JsValue::from_str("MALFORMED_ROUTE: head"),
                            );
                        }
                        self.remove_stream(stream_id);
                        return;
                    }
                };
                if !head.ok {
                    let code = if head.code.is_empty() {
                        "TARGET_CONNECT_FAILED".to_string()
                    } else {
                        head.code.clone()
                    };
                    if let Some(reject) = slot.head_reject.borrow_mut().take() {
                        let _ = reject
                            .call1(&JsValue::UNDEFINED, &JsValue::from_str(&code));
                    }
                    self.remove_stream(stream_id);
                    return;
                }
                match build_streaming_response(&head, slot.clone()) {
                    Ok(resp) => {
                        slot.head_built.set(true);
                        if let Some(resolve) = slot.head_resolve.borrow_mut().take() {
                            let _ = resolve.call1(&JsValue::UNDEFINED, &resp);
                        }
                    }
                    Err(e) => {
                        if let Some(reject) = slot.head_reject.borrow_mut().take() {
                            let _ = reject.call1(&JsValue::UNDEFINED, &e);
                        }
                        self.remove_stream(stream_id);
                    }
                }
            }
            FRAME_BODY_DOWN => {
                if payload.is_empty() {
                    // EOF terminator.
                    slot.stream_closed.set(true);
                    if let Some(ctrl) = slot.controller.borrow_mut().take() {
                        invoke_controller(&ctrl, "close", &Array::new());
                    }
                    self.remove_stream(stream_id);
                } else {
                    // Enqueue chunk into the ReadableStream.
                    let arr = Uint8Array::new_with_length(payload.len() as u32);
                    arr.copy_from(&payload);
                    let ctrl = slot.controller.borrow().clone();
                    if let Some(c) = ctrl {
                        let args = Array::new();
                        args.push(&arr);
                        invoke_controller(&c, "enqueue", &args);
                    }
                    // Chunks before controller is registered are dropped —
                    // start() is synchronous when the ReadableStream is
                    // constructed so this is normally race-free, but if it
                    // ever happens we'd see truncated bodies. Logging would
                    // be nice but not critical.
                }
            }
            FRAME_ERROR => {
                let code = String::from_utf8(payload)
                    .unwrap_or_else(|_| "TARGET_CONNECT_FAILED".to_string());
                if !slot.head_built.get() {
                    if let Some(reject) = slot.head_reject.borrow_mut().take() {
                        let _ = reject
                            .call1(&JsValue::UNDEFINED, &JsValue::from_str(&code));
                    }
                } else if !slot.stream_closed.get() {
                    if let Some(ctrl) = slot.controller.borrow_mut().take() {
                        let args = Array::new();
                        args.push(&JsValue::from_str(&code));
                        invoke_controller(&ctrl, "error", &args);
                    }
                }
                self.remove_stream(stream_id);
            }
            _ => {}
        }
    }

    fn remove_stream(&self, id: u32) {
        self.streams.borrow_mut().remove(&id);
    }

    fn send_raw(&self, frame: &[u8]) -> Result<(), JsValue> {
        let arr = Uint8Array::new_with_length(frame.len() as u32);
        arr.copy_from(frame);
        self.ws.send_with_array_buffer(&arr.buffer())
    }

    fn queue_frame(&self, stream_id: u32, frame_type: u8, payload: &[u8]) {
        let mut buf = Vec::with_capacity(5 + payload.len());
        buf.extend_from_slice(&stream_id.to_be_bytes());
        buf.push(frame_type);
        buf.extend_from_slice(payload);
        if self.open.get() {
            let _ = self.send_raw(&buf);
        } else {
            self.pending.borrow_mut().push(buf);
        }
    }

    /// Issue a multiplexed HTTP request. Resolves with a streaming Response.
    pub async fn fetch(
        self: Rc<Self>,
        url: String,
        method: String,
        headers: Vec<(String, String)>,
        body_bytes: Vec<u8>,
    ) -> Result<JsValue, JsValue> {
        let stream_id = self.allocate_stream_id();
        let slot = Rc::new(StreamSlot::new());
        self.streams.borrow_mut().insert(stream_id, slot.clone());

        let envelope = RelayRequest {
            url: &url,
            method: &method,
            headers: &headers,
            has_body: !body_bytes.is_empty(),
        };
        let env_text = serde_json::to_string(&envelope).map_err(|_| {
            JsValue::from_str("MALFORMED_ROUTE: envelope")
        })?;

        // Build the head-arrived Promise. The resolve/reject callbacks are
        // stashed in the slot; dispatch_frame fires them on FRAME_HEAD / FRAME_ERROR.
        let slot_for_promise = slot.clone();
        let promise = Promise::new(&mut |resolve, reject| {
            *slot_for_promise.head_resolve.borrow_mut() = Some(resolve);
            *slot_for_promise.head_reject.borrow_mut() = Some(reject);
        });

        // Send envelope + body chunks. Frames are queued if the WS is still
        // connecting; flushed automatically on onopen.
        self.queue_frame(stream_id, FRAME_ENVELOPE, env_text.as_bytes());
        if !body_bytes.is_empty() {
            const CHUNK: usize = 64 * 1024;
            for chunk in body_bytes.chunks(CHUNK) {
                self.queue_frame(stream_id, FRAME_BODY_UP, chunk);
            }
            // Empty BODY_UP = EOF terminator.
            self.queue_frame(stream_id, FRAME_BODY_UP, &[]);
        }

        let resp = JsFuture::from(promise).await?;
        Ok(resp)
    }
}

fn invoke_controller(ctrl: &JsValue, method: &str, args: &Array) {
    if let Ok(fn_value) = Reflect::get(ctrl, &JsValue::from_str(method)) {
        if let Some(f) = fn_value.dyn_ref::<Function>() {
            let _ = f.apply(ctrl, args);
        }
    }
}

fn build_streaming_response(
    head: &RelayResponseHead,
    slot: Rc<StreamSlot>,
) -> Result<JsValue, JsValue> {
    let global = js_sys::global();
    let response_ctor = Reflect::get(&global, &JsValue::from_str("Response"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let headers_ctor = Reflect::get(&global, &JsValue::from_str("Headers"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let stream_ctor = Reflect::get(&global, &JsValue::from_str("ReadableStream"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;

    let headers = Reflect::construct(&headers_ctor, &Array::new())
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let append = Reflect::get(&headers, &JsValue::from_str("append"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    for (k, v) in &head.headers {
        let args = Array::new();
        args.push(&JsValue::from_str(k));
        args.push(&JsValue::from_str(v));
        let _ = append.apply(&headers, &args);
    }
    // Surface the post-redirect URL so the SW can use it as the base when
    // rewriting root-relative URLs in HTML/CSS. Without this, root-relative
    // resources fall back to the originally requested host (eg. pay.naver.com)
    // even though the redirect landed on a different host (eg. nid.naver.com).
    if !head.final_url.is_empty() {
        let args = Array::new();
        args.push(&JsValue::from_str("X-ZP-Final-URL"));
        args.push(&JsValue::from_str(&head.final_url));
        let _ = append.apply(&headers, &args);
    }

    let source = js_sys::Object::new();
    let slot_for_start = slot.clone();
    let start_cb = Closure::wrap(Box::new(move |ctrl: JsValue| {
        *slot_for_start.controller.borrow_mut() = Some(ctrl);
    }) as Box<dyn FnMut(JsValue)>);
    let _ = Reflect::set(&source, &JsValue::from_str("start"), start_cb.as_ref().unchecked_ref());
    start_cb.forget();

    let stream_args = Array::new();
    stream_args.push(&source);
    let stream = Reflect::construct(&stream_ctor, &stream_args)
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;

    let init = js_sys::Object::new();
    let _ = Reflect::set(&init, &JsValue::from_str("status"), &JsValue::from_f64(head.status as f64));
    let _ = Reflect::set(&init, &JsValue::from_str("headers"), &headers);

    let args = Array::new();
    args.push(&stream);
    args.push(&init);
    let resp = Reflect::construct(&response_ctor, &args)
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let _ = head.host;
    Ok(resp)
}

fn get_string_prop(obj: &JsValue, key: &str) -> Option<String> {
    let v = Reflect::get(obj, &JsValue::from_str(key)).ok()?;
    if v.is_undefined() || v.is_null() {
        return None;
    }
    v.as_string()
}
