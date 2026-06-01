//! `web_sys::WebSocket` → `futures::io::AsyncRead + AsyncWrite` adapter.
//!
//! The WebSocket API is event-driven: incoming binary frames fire `onmessage`
//! callbacks asynchronously, and the only outgoing write surface is the
//! synchronous `send_with_u8_array` method. To make higher-layer transport
//! crates (yamux, rustls, h2 over rustls) usable, we present the connection
//! as a plain byte stream:
//!
//! * **Inbound**: `onmessage` callbacks push frame payloads into an internal
//!   queue and wake any pending `poll_read`. `onclose` / `onerror` mark the
//!   stream EOF/errored, and pending reads observe that on the next poll.
//! * **Outbound**: `poll_write` calls `WebSocket::send_with_u8_array`
//!   immediately. The WebSocket layer buffers internally (bufferedAmount),
//!   so we don't need our own write queue; if the buffer fills, the
//!   underlying transport applies its own backpressure.
//! * **Flush/Close**: `poll_flush` is a no-op (the browser stack owns the
//!   socket buffer); `poll_close` calls `WebSocket::close()`.
//!
//! ## Frame semantics
//!
//! Yamux, TLS records, and HTTP all see this stream as raw bytes — they
//! don't care about WebSocket frame boundaries, and we don't preserve them.
//! `poll_read` returns as many bytes as fit in the caller's buffer from the
//! current pending frame; leftover bytes stay queued for the next read.
//!
//! ## Thread model
//!
//! WASM is single-threaded; the callbacks and the futures executor run on
//! the same JS event loop. We use `Rc<RefCell<_>>` for shared state. No
//! `Send + Sync` bounds. The `Waker` is stored as a plain field — the JS
//! callback wakes the executor synchronously on the same task queue.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use futures_util::io::{AsyncRead, AsyncWrite};
use js_sys::Uint8Array;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{BinaryType, CloseEvent, ErrorEvent, MessageEvent, WebSocket};

/// Internal shared state. Lives in a single `Rc<RefCell<_>>` shared by the
/// `WsStream` (read/write surface) and the four `Closure`s wired to the
/// underlying `WebSocket` (open, message, error, close).
struct Inner {
    /// Inbound binary frames not yet drained by `poll_read`. Each entry is
    /// a whole received frame's bytes; the front entry is being drained
    /// from `read_cursor`.
    rx_buf: VecDeque<Vec<u8>>,
    /// Byte offset within `rx_buf.front()` of the next byte to return.
    /// Reset to 0 whenever the front entry is drained and popped.
    read_cursor: usize,
    /// Set on `onclose` (clean shutdown). After all queued bytes drain,
    /// `poll_read` returns `Ok(0)`.
    closed: bool,
    /// Set on `onerror` or `onclose` with a non-1000 code. `poll_read` and
    /// `poll_write` return this once observed; the error is taken (consumed)
    /// so subsequent polls behave like a closed stream.
    error: Option<io::Error>,
    /// Set once `onopen` fires; `WsStream::open()` resolves its readiness
    /// future from this side. The future also resolves on early `onerror`.
    opened: bool,
    /// Waker for a pending `poll_read`. Set when read is parked because
    /// `rx_buf` is empty and the stream is not yet closed/errored. Woken
    /// from `onmessage` / `onclose` / `onerror`.
    read_waker: Option<Waker>,
    /// Waker for `WsStream::open()`'s readiness future. Cleared on first
    /// wake (open or error).
    open_waker: Option<Waker>,
}

impl Inner {
    fn new() -> Self {
        Self {
            rx_buf: VecDeque::new(),
            read_cursor: 0,
            closed: false,
            error: None,
            opened: false,
            read_waker: None,
            open_waker: None,
        }
    }

    fn wake_read(&mut self) {
        if let Some(w) = self.read_waker.take() {
            w.wake();
        }
    }

    fn wake_open(&mut self) {
        if let Some(w) = self.open_waker.take() {
            w.wake();
        }
    }
}

/// AsyncRead/AsyncWrite-shaped view of a `WebSocket`. Drops own the socket:
/// dropping the `WsStream` closes the underlying WebSocket and releases the
/// four callback closures.
pub(crate) struct WsStream {
    ws: WebSocket,
    inner: Rc<RefCell<Inner>>,
    /// Holding boxes for the four registered callbacks. Kept alive as long
    /// as the stream is alive; dropped in `Drop` so the JS side stops
    /// pushing into freed state.
    _on_open: Closure<dyn FnMut(JsValue)>,
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_error: Closure<dyn FnMut(ErrorEvent)>,
    _on_close: Closure<dyn FnMut(CloseEvent)>,
}

impl WsStream {
    /// Open a WebSocket to `url` and resolve once `onopen` fires. The
    /// returned `WsStream` is then ready for `AsyncRead`/`AsyncWrite`.
    ///
    /// Returns `io::Error` if WebSocket construction fails (browser refused
    /// the URL) or if `onerror`/`onclose` fires before `onopen` (handshake
    /// failure).
    pub(crate) async fn open(url: &str) -> io::Result<Self> {
        let ws = WebSocket::new(url).map_err(js_err)?;
        ws.set_binary_type(BinaryType::Arraybuffer);

        let inner = Rc::new(RefCell::new(Inner::new()));

        // onopen: mark opened, wake any pending open-future.
        let on_open = {
            let inner = inner.clone();
            Closure::wrap(Box::new(move |_ev: JsValue| {
                let mut g = inner.borrow_mut();
                g.opened = true;
                g.wake_open();
            }) as Box<dyn FnMut(JsValue)>)
        };
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        // onmessage: extract bytes from ArrayBuffer (binaryType arraybuffer
        // is set above) or, for string frames, the UTF-8 bytes — but we
        // never expect string frames on this transport so a string frame is
        // an error.
        let on_message = {
            let inner = inner.clone();
            Closure::wrap(Box::new(move |ev: MessageEvent| {
                let data = ev.data();
                let bytes: Vec<u8> = if let Ok(ab) = data.clone().dyn_into::<js_sys::ArrayBuffer>() {
                    let arr = Uint8Array::new(&ab);
                    let mut v = vec![0u8; arr.length() as usize];
                    arr.copy_to(&mut v);
                    v
                } else if let Some(s) = data.as_string() {
                    // Unexpected: relay should always send binary. Surface as
                    // an error so the higher layer gives up rather than
                    // mis-framing UTF-8 as raw bytes.
                    let mut g = inner.borrow_mut();
                    g.error = Some(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("ws_stream: unexpected text frame ({} chars)", s.len()),
                    ));
                    g.wake_read();
                    return;
                } else {
                    let mut g = inner.borrow_mut();
                    g.error = Some(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "ws_stream: onmessage payload is neither ArrayBuffer nor string",
                    ));
                    g.wake_read();
                    return;
                };
                if bytes.is_empty() {
                    // Treat empty binary frames as a no-op rather than EOF;
                    // EOF is signaled by `onclose`.
                    return;
                }
                let mut g = inner.borrow_mut();
                g.rx_buf.push_back(bytes);
                g.wake_read();
            }) as Box<dyn FnMut(MessageEvent)>)
        };
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        // onerror: record the error, wake everyone.
        let on_error = {
            let inner = inner.clone();
            Closure::wrap(Box::new(move |_ev: ErrorEvent| {
                let mut g = inner.borrow_mut();
                if g.error.is_none() {
                    g.error = Some(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "ws_stream: WebSocket onerror",
                    ));
                }
                g.closed = true;
                g.wake_read();
                g.wake_open();
            }) as Box<dyn FnMut(ErrorEvent)>)
        };
        ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        // onclose: clean shutdown unless the code is non-1000.
        let on_close = {
            let inner = inner.clone();
            Closure::wrap(Box::new(move |ev: CloseEvent| {
                let mut g = inner.borrow_mut();
                g.closed = true;
                let code = ev.code();
                if !ev.was_clean() || (code != 1000 && code != 1005) {
                    if g.error.is_none() {
                        g.error = Some(io::Error::new(
                            io::ErrorKind::ConnectionReset,
                            format!(
                                "ws_stream: WebSocket closed code={} clean={}",
                                code,
                                ev.was_clean()
                            ),
                        ));
                    }
                }
                g.wake_read();
                g.wake_open();
            }) as Box<dyn FnMut(CloseEvent)>)
        };
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        // Park until onopen (or early error).
        OpenFuture {
            inner: inner.clone(),
        }
        .await?;

        Ok(Self {
            ws,
            inner,
            _on_open: on_open,
            _on_message: on_message,
            _on_error: on_error,
            _on_close: on_close,
        })
    }
}

impl Drop for WsStream {
    fn drop(&mut self) {
        // Detach JS callbacks so any in-flight events drop before the
        // closures are freed.
        self.ws.set_onopen(None);
        self.ws.set_onmessage(None);
        self.ws.set_onerror(None);
        self.ws.set_onclose(None);
        // Best-effort close; ignore errors (the socket may already be in a
        // closing/closed state).
        let _ = self.ws.close();
    }
}

/// Resolves when `Inner::opened` is true or `Inner::error` is set.
struct OpenFuture {
    inner: Rc<RefCell<Inner>>,
}

impl std::future::Future for OpenFuture {
    type Output = io::Result<()>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut g = self.inner.borrow_mut();
        if let Some(e) = g.error.take() {
            return Poll::Ready(Err(e));
        }
        if g.opened {
            return Poll::Ready(Ok(()));
        }
        g.open_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncRead for WsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let mut g = self.inner.borrow_mut();
        // Drain the front frame first. Errors from `onclose`/`onerror` are
        // surfaced ONLY after the buffered payload is fully drained — when an
        // HTTP/1.1 origin sends `Connection: close` it writes the response
        // body and immediately FINs, and the relay's `io.Copy` closes the WS
        // the moment it observes EOF in one direction. The close event can
        // therefore fire while the last response frames are still queued; if
        // we surfaced the error first we would TARGET_HTTP_FAILED valid
        // responses for any non-keepalive origin.
        let (n, drained) = {
            match g.rx_buf.front() {
                Some(front) => {
                    let cursor = g.read_cursor;
                    let avail = front.len() - cursor;
                    let n = avail.min(buf.len());
                    buf[..n].copy_from_slice(&front[cursor..cursor + n]);
                    (n, cursor + n >= front.len())
                }
                None => (0, false),
            }
        };
        if n > 0 {
            if drained {
                g.rx_buf.pop_front();
                g.read_cursor = 0;
            } else {
                g.read_cursor += n;
            }
            return Poll::Ready(Ok(n));
        }
        // Buffer empty. Now surface any buffered error (consumes it).
        if let Some(e) = g.error.take() {
            return Poll::Ready(Err(e));
        }
        // EOF after onclose.
        if g.closed {
            return Poll::Ready(Ok(0));
        }
        // Park.
        g.read_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        // Surface an already-observed error first.
        {
            let mut g = self.inner.borrow_mut();
            if let Some(e) = g.error.take() {
                return Poll::Ready(Err(e));
            }
            if g.closed {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "ws_stream: write after close",
                )));
            }
        }
        // `send_with_u8_array` takes a &[u8] directly; the JS side copies
        // into its own buffer. Empty writes are a no-op (don't generate
        // an empty frame).
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        match self.ws.send_with_u8_array(buf) {
            Ok(()) => Poll::Ready(Ok(buf.len())),
            Err(e) => Poll::Ready(Err(js_err(e))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // The browser owns the socket buffer; there's no flush primitive
        // exposed to JS. Higher layers that need ordering rely on TCP
        // (provided by the relay's dialer) preserving byte order, which
        // it does.
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let _ = self.ws.close();
        let mut g = self.inner.borrow_mut();
        g.closed = true;
        Poll::Ready(Ok(()))
    }
}

fn js_err(v: JsValue) -> io::Error {
    let msg = v
        .as_string()
        .or_else(|| js_sys::JSON::stringify(&v).ok().and_then(|s| s.as_string()))
        .unwrap_or_else(|| "ws_stream: opaque JS error".to_string());
    io::Error::new(io::ErrorKind::Other, msg)
}

