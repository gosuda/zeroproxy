//! ZeroProxy runtime membrane.
//!
//! Implements:
//! - __zp_get / __zp_set / __zp_call / __zp_construct
//! - __zp_nav_assign / __zp_nav_replace (navigation routing)
//! - storage virtualization: localStorage/sessionStorage/IDB/CacheStorage/cookie
//! - origin virtualization: document.domain/origin/window.origin
//!
//! Exports via wasm-bindgen; JS prelude installs them as globals.

use wasm_bindgen::prelude::*;

/// Stub export to verify build pipeline.
#[wasm_bindgen]
pub fn zp_membrane_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}
