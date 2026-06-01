//! Client-side transport stack for the Rust WASM kernel.
//!
//! ## Why this exists
//!
//! The Step 13 cutover (commit 291db00) migrated `kernel_fetch` from the
//! Go WASM kernel's SOCKS5+uTLS+HTTP stack to a *JSON envelope* posted over
//! `/zp/relay`. That move broke ZeroProxy's core security invariant:
//! ARCHITECTURE.md states the relay "does not parse target HTTP, TLS,
//! redirects, cookies, or HTML." With the JSON envelope, the server sees
//! plaintext URLs, methods, headers (including cookies and `Authorization`),
//! and request bodies — every byte of the target HTTPS traffic.
//!
//! This module restores the original boundary by re-implementing the
//! transport stack in Rust/WASM so the relay reverts to a byte-pipe:
//!
//! ```text
//! kernel_fetch(req)
//!     ├─ ws_stream :: open WebSocket to /zp/ws-pipe, expose AsyncRead/Write
//!     ├─ yamux     :: client session, one stream per target TCP connection
//!     ├─ socks5    :: DOMAINNAME CONNECT with IsolateSOCKSAuth username
//!     ├─ tls       :: rustls (rustls-rustcrypto provider) — HTTPS targets
//!     └─ http      :: HTTP/2 (h2 crate) when ALPN selects h2, HTTP/1.1 else
//! ```
//!
//! ## Incremental landing plan
//!
//! Layers ship one at a time; each step ends in a green
//! `cargo check --target wasm32-unknown-unknown -p zp-bundle`:
//!
//! 1. **(this commit)** `ws_stream` — WebSocket → futures::io::AsyncRead/Write
//!    adapter. No SOCKS5, no TLS, no HTTP yet.
//! 2. `socks5` — DOMAINNAME CONNECT client over the WS adapter.
//! 3. `http1`  — HTTP/1.1 client over the SOCKS5 stream (plain http:// first).
//! 4. `tls`    — rustls TLS handshake on the SOCKS5 stream (https:// works).
//! 5. `http2`  — h2 client when ALPN negotiates `h2`.
//! 6. `mux`    — yamux multiplex so one WS carries many concurrent streams.
//! 7. Swap `kernel_fetch` over and delete `/zp/relay*` server endpoints.
//!
//! Until step 7, the existing `relay_*` helpers in `kernel/mod.rs` remain
//! active; this module is dead code from the public surface's perspective
//! but its build status gates the progression.

// Dead-code is expected while layers land one at a time. Each step lifts the
// allow on the file that has reached its first real caller.
#![allow(dead_code)]

pub(crate) mod fetch;
pub(crate) mod http1;
pub(crate) mod pool;
pub(crate) mod socks5;
pub(crate) mod tls;
pub(crate) mod ws_stream;
pub(crate) mod yamux;
