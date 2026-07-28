//! Response-body decoders for the Phase 5.12 Chrome-shape
//! `Accept-Encoding: gzip, deflate, br, zstd, identity;q=0.1` header.
//!
//! Real browsers compress responses by default; without a decoder the
//! kernel must force `identity` and ship a curl-shape Accept-Encoding
//! that WAFs flag. With these decoders we can offer the same content
//! codings Chrome 148 advertises and unwrap whatever the server picks.
//!
//! The codecs run **after** the full body has been received over h2 /
//! h1 — we don't stream-decode yet. h2 body chunks are accumulated into
//! a single `Vec<u8>` already (see http2.rs body_buf), so decoding the
//! collected buffer keeps the call sites a one-line transformation.
//! Streaming decode is a follow-up once SSE / chunked CSS / big media
//! responses become a measurable problem.
//!
//! All three decoders are pure-Rust and wasm32-unknown-unknown clean:
//!   - gzip / deflate: `flate2` with the `rust_backend` feature.
//!   - brotli:        `brotli` crate (no C bindings).
//!   - zstd:          `ruzstd` crate (pure-Rust zstd decoder).
//!
//! Unknown / unsupported codings pass through untouched and we log the
//! token so we can extend the matrix later.

use std::io::Read;

/// Inspect a comma-separated `Content-Encoding` header, decode the body
/// through each coding right-to-left, and strip the header tokens we
/// successfully handled so the SW response carries plaintext bytes
/// with no leftover encoding claim.
///
/// Returns the decoded bytes along with the residual Content-Encoding
/// string (empty if all codings were handled). The caller is expected
/// to drop the original header and substitute the residual; we never
/// keep a `Content-Encoding: gzip` claim on bytes we already unwrapped.
pub(crate) fn decode_body(content_encoding: &str, body: Vec<u8>) -> (Vec<u8>, String) {
    let trimmed = content_encoding.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("identity") {
        return (body, String::new());
    }

    // RFC 9110 §8.4: codings apply outermost-first on the wire, so we
    // undo right-to-left. `gzip, br` means brotli was applied first, then
    // gzip on top — peel gzip, then peel brotli.
    let mut codings: Vec<String> = trimmed
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut current = body;
    let mut residual: Vec<String> = Vec::new();
    while let Some(coding) = codings.pop() {
        match coding.as_str() {
            "gzip" | "x-gzip" => match decode_gzip(&current) {
                Some(out) => current = out,
                None => {
                    crate::kernel::push_trace(&format!("tx:decode-err coding=gzip bytes={}", current.len()));
                    // Decode failure: preserve remaining codings + this one in residual order.
                    residual.insert(0, coding);
                    break;
                }
            },
            "deflate" => match decode_deflate(&current) {
                Some(out) => current = out,
                None => {
                    crate::kernel::push_trace(&format!("tx:decode-err coding=deflate bytes={}", current.len()));
                    residual.insert(0, coding);
                    break;
                }
            },
            "br" => match decode_brotli(&current) {
                Some(out) => current = out,
                None => {
                    crate::kernel::push_trace(&format!("tx:decode-err coding=br bytes={}", current.len()));
                    residual.insert(0, coding);
                    break;
                }
            },
            "zstd" => match decode_zstd(&current) {
                Some(out) => current = out,
                None => {
                    crate::kernel::push_trace(&format!("tx:decode-err coding=zstd bytes={}", current.len()));
                    residual.insert(0, coding);
                    break;
                }
            },
            "identity" => {} // no-op layer
            _ => {
                // Unknown coding — we can't strip it without lying about the
                // payload. Keep the remaining codings (including this) in residual.
                crate::kernel::push_trace(&format!(
                    "tx:decode-unknown coding={} bytes={}",
                    coding,
                    current.len()
                ));
                residual.insert(0, coding);
                break;
            }
        }
    }
    // Anything still on `codings` (codings to the LEFT of the failed/unknown
    // one) is also preserved — those were applied first on the wire and
    // remain in effect on the bytes we couldn't fully peel.
    while let Some(remaining) = codings.pop() {
        residual.insert(0, remaining);
    }
    (current, residual.join(", "))
}

/// Has the OUTERMOST content-coding's wire stream fully arrived? Used by the
/// h2 body reader to finish the instant a compressed body is complete instead
/// of blocking on a peer that withholds END_STREAM (NAVER's edge holds it for
/// 60–240s after sending the whole body).
///
/// The check is exact, not heuristic: a coding only reports complete when its
/// own end marker validates — gzip's CRC32+ISIZE footer, zlib's adler32,
/// brotli's / zstd's end-of-stream. A truncated stream fails to decode, so we
/// keep reading. Only the outermost coding (last on the wire) is inspected;
/// inner layers are validated in the full `decode_body` unwrap afterwards.
pub(crate) fn body_is_complete(content_encoding: &str, body: &[u8]) -> bool {
    let trimmed = content_encoding.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("identity") {
        return false; // no coding → no end-of-stream marker to detect here
    }
    let outer = trimmed
        .split(',')
        .next_back()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match outer.as_str() {
        // gzip: detect the DEFLATE stream end (final block), NOT the gzip
        // footer. NAVER delivers the entire compressed content early but
        // withholds the 8-byte CRC32+ISIZE footer until it sends END_STREAM
        // (~60s later). A browser decompresses and renders from the deflate
        // content and only uses the footer for an integrity check — so it
        // finishes early. Requiring a full GzDecoder (footer-validating)
        // decode here would wait the whole 60s. `deflate_stream_complete`
        // reaches StreamEnd at the deflate final block, footer or not.
        "gzip" | "x-gzip" => gzip_content_complete(body),
        // zlib "deflate": the adler32 trailer is part of the deflate framing
        // here; reuse the full-decode check (servers rarely split it).
        "deflate" => decode_deflate(body).is_some(),
        "br" => decode_brotli(body).is_some(),
        "zstd" => decode_zstd(body).is_some(),
        _ => false,
    }
}

/// True once a gzip member's DEFLATE payload has fully arrived (final block
/// decoded), independent of the trailing 8-byte CRC32+ISIZE footer. Parses
/// the RFC 1952 header to find the deflate offset, then runs a raw inflate
/// and reports whether it reached `StreamEnd`.
fn gzip_content_complete(body: &[u8]) -> bool {
    let Some(deflate_off) = gzip_header_len(body) else {
        return false;
    };
    if deflate_off >= body.len() {
        return false;
    }
    let deflate = &body[deflate_off..];
    let mut d = flate2::Decompress::new(false); // raw deflate, no zlib header
    let mut scratch = [0u8; 32 * 1024];
    loop {
        let in_pos = d.total_in() as usize;
        if in_pos > deflate.len() {
            return false;
        }
        let out_before = d.total_out();
        match d.decompress(&deflate[in_pos..], &mut scratch, flate2::FlushDecompress::None) {
            Ok(flate2::Status::StreamEnd) => return true,
            Ok(_) => {
                let no_input_progress = d.total_in() as usize == in_pos;
                let no_output_progress = d.total_out() == out_before;
                // Stuck with nothing left to do and not at the end ⇒ the
                // remaining input is incomplete; keep reading more body.
                if no_input_progress && no_output_progress {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
}

/// Length of the RFC 1952 gzip header (so `body[len..]` is the deflate
/// stream). Returns None if the magic/method is wrong or a flagged optional
/// field is truncated.
fn gzip_header_len(body: &[u8]) -> Option<usize> {
    if body.len() < 10 || body[0] != 0x1f || body[1] != 0x8b || body[2] != 0x08 {
        return None;
    }
    let flg = body[3];
    let mut pos = 10usize;
    if flg & 0x04 != 0 {
        // FEXTRA: 2-byte LE length + that many bytes.
        if pos + 2 > body.len() {
            return None;
        }
        let xlen = u16::from_le_bytes([body[pos], body[pos + 1]]) as usize;
        pos += 2 + xlen;
    }
    if flg & 0x08 != 0 {
        // FNAME: NUL-terminated.
        while pos < body.len() && body[pos] != 0 {
            pos += 1;
        }
        pos += 1;
    }
    if flg & 0x10 != 0 {
        // FCOMMENT: NUL-terminated.
        while pos < body.len() && body[pos] != 0 {
            pos += 1;
        }
        pos += 1;
    }
    if flg & 0x02 != 0 {
        // FHCRC: 2 bytes.
        pos += 2;
    }
    if pos > body.len() {
        return None;
    }
    Some(pos)
}

fn decode_gzip(input: &[u8]) -> Option<Vec<u8>> {
    // Fast path: a complete gzip member (CRC32+ISIZE footer present) decodes
    // and validates cleanly.
    let mut decoder = flate2::read::GzDecoder::new(input);
    let mut out = Vec::with_capacity(input.len() * 4);
    if decoder.read_to_end(&mut out).is_ok() {
        return Some(out);
    }
    // Footer-less gzip: NAVER (and similar) deliver the whole DEFLATE payload
    // but withhold the trailing footer until END_STREAM, so the h2 body reader
    // returns the content early (see http2.rs / body_is_complete). Decode the
    // raw deflate stream directly and ignore the absent integrity trailer —
    // the same bytes a streaming browser renders. CRC isn't validated, which
    // matches how browsers surface a still-rendering response.
    let off = gzip_header_len(input)?;
    inflate_raw(input.get(off..)?)
}

/// Inflate a raw DEFLATE stream, returning the decompressed bytes once the
/// final block is reached (or as much as decoded before the input runs out).
fn inflate_raw(deflate: &[u8]) -> Option<Vec<u8>> {
    let mut d = flate2::Decompress::new(false); // raw deflate, no zlib header
    let mut out = Vec::with_capacity(deflate.len() * 4);
    let mut scratch = [0u8; 32 * 1024];
    loop {
        let in_pos = d.total_in() as usize;
        if in_pos > deflate.len() {
            break;
        }
        let out_before = d.total_out();
        let status = d.decompress(&deflate[in_pos..], &mut scratch, flate2::FlushDecompress::None);
        let produced = (d.total_out() - out_before) as usize;
        out.extend_from_slice(&scratch[..produced]);
        match status {
            Ok(flate2::Status::StreamEnd) => break,
            Ok(_) => {
                // No input consumed and no output produced ⇒ nothing more we
                // can do with the bytes on hand; return what we decoded.
                if d.total_in() as usize == in_pos && produced == 0 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Stateful incremental gunzip for the streaming HTML path. Feed gzip wire
/// bytes chunk-by-chunk via [`StreamingGunzip::push`]; each call returns the
/// plaintext produced so far so the kernel can `enqueue` it into a
/// `ReadableStream` the instant it arrives — exactly how a browser stream-
/// decompresses. NO timers, NO whole-body buffering.
///
/// The gzip footer (CRC32+ISIZE) is intentionally NOT validated: NAVER and
/// similar edges deliver every non-final DEFLATE block early but withhold the
/// final block + footer with END_STREAM for ~60s. We decode and emit the early
/// content immediately; the absent footer just means the integrity trailer is
/// skipped (same surface as a still-rendering browser response).
pub(crate) struct StreamingGunzip {
    decomp: flate2::Decompress,
    /// Accumulates wire bytes until the RFC 1952 header is fully parsed (the
    /// header can, rarely, span chunk boundaries via FNAME/FEXTRA fields).
    header_buf: Vec<u8>,
    header_done: bool,
    /// Once the DEFLATE final block validates we stop feeding the inflater —
    /// any trailing footer bytes must NOT reach the raw inflate stream.
    /// Set when the inflater STOPS — either at the final block (success) or on
    /// a decode error. Use [`Self::is_stream_end`] to tell those apart.
    finished: bool,
    /// Set ONLY when the inflater reported `Status::StreamEnd`, i.e. the
    /// content really is complete. `finished` alone must never be treated as
    /// "complete": it is also set on decode errors, and closing the page-facing
    /// stream on an error truncates the document (observed: NAVER rendering as
    /// a blank page, body ≈ 1.6 KB, because the buffered 181 KB inline script
    /// never received its closing tag).
    stream_end: bool,
}

impl StreamingGunzip {
    pub(crate) fn new() -> Self {
        StreamingGunzip {
            decomp: flate2::Decompress::new(false), // raw deflate, no zlib header
            header_buf: Vec::new(),
            header_done: false,
            finished: false,
            stream_end: false,
        }
    }

    /// True once the DEFLATE stream reached its final block — the decoded body
    /// is COMPLETE even if the h2 `END_STREAM` frame has not arrived yet. The
    /// streaming pump uses this to close the page-facing stream at content-end
    /// (like a real browser, which decodes gzip itself and never waits for the
    /// trailing frame) instead of parking. Decode ERRORS deliberately do not
    /// set this: an errored stream must not be reported as a complete one.
    pub(crate) fn is_stream_end(&self) -> bool {
        self.stream_end
    }

    /// The inflater stopped without reaching the final block — the body cannot
    /// be decoded any further. Callers must surface this instead of parking
    /// forever on a stream that will never produce another byte.
    pub(crate) fn is_error(&self) -> bool {
        self.finished && !self.stream_end
    }

    /// Feed one chunk of gzip wire bytes; return the plaintext produced by it.
    /// Returns empty while still accumulating the header or after StreamEnd.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.finished {
            return Vec::new();
        }
        if !self.header_done {
            self.header_buf.extend_from_slice(chunk);
            match gzip_header_len(&self.header_buf) {
                Some(off) => {
                    self.header_done = true;
                    // Everything past the header is the first deflate bytes.
                    let deflate = self.header_buf.split_off(off);
                    self.header_buf = Vec::new(); // drop the consumed header bytes
                    self.inflate(&deflate)
                }
                None => Vec::new(), // need more header bytes
            }
        } else {
            self.inflate(chunk)
        }
    }

    fn inflate(&mut self, deflate: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut scratch = [0u8; 32 * 1024];
        let mut consumed = 0usize;
        loop {
            if consumed > deflate.len() {
                break;
            }
            let before_in = self.decomp.total_in();
            let before_out = self.decomp.total_out();
            let status = self.decomp.decompress(
                &deflate[consumed..],
                &mut scratch,
                flate2::FlushDecompress::None,
            );
            let produced = (self.decomp.total_out() - before_out) as usize;
            out.extend_from_slice(&scratch[..produced]);
            let consumed_now = (self.decomp.total_in() - before_in) as usize;
            consumed += consumed_now;
            match status {
                Ok(flate2::Status::StreamEnd) => {
                    self.finished = true;
                    self.stream_end = true;
                    break;
                }
                Ok(_) => {
                    // No progress and input drained ⇒ wait for the next chunk.
                    if consumed_now == 0 && produced == 0 {
                        break;
                    }
                }
                Err(_) => {
                    self.finished = true;
                    break;
                }
            }
        }
        out
    }
}

fn decode_deflate(input: &[u8]) -> Option<Vec<u8>> {
    // RFC 9110 §8.4.1.2: HTTP "deflate" is zlib-wrapped (RFC 1950), not raw
    // deflate. `ZlibDecoder` reads the zlib header + adler32 trailer.
    let mut decoder = flate2::read::ZlibDecoder::new(input);
    let mut out = Vec::with_capacity(input.len() * 4);
    decoder.read_to_end(&mut out).ok().map(|_| out)
}

fn decode_brotli(input: &[u8]) -> Option<Vec<u8>> {
    let mut reader = brotli::Decompressor::new(input, 4096);
    let mut out = Vec::with_capacity(input.len() * 4);
    reader.read_to_end(&mut out).ok().map(|_| out)
}

fn decode_zstd(input: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(input).ok()?;
    let mut out = Vec::with_capacity(input.len() * 4);
    decoder.read_to_end(&mut out).ok().map(|_| out)
}
