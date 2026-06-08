//! ZeroProxy SW kernel WASM bundle (cdylib).
//!
//! 2026-06-08 split-bundle (c.3): the kernel/transport half of the former
//! monolithic `zp-bundle`. The eager `zp-bundle` (rewriter + htmltx + CSS
//! + sourcemap + CSP) runs on every script / CSS response so it stays on
//! the SW activate critical path; this crate's wasm only needs to be
//! instantiated when an actual upstream fetch happens (first
//! `transportFetch`), so it gets fetched + instantiated lazily.
//!
//! Surface mirrors the kernel-side of pre-(c.3) `zp-bundle` exactly —
//! the SW `initKernel()` shim just routes the same names through a
//! different wasm-bindgen factory (`self.ZPKernelWBG`).

#![cfg(target_arch = "wasm32")]

pub mod kernel;
pub mod membrane;
pub mod rtcgw_client;
pub mod wtproxy_client;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    // Future: install console hooks, panic-hook for diagnostics
}
