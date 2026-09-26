//! Embedding seam: pluggable raw-connection factory (REFACTOR.md §3.2).
//!
//! ```text
//! open_fresh(fetch.rs)
//!   └─ Dialer::connect(target, relay_url, t0)
//!        ├─ RelayDialer (default): yamux session → SOCKS5 CONNECT
//!        └─ host-injected Dialer: direct/Tor/CONNECT/in-process
//! ```
//!
//! TLS and HTTP layering above the returned byte stream are unchanged;
//! a Dialer only decides where raw bytes terminate. Errors stay `JsValue`
//! so existing `TARGET_CONNECT_FAILED:*` codes pass through verbatim.
//!
//! The kernel is `wasm32`-only and single-threaded, so the trait uses
//! `LocalBoxFuture` + `Rc` rather than `Send`/`BoxFuture`.

use std::cell::RefCell;
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
pub struct TargetAddr {
    pub host: String,
    pub port: u16,
}

/// Pluggable raw-byte-connection factory.
///
/// `t0` is the caller's `Date.now()` seed — implementations forward it to
/// `push_trace` deltas so stage-level latency attribution keeps working.
pub trait Dialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay_url: &'a str,
        t0: f64,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, JsValue>>;
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn delta_ms(t0: f64) -> u32 {
    (now_ms() - t0).max(0.0) as u32
}

/// Today's pipeline, verbatim: shared yamux session over `/zp/ws-pipe`,
/// one stream per connection, SOCKS5 `CONNECT` through the relay.
pub struct RelayDialer;

impl Dialer for RelayDialer {
    fn connect<'a>(
        &'a self,
        target: &'a TargetAddr,
        relay_url: &'a str,
        t0: f64,
    ) -> LocalBoxFuture<'a, Result<Box<dyn AsyncIo>, JsValue>> {
        Box::pin(async move {
            let t_mux = now_ms();
            let session = yamux::get_or_open(relay_url).await.map_err(|e| {
                crate::kernel::push_trace(&format!(
                    "tx:mux-session-err err={} t={}ms",
                    e,
                    delta_ms(t0)
                ));
                jserr("TARGET_CONNECT_FAILED:mux-session", &e)
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
                    let session = yamux::get_or_open(relay_url)
                        .await
                        .map_err(|e| jserr("TARGET_CONNECT_FAILED:mux-reopen", &e))?;
                    session.open_stream().await.map_err(|e| {
                        crate::kernel::push_trace(&format!(
                            "tx:mux-open-err2 host={} err={} t={}ms",
                            target.host,
                            e,
                            delta_ms(t0)
                        ));
                        jserr("TARGET_CONNECT_FAILED:mux-open", &e)
                    })?
                }
            };
            crate::kernel::push_trace(&format!(
                "tx:mux-stream-ok host={} mux={}ms t={}ms",
                target.host,
                delta_ms(t_mux),
                delta_ms(t0)
            ));

            let t_socks = now_ms();
            socks5::connect(&mut stream, &target.host, target.port, &Auth::None)
                .await
                .map_err(|e| {
                    crate::kernel::push_trace(&format!(
                        "tx:socks5-err host={} err={} t={}ms",
                        target.host,
                        e,
                        delta_ms(t0)
                    ));
                    jserr("TARGET_CONNECT_FAILED:socks5", &e)
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
pub(crate) fn dialer() -> Rc<dyn Dialer> {
    CURRENT
        .with(|c| c.borrow().clone())
        .unwrap_or_else(|| Rc::new(RelayDialer))
}

/// Embedder hook — install a custom `Dialer` before the first fetch.
/// Deliberately not a `#[wasm_bindgen]` export: wasm hosts implement the
/// trait in Rust and link it; the JS-side transport contract is unchanged.
pub fn set_dialer(d: Rc<dyn Dialer>) {
    CURRENT.with(|c| *c.borrow_mut() = Some(d));
}
