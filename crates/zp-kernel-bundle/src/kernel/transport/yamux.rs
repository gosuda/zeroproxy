//! Yamux multiplex client: one shared `WsStream` carries N concurrent
//! target streams. Eliminates the per-request WebSocket handshake cost
//! when opening multiple TCP connections.
//!
//! TLS still runs inside each yamux stream: the relay server sees
//! yamux framing and ciphertext, never plaintext.
//!
//! ## Driver pattern
//!
//! `yamux::Connection` exposes only `poll_*` APIs, and `poll_new_outbound`
//! cannot be called concurrently with `poll_next_inbound` (both need
//! `Pin<&mut Connection>`). A single owning driver task holds the
//! `Connection` and serves `Cmd::Open` requests from `MuxSession` over an
//! mpsc/oneshot channel pair.
//!
//! The driver also drains inbound streams (a SOCKS5+TLS+HTTP client
//! never accepts inbound streams, so they are dropped).
//!
//! ## Lifecycle
//!
//! [`get_or_open`] returns a process-singleton (`thread_local` on
//! single-threaded WASM). The first call opens the WebSocket and spawns
//! the driver. Subsequent calls reuse the existing session. A driver
//! that observes WS EOF/error tears down the session so the next call
//! reconnects.

use std::cell::RefCell;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures::channel::{mpsc, oneshot};
use futures::future::poll_fn;
use futures::stream::StreamExt;
use futures_util::io::{AsyncRead, AsyncWrite};
use wasm_bindgen_futures::spawn_local;
use yamux::{Config, Connection, Mode, Stream as YStream};

use super::ws_stream::WsStream;

type OpenReply = oneshot::Sender<Result<YStream, io::Error>>;

enum Cmd {
    Open(OpenReply),
}

/// Cloneable handle to a yamux session. All accesses serialise through
/// the driver task; multiple call sites can `open_stream()` concurrently
/// from the same JS event loop without RefCell borrow conflicts.
#[derive(Clone)]
pub(crate) struct MuxSession {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl MuxSession {
    /// Open a new outbound yamux stream. Returns immediately when the
    /// stream is allocated client-side; subsequent SOCKS5 / TLS / HTTP
    /// bytes do the real round-trip.
    pub(crate) async fn open_stream(&self) -> io::Result<MuxStream> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .unbounded_send(Cmd::Open(tx))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "mux: driver gone"))?;
        let stream = rx.await.map_err(|_| {
            io::Error::new(io::ErrorKind::BrokenPipe, "mux: driver dropped reply")
        })??;
        Ok(MuxStream { inner: stream })
    }
}

/// Async byte stream view of one yamux stream. `yamux::Stream` already
/// implements `AsyncRead + AsyncWrite`; this newtype is a thin wrapper
/// so the rest of the transport stack (`socks5`, `tls`, `http1`) sees a
/// concrete type with stable bounds.
pub(crate) struct MuxStream {
    inner: YStream,
}

impl AsyncRead for MuxStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for MuxStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}

thread_local! {
    static SESSION: RefCell<Option<MuxSession>> = const { RefCell::new(None) };
}

/// Return the process-singleton mux session, opening it on first call.
/// `relay_url` is the WebSocket URL of the byte-pipe endpoint (e.g.
/// `wss://proxy.example/zp/ws-pipe`).
///
/// If the cached session's driver has exited, `open_stream` fails and the
/// caller invalidates the cache via [`invalidate`] (see `transport::fetch::fetch`).
pub(crate) async fn get_or_open(relay_url: &str) -> io::Result<MuxSession> {
    if let Some(s) = SESSION.with(|c| c.borrow().clone()) {
        return Ok(s);
    }
    let ws = WsStream::open(relay_url).await?;
    // Raise split_send_size from the 16 KiB default to 256 KiB to reduce
    // per-frame WebSocket message and WASM wakeup overhead when multiplexing
    // many concurrent streams.
    let mut cfg = Config::default();
    cfg.set_split_send_size(256 * 1024);
    let rx_pending = ws.rx_pending();
    let conn = Connection::new(ws, cfg, Mode::Client);
    let (cmd_tx, cmd_rx) = mpsc::unbounded::<Cmd>();
    spawn_local(drive(conn, cmd_rx, rx_pending));
    let session = MuxSession { tx: cmd_tx };
    SESSION.with(|c| *c.borrow_mut() = Some(session.clone()));
    Ok(session)
}

/// Clear the cached session when `open_stream` fails so the next request
/// opens a fresh WebSocket and yamux session.
pub(crate) fn invalidate() {
    SESSION.with(|c| *c.borrow_mut() = None);
}

/// Driver task: owns the yamux `Connection`, multiplexes inbound polling
/// with outbound `Open` commands. Exits when either side closes.
///
/// Inbound polling must never pause: yamux's state machine advances by
/// reading frames off the wire, so a request blocked on `poll_new_outbound`
/// will deadlock unless inbound frames continue draining concurrently.
/// The `poll_fn` below drives both directions on each tick.
async fn drive(
    mut conn: Connection<WsStream>,
    mut cmd_rx: mpsc::UnboundedReceiver<Cmd>,
    rx_pending: crate::kernel::transport::ws_stream::RxPending,
) {
    let mut pending: std::collections::VecDeque<OpenReply> = std::collections::VecDeque::new();
    loop {
        let event = poll_fn(|cx| {
            // (1) Drain any newly queued open requests. We always pull
            //     from cmd_rx first so backpressure doesn't accumulate.
            loop {
                match cmd_rx.poll_next_unpin(cx) {
                    Poll::Ready(Some(Cmd::Open(reply))) => pending.push_back(reply),
                    Poll::Ready(None) => return Poll::Ready(Event::Shutdown),
                    Poll::Pending => break,
                }
            }
            // (2) Always poll inbound to drive yamux state machine reads.
            //     Without this, frames pile up in the WS recv buffer and
            //     outbound opens never see their ACK.
            let mut made_progress = false;
            match Pin::new(&mut conn).poll_next_inbound(cx) {
                Poll::Ready(Some(Ok(stream))) => {
                    drop(stream); // client mode: ignore inbound streams
                    made_progress = true;
                }
                Poll::Ready(Some(Err(_))) | Poll::Ready(None) => return Poll::Ready(Event::Eof),
                Poll::Pending => {}
            }
            // (3) If a request is waiting, try to make it. Only the first
            //     pending one per tick; the next iteration handles more.
            if let Some(reply) = pending.pop_front() {
                match Pin::new(&mut conn).poll_new_outbound(cx) {
                    Poll::Ready(Ok(stream)) => {
                        let _ = reply.send(Ok(stream));
                        made_progress = true;
                    }
                    Poll::Ready(Err(e)) => {
                        let _ = reply.send(Err(io::Error::new(
                            io::ErrorKind::Other,
                            format!("yamux: open: {e}"),
                        )));
                        return Poll::Ready(Event::Eof);
                    }
                    Poll::Pending => {
                        // Put it back; we'll retry next tick when frames
                        // have flowed.
                        pending.push_front(reply);
                    }
                }
            }
            // Never park while the socket still holds un-parsed frames.
            // `poll_next_inbound` reports `Pending` once it has taken what it
            // wants for this tick, and `made_progress` only covers new inbound
            // streams and completed opens, not plain DATA frames for existing
            // streams.
            if made_progress || rx_pending.has_buffered() {
                // Re-poll immediately to drain anything else ready.
                cx.waker().wake_by_ref();
            }
            Poll::Pending
        })
        .await;

        match event {
            Event::Shutdown => {
                let _ = poll_fn(|cx| Pin::new(&mut conn).poll_close(cx)).await;
                invalidate();
                return;
            }
            Event::Eof => {
                // Drain any unfulfilled opens with an error so callers
                // don't hang forever.
                while let Some(reply) = pending.pop_front() {
                    let _ = reply.send(Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "yamux: connection closed",
                    )));
                }
                invalidate();
                return;
            }
        }
    }
}

enum Event {
    Shutdown,
    Eof,
}
