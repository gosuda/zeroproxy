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
//! [`rustls_rustcrypto`] supplies the crypto provider: pure-Rust ciphers
//! from the RustCrypto org. `ring` and `aws-lc-rs` are the conventional
//! choices in native Rust, but neither works on `wasm32-unknown-unknown`
//! (ring uses target-specific asm, aws-lc-rs requires the BoringSSL C lib).
//!
//! ## Root certificates
//!
//! [`webpki_roots::TLS_SERVER_ROOTS`] embeds Mozilla's CA bundle in the
//! binary so WASM needs no platform certificate access.
//!
//! ## ALPN
//!
//! Callers pass an `alpn` list; rustls advertises it during ClientHello
//! and exposes the negotiated value on the open connection. The HTTP layer
//! reads it to decide between HTTP/2 (`h2`) and HTTP/1.1 (`http/1.1`).
//!
//! ## JA3 fingerprint shaping
//!
//! Upstream WAFs penalize ClientHellos whose JA3 hash does not match a
//! browser. `rustls_rustcrypto::ALL_CIPHER_SUITES` puts TLS 1.2 ECDHE
//! suites before TLS 1.3, whereas Chrome emits TLS 1.3 first
//! (`0x1301, 0x1302, 0x1303`), followed by TLS 1.2 ECDHE interleaved by
//! AES key size.
//!
//! This module overrides `cipher_suites` on the `CryptoProvider` to
//! Chrome's order and prepends `X25519MLKEM768` to `kx_groups`, while the
//! rustls fork shapes GREASE, extension ordering, and decoy cipher suites
//! from `ja3::CapturedSpec` when installed.

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
    /// on every fetch is expensive: `webpki_roots::TLS_SERVER_ROOTS`
    /// inserts and indexes 145 certificates into a `RootCertStore`, and
    /// `rustls_rustcrypto::provider()` runs per-call setup. Caching makes
    /// this a one-time cost per ALPN combination (`["http/1.1"]` or
    /// `["h2", "http/1.1"]`).
    static CONFIG_CACHE: RefCell<Vec<(Vec<Vec<u8>>, Arc<ClientConfig>)>> = const {
        RefCell::new(Vec::new())
    };
}

/// Build a Chrome-ordered cipher suite list from `rustls_rustcrypto`'s
/// public constants. Order matches Chrome's TLS ClientHello:
/// TLS 1.3 first (`AES128, AES256, CHACHA20`), then TLS 1.2 ECDHE
/// suites interleaved by AES key size (each `ECDHE_ECDSA` suite followed
/// by its `ECDHE_RSA` counterpart).
///
/// This list contains the 9 negotiable suites implemented by
/// `rustls_rustcrypto`. When `ja3::CapturedSpec` is installed, the rustls
/// fork's `client::hs::apply_chrome_ja3_shape` overrides the wire-emitted
/// ClientHello cipher list to include legacy RSA fallback cipher IDs
/// (49171, 49172, 156, 157, 47, 53) as non-negotiated decoys.
fn chrome_ordered_cipher_suites() -> Vec<rustls::SupportedCipherSuite> {
    use rustls_rustcrypto as rc;
    vec![
        // TLS 1.3 (Chrome order: AES128, AES256, CHACHA20)
        rc::TLS13_AES_128_GCM_SHA256,
        rc::TLS13_AES_256_GCM_SHA384,
        rc::TLS13_CHACHA20_POLY1305_SHA256,
        // TLS 1.2 ECDHE interleaved by AES size:
        // AES128 ECDSA, AES128 RSA
        rc::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        rc::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        // AES256 ECDSA, AES256 RSA
        rc::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
        rc::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        // CHACHA20 ECDSA, CHACHA20 RSA
        rc::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
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
        let mut provider = rustls_rustcrypto::provider();
        provider.cipher_suites = chrome_ordered_cipher_suites();
        // Prepend X25519MLKEM768 hybrid (group 0x11ec = 4588) so a captured
        // Chrome ClientHello with `supportedCurves: [4588, 29, 23, 24]`
        // emits both the 1216-byte hybrid share and the classical X25519
        // sibling via `ActiveKeyExchange::hybrid_component`.
        let mut kx_groups = provider.kx_groups.clone();
        kx_groups.insert(0, &super::mlkem_hybrid::X25519MLKEM768);
        provider.kx_groups = kx_groups;
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
        // ServerName::try_from rejects IP literals; callers only pass hostnames.
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
    /// write-drain and read-fill until rustls reports the handshake done.
    async fn handshake(&mut self) -> io::Result<()> {
        while self.conn.is_handshaking() {
            // Drain any pending outbound TLS bytes.
            self.drain_pending_out().await?;
            while self.conn.wants_write() {
                let mut chunk = Vec::with_capacity(4096);
                self.conn.write_tls(&mut chunk).map_err(|e| {
                    io::Error::new(io::ErrorKind::Other, format!("tls: write_tls: {e}"))
                })?;
                self.inner.write_all(&chunk).await?;
            }
            self.inner.flush().await?;

            // If we still need more from the peer, read it.
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

// After handshake completes, reads pull plaintext via `conn.reader()` and
// writes push plaintext via `conn.writer()`. The state-machine pump runs
// inside the poll fns: on poll_read we may need to refill the encrypted
// inbound buffer; on poll_write we always need to flush encrypted outbound.
//
// We park on the *inner* stream's wakers: when the underlying byte stream
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
                    // Read errors here are typically `WouldBlock` when no
                    // plaintext is ready; fall through to refill.
                }
            }

            // No plaintext yet. Before polling the socket, feed rustls any
            // ciphertext already buffered in `pending_in`.
            //
            // `read_tls` consumes at most one TLS message per call, so a single
            // 8 KiB socket read can leave whole records in `pending_in`.
            // Draining `pending_in` first ensures buffered records are
            // decrypted before parking on the socket (`consumed == 0`).
            if !self.pending_in.is_empty() {
                let raw = std::mem::take(&mut self.pending_in);
                let mut slice: &[u8] = &raw;
                let read_res = self.conn.read_tls(&mut slice);
                let consumed = raw.len() - slice.len();
                self.pending_in = slice.to_vec();
                read_res.map_err(|e| {
                    io::Error::new(io::ErrorKind::Other, format!("tls: read_tls: {e}"))
                })?;
                if consumed > 0 {
                    self.conn.process_new_packets().map_err(|e| {
                        io::Error::new(io::ErrorKind::InvalidData, format!("tls: process: {e}"))
                    })?;
                    continue; // retry plaintext extraction
                }
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
        // Push plaintext into rustls.
        let written = match self.conn.writer().write(buf) {
            Ok(n) => n,
            Err(e) => return Poll::Ready(Err(e)),
        };
        // Drain encrypted bytes produced by rustls into `pending_out`.
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
        // Write as many of `pending_out`'s bytes as the inner stream
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
