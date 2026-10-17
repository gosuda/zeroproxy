//! Per-origin connection pool with HTTP/1.1 keep-alive.
//!
//! Without this layer, every fetch (including subresources on the same host
//! as the document) pays a fresh SOCKS5 + TLS handshake. TLS handshakes
//! dominate latency under `rustls-rustcrypto` (pure-Rust ECDHE / AEAD), so
//! reusing `TlsStream` connections is a major page-load speedup alongside
//! HTTP/2.
//!
//! ## Model
//!
//! Each `PoolKey (scheme, host, port, isolation_key)` maps to a
//! `VecDeque<PooledConn>` (LIFO queue of `Tls` or `Plain` connections).
//!
//! * **Take**: pop the most-recently-used conn for the key (LIFO so the
//!   warmest TCP/TLS window stays warm). Returns `None` on a miss so the
//!   caller opens a fresh conn.
//! * **Put**: only after complete body framing and content decoding, when
//!   `codec::response_keepalive` permits reuse. Errors/cancellation drop it.
//! * **Stale recovery**: if the kept conn's next request errors at
//!   write/read time (typical: upstream silently dropped the idle
//!   socket), the caller opens a fresh conn and retries. We don't proactively
//!   ping; a quick failure-and-retry is cheaper than a heartbeat loop on
//!   every idle conn.
//!
//! ## TLS / yamux invariants preserved
//!
//! The cached `TlsStream` already has its handshake complete and is
//! sitting on a live yamux stream. Reusing it requires 0 round-trips for
//! TLS setup, SOCKS5, or the yamux SYN, leaving only the HTTP/1.1 request
//! and response on the wire.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::io::{AsyncRead, AsyncWrite};

use super::dialer::AsyncIo;
use super::http2::Http2Client;
use super::tls::TlsStream;

#[derive(Clone, Eq, PartialEq, Hash, Debug)]
pub(crate) struct PoolKey {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub isolation_key: String,
}

/// One pooled HTTP/1.1 connection (plain or TLS-wrapped). Both variants
/// implement `AsyncRead + AsyncWrite` over `Box<dyn AsyncIo>` from the
/// active `Dialer`.
pub(crate) enum PooledConn {
    Plain(Box<dyn AsyncIo>),
    Tls(Box<TlsStream<Box<dyn AsyncIo>>>),
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

/// Cap on idle conns kept per (scheme,host,port,isolation_key). Sites with bursty
/// fanout (CDN with N parallel requests) drain the pool then re-fill; we
/// don't want to hold 100+ idle yamux streams against the relay.
const MAX_IDLE_PER_KEY: usize = 6;
/// Cap on distinct `PoolKey` buckets across all origins and isolation keys.
const MAX_POOL_KEYS: usize = 64;

thread_local! {
    static POOL: RefCell<HashMap<PoolKey, VecDeque<PooledConn>>> =
        RefCell::new(HashMap::new());
    /// Per-origin HTTP/2 client. Unlike HTTP/1.1, one `Http2Client` serves
    /// every concurrent fetch to the origin via h2's stream multiplexing.
    /// Cloning `SendRequest` is cheap (Arc internally), so callers use
    /// `get_http2()` to grab a handle without returning it.
    static HTTP2_POOL: RefCell<HashMap<PoolKey, Http2Client>> =
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
        p.retain(|_, q| !q.is_empty());
        if !p.contains_key(&key) && p.len() >= MAX_POOL_KEYS {
            if let Some(evict) = p.keys().next().cloned() {
                p.remove(&evict);
            }
        }
        let q = p.entry(key).or_default();
        if q.len() >= MAX_IDLE_PER_KEY {
            // Drop the oldest (front) connection, which is most likely to
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
    HTTP2_POOL.with(|p| p.borrow_mut().clear());
}

/// Look up a live HTTP/2 client for the origin. Returns a clone of the
/// `Http2Client` (h2 stores the connection state behind an `Arc`) so
/// callers send concurrently without coordinating. Dead connections
/// (`is_alive()` false) are evicted and treated as a miss.
pub(crate) fn get_http2(key: &PoolKey) -> Option<Http2Client> {
    HTTP2_POOL.with(|p| {
        let mut p = p.borrow_mut();
        if let Some(client) = p.get(key) {
            if client.is_alive() {
                return Some(client.clone());
            }
            // Connection closed; drop the dead entry so the next caller
            // opens a fresh one.
            p.remove(key);
        }
        None
    })
}

/// Register an HTTP/2 client as the per-origin singleton. If an entry
/// already exists (race: two parallel fetches both opened a fresh
/// connection), the new client wins and the older one's streams drain
/// naturally.
pub(crate) fn put_http2(key: PoolKey, client: Http2Client) {
    HTTP2_POOL.with(|p| {
        let mut p = p.borrow_mut();
        if !p.contains_key(&key) && p.len() >= MAX_POOL_KEYS {
            if let Some(evict) = p.keys().next().cloned() {
                p.remove(&evict);
            }
        }
        p.insert(key, client);
    });
}

/// Drop the cached HTTP/2 client for `key`. Called when `send_request`
/// on a pooled clone fails: h2 0.4 has no synchronous liveness probe,
/// so the pool can hand out clones whose underlying connection has sent
/// GOAWAY or whose driver task has exited.
pub(crate) fn remove_http2(key: &PoolKey) {
    HTTP2_POOL.with(|p| {
        p.borrow_mut().remove(key);
    });
}
