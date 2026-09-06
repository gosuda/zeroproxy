//! Bounded buffered decoding for executable responses and non-streamable
//! content codings. gzip/deflate on live bodies use DecompressionStream; these
//! decoders must reject corrupt/unsupported bodies, never return encoded bytes
//! as if they were plaintext. HTTP framing, not a codec marker, ends a body.

use std::io::{self, Read};

pub(crate) const MAX_DECODED_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn decode_body(content_encoding: &str, mut body: Vec<u8>) -> io::Result<Vec<u8>> {
    // Codings are listed in application order: gzip, br is gzip wrapped in
    // brotli. Decode the last (outermost) coding first.
    for coding in content_encoding.split(',').rev().map(str::trim) {
        body = match coding.to_ascii_lowercase().as_str() {
            "" | "identity" => body,
            "gzip" | "x-gzip" => read_bounded(flate2::read::MultiGzDecoder::new(body.as_slice()))?,
            "deflate" => read_bounded(flate2::read::ZlibDecoder::new(body.as_slice()))?,
            "br" => read_bounded(brotli::Decompressor::new(body.as_slice(), 4096))?,
            "zstd" => {
                let decoder = ruzstd::decoding::StreamingDecoder::new(body.as_slice())
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
                read_bounded(decoder)?
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData,
                format!("unsupported Content-Encoding: {coding}"))),
        };
    }
    Ok(body)
}

fn read_bounded(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    reader.take(MAX_DECODED_BYTES as u64 + 1).read_to_end(&mut out)?;
    if out.len() > MAX_DECODED_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "decoded response exceeded cap"));
    }
    Ok(out)
}
