//! Client-side transport stack for the Rust WASM kernel.
//!
//! The relay does not parse target HTTP, TLS, redirects, cookies, or HTML.
//! This module implements the transport layers in Rust/WASM so the relay acts
//! as an opaque byte pipe:
//!
//! - `ws_stream`: opens a WebSocket to `/zp/ws-pipe` and adapts it to `AsyncRead` / `AsyncWrite`.
//! - `yamux`: multiplexes one logical stream per target TCP connection over the WebSocket.
//! - `socks5`: performs `DOMAINNAME` `CONNECT` with per-tab `IsolateSOCKSAuth` credentials.
//! - `tls`: negotiates TLS via `rustls` (`rustls-rustcrypto` provider) for HTTPS targets.
//! - `http1` and `http2`: speaks HTTP/2 when ALPN selects `h2`, or HTTP/1.1 otherwise.
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
