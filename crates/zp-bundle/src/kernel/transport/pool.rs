//! Per-origin connection pool with HTTP/1.1 keep-alive.
//!
//! Without this layer, every fetch — even subresources on the same host
//! as the document — pays a fresh SOCKS5 + TLS handshake. TLS handshake
//! is dominant under `rustls-rustcrypto` (pure-Rust ECDHE / AEAD), so a
//! reused `TlsStream` is the largest single page-load speedup we can
//! land short of HTTP/2.
//!
//! ## Model
//!
//! ```text
//! ┌── PoolKey (scheme, host, port) ──┬─→ VecDeque<PooledConn>
//! │   "https" / "github.com" / 443   │   [Tls, Tls, Tls]   (LIFO)
//! │   "http"  / "127.0.0.1"  / 8080  │   [Plain]
//! └──────────────────────────────────┴────────────────────
//! ```
//!
//! * **Take**: pop the most-recently-used conn for the key (LIFO so the
//!   warmest TCP/TLS window stays warm). Miss → `None`; caller opens a
//!   fresh conn.
//! * **Put**: only if the response says we can keep going — see
//!   [`http1::response_is_keepalive`]. Otherwise drop the conn.
//! * **Stale recovery**: if the kept conn's next request errors at
//!   write/read time (typical: upstream silently dropped the idle
//!   socket), the caller opens a fresh conn and retries. We don't proactively
//!   ping; a quick failure-and-retry is cheaper than a heartbeat loop on
//!   every idle conn.
//!
//! ## TLS / yamux invariants preserved
//!
//! The cached `TlsStream` already has its handshake complete and is
//! sitting on a live yamux stream. Reusing it pushes:
//!   - 0 round-trips for TLS setup
//!   - 0 round-trips for SOCKS5 (already established by the prior request)
//!   - 0 round-trips for the yamux SYN
//!
//! …leaving only the HTTP/1.1 request + response on the same wire. That's
//! the same speedup curl / browsers get with native keep-alive.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::io::{AsyncRead, AsyncWrite};

use super::tls::TlsStream;
use super::yamux::MuxStream;

#[derive(Clone, Eq, PartialEq, Hash, Debug)]
pub(crate) struct PoolKey {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

/// One pooled connection. Either plain HTTP/1.1 over yamux (for `http://`
/// targets) or HTTP/1.1 over TLS over yamux (for `https://`). Both flavors
/// implement `AsyncRead + AsyncWrite` so the HTTP layer is provider-blind.
pub(crate) enum PooledConn {
    Plain(MuxStream),
    Tls(Box<TlsStream<MuxStream>>),
}

impl AsyncRead for PooledConn {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            PooledConn::Plain(s) => Pin::new(s).poll_read(cx, buf),
            PooledConn::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for PooledConn {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            PooledConn::Plain(s) => Pin::new(s).poll_write(cx, buf),
            PooledConn::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            PooledConn::Plain(s) => Pin::new(s).poll_flush(cx),
            PooledConn::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            PooledConn::Plain(s) => Pin::new(s).poll_close(cx),
            PooledConn::Tls(s) => Pin::new(s.as_mut()).poll_close(cx),
        }
    }
}

// ----- per-key idle queue ---------------------------------------------------

/// Cap on idle conns kept per (scheme,host,port). Sites with bursty
/// fanout (CDN with N parallel requests) drain the pool then re-fill; we
/// don't want to hold 100+ idle yamux streams against the relay.
const MAX_IDLE_PER_KEY: usize = 6;

thread_local! {
    static POOL: RefCell<HashMap<PoolKey, VecDeque<PooledConn>>> =
        RefCell::new(HashMap::new());
}

/// Take the most-recently-used idle conn for `key`, or `None`.
pub(crate) fn take(key: &PoolKey) -> Option<PooledConn> {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let q = p.get_mut(key)?;
        let c = q.pop_back();
        if q.is_empty() {
            p.remove(key);
        }
        c
    })
}

/// Park `conn` back for the given key. The caller has already verified
/// that the prior request finished cleanly and that the response permits
/// keep-alive. Overflow past `MAX_IDLE_PER_KEY` drops the oldest entry.
pub(crate) fn put(key: PoolKey, conn: PooledConn) {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let q = p.entry(key).or_default();
        if q.len() >= MAX_IDLE_PER_KEY {
            // Drop the oldest (front) — that's the conn most likely to
            // have been idled out upstream.
            q.pop_front();
        }
        q.push_back(conn);
    });
}

/// Wipe the entire pool. Useful when the yamux session dies (no point
/// holding `MuxStream`s whose parent connection is gone).
pub(crate) fn clear() {
    POOL.with(|p| p.borrow_mut().clear());
}
