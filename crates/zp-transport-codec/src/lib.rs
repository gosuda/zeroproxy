//! Pure-byte protocol codecs for ZeroProxy's client-side transport stack.
//!
//! The async wrappers (`futures-io`, yamux, rustls) live in
//! `zp-bundle/src/kernel/transport/` and only build on `wasm32-unknown-unknown`
//! because they pull web-only deps. To keep the protocol parsing itself
//! unit-testable on the host, every byte-layout decision lives here as
//! plain `&[u8]` → `Result<…>` helpers. The wasm async wrappers call into
//! these helpers and just push/pull the byte streams.
//!
//! Layered to mirror the RFC:
//!
//! * [`socks5`] — RFC 1928 method negotiation + CONNECT + RFC 1929
//!   username/password sub-negotiation.
//! * [`http1`] — RFC 9112 request-line + header block builder/parser.

#![deny(missing_docs)]

pub mod http1;
pub mod socks5;
