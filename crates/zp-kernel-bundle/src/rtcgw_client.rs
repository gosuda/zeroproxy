//! Virtual WebRTC client. Phase D5.
//!
//! Implements virtual `RTCPeerConnection`/`RTCDataChannel` that routes through
//! `internal/rtcgw` (pion-based server gateway). SDP munging keeps all ICE
//! candidates pointed at ZeroProxy.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn rtcgw_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}
