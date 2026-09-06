//! HTTP/1.1 over a pooled TLS/yamux connection. Response headers complete the
//! request future; a pull-driven body owns the connection until framing and
//! content decoding finish. Cancellation and errors never return it to the pool.

use std::cell::RefCell;
use std::io;
use std::rc::Rc;

use futures_util::io::{AsyncReadExt, AsyncWriteExt};
use zp_transport_codec::http1 as codec;

use super::http2::{self, H2Response};
use super::pool::{self, PoolKey, PooledConn};

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub null_body: bool,
}

pub(crate) async fn send_request(
    mut conn: PooledConn,
    key: PoolKey,
    method: &str,
    host_header: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> io::Result<H2Response> {
    let head = codec::build_request_head(method, host_header, path, headers, body.len())?;
    conn.write_all(&head).await?;
    conn.write_all(body).await?;
    conn.flush().await?;

    let mut input = Vec::with_capacity(4096);
    let mut scratch = [0u8; 4096];
    let (head, http11) = loop {
        if let Some(end) = codec::find_crlf2(&input) {
            if end > codec::MAX_HEAD_BYTES {
                return Err(invalid("response head exceeded limit"));
            }
            let head = codec::parse_response_head(&input)?;
            let http11 = input.starts_with(b"HTTP/1.1 ");
            input.drain(..head.head_len);
            // 100 Continue / 103 Early Hints can share a read with the final head.
            if (100..200).contains(&head.status) && head.status != 101 {
                continue;
            }
            break (head, http11);
        }
        if input.len() > codec::MAX_HEAD_BYTES {
            return Err(invalid("response head exceeded limit"));
        }
        let n = conn.read(&mut scratch).await?;
        if n == 0 {
            return Err(truncated());
        }
        input.extend_from_slice(&scratch[..n]);
    };
    if head.status == 101 {
        return Err(invalid("unexpected protocol upgrade"));
    }
    let null_body = method.eq_ignore_ascii_case("HEAD") || codec::no_body_status(head.status);
    let transfer: Vec<&str> = head.headers.iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, v)| v.split(',').map(str::trim))
        .collect();
    // Transfer codings other than chunked require their own decoding. Never
    // mistake those bytes for content-decoded plaintext or trust a competing CL.
    if !null_body && !transfer.is_empty()
        && (transfer.len() != 1 || !transfer[0].eq_ignore_ascii_case("chunked"))
    {
        return Err(invalid("unsupported Transfer-Encoding"));
    }
    let framing = if null_body {
        Framing::Fixed(0)
    } else if !transfer.is_empty() {
        Framing::Chunked(codec::ChunkedDecoder::new(usize::MAX))
    } else if let Some(n) = codec::header_content_length(&head.headers)? {
        Framing::Fixed(n)
    } else {
        Framing::Eof
    };
    let has_token = |list: &[(String, String)], name: &str, token: &str| {
        list.iter().any(|(k, v)| k.eq_ignore_ascii_case(name)
            && v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    };
    let keepalive = !matches!(framing, Framing::Eof)
        && codec::response_keepalive(if null_body { 204 } else { head.status }, &head.headers)
        && !has_token(headers, "connection", "close")
        && (http11 || has_token(&head.headers, "connection", "keep-alive"));
    // The framed reader deposits a clean connection here, but only the final
    // decoded consumer may return it. A bad gzip footer must discard it too.
    let completed = Rc::new(RefCell::new(None));
    let reader = BodyReader {
        conn: Some(conn), framing, input, completed: completed.clone(), keepalive,
    };
    let chunks = futures_util::stream::try_unfold(reader, |mut reader| async move {
        match reader.next_chunk().await? {
            Some(chunk) => Ok(Some((bytes::Bytes::from(chunk), reader))),
            None => Ok(None),
        }
    });
    http2::finish_response(
        head.status, head.reason, head.headers, null_body, Box::pin(chunks),
        Box::new(move || {
            if let Some(conn) = completed.borrow_mut().take() {
                pool::put(key, conn);
            }
        }),
    ).await
}

enum Framing {
    Fixed(u64),
    Chunked(codec::ChunkedDecoder),
    Eof,
}

struct BodyReader {
    conn: Option<PooledConn>,
    framing: Framing,
    input: Vec<u8>,
    completed: Rc<RefCell<Option<PooledConn>>>,
    keepalive: bool,
}

impl BodyReader {
    fn finish(&mut self) {
        if self.keepalive {
            *self.completed.borrow_mut() = self.conn.take();
        } else {
            self.conn.take();
        }
    }

    async fn next_chunk(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            match &mut self.framing {
                Framing::Fixed(remaining) => {
                    if self.input.len() as u64 > *remaining {
                        return Err(invalid("bytes beyond Content-Length"));
                    }
                    if !self.input.is_empty() {
                        *remaining -= self.input.len() as u64;
                        return Ok(Some(std::mem::take(&mut self.input)));
                    }
                    if *remaining == 0 {
                        self.finish();
                        return Ok(None);
                    }
                }
                Framing::Chunked(decoder) => {
                    decoder.push(&self.input);
                    self.input.clear();
                    decoder.step_until_blocked()?;
                    if decoder.is_done() && decoder.has_remaining_input() {
                        return Err(invalid("bytes beyond chunked terminator"));
                    }
                    let chunk = decoder.take_body();
                    if !chunk.is_empty() {
                        return Ok(Some(chunk));
                    }
                    if decoder.is_done() {
                        self.finish();
                        return Ok(None);
                    }
                }
                Framing::Eof if !self.input.is_empty() => {
                    return Ok(Some(std::mem::take(&mut self.input)));
                }
                Framing::Eof => {}
            }
            let mut scratch = [0u8; 8192];
            let limit = match self.framing {
                Framing::Fixed(n) => n.min(scratch.len() as u64) as usize,
                _ => scratch.len(),
            };
            let n = self.conn.as_mut().expect("body connection").read(&mut scratch[..limit]).await?;
            if n == 0 {
                if matches!(self.framing, Framing::Eof) {
                    self.finish();
                    return Ok(None);
                }
                return Err(truncated());
            }
            self.input.extend_from_slice(&scratch[..n]);
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("http1: {message}"))
}

fn truncated() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "http1: truncated response")
}
