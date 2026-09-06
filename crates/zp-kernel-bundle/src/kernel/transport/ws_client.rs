//! Target-side WebSocket client (RFC 6455).
//!
//! Sits on top of the existing dialer (yamux → SOCKS5 → optional TLS via
//! `PooledConn`) and adds:
//!
//! * **Client handshake** — HTTP/1.1 GET with `Upgrade: websocket`,
//!   random 16-byte `Sec-WebSocket-Key`, validation of the server's
//!   `Sec-WebSocket-Accept = base64(SHA1(key || GUID))` per §1.3.
//! * **Frame codec** — minimal subset of §5: encode binary/text/close/
//!   pong with client mask (§5.3 — MUST be set for client→server), decode
//!   server frames (MUST NOT be masked; fail the connection if they are).
//!   Fragmentation across continuation frames is supported on read; we
//!   never fragment on write (message bodies fit in one frame).
//! * **JS surface** — `WsClient` is exposed to JS via `wasm_bindgen` with
//!   `protocol()`, `send_text` / `send_bytes`, `set_handlers`, `close()`,
//!   and `buffered_amount()` — the methods the SW `openRuntimeStream`
//!   calls (web/sw.js).
//!
//! Out of scope for this landing (would meaningfully increase LOC without
//! changing escape-jail correctness): permessage-deflate, per-message
//! compression, multiple subprotocol negotiation strategies beyond a
//! straight pick-from-offered.

use std::cell::RefCell;
use std::io;
use std::rc::Rc;

use base64::Engine;
use futures_util::future::{AbortHandle, Abortable};
use futures_util::io::{AsyncReadExt, AsyncWriteExt};
use js_sys::{Function, Reflect, Uint8Array};
use sha1::{Digest, Sha1};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;

use super::pool::PooledConn;
use super::socks5::{self, Auth};
use super::tls::TlsStream;
use super::yamux;

/// RFC 6455 §1.3 magic GUID.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Encapsulates the parsed `ws://` / `wss://` URL for the dialer.
struct WsUrl {
    secure: bool,
    host: String,
    port: u16,
    path_and_query: String,
}

impl WsUrl {
    fn parse(url: &str) -> Result<Self, String> {
        // Use the browser's WHATWG URL parser for safety against malformed
        // ports / userinfo / IDN — same path the HTTP fetch uses.
        let u = web_sys::Url::new(url).map_err(|_| format!("bad URL: {url}"))?;
        let proto = u.protocol(); // "ws:" / "wss:"
        let scheme = proto.trim_end_matches(':').to_ascii_lowercase();
        let secure = match scheme.as_str() {
            "ws" => false,
            "wss" => true,
            other => return Err(format!("unsupported ws scheme: {other}")),
        };
        let host = u.hostname();
        if host.is_empty() {
            return Err(format!("empty host in URL: {url}"));
        }
        let port_str = u.port();
        let port: u16 = if port_str.is_empty() {
            if secure { 443 } else { 80 }
        } else {
            port_str
                .parse()
                .map_err(|_| format!("bad port: {port_str}"))?
        };
        let mut path = u.pathname();
        if path.is_empty() {
            path.push('/');
        }
        let search = u.search();
        if !search.is_empty() {
            path.push_str(&search);
        }
        Ok(Self {
            secure,
            host,
            port,
            path_and_query: path,
        })
    }
}

/// Generate a 16-byte random nonce per §4.1, base64-encode it as the
/// `Sec-WebSocket-Key` value. Uses `getrandom` (the wasm_js feature is
/// already enabled on this crate for rustls).
fn fresh_key() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| format!("getrandom: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// `base64(SHA1(client_key || GUID))` per §1.3.
fn expected_accept(client_key: &str) -> String {
    let mut h = Sha1::new();
    h.update(client_key.as_bytes());
    h.update(WS_GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

fn jserr_str(s: impl Into<String>) -> JsValue {
    JsValue::from_str(&s.into())
}

/// Open a transport-level byte stream to (host, port) with the existing
/// dialer (yamux + SOCKS5 + optional TLS). `secure` selects HTTPS layer
/// with ALPN forced to `http/1.1` — WebSocket Upgrade requires HTTP/1.1.
async fn open_target_stream(
    host: &str,
    port: u16,
    secure: bool,
) -> Result<PooledConn, JsValue> {
    let relay_url = super::fetch::pick_relay_url().map_err(jserr_str)?;
    let session = yamux::get_or_open(&relay_url)
        .await
        .map_err(|e| jserr_str(format!("TARGET_CONNECT_FAILED:mux-session: {e}")))?;
    let mut stream = session
        .open_stream()
        .await
        .map_err(|e| jserr_str(format!("TARGET_CONNECT_FAILED:mux-open: {e}")))?;
    socks5::connect(&mut stream, host, port, &Auth::None)
        .await
        .map_err(|e| jserr_str(format!("TARGET_CONNECT_FAILED:socks5: {e}")))?;
    if !secure {
        return Ok(PooledConn::Plain(stream));
    }
    // ALPN for WS-over-TLS is always http/1.1 (RFC 8441 covers a separate
    // h2 bootstrap but we don't implement that — the SW would have to
    // perform an HTTP/2 CONNECT first).
    let tls = TlsStream::connect(stream, host, &[b"http/1.1"])
        .await
        .map_err(|e| jserr_str(format!("TARGET_TLS_FAILED: {e}")))?;
    Ok(PooledConn::Tls(Box::new(tls)))
}

/// Write the GET handshake to `conn` and parse the 101 response. Returns
/// the server-negotiated sub-protocol (may be empty).
async fn handshake(
    conn: &mut PooledConn,
    url: &WsUrl,
    protocols: &[String],
    identity_headers: &[(&str, &str)],
) -> Result<String, JsValue> {
    let client_key = fresh_key().map_err(jserr_str)?;
    let expected = expected_accept(&client_key);

    let host_header = if (!url.secure && url.port == 80) || (url.secure && url.port == 443) {
        url.host.clone()
    } else {
        format!("{}:{}", url.host, url.port)
    };

    let mut req = String::with_capacity(256);
    req.push_str("GET ");
    req.push_str(&url.path_and_query);
    req.push_str(" HTTP/1.1\r\n");
    req.push_str("Host: ");
    req.push_str(&host_header);
    req.push_str("\r\n");
    req.push_str("Upgrade: websocket\r\n");
    req.push_str("Connection: Upgrade\r\n");
    req.push_str("Sec-WebSocket-Version: 13\r\n");
    req.push_str("Sec-WebSocket-Key: ");
    req.push_str(&client_key);
    req.push_str("\r\n");
    for (name, value) in identity_headers {
        if !matches!(*name, "Origin" | "User-Agent" | "Cookie")
            || value.bytes().any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
        {
            return Err(jserr_str("WS_BLOCKED: invalid handshake identity header"));
        }
        if !value.is_empty() {
            req.push_str(name);
            req.push_str(": ");
            req.push_str(value);
            req.push_str("\r\n");
        }
    }
    if !protocols.is_empty() {
        req.push_str("Sec-WebSocket-Protocol: ");
        req.push_str(&protocols.join(", "));
        req.push_str("\r\n");
    }
    req.push_str("\r\n");

    conn.write_all(req.as_bytes())
        .await
        .map_err(|e| jserr_str(format!("TARGET_HTTP_FAILED: ws-handshake-write: {e}")))?;

    // Read the response until we have a complete header block (\r\n\r\n).
    // Cap at 16 KiB so a wedged server can't keep us reading forever.
    let mut buf = Vec::with_capacity(1024);
    loop {
        let mut chunk = [0u8; 1024];
        let n = conn
            .read(&mut chunk)
            .await
            .map_err(|e| jserr_str(format!("TARGET_HTTP_FAILED: ws-handshake-read: {e}")))?;
        if n == 0 {
            return Err(jserr_str("TARGET_HTTP_FAILED: ws-handshake-eof"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(jserr_str("TARGET_HTTP_FAILED: ws-handshake-too-large"));
        }
    }

    let mut hdrs = [httparse::EMPTY_HEADER; 64];
    let mut resp = httparse::Response::new(&mut hdrs);
    let parsed = resp
        .parse(&buf)
        .map_err(|e| jserr_str(format!("TARGET_HTTP_FAILED: ws-handshake-parse: {e}")))?;
    if !parsed.is_complete() {
        return Err(jserr_str("TARGET_HTTP_FAILED: ws-handshake-incomplete"));
    }
    if resp.code != Some(101) {
        return Err(jserr_str(format!(
            "TARGET_HTTP_FAILED: ws-handshake-status: {}",
            resp.code.unwrap_or(0)
        )));
    }

    let mut got_upgrade = false;
    let mut got_connection = false;
    let mut got_accept = false;
    let mut negotiated_protocol = String::new();
    for h in resp.headers.iter() {
        let name = h.name;
        let value = std::str::from_utf8(h.value).unwrap_or("");
        if name.eq_ignore_ascii_case("upgrade") {
            if value.trim().eq_ignore_ascii_case("websocket") {
                got_upgrade = true;
            }
        } else if name.eq_ignore_ascii_case("connection") {
            if value
                .split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("upgrade"))
            {
                got_connection = true;
            }
        } else if name.eq_ignore_ascii_case("sec-websocket-accept") {
            if value.trim() == expected {
                got_accept = true;
            }
        } else if name.eq_ignore_ascii_case("sec-websocket-protocol") {
            negotiated_protocol = value.trim().to_string();
        }
    }
    if !got_upgrade || !got_connection || !got_accept {
        return Err(jserr_str("TARGET_HTTP_FAILED: ws-handshake-headers"));
    }
    // §4.2.2: the negotiated protocol MUST come from the client's offered
    // list. The SW also re-validates this; do it here as defense-in-depth.
    if !negotiated_protocol.is_empty()
        && !protocols.is_empty()
        && !protocols.iter().any(|p| p == &negotiated_protocol)
    {
        return Err(jserr_str("WS_BLOCKED: ws-protocol-not-offered"));
    }
    Ok(negotiated_protocol)
}

// ---------------------------------------------------------------------------
// Frame codec (RFC 6455 §5).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Opcode {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
}

impl Opcode {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x0 => Opcode::Continuation,
            0x1 => Opcode::Text,
            0x2 => Opcode::Binary,
            0x8 => Opcode::Close,
            0x9 => Opcode::Ping,
            0xA => Opcode::Pong,
            _ => return None,
        })
    }
    fn is_control(self) -> bool {
        matches!(self, Opcode::Close | Opcode::Ping | Opcode::Pong)
    }
}

/// Encode a single FIN=1 frame with client mask (§5.3). Caller passes the
/// already-resolved payload (no fragmentation). Returns the bytes ready
/// to `write_all` to the transport.
fn encode_frame(op: Opcode, payload: &[u8]) -> Result<Vec<u8>, String> {
    if op.is_control() && payload.len() > 125 {
        return Err("control frame payload exceeds 125 bytes".into());
    }
    let mut mask = [0u8; 4];
    getrandom::fill(&mut mask).map_err(|e| format!("getrandom mask: {e}"))?;
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | (op as u8)); // FIN=1, RSV=000, opcode
    let len = payload.len();
    if len < 126 {
        out.push(0x80 | (len as u8));
    } else if len <= 0xFFFF {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    let mask_start = out.len();
    out.extend_from_slice(payload);
    for (i, b) in out[mask_start..].iter_mut().enumerate() {
        *b ^= mask[i & 3];
    }
    Ok(out)
}

/// One decoded server→client frame. Server frames MUST NOT be masked
/// (§5.1); we enforce that and return an error if violated.
#[derive(Debug)]
struct Frame {
    fin: bool,
    op: Opcode,
    payload: Vec<u8>,
}

// ---------------------------------------------------------------------------
// JS-facing client.
// ---------------------------------------------------------------------------

/// Outbound work queue for the writer task. Strings, bytes, control frames,
/// and a close request flow through here so the writer is the single
/// authority for the transport's write side.
enum OutMsg {
    Text(String),
    Binary(Vec<u8>),
    Pong(Vec<u8>),
    Close(Vec<u8>),
}

struct WriterShared {
    queue: std::collections::VecDeque<OutMsg>,
    waker: Option<std::task::Waker>,
    closed_local: bool,
    peer_close: Option<(u16, String)>,
    /// Sum of pending payload bytes (queued but not yet handed to the
    /// transport). Matches the WHATWG WebSocket `bufferedAmount` semantics
    /// closely enough for backpressure heuristics.
    buffered: usize,
}

struct Shared {
    on_message: RefCell<Option<Function>>,
    on_close: RefCell<Option<Function>>,
    on_error: RefCell<Option<Function>>,
    writer: RefCell<WriterShared>,
    reader_abort: AbortHandle,
    writer_abort: AbortHandle,
    protocol: String,
    /// Set when the writer or reader has torn down the transport. Used by
    /// `send` to fast-fail without enqueuing.
    closed: RefCell<bool>,
    /// First close code/reason observed from the remote (or `1006` if the
    /// connection dropped abnormally). Reported to JS via `on_close`.
    close_code: RefCell<u16>,
    close_reason: RefCell<String>,
}

#[wasm_bindgen]
pub struct WsClient {
    shared: Rc<Shared>,
}

#[wasm_bindgen]
impl WsClient {
    /// Server-selected sub-protocol (`""` when none).
    #[wasm_bindgen(getter)]
    pub fn protocol(&self) -> String {
        self.shared.protocol.clone()
    }

    /// Bytes queued for transmission but not yet handed to the transport.
    #[wasm_bindgen(getter, js_name = bufferedAmount)]
    pub fn buffered_amount(&self) -> u32 {
        self.shared.writer.borrow().buffered as u32
    }

    /// Install message/close/error callbacks. The SW passes a single
    /// object literal `{message, close, error}`; we read each field via
    /// `Reflect::get` so missing fields are tolerated.
    #[wasm_bindgen(js_name = setHandlers)]
    pub fn set_handlers(&self, handlers: JsValue) -> Result<(), JsValue> {
        if handlers.is_undefined() || handlers.is_null() {
            return Err(JsValue::from_str("setHandlers: missing handlers object"));
        }
        let take = |key: &str| -> Option<Function> {
            Reflect::get(&handlers, &JsValue::from_str(key))
                .ok()
                .and_then(|v| v.dyn_into::<Function>().ok())
        };
        *self.shared.on_message.borrow_mut() = take("message");
        *self.shared.on_close.borrow_mut() = take("close");
        *self.shared.on_error.borrow_mut() = take("error");
        // A peer can finish before JS resumes after kernelStream's promise.
        if *self.shared.closed.borrow() {
            let code = *self.shared.close_code.borrow();
            let reason = self.shared.close_reason.borrow().clone();
            let cb_opt = self.shared.on_close.borrow().clone();
            if let Some(cb) = cb_opt {
                let _ = cb.call2(&JsValue::NULL, &JsValue::from(code as f64), &JsValue::from_str(&reason));
            }
        }
        Ok(())
    }

    /// Send a payload — string → Text frame, ArrayBuffer / Uint8Array →
    /// Binary frame. Other shapes are coerced via `toString()` to match
    /// the native `WebSocket.send` polymorphism.
    pub fn send(&self, data: JsValue) -> Result<(), JsValue> {
        if *self.shared.closed.borrow() {
            return Err(JsValue::from_str("WS_BLOCKED: send after close"));
        }
        let mut w = self.shared.writer.borrow_mut();
        if w.closed_local {
            return Err(JsValue::from_str("WS_BLOCKED: send after close"));
        }
        if let Some(s) = data.as_string() {
            w.buffered = w.buffered.saturating_add(s.len());
            w.queue.push_back(OutMsg::Text(s));
        } else if let Ok(arr) = data.clone().dyn_into::<js_sys::ArrayBuffer>() {
            let u8 = Uint8Array::new(&arr);
            let mut v = vec![0u8; u8.length() as usize];
            u8.copy_to(&mut v);
            w.buffered = w.buffered.saturating_add(v.len());
            w.queue.push_back(OutMsg::Binary(v));
        } else if let Ok(u8) = data.clone().dyn_into::<Uint8Array>() {
            let mut v = vec![0u8; u8.length() as usize];
            u8.copy_to(&mut v);
            w.buffered = w.buffered.saturating_add(v.len());
            w.queue.push_back(OutMsg::Binary(v));
        } else {
            return Err(JsValue::from_str("send: unsupported payload type"));
        }
        if let Some(waker) = w.waker.take() {
            waker.wake();
        }
        Ok(())
    }

    /// Initiate a close with optional code/reason. Native semantics: if
    /// code is omitted we send 1000; reason defaults to "". Subsequent
    /// `send` calls fail.
    pub fn close(&self, code: Option<u16>, reason: Option<String>) {
        if *self.shared.closed.borrow() {
            return;
        }
        let code = code.unwrap_or(1000);
        let reason = reason.unwrap_or_default();
        if (code != 1000 && !(3000..=4999).contains(&code)) || reason.len() > 123 {
            fail_connection(&self.shared, "invalid local close code or reason");
            return;
        }
        let mut w = self.shared.writer.borrow_mut();
        if w.closed_local {
            return;
        }
        w.closed_local = true;
        let mut payload = Vec::with_capacity(2 + reason.len());
        payload.extend_from_slice(&code.to_be_bytes());
        payload.extend_from_slice(reason.as_bytes());
        w.queue.push_back(OutMsg::Close(payload));
        if let Some(waker) = w.waker.take() {
            waker.wake();
        }
    }
}

/// Public entry point — opens the transport, performs the handshake,
/// spawns the reader/writer drivers, and returns the JS-facing client.
pub async fn open(url: &str, protocols: &[String], identity_headers: &[(&str, &str)]) -> Result<JsValue, JsValue> {
    let parsed = WsUrl::parse(url).map_err(jserr_str)?;
    let mut conn = open_target_stream(&parsed.host, parsed.port, parsed.secure).await?;
    let negotiated = handshake(&mut conn, &parsed, protocols, identity_headers).await?;

    let (reader_abort, reader_registration) = AbortHandle::new_pair();
    let (writer_abort, writer_registration) = AbortHandle::new_pair();
    let shared = Rc::new(Shared {
        on_message: RefCell::new(None),
        on_close: RefCell::new(None),
        on_error: RefCell::new(None),
        writer: RefCell::new(WriterShared {
            queue: std::collections::VecDeque::new(),
            waker: None,
            closed_local: false,
            peer_close: None,
            buffered: 0,
        }),
        reader_abort,
        writer_abort,
        protocol: negotiated,
        closed: RefCell::new(false),
        close_code: RefCell::new(1006),
        close_reason: RefCell::new(String::new()),
    });

    // Reader/writer share the same byte-stream. We split it into two
    // halves so each task can poll its end independently. `AsyncReadExt`
    // / `AsyncWriteExt` provide `.split()`.
    let (reader_half, writer_half) = futures_util::AsyncReadExt::split(conn);

    let reader_shared = shared.clone();
    spawn_local(async move {
        let _ = Abortable::new(reader_task(reader_half, reader_shared), reader_registration).await;
    });
    let writer_shared = shared.clone();
    spawn_local(async move {
        let _ = Abortable::new(writer_task(writer_half, writer_shared), writer_registration).await;
    });

    let client = WsClient { shared };
    Ok(JsValue::from(client))
}

async fn reader_task(
    mut conn: futures_util::io::ReadHalf<PooledConn>,
    shared: Rc<Shared>,
) {
    // Accumulator for fragmented data messages. Per §5.4 control frames
    // can interleave with fragments but never themselves fragment.
    let mut frag_op: Option<Opcode> = None;
    let mut frag_buf: Vec<u8> = Vec::new();

    loop {
        if *shared.closed.borrow() {
            return;
        }
        // Read one frame.
        let frame = match read_frame_split(&mut conn).await {
            Ok(f) => f,
            Err(_e) => {
                fail_connection(&shared, "WebSocket transport ended without a Close frame");
                return;
            }
        };
        match frame.op {
            Opcode::Continuation => {
                if frag_op.is_none() {
                    fail_connection(&shared, "continuation without start");
                    return;
                }
                frag_buf.extend_from_slice(&frame.payload);
                if frame.fin {
                    let op = frag_op.take().unwrap();
                    let payload = std::mem::take(&mut frag_buf);
                    deliver_message(&shared, op, payload);
                }
            }
            Opcode::Text | Opcode::Binary => {
                if frag_op.is_some() {
                    fail_connection(&shared, "new data frame mid-fragment");
                    return;
                }
                if frame.fin {
                    deliver_message(&shared, frame.op, frame.payload);
                } else {
                    frag_op = Some(frame.op);
                    frag_buf = frame.payload;
                }
            }
            Opcode::Ping => {
                // Reply with a Pong carrying the same payload.
                let mut w = shared.writer.borrow_mut();
                if !w.closed_local {
                    w.queue.push_back(OutMsg::Pong(frame.payload));
                    if let Some(waker) = w.waker.take() {
                        waker.wake();
                    }
                }
            }
            Opcode::Pong => {
                // We don't initiate pings yet; ignore.
            }
            Opcode::Close => {
                let (code, reason) = match decode_close_payload(&frame.payload) {
                    Ok(close) => close,
                    Err(error) => {
                        fail_connection(&shared, error);
                        return;
                    }
                };
                let mut w = shared.writer.borrow_mut();
                w.peer_close = Some((code, reason));
                // Do not send queued data after receiving Close. Preserve a
                // local Close already queued, or reply below if none exists.
                w.queue.retain(|msg| matches!(msg, OutMsg::Close(_)));
                w.buffered = 0;
                if !w.closed_local {
                    // A peer close ends data delivery; echo its exact payload,
                    // including the valid empty (no status code) form (§5.5.1).
                    w.closed_local = true;
                    w.queue.push_back(OutMsg::Close(frame.payload));
                }
                if let Some(waker) = w.waker.take() {
                    waker.wake();
                }
                return;
            }
        }
    }
}

/// Read one frame from a `ReadHalf` — wraps the unified codec.
async fn read_frame_split(
    conn: &mut futures_util::io::ReadHalf<PooledConn>,
) -> io::Result<Frame> {
    let mut header = [0u8; 2];
    conn.read_exact(&mut header).await?;
    let b0 = header[0];
    let b1 = header[1];
    let fin = (b0 & 0x80) != 0;
    let rsv = b0 & 0x70;
    if rsv != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("ws: RSV bits set (0x{rsv:x})"),
        ));
    }
    let op_byte = b0 & 0x0F;
    let op = Opcode::from_u8(op_byte).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("ws: unknown opcode 0x{op_byte:x}"),
        )
    })?;
    let masked = (b1 & 0x80) != 0;
    if masked {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ws: server frame is masked (§5.1 violation)",
        ));
    }
    let len_field = b1 & 0x7F;
    let payload_len: usize = match len_field {
        0..=125 => len_field as usize,
        126 => {
            let mut ext = [0u8; 2];
            conn.read_exact(&mut ext).await?;
            u16::from_be_bytes(ext) as usize
        }
        127 => {
            let mut ext = [0u8; 8];
            conn.read_exact(&mut ext).await?;
            let v = u64::from_be_bytes(ext);
            if v > 64 * 1024 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ws: frame payload > 64 MiB",
                ));
            }
            v as usize
        }
        _ => unreachable!(),
    };
    if op.is_control() {
        if !fin {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ws: control frame fragmented (FIN=0)",
            ));
        }
        if payload_len > 125 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ws: control payload > 125",
            ));
        }
    }
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        conn.read_exact(&mut payload).await?;
    }
    Ok(Frame { fin, op, payload })
}

async fn writer_task(
    mut conn: futures_util::io::WriteHalf<PooledConn>,
    shared: Rc<Shared>,
) {
    loop {
        // A local close stops sends, not reads: wait for the peer handshake.
        let msg_opt = WriterPoll {
            shared: shared.clone(),
        }
        .await;
        let msg = match msg_opt {
            Some(m) => m,
            None => {
                let peer_close = shared.writer.borrow_mut().peer_close.take();
                let _ = conn.close().await;
                if let Some((code, reason)) = peer_close {
                    surface_close(&shared, code, reason);
                }
                return;
            }
        };
        let (op, payload) = match msg {
            OutMsg::Text(s) => (Opcode::Text, s.into_bytes()),
            OutMsg::Binary(b) => (Opcode::Binary, b),
            OutMsg::Pong(b) => (Opcode::Pong, b),
            OutMsg::Close(payload) => (Opcode::Close, payload),
        };
        let encoded = match encode_frame(op, &payload) {
            Ok(b) => b,
            Err(e) => {
                fail_connection(&shared, &e);
                return;
            }
        };
        // Decrement buffered by the original payload size (not the
        // on-wire size which adds header + mask). Approximate matches the
        // WHATWG behavior — bufferedAmount drops by the API-side payload.
        {
            let mut w = shared.writer.borrow_mut();
            w.buffered = w.buffered.saturating_sub(payload.len());
        }
        if conn.write_all(&encoded).await.is_err() || conn.flush().await.is_err() {
            fail_connection(&shared, "WebSocket frame write failed");
            return;
        }
        // Do not send transport FIN after a Close: the relay would tear down
        // both directions before the peer can echo. WriterPoll waits for it.
    }
}

struct WriterPoll {
    shared: Rc<Shared>,
}

impl std::future::Future for WriterPoll {
    type Output = Option<OutMsg>;
    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        if *self.shared.closed.borrow() {
            return std::task::Poll::Ready(None);
        }
        let mut w = self.shared.writer.borrow_mut();
        if let Some(m) = w.queue.pop_front() {
            return std::task::Poll::Ready(Some(m));
        }
        if w.peer_close.is_some() {
            return std::task::Poll::Ready(None);
        }
        w.waker = Some(cx.waker().clone());
        std::task::Poll::Pending
    }
}

fn decode_close_payload(payload: &[u8]) -> Result<(u16, String), &'static str> {
    if payload.is_empty() {
        return Ok((1005, String::new()));
    }
    if payload.len() == 1 {
        return Err("malformed close payload");
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    if !matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999) {
        return Err("invalid close status code");
    }
    let reason = std::str::from_utf8(&payload[2..]).map_err(|_| "invalid close reason UTF-8")?;
    Ok((code, reason.to_owned()))
}

fn deliver_message(shared: &Rc<Shared>, op: Opcode, payload: Vec<u8>) {
    let cb_opt = shared.on_message.borrow().clone();
    let Some(cb) = cb_opt else { return };
    let arg = match op {
        Opcode::Text => match String::from_utf8(payload) {
            Ok(s) => JsValue::from_str(&s),
            Err(_) => {
                // §8.1: invalid UTF-8 fails the connection, not a clean close.
                fail_connection(shared, "invalid UTF-8 in text frame");
                return;
            }
        },
        Opcode::Binary => {
            let u8 = Uint8Array::new_with_length(payload.len() as u32);
            u8.copy_from(&payload);
            u8.buffer().into()
        }
        _ => return,
    };
    let _ = cb.call1(&JsValue::NULL, &arg);
}

fn fail_connection(shared: &Rc<Shared>, error: &str) {
    if *shared.closed.borrow() {
        return;
    }
    let cb_opt = shared.on_error.borrow().clone();
    if let Some(cb) = cb_opt {
        let _ = cb.call1(&JsValue::NULL, &JsValue::from_str(error));
    }
    surface_close(shared, 1006, String::new());
}

fn surface_close(shared: &Rc<Shared>, code: u16, reason: String) {
    {
        let mut closed = shared.closed.borrow_mut();
        if *closed {
            return;
        }
        *closed = true;
    }
    *shared.close_code.borrow_mut() = code;
    *shared.close_reason.borrow_mut() = reason.clone();
    // Stop either blocked driver, including a writer waiting on an empty
    // queue after peer EOF, so no task retains a transport half indefinitely.
    shared.reader_abort.abort();
    shared.writer_abort.abort();
    {
        let mut w = shared.writer.borrow_mut();
        w.queue.clear();
        w.buffered = 0;
        if let Some(waker) = w.waker.take() {
            waker.wake();
        }
    }
    let cb_opt = shared.on_close.borrow().clone();
    if let Some(cb) = cb_opt {
        let code_js = JsValue::from(code as f64);
        let reason_js = JsValue::from_str(&reason);
        let _ = cb.call2(&JsValue::NULL, &code_js, &reason_js);
    }
}

// ---------------------------------------------------------------------------
// Unit tests (host-side only — they don't need a browser / network).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_matches_rfc_example() {
        // RFC 6455 §1.3 example.
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        assert_eq!(expected_accept(key), want);
    }

    #[test]
    fn encode_frame_sets_fin_mask_and_xor_payload() {
        let frame = encode_frame(Opcode::Binary, b"hi").unwrap();
        // 2-byte header + 4-byte mask + 2-byte payload = 8 bytes total.
        assert_eq!(frame.len(), 8);
        assert_eq!(frame[0], 0x82); // FIN=1, opcode=2
        assert_eq!(frame[1] & 0x80, 0x80); // MASK=1
        assert_eq!(frame[1] & 0x7F, 2); // len=2
        // Unmask and confirm the payload round-trips.
        let mask = &frame[2..6];
        let mut payload = frame[6..8].to_vec();
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i & 3];
        }
        assert_eq!(payload, b"hi");
    }

    #[test]
    fn encode_frame_rejects_oversized_control_payload() {
        let big = vec![0u8; 126];
        assert!(encode_frame(Opcode::Ping, &big).is_err());
    }

    #[test]
    fn encode_frame_uses_16bit_extended_len_for_126_to_65535() {
        let payload = vec![b'x'; 200];
        let frame = encode_frame(Opcode::Text, &payload).unwrap();
        assert_eq!(frame[1] & 0x7F, 126);
        let ext = u16::from_be_bytes([frame[2], frame[3]]);
        assert_eq!(ext as usize, 200);
    }

    #[test]
    fn close_payload_round_trips_code_and_reason() {
        let (code, reason) = decode_close_payload(&[
            0x03, 0xE8, b'b', b'y', b'e',
        ]).unwrap();
        assert_eq!(code, 1000);
        assert_eq!(reason, "bye");
    }

    #[test]
    fn close_payload_empty_returns_1005() {
        let (code, reason) = decode_close_payload(&[]).unwrap();
        assert_eq!(code, 1005);
        assert_eq!(reason, "");
    }

    #[test]
    fn close_payload_single_byte_is_malformed() {
        assert!(decode_close_payload(&[0x03]).is_err());
    }

    // Note: `WsUrl::parse` calls `web_sys::Url::new` which requires a
    // browser runtime — covered by build verification and the SW E2E
    // path rather than host-side unit tests.
}
