//! Yamux multiplex client: one shared `WsStream` carries N concurrent
//! target streams. Eliminates the per-request WebSocket handshake cost
//! that dominates page-load latency when 30+ subresources need fresh
//! TCP connections.
//!
//! TLS still runs **inside** each yamux stream — the relay server sees
//! yamux framing + ciphertext, never plaintext. yamux is purely about
//! WebSocket-handshake amortisation; the client-TLS invariant is
//! untouched.
//!
//! ## Driver pattern
//!
//! `yamux::Connection` exposes only `poll_*` APIs, and `poll_new_outbound`
//! cannot be called concurrently with `poll_next_inbound` (both need
//! `Pin<&mut Connection>`). The standard workaround is a single owning
//! driver task that owns the `Connection` and serves requests from a
//! channel:
//!
//! ```text
//! WsStream ─┬─→ yamux::Connection ──→ driver_task (spawn_local)
//!           ↑                            ↑
//!           │                            │ Cmd::OpenStream → oneshot
//!           └─ MuxSession (Rc, Clone) ───┘
//! ```
//!
//! The driver also drains inbound streams (a SOCKS5+TLS+HTTP client
//! never accepts inbound streams, so they're silently dropped — the
//! server doesn't initiate any).
//!
//! ## Lifecycle
//!
//! [`get_session`] returns a process-singleton (`thread_local`, fine on
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

// ----- session singleton ----------------------------------------------------

thread_local! {
    static SESSION: RefCell<Option<MuxSession>> = const { RefCell::new(None) };
}

/// Return the process-singleton mux session, opening it on first call.
/// `relay_url` is the WebSocket URL of the byte-pipe endpoint (e.g.
/// `wss://proxy.example/zp/ws-pipe`).
///
/// If the cached session's driver has died (WS dropped, GoAway received,
/// etc.) the caller's `open_stream` will fail and a follow-up call lands
/// here — but the cached session still says "I'm fine". Detecting death
/// vs busy is non-trivial with mpsc::unbounded; the simplest robust
/// recovery is to invalidate the cache when `open_stream` fails (see
/// `transport::fetch::fetch`).
pub(crate) async fn get_or_open(relay_url: &str) -> io::Result<MuxSession> {
    if let Some(s) = SESSION.with(|c| c.borrow().clone()) {
        return Ok(s);
    }
    let ws = WsStream::open(relay_url).await?;
    // 2026-06-13 throughput fix: NAVER 메인 같은 이미지-heavy 페이지에서
    // 28+ 동시 스트림이 단일 WS/yamux 세션으로 다중화되며 throughput 붕괴
    // → 모든 다운로드가 ~243s stall 후 동시 release (real Chrome 측정).
    // 원인: (a) split_send_size 기본 16KB 라 500KB 이미지 = 32 frame, 28
    // 스트림 × 32 = ~900 frame 이 단일 WS 를 통과하며 frame-당 wasm wake
    // 오버헤드, (b) per-stream receive window 가 256KB 에서 시작해 RTT 마다
    // 성장 — proxied high-latency 경로에서 성장이 느려 sender 가 자주 stall.
    // split_send_size 를 256KB 로 키워 frame 수 1/16 + WS message 오버헤드
    // 감소. max_connection_receive_window 는 기본 1GiB 유지 (충분).
    let mut cfg = Config::default();
    cfg.set_split_send_size(256 * 1024);
    let conn = Connection::new(ws, cfg, Mode::Client);
    let (cmd_tx, cmd_rx) = mpsc::unbounded::<Cmd>();
    spawn_local(drive(conn, cmd_rx));
    let session = MuxSession { tx: cmd_tx };
    SESSION.with(|c| *c.borrow_mut() = Some(session.clone()));
    Ok(session)
}

/// Forget the cached session. Called when `open_stream` fails — likely
/// the WS / yamux session is dead and the next request should open a
/// fresh one.
pub(crate) fn invalidate() {
    SESSION.with(|c| *c.borrow_mut() = None);
}

/// Driver task: owns the yamux `Connection`, multiplexes inbound polling
/// with outbound `Open` commands. Exits when either side closes.
///
/// The key invariant: **inbound polling must never pause**. yamux's state
/// machine advances by reading frames off the wire, so a request blocked
/// on `poll_new_outbound` will deadlock unless we keep draining inbound
/// concurrently — outbound opens depend on the server's RST/ACK frames
/// flowing through the same socket. A naive `select! { open => ..., inb
/// => .. }` that `.await`s `poll_new_outbound` inside the open arm stops
/// the inbound pump until the open completes, and the open never
/// completes because the inbound pump stopped. The poll_fn below drives
/// both each tick.
async fn drive(mut conn: Connection<WsStream>, mut cmd_rx: mpsc::UnboundedReceiver<Cmd>) {
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
            // (2) Always poll inbound — drives the yamux state machine
            //     reads. Without this, frames pile up in the WS recv
            //     buffer and the outbound open never sees its ACK.
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
            if made_progress {
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
