//! Embedding seam: pluggable raw-connection factory.
//!
//! ```text
//! open_fresh(fetch.rs)
//!   └─ Dialer::connect(target, relay_url)
//!        ├─ RelayDialer (default): yamux session + SOCKS5 CONNECT
//!        └─ host-injected Dialer: direct/Tor/CONNECT/in-process
//! ```
//!
//! TLS and HTTP layering above the returned byte stream are unchanged;
//! a Dialer only decides where raw bytes terminate.
//!
//! The kernel is `wasm32`-only and single-threaded, so the trait uses
//! `LocalBoxFuture` + `Rc` rather than `Send`/`BoxFuture`.

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use futures_util::io::{AsyncRead, AsyncWrite};
use wasm_bindgen::JsValue;

use super::fetch::jserr;
use super::pool;
use super::socks5::{self, Auth};
use super::yamux;

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

/// Structured error returned by [`Dialer::connect`]. Converts into the wire
/// `TARGET_CONNECT_FAILED:*` `JsValue` format at the JS boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialError {
    /// Failed to establish or open a multiplexed stream on the relay session.
    RelaySession {
        stage: &'static str,
        detail: String,
    },
    /// Upstream SOCKS5 or target TCP connect failed.
    TargetConnect {
        stage: &'static str,
        detail: String,
    },
    /// Custom embedder-supplied dial failure.
    Custom {
        code: &'static str,
        detail: String,
    },
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

    pub fn into_js_error(self) -> JsValue {
        jserr(self.code(), &self.detail())
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

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn delta_ms(t0: f64) -> u32 {
    (now_ms() - t0).max(0.0) as u32
}

/// Default pipeline: shared yamux session over `/zp/ws-pipe`,
/// one stream per connection, SOCKS5 `CONNECT` through the relay.
pub struct RelayDialer;

impl Dialer for RelayDialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay_url: &'a str,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, DialError>> {
        Box::pin(async move {
            let t0 = now_ms();
            let t_mux = t0;
            let session = yamux::get_or_open(relay_url).await.map_err(|e| {
                crate::kernel::push_trace(&format!(
                    "tx:mux-session-err err={} t={}ms",
                    e,
                    delta_ms(t0)
                ));
                DialError::RelaySession {
                    stage: "TARGET_CONNECT_FAILED:mux-session",
                    detail: e.to_string(),
                }
            })?;
            let mut stream = match session.open_stream().await {
                Ok(s) => s,
                Err(e) => {
                    crate::kernel::push_trace(&format!(
                        "tx:mux-open-err host={} err={} t={}ms (reopening)",
                        target.host,
                        e,
                        delta_ms(t0)
                    ));
                    yamux::invalidate();
                    pool::clear();
                    let session = yamux::get_or_open(relay_url).await.map_err(|e| {
                        DialError::RelaySession {
                            stage: "TARGET_CONNECT_FAILED:mux-reopen",
                            detail: e.to_string(),
                        }
                    })?;
                    session.open_stream().await.map_err(|e| {
                        crate::kernel::push_trace(&format!(
                            "tx:mux-open-err2 host={} err={} t={}ms",
                            target.host,
                            e,
                            delta_ms(t0)
                        ));
                        DialError::RelaySession {
                            stage: "TARGET_CONNECT_FAILED:mux-open",
                            detail: e.to_string(),
                        }
                    })?
                }
            };
            crate::kernel::push_trace(&format!(
                "tx:mux-stream-ok host={} mux={}ms t={}ms",
                target.host,
                delta_ms(t_mux),
                delta_ms(t0)
            ));

            let auth = match target.isolation_key.as_deref() {
                Some(k) if (1..=255).contains(&k.len()) => Auth::UserPassword {
                    user: k.to_string(),
                    pass: "zp".to_string(),
                },
                _ => Auth::None,
            };
            let t_socks = now_ms();
            socks5::connect(&mut stream, &target.host, target.port, &auth)
                .await
                .map_err(|e| {
                    crate::kernel::push_trace(&format!(
                        "tx:socks5-err host={} err={} t={}ms",
                        target.host,
                        e,
                        delta_ms(t0)
                    ));
                    DialError::TargetConnect {
                        stage: "TARGET_CONNECT_FAILED:socks5",
                        detail: e.to_string(),
                    }
                })?;
            crate::kernel::push_trace(&format!(
                "tx:socks5-ok host={} socks5={}ms t={}ms",
                target.host,
                delta_ms(t_socks),
                delta_ms(t0)
            ));

            Ok(Box::new(stream) as Box<dyn AsyncIo>)
        })
    }
}

thread_local! {
    /// Host-injected dialer. `None` means the default relay pipeline.
    static CURRENT: RefCell<Option<Rc<dyn Dialer>>> = RefCell::new(None);
}

/// Active dialer: the injected one, or a fresh `RelayDialer`.
pub fn dialer() -> Rc<dyn Dialer> {
    CURRENT
        .with(|c| c.borrow().clone())
        .unwrap_or_else(|| Rc::new(RelayDialer))
}

/// Embedder hook: install a custom `Dialer` before the first fetch.
/// Deliberately not a `#[wasm_bindgen]` export: wasm hosts implement the
/// trait in Rust and link it; the JS-side transport contract is unchanged.
pub fn set_dialer(d: Rc<dyn Dialer>) {
    CURRENT.with(|c| *c.borrow_mut() = Some(d));
}
