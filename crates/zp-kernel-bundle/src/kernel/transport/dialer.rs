//! Pluggable raw-connection factory for the browser transport stack.
//!
//! `open_fresh` in `fetch.rs` calls [`Dialer::connect`] with the target address
//! and relay URL. By default, [`RelayDialer`] opens a stream on the shared
//! `yamux` session and runs a SOCKS5 `CONNECT` handshake through the relay;
//! host embedders can override this via [`set_dialer`].
//!
//! TLS and HTTP framing run on top of the returned byte stream. The trait,
//! address, and error types live in [`crate::dial`] so they compile on host
//! targets; this module adds the `wasm32`-only [`RelayDialer`] default.

use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use wasm_bindgen::JsValue;

use super::fetch::jserr;
use super::pool;
use super::socks5::{self, Auth};
use super::yamux;

pub use crate::dial::{
    clear_dialer, injected_dialer, set_dialer, AsyncIo, DialError, Dialer, TargetAddr,
};

impl DialError {
    pub fn into_js_error(self) -> JsValue {
        jserr(self.code(), &self.detail())
    }
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

/// Active dialer: the injected one, or a fresh `RelayDialer`.
pub fn dialer() -> Rc<dyn Dialer> {
    injected_dialer().unwrap_or_else(|| Rc::new(RelayDialer))
}
