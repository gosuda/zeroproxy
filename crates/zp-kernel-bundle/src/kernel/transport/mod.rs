//! Client-side transport stack for the Rust WASM kernel.
//!
//! The relay must not parse target HTTP, TLS, redirects, cookies, or HTML.
//! This module implements the transport stack in Rust/WASM so the relay acts
//! as a byte-pipe:
//!
//! ```text
//! kernel_fetch(req)
//!     ├─ ws_stream :: open WebSocket to /zp/ws-pipe, expose AsyncRead/Write
//!     ├─ yamux     :: client session, one stream per target TCP connection
//!     ├─ socks5    :: DOMAINNAME CONNECT with IsolateSOCKSAuth username
//!     ├─ tls       :: rustls (rustls-rustcrypto provider) for HTTPS targets
//!     └─ http      :: HTTP/2 (h2 crate) when ALPN selects h2, HTTP/1.1 else
//! ```
#![allow(dead_code)]

pub(crate) mod decode;
pub mod dialer;
pub(crate) mod fetch;
pub(crate) mod http1;
pub(crate) mod http2;
pub(crate) mod mlkem_hybrid;
pub(crate) mod pool;
pub(crate) mod socks5;
pub(crate) mod timer;
pub(crate) mod tls;
pub(crate) mod ws_client;
pub(crate) mod ws_stream;
pub(crate) mod yamux;
