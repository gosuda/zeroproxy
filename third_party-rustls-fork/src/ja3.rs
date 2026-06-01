//! ZeroProxy JA3 mirror — captured ClientHello replay.
//!
//! Phase 4 of the JA3 work (phase 1 was cipher reorder via
//! `CryptoProvider`, phase 2 was hardcoded Chrome 134 shape in
//! `client::hs::apply_chrome_ja3_shape`). Phase 4 captures the user's
//! real browser ClientHello at the ZeroProxy HTTPS listener and
//! replays it on every upstream handshake so the JA3 hash matches the
//! user's actual browser rather than our static guess.
//!
//! Data flow:
//!
//!  Browser → ZeroProxy HTTPS handshake
//!     ↓
//!  `crypto/tls.Config.GetConfigForClient` (Go server)
//!     ↓
//!  `/zp/api/fp` returns the captured spec as base64 JSON
//!     ↓
//!  Service Worker fetches it during `initBundle`
//!     ↓
//!  `zp-bundle` parses the JSON and calls `set_captured_spec`
//!     ↓
//!  `client::hs::apply_chrome_ja3_shape` reads `current()` and uses
//!  the captured cipher order + extension layout instead of the
//!  hardcoded Chrome 134 fallback.
//!
//! Storage is a `thread_local!` because the SW runs on a single thread
//! (`!Send` async tasks via `spawn_local`), and there's exactly one
//! browser identity per SW. Cross-thread access is not a concern.

use alloc::vec::Vec;
use core::cell::RefCell;

use crate::enums::CipherSuite;
use crate::NamedGroup;

// Re-export so external callers (zp-bundle kernel) can name
// `ExtensionType` without reaching into rustls's private `msgs` tree.
pub use crate::msgs::enums::ExtensionType;

// rustls is `#![no_std]`, so the `thread_local!` macro isn't in the
// implicit prelude. We pull it in explicitly. `std` is available at
// link time whenever this module is compiled — the feature is enabled
// in zp-bundle's Cargo.toml (`features = ["std", "tls12", "logging"]`)
// and the SW runtime provides a real `std` for wasm32.
extern crate std;
use std::thread_local;

/// Snapshot of a ClientHello captured from the user's real browser.
/// All fields are in the order the wire said. GREASE values (the
/// `0x?A?A` family per RFC 8701) are preserved here; the encoder
/// uses them to decide injection positions but rustls's own emitter
/// strips them — see comments in `client::hs::apply_chrome_ja3_shape`.
///
/// `extensions` is the source of truth for ordering; the other fields
/// (cipher list, curve list, ec point formats) tell us *what* to emit
/// in each named extension's body.
#[derive(Clone, Debug, Default)]
pub struct CapturedSpec {
    pub versions: Vec<u16>,
    pub cipher_suites: Vec<CipherSuite>,
    pub extensions: Vec<ExtensionType>,
    pub named_groups: Vec<NamedGroup>,
    pub ec_point_formats: Vec<u8>,
    pub signature_schemes: Vec<u16>,
    pub alpn_protocols: Vec<Vec<u8>>,
}

thread_local! {
    /// The most recently installed captured spec, or `None` to fall
    /// through to the hardcoded Chrome 134 layout in
    /// `client::hs::apply_chrome_ja3_shape`. Wrapped in `RefCell` so
    /// `set_captured_spec` can mutate it during SW boot.
    static CAPTURED: RefCell<Option<CapturedSpec>> = const { RefCell::new(None) };
}

/// Install a captured spec. Called once during SW boot by the kernel
/// after `/zp/api/fp` decodes. Last write wins — the SW only calls
/// this once per activation, but if it ever needed to re-capture
/// (e.g. browser update changed the fingerprint mid-session), the
/// next call replaces.
pub fn set_captured_spec(spec: CapturedSpec) {
    CAPTURED.with(|c| {
        *c.borrow_mut() = Some(spec);
    });
}

/// Run `f` with a reference to the currently installed spec, if any.
/// Returns whatever `f` returns. The closure dance keeps the borrow
/// scoped — `RefCell::borrow()` panics on concurrent mut access, and
/// `apply_chrome_ja3_shape` runs inside the rustls handshake state
/// machine where another path might (theoretically) reentrantly call
/// `set_captured_spec`. The closure form forces a hard scope on the
/// borrow.
pub fn with_current<R>(f: impl FnOnce(Option<&CapturedSpec>) -> R) -> R {
    CAPTURED.with(|c| f(c.borrow().as_ref()))
}
