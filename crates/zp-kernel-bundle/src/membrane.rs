//! ZeroProxy runtime membrane. Replaces hot path of `web/runtime-prelude.js`.
//!
//! Implements:
//! - __zp_get / __zp_set / __zp_call / __zp_construct (Phase B3)
//! - __zp_nav_assign / __zp_nav_replace (navigation routing)
//! - storage virtualization: localStorage/sessionStorage/IDB/CacheStorage/cookie (Phase D7)
//! - origin virtualization: document.domain/origin/window.origin (Phase D7)
//!
//! Exports via wasm-bindgen; JS prelude installs them as globals.

use wasm_bindgen::prelude::*;

/// Stub export to verify build pipeline. Replaced by real membrane helpers in Phase B3.
#[wasm_bindgen]
pub fn zp_membrane_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}
