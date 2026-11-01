//! Page runtime hot-path policies and shared-memory ABI (`zp-page-rt`).
//!
//! Loaded by `web/zp-rt.js` as a raw WASM module (no wasm-bindgen glue).
//! All ABI surface is `#[no_mangle] pub extern "C"`; `web/zp-rt.js`
//! implements its handle and shared-memory calling contract.
//!
//! Hard rules:
//! - Never panic: input is untrusted and `panic = "abort"` would terminate the page.
//! - All public exports return only u32 or u64; JS interprets bit fields.
//! - Memory growth is allowed only inside the bootstrap path; hot calls must
//!   not grow so JS-side `Uint8Array` views stay valid for the call duration.

// On host targets the pool is compiled for tests only; its callers are the wasm-only exports.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod pool;

// The exports below only make sense in a wasm module; the pool and packing
// logic above stays host-compilable so `cargo test` covers it.
#[cfg(target_arch = "wasm32")]
mod abi;
#[cfg(target_arch = "wasm32")]
pub use abi::*;
