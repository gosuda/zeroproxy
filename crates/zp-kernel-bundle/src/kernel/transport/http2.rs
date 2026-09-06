//! HTTP/2 client over a TLS-wrapped yamux stream.
//!
//! One `Http2Client` per origin. A single TLS connection (one handshake,
//! one yamux stream) carries every concurrent fetch to that origin via h2
//! stream multiplex — that's the entire reason h2 exists, and it's what
//! makes the TLS pool useful for parallel browser subresource fetches.
//! HTTP/1.1 pooling, in contrast, can only reuse a connection across
//! *sequential* requests; parallel fetches each pay a fresh handshake.
//!
//! ## Driver pattern
//!
//! [`h2::client::handshake`] returns `(SendRequest, Connection)`. The
//! `Connection` future must be polled to drive the protocol forward
//! (same shape as yamux). We `wasm_bindgen_futures::spawn_local` it so
//! it runs in the same JS event loop. When the connection ends (GoAway,
//! transport EOF, peer error) the driver future resolves and the
//! `SendRequest` clones start returning errors — we surface those and
//! [`crate::kernel::transport::pool`] evicts the origin entry.
//!
//! ## tokio ↔ futures bridge
//!
//! h2 requires `tokio::io::AsyncRead + AsyncWrite`. Our TLS stream sits
//! on `futures::io::AsyncRead + AsyncWrite`. [`tokio_util::compat`] does
//! the wrapping (zero-cost newtype + trait impls). Wasm32 builds of
//! `tokio` with `default-features = false` give us only the io traits +
//! macros — no socket I/O, no multi-thread runtime — which is exactly
//! what we need.

use std::io;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use bytes::Bytes;
use futures_util::io::{AsyncRead, AsyncWrite};
use futures_util::stream::LocalBoxStream;
use futures_util::StreamExt;
use futures_util::future::{AbortHandle, Abortable};
use h2::client::SendRequest;
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Uri};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use super::http1::HttpResponse;

/// Shared response contract for both HTTP versions. Executable resources and
/// non-streamable content codings are buffered; other bodies are pull-driven.
pub(crate) enum H2Response {
    Buffered(HttpResponse),
    Streaming(StreamingResponse),
}

/// A response whose body is decoded incrementally with consumer backpressure.
pub(crate) struct StreamingResponse {
    pub(crate) status: u16,
    pub(crate) reason: String,
    /// Content-Encoding / Content-Length already stripped (body is decoded
    /// plaintext of unknown length → chunked transfer to the page).
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) stream: web_sys::ReadableStream,
}

impl H2Response {
    /// HTTP status, regardless of buffered/streaming variant (for tracing).
    pub(crate) fn status(&self) -> u16 {
        match self {
            H2Response::Buffered(r) => r.status,
            H2Response::Streaming(s) => s.status,
        }
    }
}

/// Cloneable handle to an open HTTP/2 connection. Sending a request via
/// `SendRequest::ready().await` allocates a fresh stream on the existing
/// TLS+TCP connection — no new handshake, no new socket. The clone is
/// cheap (Arc<Mutex<...>> internally) so the pool can hand the same
/// `Http2Client` to every concurrent fetch on the origin.
#[derive(Clone)]
pub(crate) struct Http2Client {
    send: SendRequest<Bytes>,
}

impl Http2Client {
    /// Optimistic liveness check. h2 0.4 has no synchronous "is the
    /// connection still open?" probe — `SendRequest::poll_ready` needs a
    /// `Context`, which we can't synthesize at lookup time. Returning
    /// `true` here means we always hand out a clone; the next
    /// `send_request` surfaces any real failure, and the pool layer
    /// evicts and retries on the cold path.
    pub(crate) fn is_alive(&self) -> bool {
        true
    }
}

/// Wraps any `AsyncRead + AsyncWrite + Unpin` (our TLS stream) and runs
/// the h2 handshake. Spawns the connection driver task and returns an
/// `Http2Client` that can issue concurrent requests on the open
/// connection.
///
/// The Builder configures SETTINGS to match a real Chrome ClientPreface
/// — anti-bot WAFs (NAVER's nid.* family) profile the connection-opening
/// frames, and our defaults landed us in a slow lane that delayed every
/// first response by ~60s. The values below are the ones Chrome 134
/// stable sends today (validated against tls.peet.ws/api/all Akamai H2
/// fingerprint):
///
///   HEADER_TABLE_SIZE       = 65536       (matches Chrome)
///   ENABLE_PUSH             = 0           (Chrome explicitly off)
///   INITIAL_WINDOW_SIZE     = 6_291_456   (6 MiB; matches Chrome)
///   MAX_HEADER_LIST_SIZE    = 262144      (matches Chrome)
///   connection window       = 15_728_640  (target; produces a
///                                          WINDOW_UPDATE increment of
///                                          15_663_105 vs the h2 default
///                                          65535, which is exactly the
///                                          value Chrome 134 reports
///                                          to Akamai-fp)
///
/// Akamai H2 fingerprint check: with these values the second pipe-
/// separated field in `tls.peet.ws`'s response is `15663105`, matching
/// Chrome 134 stable. The pseudo-header order (last field; we emit
/// `m,s,a,p`, Chrome 134 emits `m,a,s,p`) is still a known diff —
/// fixing that would need a patch to the `h2` crate or raw HEADERS-frame
/// encoding.
///
/// MAX_FRAME_SIZE stays at the 16384 default — Chrome also sends 16384
/// so no override needed.
pub(crate) async fn handshake<S>(tls: S) -> io::Result<Http2Client>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    // h2 wants tokio io. Wrap once; the compat layer is a zero-cost
    // newtype that only re-implements the trait calls.
    let tokio_stream = tls.compat();
    let mut builder = h2::client::Builder::new();
    builder
        .header_table_size(65_536)
        .enable_push(false)
        .initial_window_size(6_291_456)
        // 15_728_640 = 15_663_105 + 65_535 (h2 default). h2 sends
        // `WINDOW_UPDATE = configured_size - default` so the on-wire
        // increment is 15_663_105 — Chrome 134's exact value.
        .initial_connection_window_size(15_728_640)
        .max_header_list_size(262_144);
    let (send, connection) = builder
        .handshake(tokio_stream)
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("h2: handshake: {e}")))?;
    spawn_local(async move {
        // The connection future drives ping/window/SETTINGS frames. When
        // it completes (clean GoAway or error) we just drop — the
        // `SendRequest` will start returning errors on the next call,
        // and the pool layer evicts.
        let _ = connection.await;
    });
    Ok(Http2Client { send })
}

/// Send one HTTP/2 request and hand off its response body. The client stays in
/// the pool; cancelling one body drops only that response's RecvStream.
pub(crate) async fn send_request(
    client: &Http2Client,
    method: &str,
    scheme: &str,
    host_header: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<H2Response> {
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("h2: method: {e}")))?;
    let uri: Uri = format!("{scheme}://{host_header}{path}")
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("h2: uri: {e}")))?;

    let is_head = method == Method::HEAD;
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .version(http::Version::HTTP_2)
        .body(())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("h2: request: {e}")))?;
    {
        let h = req.headers_mut();
        for (k, v) in headers {
            let kl = k.to_ascii_lowercase();
            // HTTP/2 forbids hop-by-hop / connection-control headers.
            // The h1 path already strips these; doing it again here is
            // defence in depth (and keeps the h2 layer independent).
            if matches!(
                kl.as_str(),
                "host"
                    | "connection"
                    | "keep-alive"
                    | "proxy-connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "te"
            ) {
                continue;
            }
            // h2 lowercases header names on the wire automatically; we
            // pass the caller's casing through and h2 normalises.
            let name = match HeaderName::from_bytes(k.as_bytes()) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let value = match HeaderValue::from_str(v) {
                Ok(v) => v,
                Err(_) => continue,
            };
            h.append(name, value);
        }
    }

    // `SendRequest::ready` waits until the connection has capacity for a
    // new stream (rare to block — h2 default MAX_CONCURRENT_STREAMS is
    // high). Cloning is cheap so we don't share `send` mutably.
    let sender = client.send.clone();
    let mut sender = sender
        .ready()
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, format!("h2: ready: {e}")))?;
    let end_of_stream = body.is_empty();
    let (response_fut, mut send_stream) = sender
        .send_request(req, end_of_stream)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("h2: send_request: {e}")))?;

    if !body.is_empty() {
        send_stream
            .send_data(Bytes::copy_from_slice(body), true)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("h2: send_data: {e}")))?;
    }

    let response = response_fut
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("h2: response: {e}")))?;
    let status = response.status().as_u16();
    let reason = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let resp_headers = headers_to_vec(response.headers());

    let null_body = is_head || zp_transport_codec::http1::no_body_status(status);
    let content_length = if null_body {
        None
    } else {
        zp_transport_codec::http1::header_content_length(&resp_headers)?
    };
    let chunks = futures_util::stream::try_unfold(
        (response.into_body(), 0u64),
        move |(mut body, received)| async move {
            match body.data().await {
                Some(Ok(chunk)) => {
                    let received = received.checked_add(chunk.len() as u64)
                        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "h2: body length overflow"))?;
                    if null_body && !chunk.is_empty()
                        || content_length.map(|n| received > n).unwrap_or(false)
                    {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "h2: unexpected body length"));
                    }
                    body.flow_control().release_capacity(chunk.len())
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
                    Ok(Some((chunk, (body, received))))
                }
                Some(Err(e)) => Err(io::Error::new(io::ErrorKind::Other, format!("h2: body: {e}"))),
                None => {
                    body.trailers().await
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
                    if content_length.map(|n| received != n).unwrap_or(false) {
                        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "h2: truncated response"));
                    }
                    Ok(None)
                }
            }
        },
    );
    finish_response(status, reason, resp_headers, null_body, Box::pin(chunks), Box::new(|| {})).await
}

/// IDs are carried only for HTML timing; non-HTML streams need no global entry.
static ZP_STREAM_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) fn next_stream_id() -> u64 {
    ZP_STREAM_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn record_stream_encoded(id: u64, encoded: usize) {
    let global = js_sys::global();
    let key = JsValue::from_str("__zpStreamEncoded");
    let map = match js_sys::Reflect::get(&global, &key) {
        Ok(v) if v.is_object() => v,
        _ => {
            let o = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&global, &key, &o);
            o.into()
        }
    };
    let _ = js_sys::Reflect::set(
        &map,
        &JsValue::from_str(&id.to_string()),
        &JsValue::from_f64(encoded as f64),
    );
}

pub(crate) async fn finish_response(
    status: u16,
    reason: String,
    mut headers: Vec<(String, String)>,
    null_body: bool,
    mut chunks: LocalBoxStream<'static, io::Result<Bytes>>,
    on_complete: Box<dyn FnOnce()>,
) -> io::Result<H2Response> {
    let null_body = null_body || zp_transport_codec::http1::is_null_body_status(status);
    let content_encoding = headers.iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-encoding"))
        .map(|(_, v)| v.as_str()).collect::<Vec<_>>().join(",");
    let content_type = headers.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let is_html = content_type == "text/html";
    let executable = content_type.contains("javascript") || content_type.contains("ecmascript")
        || content_type == "text/css";
    let coding = content_encoding.trim().to_ascii_lowercase();
    let streamable = matches!(coding.as_str(), "" | "identity" | "gzip" | "x-gzip" | "deflate");
    if null_body || executable || !streamable {
        let mut body = Vec::new();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            if null_body && !chunk.is_empty() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected null response body"));
            }
            if chunk.len() > super::decode::MAX_DECODED_BYTES.saturating_sub(body.len()) {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "buffered response exceeded cap"));
            }
            body.extend_from_slice(&chunk);
        }
        if !null_body {
            let encoded = body.len();
            body = super::decode::decode_body(&content_encoding, body)?;
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-encoding")
                && !k.eq_ignore_ascii_case("content-length") && !k.eq_ignore_ascii_case("transfer-encoding"));
            headers.push(("Content-Length".into(), body.len().to_string()));
            headers.push(("X-ZP-Encoded-Size".into(), encoded.to_string()));
        }
        on_complete();
        return Ok(H2Response::Buffered(HttpResponse { status, reason, headers, body, null_body }));
    }

    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-encoding")
        && !k.eq_ignore_ascii_case("content-length") && !k.eq_ignore_ascii_case("transfer-encoding"));
    let stream_id = is_html.then(next_stream_id);
    if let Some(id) = stream_id {
        headers.push(("X-ZP-Stream-Id".into(), id.to_string()));
    }
    let encoded = Rc::new(Cell::new(0usize));
    let count = encoded.clone();
    let raw_chunks = chunks.map(move |chunk| {
        let chunk = chunk.map_err(js_error)?;
        count.set(count.get().saturating_add(chunk.len()));
        Ok(js_sys::Uint8Array::from(&chunk[..]).into())
    });
    let complete: Box<dyn FnOnce()> = Box::new(move || {
        on_complete();
        if let Some(id) = stream_id {
            record_stream_encoded(id, encoded.get());
        }
    });
    let stream = if matches!(coding.as_str(), "" | "identity") {
        readable_stream(Box::pin(raw_chunks), complete)
    } else {
        // Native stream decoding validates gzip CRC/ISIZE and zlib trailers,
        // propagates cancellation, and bounds output with native backpressure.
        // br/zstd and stacked codings take the bounded Rust buffered path above.
        let raw = readable_stream(Box::pin(raw_chunks), Box::new(|| {})).map_err(stream_error)?;
        decode_readable_stream(raw, if coding == "x-gzip" { "gzip" } else { &coding }, complete)
    }.map_err(stream_error)?;
    Ok(H2Response::Streaming(StreamingResponse { status, reason, headers, stream }))
}

type JsChunks = LocalBoxStream<'static, Result<JsValue, JsValue>>;

/// A single outstanding pull owns the Rust stream. Abort drops even a parked
/// socket read immediately; default HWM=1 retains at most one emitted chunk.
fn readable_stream(chunks: JsChunks, on_complete: Box<dyn FnOnce()>) -> Result<web_sys::ReadableStream, JsValue> {
    let state = Rc::new(RefCell::new(Some((chunks, on_complete))));
    let active = Rc::new(RefCell::new(None::<AbortHandle>));
    let pull_state = state.clone();
    let pull_active = active.clone();
    let pull = Closure::<dyn FnMut(web_sys::ReadableStreamDefaultController) -> js_sys::Promise>::new(
        move |controller: web_sys::ReadableStreamDefaultController| {
            let pending = pull_state.borrow_mut().take();
            let state = pull_state.clone();
            let (abort, registration) = AbortHandle::new_pair();
            *pull_active.borrow_mut() = Some(abort);
            wasm_bindgen_futures::future_to_promise(async move {
                let work = async move {
                    if let Some((mut chunks, complete)) = pending {
                        match chunks.next().await {
                            Some(Ok(chunk)) => {
                                controller.enqueue_with_chunk(&chunk)?;
                                *state.borrow_mut() = Some((chunks, complete));
                            }
                            Some(Err(error)) => return Err(error),
                            None => {
                                complete();
                                controller.close()?;
                            }
                        }
                    }
                    Ok(JsValue::UNDEFINED)
                };
                match Abortable::new(work, registration).await {
                    Ok(result) => result,
                    Err(_) => Ok(JsValue::UNDEFINED),
                }
            })
        },
    );
    let cancel = Closure::<dyn FnMut(JsValue)>::new(move |_reason: JsValue| {
        if let Some(abort) = active.borrow_mut().take() {
            abort.abort();
        }
        state.borrow_mut().take();
    });
    let source = js_sys::Object::new();
    js_sys::Reflect::set(&source, &"pull".into(), &pull.into_js_value())?;
    js_sys::Reflect::set(&source, &"cancel".into(), &cancel.into_js_value())?;
    web_sys::ReadableStream::new_with_underlying_source(&source)
}

/// Keep the completion callback behind the decoder, not its encoded input EOF:
/// H1 pooling must wait for the decompression integrity check too.
fn decode_readable_stream(
    raw: web_sys::ReadableStream,
    coding: &str,
    on_complete: Box<dyn FnOnce()>,
) -> Result<web_sys::ReadableStream, JsValue> {
    let mut raw_guard = DecodedReader { value: raw.clone().into(), finished: false };
    let constructor: js_sys::Function = js_sys::Reflect::get(&js_sys::global(), &"DecompressionStream".into())?.dyn_into()?;
    let args = js_sys::Array::new();
    args.push(&JsValue::from_str(coding));
    let decoder = js_sys::Reflect::construct(&constructor, &args)?;
    let pipe: js_sys::Function = js_sys::Reflect::get(&raw, &"pipeThrough".into())?.dyn_into()?;
    let decoded = pipe.call1(&raw, &decoder)?;
    let get_reader: js_sys::Function = js_sys::Reflect::get(&decoded, &"getReader".into())?.dyn_into()?;
    let reader = DecodedReader { value: get_reader.call0(&decoded)?, finished: false };
    raw_guard.finished = true;
    let chunks = futures_util::stream::try_unfold(reader, |mut reader| async move {
        let read: js_sys::Function = js_sys::Reflect::get(&reader.value, &"read".into())?.dyn_into()?;
        let promise: js_sys::Promise = read.call0(&reader.value)?.dyn_into()?;
        let result = wasm_bindgen_futures::JsFuture::from(promise).await?;
        if js_sys::Reflect::get(&result, &"done".into())?.as_bool() == Some(true) {
            reader.finished = true;
            Ok(None)
        } else {
            let value = js_sys::Reflect::get(&result, &"value".into())?;
            Ok(Some((value, reader)))
        }
    });
    readable_stream(Box::pin(chunks), on_complete)
}

struct DecodedReader {
    value: JsValue,
    finished: bool,
}

impl Drop for DecodedReader {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(cancel) = js_sys::Reflect::get(&self.value, &"cancel".into()) {
                if let Some(cancel) = cancel.dyn_ref::<js_sys::Function>() {
                    if let Ok(promise) = cancel.call0(&self.value) {
                        if let Ok(promise) = promise.dyn_into::<js_sys::Promise>() {
                            spawn_local(async move { let _ = wasm_bindgen_futures::JsFuture::from(promise).await; });
                        }
                    }
                }
            }
        }
    }
}

fn js_error(error: io::Error) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn stream_error(error: JsValue) -> io::Error {
    io::Error::new(io::ErrorKind::Other, format!("response stream: {error:?}"))
}


fn headers_to_vec(map: &HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(map.len());
    for (k, v) in map.iter() {
        let name = k.as_str().to_string();
        // Header values are bytes; lossy-decode for our String API. The
        // wire-side stays exact — this only affects what JS sees, and
        // browsers do lossy decoding too.
        let value = String::from_utf8_lossy(v.as_bytes()).into_owned();
        out.push((name, value));
    }
    out
}
