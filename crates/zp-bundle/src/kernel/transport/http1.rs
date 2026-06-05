//! HTTP/1.1 client over any `AsyncRead + AsyncWrite` byte stream.
//!
//! ## Scope
//!
//! Just enough HTTP/1.1 to be a usable target client after the SOCKS5 (+ later
//! TLS) handshake. Specifically:
//!
//! * **Request side**: absolute-path origin form ("origin-form" of RFC 7230
//!   §5.3.1). Method, request-URI, `Host` header (added if the caller didn't
//!   pass it), arbitrary headers, optional body. `Content-Length` is added
//!   when a body is present and the caller didn't already set it. Chunked
//!   request bodies are not produced — every browser request that reaches
//!   this layer has a known body length by the time the SW captures it.
//! * **Response side**: parse status-line + headers with `httparse`, then
//!   read the body honouring `Transfer-Encoding: chunked` (RFC 7230 §4.1)
//!   or `Content-Length`; if neither is set, read to EOF ("close-delimited"
//!   bodies — required by HTTP/1.0 servers and CONNECT responses).
//!
//! ## Streaming
//!
//! This first cut buffers the whole response body into a `Vec<u8>`. The
//! WASM kernel currently exposes responses to JS through a `ReadableStream`
//! controller (see [`crate::kernel::build_streaming_response`]); once the
//! transport pipeline replaces `kernel_fetch`, this module will grow a
//! streaming variant that pushes chunks into the controller instead of
//! buffering. Buffering is fine for the SOCKS5+http:// landing milestone
//! (Step 3 in `transport::mod`'s landing plan).
//!
//! ## What this module deliberately does *not* do
//!
//! * No connection pooling / keep-alive. Every request opens a fresh SOCKS5
//!   stream. Pooling lands together with yamux (Step 6).
//! * No HTTP/2 — that's the `http2` module (Step 5) once `h2` is wired.
//! * No redirect follow — the higher layer (`kernel_fetch`) walks redirects
//!   itself so the cookie jar / virtual-URL state stays consistent.
//! * No request-body streaming. The SW already buffers the body up to
//!   `MAX_REQUEST_BODY_BYTES` (8 MiB) before calling the kernel.

use std::io;

use futures_util::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use zp_transport_codec::http1 as codec;

/// Maximum bytes we'll buffer for the response head (status line + headers).
/// Mirrors `codec::MAX_HEAD_BYTES` so the wasm wrapper and host codec are
/// bounded identically.
const MAX_HEAD_BYTES: usize = codec::MAX_HEAD_BYTES;

/// Maximum bytes we'll buffer for a single response body. The SW also
/// imposes its own limit on what it'll surface to the page, so this is a
/// defensive cap to keep WASM heap usage bounded.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Predicate: can this connection be reused for another HTTP/1.1
/// request after the response has been fully read?
///
/// RFC 7230 §6.3: HTTP/1.1 defaults to keep-alive unless
/// `Connection: close` is sent. We additionally refuse to reuse
/// connections whose response body was *close-delimited* (no
/// `Content-Length`, no `Transfer-Encoding: chunked`, not a no-body
/// status) — `read_body` had to drain to EOF on those, which means the
/// underlying yamux stream is already closed. Decision is delegated to
/// `codec::response_keepalive` so host tests pin the contract.
pub fn response_is_keepalive(resp: &HttpResponse) -> bool {
    codec::response_keepalive(resp.status, &resp.headers)
}

/// Parsed HTTP/1.1 response.
#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Send an HTTP/1.1 request on `stream` and parse the response.
///
/// `host_header` is what to put in the `Host:` header — for HTTPS this is
/// the server's hostname (no port unless non-standard), for HTTP/1.1 over
/// SOCKS5 to a plain origin it's the same. Caller can pre-include `Host`
/// in `headers` and we'll skip the auto-add.
///
/// `path` is the request-URI in origin-form, e.g. `"/foo?bar=1"`. Never
/// pass an absolute URL here — that's absolute-form, only valid to HTTP
/// proxies, and the relay-side proxy is below us (SOCKS5), not here.
pub async fn send_request<S>(
    stream: &mut S,
    method: &str,
    host_header: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<HttpResponse>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    write_request(stream, method, host_header, path, headers, body).await?;
    read_response(stream).await
}

/// Serialise + send the request head and body. The head bytes are built
/// by `codec::build_request_head` (host-tested); we just push them and
/// the body through the stream.
async fn write_request<S>(
    stream: &mut S,
    method: &str,
    host_header: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let head = codec::build_request_head(method, host_header, path, headers, body.len())?;
    stream.write_all(&head).await?;
    if !body.is_empty() {
        stream.write_all(body).await?;
    }
    stream.flush().await?;
    Ok(())
}

/// Read + parse the response head, then the body according to framing
/// headers.
async fn read_response<S>(stream: &mut S) -> io::Result<HttpResponse>
where
    S: AsyncRead + Unpin,
{
    let (head_bytes, body_prefix) = read_head(stream).await?;
    let (status, reason, headers, head_len) = parse_head(&head_bytes)?;
    // Anything after the head in our scratch buffer is the first bytes of
    // the body — feed it back into the body reader.
    let leftover = &head_bytes[head_len..];

    let body = read_body(stream, &headers, leftover, body_prefix).await?;
    // Phase 5.12 mirror of the h2 path: unwrap Content-Encoding so the
    // SW returns plaintext bytes. h1 responses on the modern web are
    // rare (TLS 1.3 + ALPN almost always lands on h2), but the
    // mid-handshake h1 fallback path still needs this for sites that
    // never get to h2.
    let (body, headers) = unwrap_response_body(headers, body);
    Ok(HttpResponse {
        status,
        reason,
        headers,
        body,
    })
}

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
    let decoded_len = decoded.len().to_string();
    let mut new_headers: Vec<(String, String)> = Vec::with_capacity(headers.len());
    let coding_changed = residual != ce_value.trim();
    for (i, (k, v)) in headers.into_iter().enumerate() {
        if Some(i) == ce_index {
            if residual.is_empty() {
                continue;
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

/// Read bytes until we see CRLFCRLF. Returns (head_bytes, _) — the second
/// element is currently always empty (a stylistic stub; future variants
/// may split the bytes earlier).
async fn read_head<S>(stream: &mut S) -> io::Result<(Vec<u8>, Vec<u8>)>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    loop {
        if buf.len() > MAX_HEAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "http1: response head exceeded limit",
            ));
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "http1: EOF before response head",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
        if find_crlf2(&buf).is_some() {
            return Ok((buf, Vec::new()));
        }
    }
}

/// Probe for the head-terminator CRLFCRLF.
fn find_crlf2(b: &[u8]) -> Option<usize> {
    codec::find_crlf2(b)
}

/// Parse status line + headers via the host-tested codec.
fn parse_head(buf: &[u8]) -> io::Result<(u16, String, Vec<(String, String)>, usize)> {
    let head = codec::parse_response_head(buf)?;
    Ok((head.status, head.reason, head.headers, head.head_len))
}

/// Decide body framing from headers and dispatch. RFC 7230 §3.3.3 ordering:
/// 1. `Transfer-Encoding` (if present and *terminal* coding is chunked,
///    body is chunked-framed)
/// 2. `Content-Length`
/// 3. Read to EOF (Connection: close)
///
/// `leftover` is bytes already read from the stream after the head that
/// belong to the body. `_unused_prefix` is reserved for future variants.
async fn read_body<S>(
    stream: &mut S,
    headers: &[(String, String)],
    leftover: &[u8],
    _unused_prefix: Vec<u8>,
) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    if header_terminal_chunked(headers) {
        let mut buf = leftover.to_vec();
        return read_chunked(stream, &mut buf).await;
    }
    if let Some(n) = header_content_length(headers)? {
        return read_fixed(stream, n, leftover).await;
    }
    // EOF-framed.
    read_to_eof(stream, leftover).await
}

fn header_terminal_chunked(headers: &[(String, String)]) -> bool {
    codec::header_terminal_chunked(headers)
}

fn header_content_length(headers: &[(String, String)]) -> io::Result<Option<u64>> {
    codec::header_content_length(headers)
}

async fn read_fixed<S>(stream: &mut S, n: u64, leftover: &[u8]) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    if n as usize > MAX_BODY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "http1: Content-Length exceeds body cap",
        ));
    }
    let n = n as usize;
    let mut out = Vec::with_capacity(n);
    out.extend_from_slice(&leftover[..leftover.len().min(n)]);
    if out.len() < n {
        let remaining = n - out.len();
        let start = out.len();
        out.resize(n, 0);
        stream
            .read_exact(&mut out[start..start + remaining])
            .await?;
    }
    Ok(out)
}

async fn read_to_eof<S>(stream: &mut S, leftover: &[u8]) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut out = leftover.to_vec();
    let mut tmp = [0u8; 8192];
    loop {
        if out.len() > MAX_BODY_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "http1: EOF-delimited body exceeded cap",
            ));
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&tmp[..n]);
    }
}

/// Chunked transfer decoder. RFC 7230 §4.1.
///
/// `prefix` is bytes already read after the head that may contain the
/// first chunk-size line and beyond. We append to `prefix` and consume
/// from the front; needing more data falls through to a `stream.read()`.
async fn read_chunked<S>(stream: &mut S, prefix: &mut Vec<u8>) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut out = Vec::new();
    let mut tmp = [0u8; 8192];

    loop {
        // Read chunk-size line (hex digits, optionally followed by ";ext").
        // EOF here just means the upstream closed between chunks — common when
        // a WAF rate-limits and slams the socket after the body; surface what
        // we already buffered instead of dropping the whole response.
        let size_line = match read_line(stream, prefix, &mut tmp).await {
            Ok(line) => line,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(out),
            Err(e) => return Err(e),
        };
        let size_hex = match size_line.split(';').next() {
            Some(s) => s.trim(),
            None => "",
        };
        if size_hex.is_empty() || !size_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("http1: invalid chunk-size line {size_line:?}"),
            ));
        }
        let chunk_size = u64::from_str_radix(size_hex, 16).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("http1: chunk size: {e}"),
            )
        })?;
        if chunk_size == 0 {
            // Trailers (and one final CRLF) follow. Consume until CRLFCRLF
            // OR a bare CRLF if no trailers were sent. EOF here is benign:
            // the trailer CRLF was the last byte the upstream owed us.
            match consume_trailers(stream, prefix, &mut tmp).await {
                Ok(()) | Err(_) => {}
            }
            return Ok(out);
        }
        if out.len() as u64 + chunk_size > MAX_BODY_BYTES as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "http1: chunked body exceeded cap",
            ));
        }
        let want = chunk_size as usize;
        // Mid-chunk EOF: same WAF-cut-the-socket pattern. Return the partial
        // body we have. A page rendered from the partial bytes is strictly
        // better than the empty-error-page outcome.
        match read_into(stream, prefix, &mut tmp, want, &mut out).await {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(out),
            Err(e) => return Err(e),
        }
        // Each chunk is terminated by CRLF; consume it. Same tolerance: EOF
        // here means the trailing CRLF was lost to the close, not a parser
        // error worth propagating.
        match read_exact_n(stream, prefix, &mut tmp, 2).await {
            Ok(crlf) => {
                if &crlf[..] != b"\r\n" {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "http1: missing CRLF after chunk data",
                    ));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(out),
            Err(e) => return Err(e),
        }
    }
}

/// Read one CRLF-terminated line from (prefix + stream). The terminating
/// CRLF is consumed and not returned.
async fn read_line<S>(stream: &mut S, prefix: &mut Vec<u8>, tmp: &mut [u8]) -> io::Result<String>
where
    S: AsyncRead + Unpin,
{
    loop {
        if let Some(pos) = prefix.windows(2).position(|w| w == b"\r\n") {
            let line: Vec<u8> = prefix.drain(..pos + 2).collect();
            // line includes CRLF; strip.
            return Ok(String::from_utf8_lossy(&line[..line.len() - 2]).into_owned());
        }
        if prefix.len() > MAX_HEAD_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "http1: chunk-line too long",
            ));
        }
        let n = stream.read(tmp).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "http1: EOF while reading line",
            ));
        }
        prefix.extend_from_slice(&tmp[..n]);
    }
}

/// Read exactly `want` bytes from (prefix + stream) and append to `out`.
async fn read_into<S>(
    stream: &mut S,
    prefix: &mut Vec<u8>,
    tmp: &mut [u8],
    want: usize,
    out: &mut Vec<u8>,
) -> io::Result<()>
where
    S: AsyncRead + Unpin,
{
    let mut left = want;
    if !prefix.is_empty() {
        let take = prefix.len().min(left);
        out.extend_from_slice(&prefix[..take]);
        prefix.drain(..take);
        left -= take;
    }
    while left > 0 {
        let bound = left.min(tmp.len());
        let n = stream.read(&mut tmp[..bound]).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "http1: EOF mid-chunk",
            ));
        }
        out.extend_from_slice(&tmp[..n]);
        left -= n;
    }
    Ok(())
}

/// Read exactly `n` bytes from (prefix + stream) and return them.
async fn read_exact_n<S>(
    stream: &mut S,
    prefix: &mut Vec<u8>,
    tmp: &mut [u8],
    n: usize,
) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut out = Vec::with_capacity(n);
    read_into(stream, prefix, tmp, n, &mut out).await?;
    Ok(out)
}

/// Consume optional trailers + the final CRLF that ends a chunked body.
async fn consume_trailers<S>(stream: &mut S, prefix: &mut Vec<u8>, tmp: &mut [u8]) -> io::Result<()>
where
    S: AsyncRead + Unpin,
{
    loop {
        let line = read_line(stream, prefix, tmp).await?;
        if line.is_empty() {
            return Ok(());
        }
        // Non-empty line → trailer; loop until blank line.
    }
}

// Host-side tests for the byte-layout invariants live in
// `crates/zp-transport-codec/src/http1.rs` (request-line shape, header
// auto-add, CRLF injection rejection, response-head parse, chunked /
// Content-Length / EOF framing decisions, keep-alive predicate). The
// async behaviours that remain in this module (chunked decoder
// loop-tolerance, body cap, trailer drain) are exercised end-to-end
// when the kernel makes a real upstream fetch — there's no
// out-of-process server to mock against in `cargo test` because the
// parent `kernel` module is `cfg(target_arch = "wasm32")`.
