//! ZeroProxy browser kernel (transport layer) — Rust replacement for the
//! Go WASM kernel at `cmd/wasm-kernel/`.
//!
//! Step 13 cutover: this crate exposes a single async `kernelFetch` to the
//! Service Worker. Per call it opens a WebSocket to `/zp/relay`, sends a JSON
//! envelope describing the upstream request, then streams the response body
//! back as binary frames. No yamux multiplexing yet — one WS per HTTP req.
//!
//! The Go kernel is still in the tree (`cmd/wasm-kernel/`) and can be removed
//! after this kernel reaches feature parity. For now both ship; the SW prefers
//! whichever is initialised first.

#![cfg(target_arch = "wasm32")]

mod mux;

use js_sys::{Array, ArrayBuffer, Function, JsString, Promise, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{BinaryType, Blob, CloseEvent, ErrorEvent, MessageEvent, WebSocket};

/// Bundle version string. Mirrors zp_shared::TRANSFORMER_VERSION so the SW
/// can verify (Rust kernel, Rust rewriter, Rust membrane) all match.
#[wasm_bindgen(js_name = kernelVersion)]
pub fn kernel_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}

/// Diagnostic: synchronous probe to verify the basic JsValue ABI works
/// for this crate's wasm-bindgen surface.
#[wasm_bindgen(js_name = kernelEchoSync)]
pub fn kernel_echo_sync(arg: JsValue) -> JsValue {
    push_trace(&format!("echo_sync:is_undef={} is_obj={} as_str={:?}",
        arg.is_undefined(), arg.is_object(), arg.as_string()));
    arg
}

/// Initialize the Rust kernel. Today a no-op — `kernelFetch` opens a fresh WS
/// per request. Future: persistent yamux session held across calls.
#[wasm_bindgen(js_name = kernelInit)]
pub fn kernel_init() -> String {
    format!("zp-kernel v{} (rust, ws-relay)", zp_shared::TRANSFORMER_VERSION)
}

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

/// Open a WebSocket to `/zp/relay` (or the supplied relay server), send the
/// request envelope, and return a `Response` whose body streams the upstream
/// reply. Caller is the Service Worker (or any other agent that imports the
/// kernel WASM).
///
/// Must be declared `async`; a sync `fn` returning `Promise` drops the
/// JsValue ABI ref before the deferred async block runs, so by the time
/// relay_fetch reads `request_js.url` it's already `undefined`.
#[wasm_bindgen(js_name = kernelFetch)]
pub async fn kernel_fetch(request_js: JsValue) -> Result<JsValue, JsValue> {
    push_trace(&format!("kernel_fetch:entry is_undef={} is_obj={}", request_js.is_undefined(), request_js.is_object()));
    let url = get_string_prop(&request_js, "url").unwrap_or_default();
    let method = get_string_prop(&request_js, "method").unwrap_or_else(|| "GET".to_string());
    push_trace(&format!("kernel_fetch:captured url={} method={}", url, method));

    let mut headers_owned: Vec<(String, String)> = Vec::new();
    if let Ok(h) = Reflect::get(&request_js, &JsValue::from_str("headers")) {
        if !h.is_undefined() && !h.is_null() {
            if let Ok(entries_fn) = Reflect::get(&h, &JsValue::from_str("entries")) {
                if let Some(f) = entries_fn.dyn_ref::<Function>() {
                    if let Ok(iter) = f.call0(&h) {
                        collect_iter_pairs(&iter, &mut headers_owned);
                    }
                }
            }
        }
    }
    push_trace(&format!("kernel_fetch:captured headers={}", headers_owned.len()));

    if url.is_empty() {
        push_trace("kernel_fetch:empty-url");
        return Err(JsValue::from_str("MALFORMED_ROUTE: missing url"));
    }

    // Drain the request body for non-GET/HEAD methods. Without this, every
    // POST/PUT/PATCH/DELETE reaches the relay with an empty body — target
    // endpoints that validate the body (e.g. anti-CSRF /api/v1/collect/*)
    // 400 because they expect JSON they never receive.
    let method_upper = method.to_ascii_uppercase();
    let body_bytes: Vec<u8> = if method_upper != "GET" && method_upper != "HEAD" {
        match extract_body_bytes(&request_js).await {
            Ok(b) => b,
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    push_trace(&format!("kernel_fetch:captured body bytes={}", body_bytes.len()));

    // Multiplexed path: one shared WS, many concurrent streams. The mux
    // session is created lazily on first call and reused thereafter.
    push_trace("kernel_fetch:mux path");
    let sess = match mux::get_session() {
        Ok(s) => s,
        Err(e) => {
            push_trace(&format!("mux::get_session ERR {:?} — fallback to per-WS path", e));
            return relay_fetch_owned(url, method, headers_owned, body_bytes).await;
        }
    };
    sess.fetch(url, method, headers_owned, body_bytes).await
}

async fn relay_fetch_owned(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_bytes: Vec<u8>,
) -> Result<JsValue, JsValue> {
    push_trace(&format!("relay_fetch_owned:enter url={} method={}", url, method));
    let relay_url = match pick_relay_url() {
        Ok(u) => u,
        Err(e) => { push_trace(&format!("pick_relay_url:ERR {:?}", e)); return Err(e); }
    };
    push_trace(&format!("relay_fetch_owned:relay={}", relay_url));
    let js_resp = relay_round_trip(&relay_url, &url, &method, &headers, &body_bytes).await?;
    push_trace("relay_fetch_owned:got-response");
    if js_resp.is_undefined() {
        return Err(JsValue::from_str("TARGET_CONNECT_FAILED: no-response"));
    }
    Ok(js_resp)
}

async fn relay_fetch(request_js: JsValue) -> Result<JsValue, JsValue> {
    push_trace("relay_fetch:enter");
    let parsed = parse_request(&request_js).await;
    match &parsed {
        Ok((u, m, h, b)) => push_trace(&format!("parse_request:OK url={} method={} headers={} body={}", u, m, h.len(), b.len())),
        Err(e) => push_trace(&format!("parse_request:ERR {:?}", e)),
    }
    let (url, method, headers, body_bytes) = parsed?;
    push_trace(&format!("relay_fetch:parsed url={}", url));
    let relay_url = match pick_relay_url() {
        Ok(u) => u,
        Err(e) => { push_trace(&format!("pick_relay_url:ERR {:?}", e)); return Err(e); }
    };
    push_trace(&format!("relay_fetch:relay={}", relay_url));
    let js_resp = relay_round_trip(&relay_url, &url, &method, &headers, &body_bytes).await?;
    push_trace("relay_fetch:got-response");
    if js_resp.is_undefined() {
        return Err(JsValue::from_str("TARGET_CONNECT_FAILED: no-response"));
    }
    Ok(js_resp)
}

fn push_trace(msg: &str) {
    let global = js_sys::global();
    let key = JsValue::from_str("__zpRustTrace");
    let arr = js_sys::Reflect::get(&global, &key).unwrap_or(JsValue::UNDEFINED);
    let arr: js_sys::Array = if arr.is_undefined() {
        let a = js_sys::Array::new();
        let _ = js_sys::Reflect::set(&global, &key, &a);
        a
    } else {
        arr.unchecked_into::<js_sys::Array>()
    };
    arr.push(&JsValue::from_str(msg));
}

async fn parse_request(req: &JsValue) -> Result<(String, String, Vec<(String, String)>, Vec<u8>), JsValue> {
    // Accept either a Request instance or a plain JS object.
    push_trace(&format!("parse_request: req.is_null={} is_undefined={} is_object={}",
        req.is_null(), req.is_undefined(), req.is_object()));
    // Reflect.get raw return for "url"
    let raw_url = Reflect::get(req, &JsValue::from_str("url"));
    match &raw_url {
        Ok(v) => push_trace(&format!("Reflect.get(url) Ok type={} as_string={:?}",
            if v.is_string() { "string" } else if v.is_undefined() { "undef" } else if v.is_null() { "null" } else { "other" },
            v.as_string())),
        Err(e) => push_trace(&format!("Reflect.get(url) Err {:?}", e)),
    }
    let url = get_string_prop(req, "url").unwrap_or_default();
    if url.is_empty() {
        return Err(JsValue::from_str("MALFORMED_ROUTE: missing url"));
    }
    let method = get_string_prop(req, "method").unwrap_or_else(|| "GET".to_string());
    let mut headers: Vec<(String, String)> = Vec::new();
    let header_obj = Reflect::get(req, &JsValue::from_str("headers")).ok();
    if let Some(h) = header_obj {
        if !h.is_undefined() && !h.is_null() {
            // Headers may be an iterable (Headers instance) — try entries().
            if let Ok(entries_fn) = Reflect::get(&h, &JsValue::from_str("entries")) {
                if let Some(f) = entries_fn.dyn_ref::<Function>() {
                    if let Ok(iter) = f.call0(&h) {
                        collect_iter_pairs(&iter, &mut headers);
                    }
                }
            }
            // Or an array of [name, value] pairs.
            if headers.is_empty() {
                if let Some(arr) = h.dyn_ref::<Array>() {
                    for kv in arr.iter() {
                        if let Some(pair) = kv.dyn_ref::<Array>() {
                            if pair.length() >= 2 {
                                headers.push((to_string(&pair.get(0)), to_string(&pair.get(1))));
                            }
                        }
                    }
                }
            }
        }
    }
    let body_bytes = extract_body_bytes(req).await?;
    Ok((url, method, headers, body_bytes))
}

fn collect_iter_pairs(iter: &JsValue, out: &mut Vec<(String, String)>) {
    let next_fn = match Reflect::get(iter, &JsValue::from_str("next")) {
        Ok(v) => v,
        Err(_) => return,
    };
    let next_fn = match next_fn.dyn_ref::<Function>() {
        Some(f) => f.clone(),
        None => return,
    };
    loop {
        let step = match next_fn.call0(iter) {
            Ok(v) => v,
            Err(_) => return,
        };
        let done = Reflect::get(&step, &JsValue::from_str("done"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if done {
            return;
        }
        let value = match Reflect::get(&step, &JsValue::from_str("value")) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(arr) = value.dyn_ref::<Array>() {
            if arr.length() >= 2 {
                out.push((to_string(&arr.get(0)), to_string(&arr.get(1))));
            }
        }
    }
}

async fn extract_body_bytes(req: &JsValue) -> Result<Vec<u8>, JsValue> {
    // If the JS Request has a body, call .arrayBuffer() to drain it.
    let array_buffer_fn = match Reflect::get(req, &JsValue::from_str("arrayBuffer")) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let f = match array_buffer_fn.dyn_ref::<Function>() {
        Some(f) => f.clone(),
        None => return Ok(Vec::new()),
    };
    let promise = match f.call0(req) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let promise = match promise.dyn_ref::<Promise>() {
        Some(p) => p.clone(),
        None => return Ok(Vec::new()),
    };
    let buf = JsFuture::from(promise).await.unwrap_or(JsValue::UNDEFINED);
    if buf.is_undefined() || buf.is_null() {
        return Ok(Vec::new());
    }
    if let Some(ab) = buf.dyn_ref::<ArrayBuffer>() {
        let arr = Uint8Array::new(ab);
        return Ok(arr.to_vec());
    }
    Ok(Vec::new())
}

fn pick_relay_url() -> Result<String, JsValue> {
    // Read self.location via direct property access — js_sys::eval needs
    // CSP 'unsafe-eval' which may be denied in some sandboxes; the explicit
    // Reflect path works as long as the kernel runs inside a Worker or SW.
    let global = js_sys::global();
    let location = js_sys::Reflect::get(&global, &JsValue::from_str("location"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    if location.is_undefined() || location.is_null() {
        return Err(JsValue::from_str("SW_NOT_READY: no location"));
    }
    let host = get_string_prop(&location, "host").unwrap_or_default();
    let protocol = get_string_prop(&location, "protocol").unwrap_or_else(|| "http:".to_string());
    let scheme = if protocol == "https:" { "wss" } else { "ws" };
    if host.is_empty() {
        return Err(JsValue::from_str("SW_NOT_READY: empty host"));
    }
    Ok(format!("{}://{}/zp/relay", scheme, host))
}

async fn relay_round_trip(
    relay_url: &str,
    target_url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<JsValue, JsValue> {
    push_trace(&format!("relay_round_trip:enter relay={}", relay_url));
    let ws = WebSocket::new(relay_url).map_err(|e| {
        push_trace(&format!("WS::new failed: {:?}", e));
        JsValue::from_str("TARGET_CONNECT_FAILED: ws-construct")
    })?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    let has_body = !body.is_empty();
    let envelope = RelayRequest {
        url: target_url,
        method,
        headers,
        has_body,
    };
    let envelope_text = serde_json::to_string(&envelope)
        .map_err(|_| JsValue::from_str("MALFORMED_ROUTE: envelope"))?;
    // Body chunks: split the (already-extracted) bytes into ~64KB binary
    // frames so the server can pipe them straight into the upstream request
    // without allocating a single contiguous buffer. Real streaming requires
    // SW-side pumping of `request.body` — captured into `body_bytes` upstream
    // for now — but the wire protocol is already shaped for it.
    let body_chunks: Option<Vec<Vec<u8>>> = if has_body {
        const CHUNK: usize = 64 * 1024;
        Some(body.chunks(CHUNK).map(|c| c.to_vec()).collect())
    } else {
        None
    };

    // Streaming completion: as soon as the head text frame arrives we build a
    // Response whose body is a ReadableStream we control. Subsequent binary
    // frames are enqueued into the stream; an empty binary frame closes it.
    // The Promise resolves with the Response after the head — body continues
    // to stream while the SW (or downstream consumer) already pumps it.
    let ws_for_promise = ws.clone();
    let controller_slot: Rc<RefCell<Option<JsValue>>> = Rc::new(RefCell::new(None));
    let response_built: Rc<RefCell<bool>> = Rc::new(RefCell::new(false));
    let stream_closed: Rc<RefCell<bool>> = Rc::new(RefCell::new(false));

    let promise = Promise::new(&mut |resolve, reject| {
        let resolve = Rc::new(resolve);
        let reject = Rc::new(reject);

        let ws_for_open = ws_for_promise.clone();
        let envelope_for_open = envelope_text.clone();
        let body_chunks_for_open = body_chunks.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            push_trace("WS:onopen sending envelope");
            if let Err(e) = ws_for_open.send_with_str(&envelope_for_open) {
                push_trace(&format!("WS send failed: {:?}", e));
                return;
            }
            // After envelope, stream body chunks (binary frames), terminated
            // by an empty binary frame. Server's relay reads these into an
            // io.Pipe feeding the upstream request body.
            if let Some(chunks) = body_chunks_for_open.as_ref() {
                for chunk in chunks {
                    let arr = Uint8Array::new_with_length(chunk.len() as u32);
                    arr.copy_from(chunk);
                    if let Err(e) = ws_for_open.send_with_array_buffer(&arr.buffer()) {
                        push_trace(&format!("WS body chunk send failed: {:?}", e));
                        return;
                    }
                }
                let empty = Uint8Array::new_with_length(0);
                let _ = ws_for_open.send_with_array_buffer(&empty.buffer());
                push_trace("WS body chunks done");
            }
        }) as Box<dyn FnMut(JsValue)>);
        ws_for_promise.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        on_open.forget();

        let resolve_msg = resolve.clone();
        let reject_msg = reject.clone();
        let controller_msg = controller_slot.clone();
        let response_built_msg = response_built.clone();
        let stream_closed_msg = stream_closed.clone();
        let on_message = Closure::wrap(Box::new(move |ev: MessageEvent| {
            let data = ev.data();
            if let Some(s) = data.dyn_ref::<JsString>() {
                if *response_built_msg.borrow() {
                    push_trace("WS:duplicate head frame ignored");
                    return;
                }
                let txt = String::from(s);
                push_trace(&format!("WS:head bytes={}", txt.len()));
                let head: RelayResponseHead = match serde_json::from_str(&txt) {
                    Ok(h) => h,
                    Err(_) => {
                        let _ = reject_msg.call1(&JsValue::UNDEFINED, &JsValue::from_str("MALFORMED_ROUTE"));
                        return;
                    }
                };
                if !head.ok {
                    let code = if head.code.is_empty() { "TARGET_CONNECT_FAILED".to_string() } else { head.code.clone() };
                    let _ = reject_msg.call1(&JsValue::UNDEFINED, &JsValue::from_str(&code));
                    return;
                }
                match build_streaming_response(&head, controller_msg.clone()) {
                    Ok(resp) => {
                        *response_built_msg.borrow_mut() = true;
                        push_trace("WS:resolving with streaming Response");
                        let _ = resolve_msg.call1(&JsValue::UNDEFINED, &resp);
                    }
                    Err(e) => { let _ = reject_msg.call1(&JsValue::UNDEFINED, &e); }
                }
            } else if let Some(ab) = data.dyn_ref::<ArrayBuffer>() {
                let arr = Uint8Array::new(ab);
                let len = arr.length();
                if len == 0 {
                    push_trace("WS:body-EOF, closing stream");
                    *stream_closed_msg.borrow_mut() = true;
                    if let Some(ctrl) = controller_slot_take(&controller_msg) {
                        invoke_controller(&ctrl, "close", &Array::new());
                    }
                } else {
                    push_trace(&format!("WS:body chunk={}", len));
                    if let Some(ctrl) = controller_slot_peek(&controller_msg) {
                        let args = Array::new();
                        args.push(&arr);
                        invoke_controller(&ctrl, "enqueue", &args);
                    } else {
                        push_trace("WS:chunk before controller — dropping");
                    }
                }
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        ws_for_promise.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        on_message.forget();

        let reject_close = reject.clone();
        let response_built_close = response_built.clone();
        let stream_closed_close = stream_closed.clone();
        let controller_close = controller_slot.clone();
        let on_close = Closure::wrap(Box::new(move |ev: CloseEvent| {
            push_trace(&format!("WS:onclose code={}", ev.code()));
            if !*response_built_close.borrow() {
                let _ = reject_close.call1(&JsValue::UNDEFINED, &JsValue::from_str("TARGET_CONNECT_FAILED: ws-close"));
            } else if !*stream_closed_close.borrow() {
                if let Some(ctrl) = controller_slot_take(&controller_close) {
                    invoke_controller(&ctrl, "close", &Array::new());
                }
            }
        }) as Box<dyn FnMut(CloseEvent)>);
        ws_for_promise.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        on_close.forget();

        let reject_err = reject.clone();
        let response_built_err = response_built.clone();
        let stream_closed_err = stream_closed.clone();
        let controller_err = controller_slot.clone();
        let on_error = Closure::wrap(Box::new(move |_: ErrorEvent| {
            push_trace("WS:onerror");
            if !*response_built_err.borrow() {
                let _ = reject_err.call1(&JsValue::UNDEFINED, &JsValue::from_str("TARGET_CONNECT_FAILED: ws-error"));
            } else if !*stream_closed_err.borrow() {
                if let Some(ctrl) = controller_slot_take(&controller_err) {
                    let args = Array::new();
                    args.push(&JsValue::from_str("TARGET_CONNECT_FAILED: ws-error"));
                    invoke_controller(&ctrl, "error", &args);
                }
            }
        }) as Box<dyn FnMut(ErrorEvent)>);
        ws_for_promise.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        on_error.forget();
    });

    push_trace("awaiting WS-completion-promise");
    let out = JsFuture::from(promise).await;
    push_trace(&format!("WS-promise settled ok={}", out.is_ok()));
    // Do NOT close ws here — the stream may still be feeding chunks. The WS
    // closes naturally when the server signals EOF (empty binary frame) and
    // the on_close handler clears the controller.
    out
}

/// Open a WebSocket through the relay (server-side `/zp/ws-bridge`) to a
/// target WebSocket URL. Returns a stream object with `setHandlers`, `send`,
/// `close`, and `.protocol`, mirroring the surface the SW already uses for
/// the legacy Go `__zp_stream`.
#[wasm_bindgen(js_name = kernelStream)]
pub async fn kernel_stream(arg: JsValue) -> Result<JsValue, JsValue> {
    push_trace("kernel_stream:entry");
    let url = get_string_prop(&arg, "url").unwrap_or_default();
    if url.is_empty() {
        return Err(JsValue::from_str("MALFORMED_ROUTE: missing url"));
    }
    let protocols: Vec<String> = match Reflect::get(&arg, &JsValue::from_str("protocols")) {
        Ok(v) if !v.is_undefined() && !v.is_null() => {
            if let Some(a) = v.dyn_ref::<Array>() {
                a.iter().filter_map(|v| v.as_string()).collect()
            } else { Vec::new() }
        }
        _ => Vec::new(),
    };
    let bridge_url = pick_bridge_url()?;
    push_trace(&format!("kernel_stream:bridge={} target={}", bridge_url, url));

    let ws = WebSocket::new(&bridge_url)
        .map_err(|_| JsValue::from_str("TARGET_CONNECT_FAILED: bridge-construct"))?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    let envelope = serde_json::json!({
        "url": url,
        "protocols": protocols,
        "tabId": get_string_prop(&arg, "tabId").unwrap_or_default(),
        "isolation": get_string_prop(&arg, "streamIsolationKey").unwrap_or_default(),
    });
    let envelope_text = envelope.to_string();

    // ACK promise: resolved on first text frame from the bridge (success/fail).
    let ws_for_ack = ws.clone();
    let envelope_for_open = envelope_text.clone();
    let ack_promise = Promise::new(&mut |resolve, reject| {
        let resolve = Rc::new(resolve);
        let reject = Rc::new(reject);

        let env = envelope_for_open.clone();
        let ws_open = ws_for_ack.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            let _ = ws_open.send_with_str(&env);
        }) as Box<dyn FnMut(JsValue)>);
        ws_for_ack.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        on_open.forget();

        let resolve_msg = resolve.clone();
        let reject_msg = reject.clone();
        let on_message = Closure::wrap(Box::new(move |ev: MessageEvent| {
            let data = ev.data();
            if let Some(s) = data.dyn_ref::<JsString>() {
                let _ = resolve_msg.call1(&JsValue::UNDEFINED, &JsValue::from(s.clone()));
            } else {
                let _ = reject_msg.call1(&JsValue::UNDEFINED, &JsValue::from_str("MALFORMED_ROUTE: non-text ack"));
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        ws_for_ack.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        on_message.forget();

        let reject_close = reject.clone();
        let on_close = Closure::wrap(Box::new(move |_: CloseEvent| {
            let _ = reject_close.call1(&JsValue::UNDEFINED, &JsValue::from_str("TARGET_CONNECT_FAILED: bridge-close"));
        }) as Box<dyn FnMut(CloseEvent)>);
        ws_for_ack.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        on_close.forget();

        let reject_err = reject.clone();
        let on_error = Closure::wrap(Box::new(move |_: ErrorEvent| {
            let _ = reject_err.call1(&JsValue::UNDEFINED, &JsValue::from_str("TARGET_CONNECT_FAILED: bridge-error"));
        }) as Box<dyn FnMut(ErrorEvent)>);
        ws_for_ack.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        on_error.forget();
    });
    let ack = JsFuture::from(ack_promise).await?;
    let ack_str = ack.as_string().ok_or_else(|| JsValue::from_str("MALFORMED_ROUTE: ack"))?;
    let ack_val: serde_json::Value = serde_json::from_str(&ack_str)
        .map_err(|_| JsValue::from_str("MALFORMED_ROUTE: ack-json"))?;
    if !ack_val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let code = ack_val.get("code").and_then(|v| v.as_str()).unwrap_or("TARGET_CONNECT_FAILED");
        return Err(JsValue::from_str(code));
    }
    let protocol = ack_val.get("protocol").and_then(|v| v.as_str()).unwrap_or("").to_string();
    push_trace(&format!("kernel_stream:ack ok protocol={}", protocol));

    // Build the stream object: { protocol, setHandlers, send, close }.
    let handlers: Rc<RefCell<Option<JsValue>>> = Rc::new(RefCell::new(None));
    let ws_for_msg = ws.clone();
    let handlers_for_msg = handlers.clone();
    let on_message = Closure::wrap(Box::new(move |ev: MessageEvent| {
        let h_slot = handlers_for_msg.borrow();
        let h = match h_slot.as_ref() {
            Some(v) => v.clone(),
            None => return,
        };
        let data = ev.data();
        if let Some(s) = data.dyn_ref::<JsString>() {
            let parsed: serde_json::Value = match serde_json::from_str(&String::from(s)) {
                Ok(v) => v,
                Err(_) => return,
            };
            let t = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match t {
                "text" => {
                    let body = parsed.get("data").and_then(|v| v.as_str()).unwrap_or("");
                    dispatch_handler(&h, "message", &JsValue::from_str(body));
                }
                "binary" => {
                    let body = parsed.get("data").and_then(|v| v.as_str()).unwrap_or("");
                    let bytes = base64_decode(body).unwrap_or_default();
                    let arr = Uint8Array::new_with_length(bytes.len() as u32);
                    arr.copy_from(&bytes);
                    dispatch_handler(&h, "message", &arr.buffer());
                }
                "close" => {
                    dispatch_handler(&h, "close", &JsValue::UNDEFINED);
                }
                _ => {}
            }
        }
    }) as Box<dyn FnMut(MessageEvent)>);
    ws_for_msg.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    on_message.forget();

    let ws_for_close = ws.clone();
    let handlers_for_close = handlers.clone();
    let on_close = Closure::wrap(Box::new(move |_: CloseEvent| {
        if let Some(h) = handlers_for_close.borrow().as_ref() {
            dispatch_handler(h, "close", &JsValue::UNDEFINED);
        }
    }) as Box<dyn FnMut(CloseEvent)>);
    ws_for_close.set_onclose(Some(on_close.as_ref().unchecked_ref()));
    on_close.forget();

    let ws_for_err = ws.clone();
    let handlers_for_err = handlers.clone();
    let on_error = Closure::wrap(Box::new(move |_: ErrorEvent| {
        if let Some(h) = handlers_for_err.borrow().as_ref() {
            dispatch_handler(h, "error", &JsValue::UNDEFINED);
        }
    }) as Box<dyn FnMut(ErrorEvent)>);
    ws_for_err.set_onerror(Some(on_error.as_ref().unchecked_ref()));
    on_error.forget();

    let stream = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&stream, &JsValue::from_str("protocol"), &JsValue::from_str(&protocol));

    let handlers_set = handlers.clone();
    let set_handlers_cb = Closure::wrap(Box::new(move |h: JsValue| {
        *handlers_set.borrow_mut() = Some(h);
    }) as Box<dyn FnMut(JsValue)>);
    let _ = js_sys::Reflect::set(&stream, &JsValue::from_str("setHandlers"), set_handlers_cb.as_ref().unchecked_ref());
    set_handlers_cb.forget();

    let ws_send = ws.clone();
    let send_cb = Closure::wrap(Box::new(move |data: JsValue| {
        if let Some(s) = data.as_string() {
            let payload = serde_json::json!({"type": "text", "data": s}).to_string();
            let _ = ws_send.send_with_str(&payload);
        } else if let Some(ab) = data.dyn_ref::<ArrayBuffer>() {
            let bytes = Uint8Array::new(ab).to_vec();
            let payload = serde_json::json!({"type": "binary", "data": base64_encode(&bytes)}).to_string();
            let _ = ws_send.send_with_str(&payload);
        } else if let Some(arr) = data.dyn_ref::<Uint8Array>() {
            let bytes = arr.to_vec();
            let payload = serde_json::json!({"type": "binary", "data": base64_encode(&bytes)}).to_string();
            let _ = ws_send.send_with_str(&payload);
        }
    }) as Box<dyn FnMut(JsValue)>);
    let _ = js_sys::Reflect::set(&stream, &JsValue::from_str("send"), send_cb.as_ref().unchecked_ref());
    send_cb.forget();

    let ws_close = ws.clone();
    let close_cb = Closure::wrap(Box::new(move || {
        let close_payload = serde_json::json!({"type": "close"}).to_string();
        let _ = ws_close.send_with_str(&close_payload);
        let _ = ws_close.close();
    }) as Box<dyn FnMut()>);
    let _ = js_sys::Reflect::set(&stream, &JsValue::from_str("close"), close_cb.as_ref().unchecked_ref());
    close_cb.forget();

    Ok(stream.into())
}

fn pick_bridge_url() -> Result<String, JsValue> {
    let global = js_sys::global();
    let location = js_sys::Reflect::get(&global, &JsValue::from_str("location"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let host = get_string_prop(&location, "host").unwrap_or_default();
    let protocol = get_string_prop(&location, "protocol").unwrap_or_else(|| "http:".to_string());
    let scheme = if protocol == "https:" { "wss" } else { "ws" };
    if host.is_empty() {
        return Err(JsValue::from_str("SW_NOT_READY: empty host"));
    }
    Ok(format!("{}://{}/zp/ws-bridge", scheme, host))
}

fn dispatch_handler(handlers: &JsValue, key: &str, arg: &JsValue) {
    if let Ok(fn_value) = js_sys::Reflect::get(handlers, &JsValue::from_str(key)) {
        if let Some(f) = fn_value.dyn_ref::<Function>() {
            let _ = f.call1(handlers, arg);
        }
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, &c) in ALPHA.iter().enumerate() {
        table[c as usize] = i as u8;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0;
    for &c in bytes {
        if c == b'=' { break; }
        let v = table[c as usize];
        if v == 255 { continue; }
        buf = (buf << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn controller_slot_peek(slot: &Rc<RefCell<Option<JsValue>>>) -> Option<JsValue> {
    slot.borrow().clone()
}

fn controller_slot_take(slot: &Rc<RefCell<Option<JsValue>>>) -> Option<JsValue> {
    slot.borrow_mut().take()
}

fn invoke_controller(ctrl: &JsValue, method: &str, args: &Array) {
    if let Ok(fn_value) = js_sys::Reflect::get(ctrl, &JsValue::from_str(method)) {
        if let Some(f) = fn_value.dyn_ref::<Function>() {
            let _ = f.apply(ctrl, args);
        }
    }
}

fn build_streaming_response(
    head: &RelayResponseHead,
    controller_slot: Rc<RefCell<Option<JsValue>>>,
) -> Result<JsValue, JsValue> {
    let global = js_sys::global();
    let response_ctor = js_sys::Reflect::get(&global, &JsValue::from_str("Response"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let headers_ctor = js_sys::Reflect::get(&global, &JsValue::from_str("Headers"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let stream_ctor = js_sys::Reflect::get(&global, &JsValue::from_str("ReadableStream"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;

    let headers = js_sys::Reflect::construct(&headers_ctor, &Array::new())
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    let append = js_sys::Reflect::get(&headers, &JsValue::from_str("append"))
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;
    for (k, v) in &head.headers {
        let args = Array::new();
        args.push(&JsValue::from_str(k));
        args.push(&JsValue::from_str(v));
        let _ = append.apply(&headers, &args);
    }

    let source = js_sys::Object::new();
    let slot_for_start = controller_slot.clone();
    let start_cb = Closure::wrap(Box::new(move |ctrl: JsValue| {
        *slot_for_start.borrow_mut() = Some(ctrl);
    }) as Box<dyn FnMut(JsValue)>);
    let _ = js_sys::Reflect::set(&source, &JsValue::from_str("start"), start_cb.as_ref().unchecked_ref());
    start_cb.forget();

    let stream_args = Array::new();
    stream_args.push(&source);
    let stream = js_sys::Reflect::construct(&stream_ctor, &stream_args)
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))?;

    let init = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&init, &JsValue::from_str("status"), &JsValue::from_f64(head.status as f64));
    let _ = js_sys::Reflect::set(&init, &JsValue::from_str("headers"), &headers);

    let args = Array::new();
    args.push(&stream);
    args.push(&init);
    js_sys::Reflect::construct(&response_ctor, &args)
        .map_err(|_| JsValue::from_str("SW_NOT_READY"))
}

fn get_string_prop(obj: &JsValue, key: &str) -> Option<String> {
    let v = Reflect::get(obj, &JsValue::from_str(key)).ok()?;
    if v.is_undefined() || v.is_null() {
        return None;
    }
    if let Some(s) = v.as_string() {
        return Some(s);
    }
    Some(format!("{}", to_string(&v)))
}

fn to_string(v: &JsValue) -> String {
    if let Some(s) = v.as_string() {
        return s;
    }
    format!("{:?}", v)
}

fn base64_encode(data: &[u8]) -> String {
    // Standard base64 (no padding stripping). Small handwritten encoder so the
    // crate stays free of an extra dep.
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

/// Cookie jar bridge stub. Real implementation will mirror document.cookie
/// from the SW into a per-tab cookie store before sending each request.
#[wasm_bindgen(js_name = kernelCookieSet)]
pub fn kernel_cookie_set(_payload: &str) -> bool {
    false
}
