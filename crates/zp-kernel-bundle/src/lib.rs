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
    // Diagnostic panic hook: a Rust panic in wasm compiles to an opaque
    // `RuntimeError: unreachable` with no message — useless for pinning a
    // crash. This hook prints the panic payload + source location to the SW
    // console AND mirrors it into the kernel trace ring (so __zpKernelProbe
    // surfaces it too). Pure diagnostics — no behavior change.
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "?".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let full = format!("ZP_KERNEL_PANIC at {loc}: {msg}");
        web_sys::console::error_1(&JsValue::from_str(&full));
        crate::kernel::push_trace(&full);
    }));
}
