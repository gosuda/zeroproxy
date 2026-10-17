//! ZeroProxy SW kernel WASM bundle (cdylib).
//!
//! The eager `zp-bundle` (rewriter + htmltx + CSS + sourcemap + CSP) runs on
//! every script or CSS response so it stays on the SW activate critical path;
//! this crate's wasm only needs to be instantiated when an actual upstream
//! fetch happens (first `transportFetch`), so it is fetched and instantiated
//! lazily via `self.ZPKernelWBG`.

#![cfg(target_arch = "wasm32")]

pub mod kernel;
pub mod membrane;
pub mod rtcgw_client;
pub mod wtproxy_client;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    // Diagnostic panic hook: a Rust panic in wasm compiles to an opaque
    // `RuntimeError: unreachable` with no message. This hook prints the
    // panic payload and source location to the SW console and mirrors it
    // into the kernel trace ring (so __zpKernelProbe surfaces it too).
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
