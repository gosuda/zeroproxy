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

use bytes::Bytes;
use futures_util::io::{AsyncRead, AsyncWrite};
use h2::client::SendRequest;
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Uri};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use super::http1::HttpResponse;

/// Result of [`send_request`]. Most responses are fully buffered + decoded
/// (`Buffered`); HTML documents take the streaming arm (`Streaming`) so the
/// page can render progressively instead of waiting on a withheld END_STREAM.
pub(crate) enum H2Response {
    Buffered(HttpResponse),
    Streaming(StreamingResponse),
}

/// A streaming HTML response: headers are fully known after the HEADERS frame;
/// the body is a `ReadableStream` of already-gunzipped plaintext driven by an
/// async pump over the h2 `RecvStream`. NO timer, NO whole-body buffering.
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

/// Send one HTTP/2 request and read the full response. The `Http2Client`
/// stays in the pool — multiple concurrent calls share it.
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

    // Content-Length lets us finish the moment the declared body has fully
    // arrived, WITHOUT waiting for the peer's END_STREAM frame. This is the
    // fix for the NAVER cold-bootstrap "exactly 60s" stall: relay byte-trace
    // proved www.naver.com delivers the entire compressed body in ~167ms but
    // then withholds the stream-closing frame for its full 60s idle timeout.
    // `body_stream.data()` only yields `None` on END_STREAM, so without this
    // short-circuit we block 60s on a response whose body is already
    // complete. Browsers and curl finish at Content-Length too — that's why
    // they're fast. Content-Length is the on-wire (still-encoded) length, so
    // it's compared against the raw `body_buf` before any gzip/br unwrap.
    let content_length: Option<usize> = resp_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok());

    // Completion for responses WITHOUT a Content-Length. Most naver.com /
    // pstatic.net responses carry NO Content-Length and the edge withholds the
    // h2 END_STREAM frame for 60–240s *after* the body has arrived; blocking on
    // `data()` until END_STREAM delays every such response by minutes and piles
    // up open streams that starve the shared yamux session. Since these bodies
    // are compressed (gzip/br), we finish the instant the codec's DEFLATE
    // stream reaches its final block — a pure read-side check, NO timers.
    //
    // ⚠️ Do NOT add a setTimeout-based idle race here. Two attempts proved it
    // traps the wasm (`RuntimeError: unreachable`) in real Chrome under load —
    // the timer-wake re-polls a task whose `data()` future was just cancelled
    // by the race and panics. SW setTimeout is also unreliable (throttled when
    // the worker has no actively-interacting client). The remaining cost is the
    // main DOCUMENT, whose final DEFLATE block NAVER withholds until END_STREAM
    // (~60s); fixing that needs a streaming/progressive render, not a timer.
    let content_encoding: Option<String> = resp_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-encoding"))
        .map(|(_, v)| v.clone());
    let detect_decode_end = content_length.is_none()
        && content_encoding
            .as_deref()
            .map(|ce| !ce.trim().is_empty() && !ce.trim().eq_ignore_ascii_case("identity"))
            .unwrap_or(false);

    // Streaming arm — ONLY the main HTML document. A 2xx `text/html` body with
    // a streamable coding (gzip or identity) is handed to the page as a
    // `ReadableStream` of decoded plaintext so it renders progressively, exactly
    // like a browser. NAVER withholds the document's final DEFLATE block +
    // END_STREAM for ~60s; buffering (the else arm) blocks the whole page on it,
    // while streaming shows the early content in ~1s. Scripts/CSS/images stay
    // buffered (they finish fast via decode-end and the script rewrite-cache
    // needs the full source). NO timer is used — the pump simply `await`s
    // `data()`; a withheld tail just parks the async task with the page already
    // painted (see trap-notebook 2026-06-16: timers trap the wasm).
    let is_html = resp_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.trim_start().to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);
    let ce_lower = content_encoding
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let coding_streamable =
        ce_lower.is_empty() || ce_lower == "identity" || ce_lower == "gzip" || ce_lower == "x-gzip";
    if (200..300).contains(&status) && is_html && coding_streamable {
        // Plaintext after the kernel-side gunzip → drop the now-false
        // Content-Encoding and the now-unknown Content-Length.
        let mut stream_headers: Vec<(String, String)> = resp_headers
            .into_iter()
            .filter(|(k, _)| {
                let lk = k.to_ascii_lowercase();
                lk != "content-encoding" && lk != "content-length"
            })
            .collect();
        // ★2026-08-23 — 서브리소스는 전부 압축된 것으로 보이는데 **문서만
        // 비압축**이면 그 하나로 드러난다. 상류가 길이를 알려 준 경우에만
        // 실는다 — 지어내지 않는다.
        //
        // ⚠ 이걸로 **문서가 닫히지는 않는다**(실측 2026-08-23):
        // 스트리밍 대상 오리진은 대개 Content-Length 를 안 보낸다
        // (github.com 문서: content-encoding: gzip 은 있고 content-length 는 없다).
        // 진짜 수는 스트림을 끝까지 읽어야 알 수 있고, 그때는 **헤더가
        // 이미 나간 뒤**다. 닫으려면 커널이 인코딩 바이트를 세서
        // 스트림 종료 시점에 SW 로 올려 보내야 한다 — 별건이고, 지문
        // 탐지기에 known open item 으로 박아 둔다.
        if let Some(cl) = content_length {
            if !ce_lower.is_empty() && ce_lower != "identity" {
                stream_headers.push(("X-ZP-Encoded-Size".to_string(), cl.to_string()));
            }
        }
        let body_stream = response.into_body();
        let stream = build_body_readable_stream(
            body_stream,
            content_encoding.clone(),
            host_header.to_string(),
        )
        .map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("h2: readable stream: {e:?}"))
        })?;
        crate::kernel::push_trace(&format!(
            "tx:h2-stream-start host={} status={} ce={}",
            host_header,
            status,
            if ce_lower.is_empty() { "identity" } else { &ce_lower }
        ));
        return Ok(H2Response::Streaming(StreamingResponse {
            status,
            reason,
            headers: stream_headers,
            stream,
        }));
    }

    let mut body_buf: Vec<u8> = Vec::new();
    let mut body_stream = response.into_body();
    let mut end_stream = false;
    loop {
        match body_stream.data().await {
            Some(Ok(chunk)) => {
                let len = chunk.len();
                body_buf.extend_from_slice(&chunk);
                // Release flow-control credit on the LIVE stream — not a clone.
                // `flow_control()` returns `&mut FlowControl`; cloning would
                // detach the released capacity from the underlying stream
                // accounting and the server would stall after the first window
                // (default 65 KiB). The cost of getting this wrong is a 60s
                // upstream idle timeout per request.
                let _ = body_stream.flow_control().release_capacity(len);
                // Body complete per Content-Length → return now instead of
                // awaiting END_STREAM. The un-ended stream is dropped/reset on
                // return, which is fine: the peer sees RST_STREAM and the
                // pooled connection survives.
                if let Some(cl) = content_length {
                    if body_buf.len() >= cl {
                        crate::kernel::push_trace(&format!(
                            "tx:h2-body-cl-complete host={} len={} cl={}",
                            host_header,
                            body_buf.len(),
                            cl
                        ));
                        break;
                    }
                } else if detect_decode_end {
                    // Compressed body with no Content-Length: stop when the
                    // codec's end marker validates (the withheld END_STREAM is
                    // just an empty trailing frame we don't need to wait for).
                    if let Some(ce) = content_encoding.as_deref() {
                        if crate::kernel::transport::decode::body_is_complete(ce, &body_buf) {
                            crate::kernel::push_trace(&format!(
                                "tx:h2-body-decode-end host={} len={} ce={}",
                                host_header,
                                body_buf.len(),
                                ce.trim()
                            ));
                            break;
                        }
                    }
                }
            }
            Some(Err(e)) => {
                // Phase 5.8: tolerate stream-level errors mid-body. The
                // common case is `h2: body: bytes remaining on stream`
                // from github.com / Cloudflare (server closes the stream
                // while declaring more bytes via content-length). Real
                // browsers show the partial body and surface a non-fatal
                // network warning; we mirror that by returning what we
                // have and pushing the error to the trace ring.
                //
                // If we got ZERO bytes the error is fatal — the upstream
                // never started a real response, propagate as before.
                crate::kernel::push_trace(&format!(
                    "tx:h2-body-trunc bytes={} err={}",
                    body_buf.len(),
                    e
                ));
                if body_buf.is_empty() {
                    return Err(io::Error::new(io::ErrorKind::Other, format!("h2: body: {e}")));
                }
                break;
            }
            None => {
                end_stream = true;
                break;
            }
        }
    }
    // Drain trailers ONLY when END_STREAM was actually received. After a
    // Content-Length or idle short-circuit the stream is still open, so
    // `trailers().await` would block for the peer's full END_STREAM idle
    // timeout (~60s) — re-introducing the very stall we just eliminated.
    if end_stream {
        let _ = body_stream.trailers().await;
    }

    // Phase 5.12 (2026-06-03): Chrome-shape Accept-Encoding advertises
    // gzip / deflate / br / zstd; servers happily respond compressed.
    // Unwrap here so the SW returns plaintext bytes to the page realm
    // (target JS expects `response.text()` to decode HTML, not gzip
    // bytes). Strip the Content-Encoding header for the codings we
    // peeled — leaving it would mislead the browser into double-
    // decoding. If a coding fails or is unknown, `decode_body` returns
    // the residual codings so the header stays accurate.
    let (body_buf, resp_headers) = unwrap_response_body(resp_headers, body_buf);

    Ok(H2Response::Buffered(HttpResponse {
        status,
        reason,
        headers: resp_headers,
        body: body_buf,
    }))
}

/// Build a `ReadableStream` whose body is the h2 response stream, gunzipped
/// incrementally. The ReadableStream constructor invokes our `start` callback
/// synchronously with the controller; we `spawn_local` the async pump there.
/// The pump owns the `RecvStream`, so dropping the stream (page cancels) tears
/// down the upstream stream cleanly.
fn build_body_readable_stream(
    body_stream: h2::RecvStream,
    content_encoding: Option<String>,
    host: String,
) -> Result<web_sys::ReadableStream, JsValue> {
    let source = js_sys::Object::new();
    // `once_into_js` yields a JS function callable exactly once — which is the
    // ReadableStream `start` contract. It also owns/leaks the closure for us.
    let start = Closure::once_into_js(
        move |controller: web_sys::ReadableStreamDefaultController| {
            spawn_local(pump_body(body_stream, controller, content_encoding, host));
        },
    );
    js_sys::Reflect::set(&source, &JsValue::from_str("start"), &start)?;
    web_sys::ReadableStream::new_with_underlying_source(&source)
}

/// Async pump: read h2 body chunks, release flow-control credit, gunzip
/// incrementally, and enqueue decoded plaintext into the stream controller.
/// Closes the controller on END_STREAM or stream error. NO timer.
async fn pump_body(
    mut body_stream: h2::RecvStream,
    controller: web_sys::ReadableStreamDefaultController,
    content_encoding: Option<String>,
    host: String,
) {
    let is_gzip = content_encoding
        .as_deref()
        .map(|c| {
            let t = c.trim().to_ascii_lowercase();
            t == "gzip" || t == "x-gzip"
        })
        .unwrap_or(false);
    let mut gunzip = if is_gzip {
        Some(crate::kernel::transport::decode::StreamingGunzip::new())
    } else {
        None
    };
    let mut total_in = 0usize;
    let mut total_out = 0usize;
    loop {
        match body_stream.data().await {
            Some(Ok(chunk)) => {
                let len = chunk.len();
                total_in += len;
                // Release credit on the LIVE stream (not a clone) — see the
                // buffered loop's note; getting this wrong stalls after one
                // window.
                let _ = body_stream.flow_control().release_capacity(len);
                let decoded: Vec<u8> = match gunzip.as_mut() {
                    Some(g) => g.push(&chunk),
                    None => chunk.to_vec(),
                };
                if !decoded.is_empty() {
                    total_out += decoded.len();
                    let arr = js_sys::Uint8Array::new_with_length(decoded.len() as u32);
                    arr.copy_from(&decoded);
                    if controller.enqueue_with_chunk(&arr).is_err() {
                        // Consumer cancelled the stream — stop pumping; dropping
                        // `body_stream` RSTs the upstream stream.
                        crate::kernel::push_trace(&format!(
                            "tx:h2-stream-cancel host={} in={} out={}",
                            host, total_in, total_out
                        ));
                        return;
                    }
                }
                // Decoded body complete at the gzip DEFLATE final block — close
                // the page-facing stream NOW instead of parking on the withheld
                // END_STREAM. NAVER delivers the whole compressed body fast but
                // holds the stream-closing frame 60–240s (anti-idle); waiting for
                // it pins the browser's document in readyState=loading that long,
                // so `defer` scripts (main.js hydration) don't run until then —
                // the "search box only for 60s" symptom. A real browser decodes
                // gzip itself and finishes at StreamEnd, never waiting; we mirror
                // that. This is the streaming analog of the buffered arm's
                // `body_is_complete` short-circuit, and unlike the reverted
                // `</body></html>`-in-plaintext probe it keys on the codec's own
                // end marker (reliable, no timer, no truncation). Dropping
                // `body_stream` on return RSTs the upstream stream; the pooled
                // connection survives.
                // A gunzip error means no further bytes can ever be produced.
                // Surface it instead of looping on `data()` forever (a silent
                // hang), and NEVER treat it as completion — closing here would
                // ship a truncated document.
                if gunzip.as_ref().map(|g| g.is_error()).unwrap_or(false) {
                    crate::kernel::push_trace(&format!(
                        "tx:h2-stream-inflate-err host={} in={} out={}",
                        host, total_in, total_out
                    ));
                    controller.error_with_e(&JsValue::from_str("gzip: decode failed mid-stream"));
                    return;
                }
                if gunzip.as_ref().map(|g| g.is_stream_end()).unwrap_or(false) {
                    crate::kernel::push_trace(&format!(
                        "tx:h2-stream-deflate-end host={} in={} out={}",
                        host, total_in, total_out
                    ));
                    let _ = controller.close();
                    return;
                }
            }
            Some(Err(e)) => {
                crate::kernel::push_trace(&format!(
                    "tx:h2-stream-err host={} in={} out={} err={}",
                    host, total_in, total_out, e
                ));
                // Surface as a stream error so the page sees a network failure
                // rather than a silently-truncated document.
                controller.error_with_e(&JsValue::from_str(&format!("h2 stream: {e}")));
                return;
            }
            None => break, // END_STREAM
        }
    }
    crate::kernel::push_trace(&format!(
        "tx:h2-stream-close host={} in={} out={}",
        host, total_in, total_out
    ));
    let _ = controller.close();
}

/// Pull the `Content-Encoding` header out of the response header list,
/// pipe the body through the matching decoders, and write back a
/// residual `Content-Encoding` only if some codings were not peeled.
/// Header lookup is case-insensitive; the original casing is preserved
/// on any header we kept.
fn unwrap_response_body(
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> (Vec<u8>, Vec<(String, String)>) {
    let mut ce_value: Option<String> = None;
    let mut ce_index: Option<usize> = None;
    let mut cl_index: Option<usize> = None;
    for (i, (k, v)) in headers.iter().enumerate() {
        let lower = k.to_ascii_lowercase();
        if lower == "content-encoding" {
            ce_value = Some(v.clone());
            ce_index = Some(i);
        } else if lower == "content-length" {
            cl_index = Some(i);
        }
    }
    let Some(ce_value) = ce_value else {
        return (body, headers);
    };
    // ★2026-08-23 — 디코드 직전의 **와이어 바이트 수**를 붙잡아 둔다.
    // 이걸 안 넘기면 페이지의 `encodedBodySize` 가 항상 decoded 와 같아져
    // **모든 응답이 비압축처럼 보인다**(실측: github 대조군 118/135 압축,
    // 프록시 0/200). 진짜 압축 크기를 아는 자리는 여기뿐이다.
    let encoded_len = body.len();
    let (decoded, residual) = crate::kernel::transport::decode::decode_body(&ce_value, body);
    // Rebuild header list. The order is preserved except the
    // Content-Encoding entry which we rewrite (or drop) and the
    // Content-Length entry which we rewrite to match the decoded length
    // when we actually decoded something (browsers reject mismatched
    // content-length with the wrong body length).
    let decoded_len = decoded.len().to_string();
    let mut new_headers: Vec<(String, String)> = Vec::with_capacity(headers.len());
    let coding_changed = residual != ce_value.trim();
    for (i, (k, v)) in headers.into_iter().enumerate() {
        if Some(i) == ce_index {
            if residual.is_empty() {
                continue; // drop entirely — everything peeled
            }
            new_headers.push((k, residual.clone()));
        } else if Some(i) == cl_index && coding_changed {
            new_headers.push((k, decoded_len.clone()));
        } else {
            new_headers.push((k, v));
        }
    }
    if coding_changed {
        // SW 가 읽고 **브라우저에 넘기기 전에 지운다** — 이건 내부 신호다.
        new_headers.push(("X-ZP-Encoded-Size".to_string(), encoded_len.to_string()));
    }
    (decoded, new_headers)
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
