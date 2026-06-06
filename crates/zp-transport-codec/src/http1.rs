//! Pure-byte HTTP/1.1 codec helpers (RFC 9112).
//!
//! Scope: serialise the request head (method + path + headers + body
//! framing), parse the response head with `httparse`, and decide body
//! framing (chunked terminal coding / Content-Length / EOF). The async
//! wrapper in `zp-bundle/src/kernel/transport/http1.rs` calls these
//! helpers and drives the underlying byte stream.

use std::io;
use std::str;

/// Maximum response head (status line + headers) we accept before
/// failing closed. Matches the wasm wrapper's cap. Sized above any
/// realistic upstream and below "kernel heap-exhaustion lever".
pub const MAX_HEAD_BYTES: usize = 64 * 1024;

/// Hard cap on the parsed header count, used as the `httparse::Header`
/// slice length on the wasm wrapper side too.
pub const MAX_HEADERS: usize = 128;

/// Parsed status line + headers + offset of the body in the head buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    /// HTTP status code (e.g. 200).
    pub status: u16,
    /// Reason phrase (may be empty if the upstream omitted it).
    pub reason: String,
    /// Headers in declaration order. Duplicate names are preserved.
    pub headers: Vec<(String, String)>,
    /// Offset into the input buffer where the body starts (== head length).
    pub head_len: usize,
}

// --- Request side ---------------------------------------------------------

/// Build the HTTP/1.1 request head as bytes: request line + headers +
/// terminating CRLF. The body is **not** appended — the wasm wrapper
/// writes it separately to support streaming and large uploads.
///
/// `host_header` is what we set as `Host:` if the caller didn't already
/// pass one. `path` is origin-form (e.g. `"/foo?bar=1"`); absolute-form
/// is rejected because the relay below us is SOCKS5, not an HTTP proxy.
///
/// Auto-inserted headers (when not present in `headers`):
/// * `Host:` — required (RFC 9112 §3.2.2). Errors if `host_header` is
///   empty.
/// * `Content-Length:` — added when `body_len > 0` and the caller did
///   not set either `Content-Length` or `Transfer-Encoding`.
/// * `Connection: keep-alive` — added when the caller did not set
///   `Connection`. We intentionally never force `close` because every
///   modern browser keeps the connection alive and WAFs treat
///   `Connection: close` on a fresh HTTPS connection as a bot signal.
pub fn build_request_head(
    method: &str,
    host_header: &str,
    path: &str,
    headers: &[(String, String)],
    body_len: usize,
) -> io::Result<Vec<u8>> {
    if !is_token(method) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "http1: method contains invalid token bytes",
        ));
    }
    if path.is_empty()
        || path
            .as_bytes()
            .iter()
            .any(|&b| b == b' ' || b == b'\r' || b == b'\n')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "http1: request-URI must be non-empty and whitespace-free",
        ));
    }

    let mut buf = Vec::with_capacity(256);
    // Request line.
    buf.extend_from_slice(method.as_bytes());
    buf.push(b' ');
    buf.extend_from_slice(path.as_bytes());
    buf.extend_from_slice(b" HTTP/1.1\r\n");

    let mut have_host = false;
    let mut have_content_length = false;
    let mut have_connection = false;
    let mut have_transfer_encoding = false;
    for (k, v) in headers {
        if !is_token(k) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("http1: header name {k:?} is not a valid HTTP token"),
            ));
        }
        if v.as_bytes().iter().any(|&b| b == b'\r' || b == b'\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("http1: header value for {k:?} contains CR/LF"),
            ));
        }
        let kl = k.to_ascii_lowercase();
        match kl.as_str() {
            "host" => have_host = true,
            "content-length" => have_content_length = true,
            "connection" => have_connection = true,
            "transfer-encoding" => have_transfer_encoding = true,
            _ => {}
        }
        buf.extend_from_slice(k.as_bytes());
        buf.extend_from_slice(b": ");
        buf.extend_from_slice(v.as_bytes());
        buf.extend_from_slice(b"\r\n");
    }
    if !have_host {
        if host_header.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "http1: Host header missing and no host provided",
            ));
        }
        buf.extend_from_slice(b"Host: ");
        buf.extend_from_slice(host_header.as_bytes());
        buf.extend_from_slice(b"\r\n");
    }
    if body_len > 0 && !have_content_length && !have_transfer_encoding {
        buf.extend_from_slice(b"Content-Length: ");
        buf.extend_from_slice(body_len.to_string().as_bytes());
        buf.extend_from_slice(b"\r\n");
    }
    if !have_connection {
        buf.extend_from_slice(b"Connection: keep-alive\r\n");
    }
    buf.extend_from_slice(b"\r\n");
    Ok(buf)
}

// --- Response side --------------------------------------------------------

/// Find the byte offset just *after* the first CRLFCRLF in `b`, i.e. the
/// length of the head. Returns `None` if the head isn't complete yet.
pub fn find_crlf2(b: &[u8]) -> Option<usize> {
    b.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// Parse status line + headers. Returns the parsed head plus the byte
/// offset where the body starts. Caller is responsible for ensuring the
/// buffer contains a complete head (`find_crlf2` is the cheap probe).
pub fn parse_response_head(buf: &[u8]) -> io::Result<ResponseHead> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut resp = httparse::Response::new(&mut headers);
    let parsed = resp
        .parse(buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("http1: parse: {e}")))?;
    let head_len = match parsed {
        httparse::Status::Complete(n) => n,
        httparse::Status::Partial => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "http1: parse: incomplete after CRLFCRLF",
            ))
        }
    };
    let status = resp
        .code
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "http1: missing status code"))?;
    let reason = resp.reason.unwrap_or("").to_string();
    let mut out = Vec::with_capacity(resp.headers.len());
    for h in resp.headers.iter() {
        let name = h.name.to_string();
        let value = match str::from_utf8(h.value) {
            Ok(s) => s.to_string(),
            Err(_) => String::from_utf8_lossy(h.value).into_owned(),
        };
        out.push((name, value));
    }
    Ok(ResponseHead {
        status,
        reason,
        headers: out,
        head_len,
    })
}

/// True when the response uses `Transfer-Encoding: chunked` with
/// `chunked` as the *terminal* coding (RFC 9112 §6.1 / RFC 7230 §3.3.3).
pub fn header_terminal_chunked(headers: &[(String, String)]) -> bool {
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("transfer-encoding") {
            if let Some(last) = v.split(',').map(|s| s.trim()).last() {
                return last.eq_ignore_ascii_case("chunked");
            }
        }
    }
    false
}

/// Returns the `Content-Length` value if present. Multiple identical
/// values are accepted; conflicting values surface as `InvalidData`
/// (RFC 9112 §6.3).
pub fn header_content_length(headers: &[(String, String)]) -> io::Result<Option<u64>> {
    let mut found: Option<u64> = None;
    for (k, v) in headers {
        if !k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let parsed: u64 = v.trim().parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("http1: bad Content-Length {v:?}"),
            )
        })?;
        if let Some(prev) = found {
            if prev != parsed {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "http1: conflicting Content-Length",
                ));
            }
        }
        found = Some(parsed);
    }
    Ok(found)
}

/// Status codes that MUST NOT carry a body (RFC 9112 §6.3 / §15.4):
/// 1xx, 204, 304. Used by `response_is_keepalive` to decide whether a
/// missing framing header is fine.
pub fn no_body_status(status: u16) -> bool {
    matches!(status, 100..=199 | 204 | 304)
}

// --- RFC 9112 §7.1 chunked-transfer helpers --------------------------------

/// Parsed `chunk-size [ ";" chunk-ext ]` line per RFC 9112 §7.1.1. The
/// extension is dropped (we don't act on any chunk-ext today). A size of
/// zero marks the terminal chunk, after which trailers (if any) and the
/// final empty line follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkSize {
    /// Decoded chunk length in bytes. RFC 9112 §7.1 says hex value; we
    /// also reject non-hex digits and empty size fields.
    pub size: u64,
    /// True when `size == 0` — caller now reads trailers + final CRLF.
    pub is_terminal: bool,
}

/// Parse one chunk-size line (the CRLF must already be stripped). Accepts
/// `"5"`, `"5;ignored"`, `"a3   ;name=value"`. Rejects empty / non-hex.
pub fn parse_chunk_size_line(line: &str) -> io::Result<ChunkSize> {
    // Take everything up to the first `;` and trim ASCII whitespace.
    let head = match line.split(';').next() {
        Some(s) => s.trim(),
        None => "",
    };
    if head.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("http1: invalid chunk-size line {line:?}"),
        ));
    }
    if !head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("http1: invalid chunk-size line {line:?}"),
        ));
    }
    let size = u64::from_str_radix(head, 16)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("http1: chunk size: {e}")))?;
    Ok(ChunkSize {
        size,
        is_terminal: size == 0,
    })
}

/// Per-chunk trailer (CRLF) that must follow the chunk body bytes
/// (RFC 9112 §7.1). Hard-coded so the async wrapper doesn't accidentally
/// drift to a single-LF terminator.
pub const CHUNK_TERMINATOR: &[u8] = b"\r\n";

/// Caller-visible cap on the chunk-size line itself. RFC 9112 §7.1 has
/// no explicit limit but a sane upstream stays well under 1 KB (size +
/// extensions). Anything longer is treated as a chunk-line DoS attempt.
pub const MAX_CHUNK_LINE: usize = MAX_HEAD_BYTES;

/// Streaming chunked-body decoder (RFC 9112 §7.1). The async wrapper in
/// `zp-bundle/src/kernel/transport/http1.rs` pushes raw bytes from the
/// upstream stream; `step()` advances the state machine and accumulates
/// chunk bodies into an internal buffer. Trailers (and the final empty
/// line) are recognised but the trailer content is discarded — every
/// caller today only consumes the body bytes.
///
/// On a mid-body / mid-trailer EOF the caller invokes `finish()` to get
/// whatever's already been accumulated; matches the wasm wrapper's
/// "WAF-cut-the-socket tolerance" semantics (a partial body renders
/// better than an empty error page).
pub struct ChunkedDecoder {
    state: ChunkedState,
    input: Vec<u8>,
    body: Vec<u8>,
    body_cap: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkedState {
    /// Need the next chunk-size line.
    WaitingForSize,
    /// Mid-chunk; this many body bytes still need to be consumed.
    ReadingBody { remaining: u64 },
    /// Body of current chunk just finished; need the CRLF before the
    /// next size line (RFC 9112 §7.1, per-chunk terminator).
    WaitingForCrlfAfterBody,
    /// Terminal zero chunk seen; consume trailer lines until a blank
    /// line.
    DrainingTrailers,
    /// Body complete.
    Done,
}

/// Outcome of one `ChunkedDecoder::step()` call.
#[derive(Debug, PartialEq, Eq)]
pub enum ChunkedStep {
    /// State machine needs more input bytes — caller reads more and
    /// pushes them with `push`.
    NeedMore,
    /// Progress made; call `step()` again. The body is in the decoder's
    /// internal buffer; access via `into_body()` when `Done`.
    Progress,
    /// Body complete. Caller takes the body via `into_body()`.
    Done,
}

impl ChunkedDecoder {
    /// Create a fresh decoder. `body_cap` caps the buffered body; an
    /// overrun surfaces as `InvalidData`.
    pub fn new(body_cap: usize) -> Self {
        Self {
            state: ChunkedState::WaitingForSize,
            input: Vec::with_capacity(8192),
            body: Vec::new(),
            body_cap,
        }
    }

    /// Append raw upstream bytes to the decoder's internal buffer.
    pub fn push(&mut self, input: &[u8]) {
        self.input.extend_from_slice(input);
    }

    /// Advance the state machine by one transition. Returns `NeedMore`
    /// when the next transition needs bytes not yet pushed.
    pub fn step(&mut self) -> io::Result<ChunkedStep> {
        match self.state {
            ChunkedState::WaitingForSize => {
                let Some(line) = self.consume_line() else {
                    return Ok(ChunkedStep::NeedMore);
                };
                let cs = parse_chunk_size_line(&line)?;
                if cs.is_terminal {
                    self.state = ChunkedState::DrainingTrailers;
                } else {
                    if self.body.len() as u64 + cs.size > self.body_cap as u64 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "http1: chunked body exceeded cap",
                        ));
                    }
                    self.state = ChunkedState::ReadingBody { remaining: cs.size };
                }
                Ok(ChunkedStep::Progress)
            }
            ChunkedState::ReadingBody { remaining } => {
                if remaining == 0 {
                    self.state = ChunkedState::WaitingForCrlfAfterBody;
                    return Ok(ChunkedStep::Progress);
                }
                let avail = self.input.len() as u64;
                if avail == 0 {
                    return Ok(ChunkedStep::NeedMore);
                }
                let take = remaining.min(avail) as usize;
                self.body.extend_from_slice(&self.input[..take]);
                self.input.drain(..take);
                let left = remaining - take as u64;
                self.state = if left == 0 {
                    ChunkedState::WaitingForCrlfAfterBody
                } else {
                    ChunkedState::ReadingBody { remaining: left }
                };
                Ok(ChunkedStep::Progress)
            }
            ChunkedState::WaitingForCrlfAfterBody => {
                if self.input.len() < CHUNK_TERMINATOR.len() {
                    return Ok(ChunkedStep::NeedMore);
                }
                if &self.input[..CHUNK_TERMINATOR.len()] != CHUNK_TERMINATOR {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "http1: missing CRLF after chunk data",
                    ));
                }
                self.input.drain(..CHUNK_TERMINATOR.len());
                self.state = ChunkedState::WaitingForSize;
                Ok(ChunkedStep::Progress)
            }
            ChunkedState::DrainingTrailers => {
                let Some(line) = self.consume_line() else {
                    return Ok(ChunkedStep::NeedMore);
                };
                if line.is_empty() {
                    self.state = ChunkedState::Done;
                    return Ok(ChunkedStep::Done);
                }
                // Non-empty trailer — discard and loop. Real trailers
                // (e.g. gRPC-Status, Server-Timing) aren't surfaced to
                // the page today.
                Ok(ChunkedStep::Progress)
            }
            ChunkedState::Done => Ok(ChunkedStep::Done),
        }
    }

    /// Drive `step()` until it returns `NeedMore` or `Done`. Returns
    /// the same outcome.
    pub fn step_until_blocked(&mut self) -> io::Result<ChunkedStep> {
        loop {
            match self.step()? {
                ChunkedStep::Progress => continue,
                other => return Ok(other),
            }
        }
    }

    /// True iff `step` would return `Done`.
    pub fn is_done(&self) -> bool {
        self.state == ChunkedState::Done
    }

    /// Consume the decoder and return whatever body has accumulated so
    /// far. Safe to call mid-stream — matches the wasm wrapper's
    /// WAF-cut-the-socket tolerance, returning a partial body instead
    /// of dropping the response.
    pub fn into_body(self) -> Vec<u8> {
        self.body
    }

    /// Peek the body accumulated so far without consuming the decoder.
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    fn consume_line(&mut self) -> Option<String> {
        let pos = self.input.windows(2).position(|w| w == b"\r\n")?;
        let bytes: Vec<u8> = self.input.drain(..pos + 2).collect();
        Some(String::from_utf8_lossy(&bytes[..bytes.len() - 2]).into_owned())
    }
}

/// Predicate matching the wasm wrapper's `response_is_keepalive`: an
/// HTTP/1.1 connection survives the response only when (a) no
/// `Connection: close` was sent, AND (b) the body was bounded
/// (Content-Length, terminal chunked, or no-body status). A
/// close-delimited body forces a fresh connection.
pub fn response_keepalive(status: u16, headers: &[(String, String)]) -> bool {
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("connection") {
            for token in v.split(',') {
                if token.trim().eq_ignore_ascii_case("close") {
                    return false;
                }
            }
        }
    }
    let chunked = header_terminal_chunked(headers);
    let has_cl = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
    chunked || has_cl || no_body_status(status)
}

// --- Token validation -----------------------------------------------------

/// RFC 9112 §5.6.2 / RFC 7230 §3.2.6 token predicate. Used for both
/// method names and header field names.
pub fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            matches!(
                b,
                b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
                    | b'^' | b'_' | b'`' | b'|' | b'~'
                    | b'0'..=b'9'
                    | b'A'..=b'Z'
                    | b'a'..=b'z'
            )
        })
}

// --- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    // -- request line ---

    #[test]
    fn request_get_no_body_adds_host_and_keep_alive() {
        let buf = build_request_head("GET", "example.com", "/", &[], 0).expect("ok");
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.starts_with("GET / HTTP/1.1\r\n"), "got: {s}");
        assert!(s.contains("Host: example.com\r\n"), "must auto-add Host: {s}");
        assert!(
            s.contains("Connection: keep-alive\r\n"),
            "must auto-add Connection: keep-alive: {s}"
        );
        assert!(s.ends_with("\r\n\r\n"));
        assert!(!s.contains("Content-Length"));
    }

    #[test]
    fn request_post_with_body_adds_content_length() {
        let buf =
            build_request_head("POST", "example.com", "/api", &[], 17).expect("ok");
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("Content-Length: 17\r\n"));
    }

    #[test]
    fn request_caller_host_skips_auto_add() {
        let buf = build_request_head("GET", "ignored", "/", &[h("Host", "user.example")], 0)
            .expect("ok");
        let s = std::str::from_utf8(&buf).unwrap();
        // Only one Host header.
        assert_eq!(s.matches("Host: ").count(), 1);
        assert!(s.contains("Host: user.example\r\n"));
    }

    #[test]
    fn request_caller_connection_skips_auto_add() {
        let buf =
            build_request_head("GET", "example.com", "/", &[h("Connection", "close")], 0)
                .expect("ok");
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("Connection: close\r\n"));
        assert!(!s.contains("Connection: keep-alive"));
    }

    #[test]
    fn request_caller_transfer_encoding_skips_content_length() {
        let buf = build_request_head(
            "POST",
            "example.com",
            "/upload",
            &[h("Transfer-Encoding", "chunked")],
            128,
        )
        .expect("ok");
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(!s.contains("Content-Length"));
        assert!(s.contains("Transfer-Encoding: chunked\r\n"));
    }

    #[test]
    fn request_invalid_method_rejected() {
        let err = build_request_head("GE T", "x", "/", &[], 0).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn request_empty_path_rejected() {
        let err = build_request_head("GET", "x", "", &[], 0).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn request_whitespace_in_path_rejected() {
        let err = build_request_head("GET", "x", "/foo bar", &[], 0).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn request_header_injection_in_value_rejected() {
        // Classic CRLF-injection guardrail: a header value with \r\n would
        // otherwise let the caller smuggle a new header line.
        let err = build_request_head(
            "GET",
            "x",
            "/",
            &[h("X-Bad", "ok\r\nX-Forwarded-For: 127.0.0.1")],
            0,
        )
        .expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn request_invalid_header_name_rejected() {
        let err = build_request_head("GET", "x", "/", &[h("Bad Name", "x")], 0)
            .expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn request_missing_host_rejected_when_no_caller_host() {
        let err = build_request_head("GET", "", "/", &[], 0).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    // -- response head parsing ---

    #[test]
    fn find_crlf2_returns_offset_after_terminator() {
        let buf = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nbody";
        let off = find_crlf2(buf).expect("complete head");
        // Offset points to the byte after CRLFCRLF.
        assert_eq!(off, buf.len() - 4);
        assert_eq!(&buf[off..], b"body");
    }

    #[test]
    fn find_crlf2_none_when_incomplete() {
        assert_eq!(find_crlf2(b"HTTP/1.1 200 OK\r\nFoo: bar\r\n"), None);
    }

    #[test]
    fn parse_response_head_minimal_200() {
        let buf = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        let head = parse_response_head(buf).expect("ok");
        assert_eq!(head.status, 200);
        assert_eq!(head.reason, "OK");
        assert_eq!(head.headers, vec![("Content-Length".into(), "5".into())]);
        assert_eq!(head.head_len, buf.len() - 5); // "hello" begins at body
    }

    #[test]
    fn parse_response_head_preserves_duplicate_headers() {
        let buf = b"HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n";
        let head = parse_response_head(buf).expect("ok");
        assert_eq!(head.headers.len(), 2);
        assert_eq!(head.headers[0], ("Set-Cookie".into(), "a=1".into()));
        assert_eq!(head.headers[1], ("Set-Cookie".into(), "b=2".into()));
    }

    #[test]
    fn parse_response_head_incomplete_rejected() {
        // Buffer has a valid CRLFCRLF but is reported as Partial when the
        // status line isn't terminated. Both errors land on InvalidData
        // — we just want to assert we don't accidentally accept either.
        let err = parse_response_head(b"HTTP/1.1 200").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    // -- framing helpers ---

    #[test]
    fn terminal_chunked_when_te_ends_with_chunked() {
        assert!(header_terminal_chunked(&[h("Transfer-Encoding", "chunked")]));
        assert!(header_terminal_chunked(&[h(
            "Transfer-Encoding",
            "gzip, chunked"
        )]));
        // chunked NOT terminal → not chunked-framed.
        assert!(!header_terminal_chunked(&[h(
            "Transfer-Encoding",
            "chunked, gzip"
        )]));
        // Case-insensitive header name and value.
        assert!(header_terminal_chunked(&[h(
            "transfer-encoding",
            "Chunked"
        )]));
    }

    #[test]
    fn content_length_single() {
        assert_eq!(
            header_content_length(&[h("Content-Length", "42")]).unwrap(),
            Some(42)
        );
    }

    #[test]
    fn content_length_duplicate_identical_ok() {
        assert_eq!(
            header_content_length(&[h("Content-Length", "10"), h("Content-Length", "10")])
                .unwrap(),
            Some(10)
        );
    }

    #[test]
    fn content_length_conflicting_rejected() {
        let err = header_content_length(&[h("Content-Length", "10"), h("Content-Length", "11")])
            .expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn content_length_non_numeric_rejected() {
        let err = header_content_length(&[h("Content-Length", "abc")]).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn response_keepalive_close_token_breaks_pool() {
        assert!(!response_keepalive(
            200,
            &[h("Content-Length", "0"), h("Connection", "close")]
        ));
        assert!(!response_keepalive(
            200,
            &[h("Connection", "keep-alive, close"), h("Content-Length", "0")]
        ));
    }

    #[test]
    fn response_keepalive_close_delimited_body_blocks_pool() {
        // No CL, no chunked, status not in no-body set → close-delimited.
        assert!(!response_keepalive(200, &[]));
    }

    #[test]
    fn response_keepalive_no_body_status_is_poolable() {
        for code in [100u16, 199, 204, 304] {
            assert!(response_keepalive(code, &[]), "code {code} should be poolable");
        }
    }

    #[test]
    fn response_keepalive_chunked_is_poolable() {
        assert!(response_keepalive(200, &[h("Transfer-Encoding", "chunked")]));
    }

    // -- token predicate ---

    #[test]
    fn is_token_accepts_rfc_alphabet() {
        assert!(is_token("GET"));
        assert!(is_token("X-Custom-Header"));
        assert!(is_token("!#$%&'*+-.^_`|~"));
    }

    #[test]
    fn is_token_rejects_empty_and_whitespace() {
        assert!(!is_token(""));
        assert!(!is_token("Bad Name"));
        assert!(!is_token("X\tName"));
        assert!(!is_token("X\r"));
    }

    // -- chunked decoder helpers ---

    #[test]
    fn chunk_size_plain_hex() {
        let cs = parse_chunk_size_line("5").expect("ok");
        assert_eq!(cs.size, 5);
        assert!(!cs.is_terminal);
    }

    #[test]
    fn chunk_size_terminal_zero() {
        let cs = parse_chunk_size_line("0").expect("ok");
        assert_eq!(cs.size, 0);
        assert!(cs.is_terminal, "size 0 must mark terminal chunk");
    }

    #[test]
    fn chunk_size_uppercase_hex() {
        let cs = parse_chunk_size_line("A3").expect("ok");
        assert_eq!(cs.size, 0xa3);
    }

    #[test]
    fn chunk_size_extension_dropped() {
        // RFC 9112 §7.1.1 chunk-ext is parsed but not acted on. We don't
        // even validate its grammar — every byte after the first `;` is
        // discarded.
        let cs = parse_chunk_size_line("5;name=value").expect("ok");
        assert_eq!(cs.size, 5);
        let cs = parse_chunk_size_line("a3;ignored=stuff;more=bits").expect("ok");
        assert_eq!(cs.size, 0xa3);
    }

    #[test]
    fn chunk_size_trims_whitespace_before_semicolon() {
        let cs = parse_chunk_size_line("a3   ;name=value").expect("ok");
        assert_eq!(cs.size, 0xa3);
    }

    #[test]
    fn chunk_size_empty_rejected() {
        let err = parse_chunk_size_line("").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn chunk_size_only_extension_rejected() {
        // ";foo" → empty size field
        let err = parse_chunk_size_line(";foo").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn chunk_size_non_hex_rejected() {
        for bad in ["xyz", "5g", "0x10"] {
            let err = parse_chunk_size_line(bad).expect_err("must fail");
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "input {bad:?}");
        }
    }

    #[test]
    fn chunk_size_leading_or_trailing_whitespace_accepted() {
        // Parser does a full trim() before hex validation, matching how
        // tolerant real upstreams are with the chunk-size line.
        assert_eq!(parse_chunk_size_line(" 5").unwrap().size, 5);
        assert_eq!(parse_chunk_size_line("5 ").unwrap().size, 5);
        assert_eq!(parse_chunk_size_line("  a3  ").unwrap().size, 0xa3);
    }

    #[test]
    fn chunk_size_overflow_rejected() {
        // 17 hex digits → > u64::MAX, parse fails.
        let err = parse_chunk_size_line("ffffffffffffffff0").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn chunk_terminator_is_crlf() {
        assert_eq!(CHUNK_TERMINATOR, b"\r\n");
    }

    // -- ChunkedDecoder ---

    fn run_one_shot(input: &[u8]) -> io::Result<Vec<u8>> {
        let mut d = ChunkedDecoder::new(1 << 20);
        d.push(input);
        let outcome = d.step_until_blocked()?;
        match outcome {
            ChunkedStep::Done => Ok(d.into_body()),
            ChunkedStep::NeedMore => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "decoder still needs more bytes",
            )),
            ChunkedStep::Progress => unreachable!(),
        }
    }

    #[test]
    fn decoder_single_chunk_no_trailer() {
        let body = run_one_shot(b"5\r\nhello\r\n0\r\n\r\n").unwrap();
        assert_eq!(body, b"hello");
    }

    #[test]
    fn decoder_multi_chunk() {
        let body = run_one_shot(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap();
        assert_eq!(body, b"hello world");
    }

    #[test]
    fn decoder_chunk_extension_dropped() {
        let body = run_one_shot(b"5;name=value\r\nhello\r\n0;eof=true\r\n\r\n").unwrap();
        assert_eq!(body, b"hello");
    }

    #[test]
    fn decoder_trailers_drained() {
        let raw = b"5\r\nhello\r\n0\r\nX-Trailer-A: foo\r\nX-Trailer-B: bar\r\n\r\n";
        let body = run_one_shot(raw).unwrap();
        assert_eq!(body, b"hello");
    }

    #[test]
    fn decoder_missing_crlf_after_body_rejected() {
        // "hello" is 5 bytes, followed by "XX" instead of CRLF.
        let err = run_one_shot(b"5\r\nhelloXX0\r\n\r\n").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn decoder_invalid_size_line_rejected() {
        let err = run_one_shot(b"xyz\r\nhello\r\n0\r\n\r\n").expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn decoder_body_cap_enforced() {
        let mut d = ChunkedDecoder::new(4);
        d.push(b"5\r\nhello\r\n0\r\n\r\n");
        let err = d.step_until_blocked().expect_err("cap must trip");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn decoder_incremental_push_handles_split_boundaries() {
        // Feed bytes in arbitrarily small slices to prove the state
        // machine doesn't depend on chunks lining up with reads.
        let mut d = ChunkedDecoder::new(1 << 20);
        let raw: &[u8] = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let mut i = 0;
        let mut done = false;
        while i < raw.len() {
            // Push one byte at a time.
            d.push(&raw[i..i + 1]);
            i += 1;
            match d.step_until_blocked().unwrap() {
                ChunkedStep::NeedMore => continue,
                ChunkedStep::Done => {
                    done = true;
                    break;
                }
                ChunkedStep::Progress => unreachable!(),
            }
        }
        assert!(done, "decoder must finish even with single-byte feeds");
        assert_eq!(d.into_body(), b"hello world");
    }

    #[test]
    fn decoder_finish_mid_stream_returns_partial_body() {
        // Server closed the socket mid-chunk after delivering the first
        // 4 bytes of a 5-byte chunk. Caller invokes into_body() and
        // gets the partial — matches the wasm wrapper's WAF-cut-socket
        // tolerance.
        let mut d = ChunkedDecoder::new(1 << 20);
        d.push(b"5\r\nhell");
        // Drive until blocked.
        let outcome = d.step_until_blocked().unwrap();
        assert_eq!(outcome, ChunkedStep::NeedMore);
        assert!(!d.is_done());
        let partial = d.into_body();
        assert_eq!(partial, b"hell", "partial body must be the bytes we did receive");
    }

    #[test]
    fn decoder_drains_no_trailer_terminator() {
        // RFC 9112 §7.1.2: a chunked body MAY have zero trailers, in
        // which case the terminal "0\r\n\r\n" is the entire trailer
        // section. Decoder must read both CRLFs.
        let body = run_one_shot(b"0\r\n\r\n").unwrap();
        assert!(body.is_empty());
    }

    #[test]
    fn is_token_rejects_separators() {
        for sep in ["(", ")", ",", ";", ":", "<", ">", "@", "/", "?", "=", "{", "}"] {
            assert!(!is_token(sep), "{sep} must be rejected");
        }
    }
}
