//! Client-side TLS via rustls, driven async over an `AsyncRead + AsyncWrite`
//! byte stream (typically a SOCKS5-tunnelled stream).
//!
//! rustls is fundamentally synchronous: you push encrypted bytes into the
//! `ClientConnection` with `read_tls`, pull encrypted bytes out with
//! `write_tls`, and exchange plaintext via `reader()`/`writer()`. This
//! module bridges that sync API into a futures-based async stream by
//! buffering bytes through `pending_in` / `pending_out` and explicitly
//! pumping the state machine inside `poll_read` / `poll_write`.
//!
//! ## Provider
//!
//! [`rustls_rustcrypto`] supplies the crypto provider — pure-Rust ciphers
//! from the RustCrypto org. `ring` and `aws-lc-rs` are the conventional
//! choices in native Rust but neither works on `wasm32-unknown-unknown`
//! (ring uses target-specific asm, aws-lc-rs requires the BoringSSL C lib).
//! rustcrypto is slower but works.
//!
//! ## Root certificates
//!
//! [`webpki_roots::TLS_SERVER_ROOTS`] — Mozilla's CA bundle baked into
//! the binary. Same trust store that ships with curl/most browsers'
//! defaults; no platform/system root access needed (which is what we
//! want — we're in WASM, no platform certs).
//!
//! ## ALPN
//!
//! Callers pass an `alpn` list; rustls advertises it during ClientHello
//! and exposes the negotiated value on the open connection. The HTTP layer
//! reads it to decide between HTTP/2 (`h2`) and HTTP/1.1 (`http/1.1`).
//!
//! ## JA3 fingerprint shaping (phase 1: cipher reorder)
//!
//! NAVER's WAF (nid.naver.com login) imposes a ~60s "slow lane" on
//! ClientHellos whose JA3 hash doesn't look browser-like. rustls's
//! default ordering — pulled from `rustls_rustcrypto::ALL_CIPHER_SUITES` —
//! puts TLS 1.2 ECDHE suites *before* TLS 1.3, which is the inverse of
//! every real browser. Chrome 134 emits TLS 1.3 first
//! (`0x1301, 0x1302, 0x1303`), then TLS 1.2 ECDHE in `AES128, AES256,
//! CHACHA` order, ECDHE_ECDSA then ECDHE_RSA.
//!
//! Phase 1 (this module): override `cipher_suites` on the
//! `CryptoProvider` to Chrome's order. No rustls fork — fully public API.
//! Flips the JA3 hash; whether the new hash also bypasses NAVER's
//! blocklist is what we're verifying.
//!
//! Phase 2 (pending — rustls fork): GREASE injection (RFC 8701) and the
//! extensions Chrome sends that rustls doesn't (`record_size_limit`,
//! `renegotiation_info`, ALPS, padding ordering). Required for an exact
//! Chrome JA3 match if phase 1 isn't enough.
//!
//! ## What this module still doesn't do
//!
//! * **No session resumption / 0-RTT.** Future optimisation.
//! * **No client certificates.** None of our target sites need them.

use std::cell::RefCell;
use std::io;
// `Read`/`Write` are brought in unprefixed so rustls's sync `Reader`/`Writer`
// methods resolve. The futures `Async*` traits are scoped to where the
// stream impls live; no collision because we never call `.read`/`.write` on
// the futures side directly (we go through `Pin::new(&mut inner).poll_*`).
use std::io::{Read as _, Write as _};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_util::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use rustls_pki_types::ServerName;

thread_local! {
    /// Cached `ClientConfig`s keyed by ALPN list. Rebuilding the config
    /// on every fetch dominates `tls:` timing — `webpki_roots::TLS_SERVER_ROOTS`
    /// is 145 certificates that must be inserted into a fresh
    /// `RootCertStore` and indexed for trust-anchor lookup, plus the
    /// `rustls_rustcrypto::provider()` does its own per-call setup. That
    /// work is 20-80ms inside WASM on a modest machine. Caching moves it
    /// to a one-time cost per ALPN combination per browsing session.
    ///
    /// Today only `["http/1.1"]` is ever requested; once h2 lands a
    /// second entry for `["h2","http/1.1"]` joins it. A `Vec<Vec<u8>>`
    /// key fits both cases without a separate cache shape.
    static CONFIG_CACHE: RefCell<Vec<(Vec<Vec<u8>>, Arc<ClientConfig>)>> = const {
        RefCell::new(Vec::new())
    };
}

/// Build (or reuse) a `ClientConfig` for the requested ALPN protocol list.
/// First call per ALPN: certificate-store + crypto-provider initialisation.
/// Cached calls: an `Arc::clone`. The `Arc<ClientConfig>` shares the heavy
/// internal state (root store, crypto provider) so a TLS handshake
/// allocates only the per-connection `ClientConnection` itself.
/// Build a Chrome-ordered cipher suite list from `rustls_rustcrypto`'s
/// public constants. Order matches Chrome 134 stable's TLS ClientHello:
/// TLS 1.3 first (`AES128, AES256, CHACHA20`), then TLS 1.2 ECDHE_ECDSA,
/// then ECDHE_RSA, both in `AES128, AES256, CHACHA20` per-family order.
///
/// JA3's "Cipher" component hashes this list verbatim, so changing the
/// order changes the hash. rustls's stock ordering is TLS 1.2 first,
/// which is the giveaway — no browser does that today.
fn chrome_ordered_cipher_suites() -> Vec<rustls::SupportedCipherSuite> {
    use rustls_rustcrypto as rc;
    vec![
        // TLS 1.3 (Chrome: AES128 → AES256 → CHACHA20)
        rc::TLS13_AES_128_GCM_SHA256,
        rc::TLS13_AES_256_GCM_SHA384,
        rc::TLS13_CHACHA20_POLY1305_SHA256,
        // TLS 1.2 ECDHE_ECDSA (Chrome: AES128 → AES256 → CHACHA20)
        rc::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        rc::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
        rc::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
        // TLS 1.2 ECDHE_RSA (Chrome: AES128 → AES256 → CHACHA20)
        rc::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        rc::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        rc::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
    ]
}

fn build_client_config(alpn: &[&[u8]]) -> io::Result<Arc<ClientConfig>> {
    let wanted: Vec<Vec<u8>> = alpn.iter().map(|p| p.to_vec()).collect();
    CONFIG_CACHE.with(|cell| -> io::Result<Arc<ClientConfig>> {
        if let Some((_, c)) = cell.borrow().iter().find(|(k, _)| k == &wanted) {
            return Ok(c.clone());
        }
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        // Phase-1 JA3 shaping: replace rustls-rustcrypto's stock
        // `cipher_suites` (TLS 1.2 first) with Chrome's ordering (TLS 1.3
        // first). Everything else on the provider — KX groups, signing,
        // KeyProvider — stays as rustls-rustcrypto built it.
        let mut provider = rustls_rustcrypto::provider();
        provider.cipher_suites = chrome_ordered_cipher_suites();
        let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("tls: config: {e}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        config.alpn_protocols = wanted.clone();
        let arc = Arc::new(config);
        cell.borrow_mut().push((wanted, arc.clone()));
        Ok(arc)
    })
}

/// Async TLS stream wrapping a byte-stream inner. Implements
/// `AsyncRead + AsyncWrite` over rustls's sync state machine.
pub struct TlsStream<S> {
    inner: S,
    conn: ClientConnection,
    /// Encrypted bytes read from `inner` but not yet consumed by
    /// `conn.read_tls()`. We refill this when rustls says it wants more
    /// input, then hand the slice to `read_tls` which copies as much as
    /// it can into its internal record buffer.
    pending_in: Vec<u8>,
    /// Encrypted bytes produced by `conn.write_tls()` but not yet flushed
    /// to `inner`. Drained inside `poll_write` / `poll_flush`.
    pending_out: Vec<u8>,
    /// `true` once we observe a clean close-notify or EOF. Subsequent
    /// `poll_read` returns `Ok(0)`.
    eof_observed: bool,
}

impl<S> TlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// Open a TLS connection: build config, instantiate `ClientConnection`,
    /// then drive the handshake to completion before returning. After this
    /// resolves, plaintext reads/writes succeed.
    pub async fn connect(inner: S, server_name: &str, alpn: &[&[u8]]) -> io::Result<Self> {
        let config = build_client_config(alpn)?;
        // ServerName::try_from rejects IP literals — fine; we only ever
        // pass hostnames here.
        let name = ServerName::try_from(server_name.to_string())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("tls: SNI: {e}")))?;
        let conn = ClientConnection::new(config, name)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("tls: new conn: {e}")))?;
        let mut s = Self {
            inner,
            conn,
            pending_in: Vec::new(),
            pending_out: Vec::new(),
            eof_observed: false,
        };
        s.handshake().await?;
        Ok(s)
    }

    /// Negotiated ALPN protocol, or `None` if the server didn't pick one
    /// (or didn't advertise the extension). Empty Vec is normalised to
    /// `None`.
    pub fn alpn_protocol(&self) -> Option<Vec<u8>> {
        self.conn.alpn_protocol().map(|p| p.to_vec())
    }

    /// Drive the handshake until `!conn.is_handshaking()`. Alternates
    /// write-drain ↔ read-fill until rustls reports the handshake done.
    async fn handshake(&mut self) -> io::Result<()> {
        while self.conn.is_handshaking() {
            // Phase 1: drain any pending outbound TLS bytes.
            self.drain_pending_out().await?;
            while self.conn.wants_write() {
                let mut chunk = Vec::with_capacity(4096);
                self.conn
                    .write_tls(&mut chunk)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("tls: write_tls: {e}")))?;
                self.inner.write_all(&chunk).await?;
            }
            self.inner.flush().await?;

            // Phase 2: if we still need more from the peer, read it.
            if self.conn.is_handshaking() && self.conn.wants_read() {
                self.read_more_into_conn().await?;
                self.conn.process_new_packets().map_err(|e| {
                    io::Error::new(io::ErrorKind::InvalidData, format!("tls: process: {e}"))
                })?;
            }
        }
        Ok(())
    }

    /// Read encrypted bytes from `inner` and feed them through `read_tls`.
    /// Bounded read; rustls processes whatever fits in one record buffer
    /// pass and we loop in the caller until handshake completes.
    async fn read_more_into_conn(&mut self) -> io::Result<()> {
        if self.pending_in.is_empty() {
            let mut tmp = [0u8; 8192];
            let n = self.inner.read(&mut tmp).await?;
            if n == 0 {
                self.eof_observed = true;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "tls: EOF before handshake completion",
                ));
            }
            self.pending_in.extend_from_slice(&tmp[..n]);
        }
        let mut slice: &[u8] = &self.pending_in;
        let consumed = self
            .conn
            .read_tls(&mut slice)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("tls: read_tls: {e}")))?;
        self.pending_in.drain(..consumed);
        Ok(())
    }

    /// Flush any encrypted bytes we owe `inner`. Idempotent.
    async fn drain_pending_out(&mut self) -> io::Result<()> {
        if !self.pending_out.is_empty() {
            // Take a local copy so we can borrow `inner` mut while writing.
            let payload = std::mem::take(&mut self.pending_out);
            self.inner.write_all(&payload).await?;
        }
        Ok(())
    }
}

// ---------- AsyncRead / AsyncWrite ----------------------------------------
//
// After handshake completes, reads pull plaintext via `conn.reader()` and
// writes push plaintext via `conn.writer()`. The state-machine pump runs
// inside the poll fns: on poll_read we may need to refill the encrypted
// inbound buffer; on poll_write we always need to flush encrypted outbound.
//
// We park on the *inner* stream's wakers — when the underlying byte stream
// has new bytes for us, the runtime wakes us and we re-poll the state
// machine. No separate waker bookkeeping needed.

impl<S> AsyncRead for TlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            // Try plaintext first.
            match self.conn.reader().read(buf) {
                Ok(0) if self.eof_observed => return Poll::Ready(Ok(0)),
                Ok(n) if n > 0 => return Poll::Ready(Ok(n)),
                Ok(_) | Err(_) => {
                    // Read errors here are typically "no data ready" —
                    // rustls returns std::io::Error::ErrorKind::WouldBlock
                    // in that case. Fall through to refill.
                }
            }

            // No plaintext available. Try to pump more from the wire.
            if !self.conn.wants_read() && self.pending_in.is_empty() {
                // rustls says it doesn't need more data, and we have no
                // bytes to give. EOF or true block. Probe the inner read:
                // if it returns 0 we're at EOF.
            }
            let mut tmp = [0u8; 8192];
            let read_poll = Pin::new(&mut self.inner).poll_read(cx, &mut tmp);
            match read_poll {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Ready(Ok(0)) => {
                    self.eof_observed = true;
                    // One more attempt to extract plaintext that's already
                    // decrypted but hadn't fit before; if nothing's there,
                    // return Ok(0).
                    return Poll::Ready(match self.conn.reader().read(buf) {
                        Ok(n) => Ok(n),
                        Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => Ok(0),
                        Err(e) => Err(e),
                    });
                }
                Poll::Ready(Ok(n)) => {
                    // Feed the new bytes to rustls and continue the loop.
                    // Take the buffer out so we don't simultaneously hold
                    // a borrow on `self.pending_in` *and* a mut borrow on
                    // `self.conn`. Whatever rustls leaves unread goes back.
                    self.pending_in.extend_from_slice(&tmp[..n]);
                    let raw = std::mem::take(&mut self.pending_in);
                    let mut slice: &[u8] = &raw;
                    let read_res = self.conn.read_tls(&mut slice);
                    let leftover = slice.to_vec();
                    self.pending_in = leftover;
                    read_res.map_err(|e| {
                        io::Error::new(io::ErrorKind::Other, format!("tls: read_tls: {e}"))
                    })?;
                    self.conn.process_new_packets().map_err(|e| {
                        io::Error::new(io::ErrorKind::InvalidData, format!("tls: process: {e}"))
                    })?;
                    // Loop back to try plaintext extraction again.
                }
            }
        }
    }
}

impl<S> AsyncWrite for TlsStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        // Step 1: push plaintext into rustls.
        let written = match self.conn.writer().write(buf) {
            Ok(n) => n,
            Err(e) => return Poll::Ready(Err(e)),
        };
        // Step 2: drain whatever encrypted bytes rustls produced into our
        // outbound buffer and try to flush them.
        while self.conn.wants_write() {
            let mut chunk = Vec::with_capacity(4096);
            if let Err(e) = self.conn.write_tls(&mut chunk) {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("tls: write_tls: {e}"),
                )));
            }
            self.pending_out.extend_from_slice(&chunk);
        }
        // Step 3: write as many of pending_out's bytes as the inner stream
        // will take right now without blocking.
        let pending = std::mem::take(&mut self.pending_out);
        let mut offset = 0;
        while offset < pending.len() {
            match Pin::new(&mut self.inner).poll_write(cx, &pending[offset..]) {
                Poll::Ready(Ok(0)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "tls: inner wrote 0 bytes",
                    )));
                }
                Poll::Ready(Ok(n)) => offset += n,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => {
                    // Stash the unsent tail and tell the caller we
                    // accepted `written` bytes of plaintext (rustls owns
                    // them now). The next poll_write/poll_flush will
                    // resume draining.
                    self.pending_out = pending[offset..].to_vec();
                    return Poll::Ready(Ok(written));
                }
            }
        }
        Poll::Ready(Ok(written))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Drain any TLS records rustls has buffered.
        while self.conn.wants_write() {
            let mut chunk = Vec::with_capacity(4096);
            if let Err(e) = self.conn.write_tls(&mut chunk) {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::Other,
                    format!("tls: write_tls: {e}"),
                )));
            }
            self.pending_out.extend_from_slice(&chunk);
        }
        // Write the buffered encrypted bytes.
        let pending = std::mem::take(&mut self.pending_out);
        let mut offset = 0;
        while offset < pending.len() {
            match Pin::new(&mut self.inner).poll_write(cx, &pending[offset..]) {
                Poll::Ready(Ok(0)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "tls: inner wrote 0 bytes during flush",
                    )));
                }
                Poll::Ready(Ok(n)) => offset += n,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => {
                    self.pending_out = pending[offset..].to_vec();
                    return Poll::Pending;
                }
            }
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Send a close_notify if we haven't already.
        self.conn.send_close_notify();
        // Try to drain the resulting alert + any pending writes.
        match self.as_mut().poll_flush(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.inner).poll_close(cx),
            other => other,
        }
    }
}

// TODO(test): handshake against a local TLS server (rcgen + a tokio
// listener loop on the host side) once the test infra split (see
// http1.rs note) lands. wasm-bindgen-test can also drive a handshake
// against a real public host inside Node, but that's a network-bound
// test. For now the SOCKS5 → TLS → HTTP integration is exercised
// end-to-end by the SW once `kernel_fetch` is rewired (Step 7).
