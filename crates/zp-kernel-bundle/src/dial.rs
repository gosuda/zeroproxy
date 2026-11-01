//! Host-portable dialer contract.
//!
//! The pluggable raw-connection factory sits between the HTTP/TLS layers and
//! whatever terminates the bytes (relay pipeline, direct, Tor, in-process).
//! Only the contract lives here so it compiles and is testable on every target;
//! the wasm-only default (`RelayDialer`) lives in `kernel::transport::dialer`.
//!
//! Futures are `LocalBoxFuture` and the injected dialer is an `Rc`: the kernel
//! is single-threaded, so none of this needs `Send`.

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use futures_util::io::{AsyncRead, AsyncWrite};

/// Byte stream produced by a [`Dialer`]. Marker trait so
/// `Box<dyn AsyncIo>` can flow through `TlsStream`/`http1`/`http2`, which
/// only require `AsyncRead + AsyncWrite + Unpin`.
pub trait AsyncIo: AsyncRead + AsyncWrite + Unpin {}
impl<T: AsyncRead + AsyncWrite + Unpin> AsyncIo for T {}

/// TCP-level endpoint the dialer must reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetAddr {
    pub host: String,
    pub port: u16,
    pub isolation_key: Option<String>,
}

/// Structured error returned by [`Dialer::connect`]. The wasm boundary turns it
/// into the wire `TARGET_CONNECT_FAILED:*` `JsValue` format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialError {
    /// Failed to establish or open a multiplexed stream on the relay session.
    RelaySession { stage: &'static str, detail: String },
    /// Upstream SOCKS5 or target TCP connect failed.
    TargetConnect { stage: &'static str, detail: String },
    /// Custom embedder-supplied dial failure.
    Custom { code: &'static str, detail: String },
}

impl DialError {
    pub fn code(&self) -> &'static str {
        match self {
            DialError::RelaySession { stage, .. } | DialError::TargetConnect { stage, .. } => stage,
            DialError::Custom { code, .. } => code,
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            DialError::RelaySession { detail, .. }
            | DialError::TargetConnect { detail, .. }
            | DialError::Custom { detail, .. } => detail,
        }
    }
}

impl fmt::Display for DialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.detail())
    }
}

impl std::error::Error for DialError {}

/// Pluggable raw-byte-connection factory.
pub trait Dialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay_url: &'a str,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, DialError>>;
}

thread_local! {
    /// Host-injected dialer. `None` means the target's default pipeline.
    static CURRENT: RefCell<Option<Rc<dyn Dialer>>> = RefCell::new(None);
}

/// The dialer installed with [`set_dialer`], if any.
pub fn injected_dialer() -> Option<Rc<dyn Dialer>> {
    CURRENT.with(|c| c.borrow().clone())
}

/// Embedder hook: install a custom `Dialer` before the first fetch.
/// Deliberately not a `#[wasm_bindgen]` export: hosts implement the trait in
/// Rust and link it; the JS-side transport contract is unchanged.
pub fn set_dialer(d: Rc<dyn Dialer>) {
    CURRENT.with(|c| *c.borrow_mut() = Some(d));
}

/// Remove the injected dialer so the default pipeline applies again.
pub fn clear_dialer() {
    CURRENT.with(|c| *c.borrow_mut() = None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::io::{AsyncReadExt, AsyncWriteExt, Cursor};
    use futures_util::task::noop_waker_ref;
    use std::future::Future;
    use std::task::{Context, Poll};

    fn block_on<F: Future>(fut: F) -> F::Output {
        let mut fut = Box::pin(fut);
        let mut cx = Context::from_waker(noop_waker_ref());
        loop {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
        }
    }

    struct FixedBytes(Vec<u8>);

    impl Dialer for FixedBytes {
        fn connect<'a>(
            &'a self,
            target: &'a TargetAddr,
            _relay_url: &'a str,
        ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, DialError>> {
            Box::pin(async move {
                if target.host == "refused.test" {
                    return Err(DialError::Custom {
                        code: "TARGET_CONNECT_FAILED:refused",
                        detail: format!("{}:{}", target.host, target.port),
                    });
                }
                Ok(Box::new(Cursor::new(self.0.clone())) as Box<dyn AsyncIo>)
            })
        }
    }

    fn addr(host: &str) -> TargetAddr {
        TargetAddr {
            host: host.into(),
            port: 443,
            isolation_key: None,
        }
    }

    #[test]
    fn injected_dialer_hands_back_a_usable_stream() {
        set_dialer(Rc::new(FixedBytes(b"hello".to_vec())));
        let d = injected_dialer().expect("dialer was installed");
        let target = addr("example.test");
        let mut stream = block_on(d.connect(&target, "wss://relay.test/zp/ws-pipe")).unwrap();
        let mut buf = Vec::new();
        block_on(stream.read_to_end(&mut buf)).unwrap();
        assert_eq!(buf, b"hello");
        block_on(stream.write_all(b"!")).unwrap();
        clear_dialer();
        assert!(injected_dialer().is_none());
    }

    #[test]
    fn dial_error_carries_wire_code_and_detail() {
        set_dialer(Rc::new(FixedBytes(Vec::new())));
        let d = injected_dialer().unwrap();
        let target = addr("refused.test");
        let err = block_on(d.connect(&target, ""))
            .err()
            .expect("connect must fail");
        clear_dialer();
        assert_eq!(err.code(), "TARGET_CONNECT_FAILED:refused");
        assert_eq!(err.detail(), "refused.test:443");
        assert_eq!(
            err.to_string(),
            "TARGET_CONNECT_FAILED:refused: refused.test:443"
        );
    }

    #[test]
    fn relay_and_target_errors_report_their_stage_as_code() {
        let relay = DialError::RelaySession {
            stage: "TARGET_CONNECT_FAILED:mux-open",
            detail: "x".into(),
        };
        let target = DialError::TargetConnect {
            stage: "TARGET_CONNECT_FAILED:socks5",
            detail: "y".into(),
        };
        assert_eq!(relay.code(), "TARGET_CONNECT_FAILED:mux-open");
        assert_eq!(target.code(), "TARGET_CONNECT_FAILED:socks5");
    }
}
