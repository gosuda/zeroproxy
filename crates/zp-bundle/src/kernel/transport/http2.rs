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
use wasm_bindgen_futures::spawn_local;

use super::http1::HttpResponse;

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
) -> io::Result<HttpResponse> {
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

    let mut body_buf: Vec<u8> = Vec::new();
    let mut body_stream = response.into_body();
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
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        format!("h2: body: {e}"),
                    ));
                }
                break;
            }
            None => break,
        }
    }
    // h2 trailers — not used by browser fetch responses, but draining
    // keeps the protocol state consistent.
    let _ = body_stream.trailers().await;

    // Phase 5.12 (2026-06-03): Chrome-shape Accept-Encoding advertises
    // gzip / deflate / br / zstd; servers happily respond compressed.
    // Unwrap here so the SW returns plaintext bytes to the page realm
    // (target JS expects `response.text()` to decode HTML, not gzip
    // bytes). Strip the Content-Encoding header for the codings we
    // peeled — leaving it would mislead the browser into double-
    // decoding. If a coding fails or is unknown, `decode_body` returns
    // the residual codings so the header stays accurate.
    let (body_buf, resp_headers) = unwrap_response_body(resp_headers, body_buf);

    Ok(HttpResponse {
        status,
        reason,
        headers: resp_headers,
        body: body_buf,
    })
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
