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

fn decode_gzip(input: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = flate2::read::GzDecoder::new(input);
    let mut out = Vec::with_capacity(input.len() * 4);
    decoder.read_to_end(&mut out).ok().map(|_| out)
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
