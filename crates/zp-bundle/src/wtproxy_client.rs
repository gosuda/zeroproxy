//! Virtual WebTransport client. Phase D4.
//!
//! Exposes `WebTransport`-shaped API to target code that routes through SW
//! over yamux/HTTP-3 to server WT gateway (`internal/wtproxy`).

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn wtproxy_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}
