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

/// RFC 8701 GREASE values. The TLS protocol designates these 16
/// `0x?A?A` code points as reserved for browsers to randomly inject
/// into ClientHello cipher / extension / group lists. Servers must
/// ignore them; if they don't, the protocol's intolerance is exposed
/// and the deployment can be flagged.
///
/// JA3 strips GREASE before hashing — they don't change the JA3 hash.
/// But the *absence* of GREASE is itself a strong fingerprint: every
/// modern browser emits GREASE, so a ClientHello without GREASE is
/// almost certainly a bot. NAVER's WAF appears to weight GREASE
/// presence into its bot-detection signal.
/// Length of the body emitted for ExtensionType::Padding (RFC 7685, id 21).
/// Chrome 134 emits a variable-length zero body so total cleartext
/// ClientHello hits 512 bytes (the legacy SSLv3 / F5 BIG-IP workaround
/// threshold). Without knowing our offset inside the outer hello buffer
/// at encode time we just pick a fixed value that's representative of
/// what Chrome actually emits (~100 bytes); the *presence* of id 21 with
/// a zero body is the fingerprint signal, not the exact length.
pub const PADDING_BODY_LEN: usize = 100;

pub const GREASE_VALUES: [u16; 16] = [
    0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
    0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa,
];

/// True iff `v` is a GREASE code point (RFC 8701: high and low nibbles
/// of both bytes are `0xA`). The extension encoder uses this to emit a
/// zero-byte body for any extension whose ID falls in this range —
/// without it, `encode_one`'s catch-all arm would drop GREASE extension
/// IDs on the floor.
pub fn is_grease_value(v: u16) -> bool {
    (v & 0x0f0f) == 0x0a0a && (v & 0xf0f0) == 0xa0a0
}

/// Pick a random GREASE value. The choice is per-emission so two
/// ClientHellos from the same session present different GREASE bytes
/// — that's part of the browser-like behaviour.
///
/// Uses a thread-local xorshift64 PRNG. The seed is a deterministic
/// non-zero constant (golden-ratio bytes); on wasm32-unknown-unknown
/// `std::time::SystemTime::now()` panics with "time not implemented",
/// and we'd rather not pull in `web-time` or `rand_core` here. The
/// first GREASE per SW activation is therefore deterministic, but
/// every subsequent call advances the state — every ClientHello after
/// the first sees a fresh value, which is what RFC 8701 requires.
pub fn random_grease() -> u16 {
    use core::cell::Cell;
    thread_local! {
        static RNG: Cell<u64> = const { Cell::new(0x9E3779B97F4A7C15) };
    }
    RNG.with(|s| {
        // xorshift64 step
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        GREASE_VALUES[(x as usize) & 0x0f]
    })
}

/// Generate `n` pseudo-random bytes from the same xorshift64 state that
/// drives `random_grease()`. Used by Phase 5.7 ECH GREASE to fill the
/// outer hello's `enc` and `payload` fields — anti-bot fingerprinters
/// only check that the body decodes as a valid `EncryptedClientHelloOuter`
/// with non-empty payload; the actual bytes are server-decrypted noise
/// for real ECH, so any bytes look identical to the WAF observer.
pub fn random_bytes(n: usize) -> alloc::vec::Vec<u8> {
    use core::cell::Cell;
    thread_local! {
        static RNG: Cell<u64> = const { Cell::new(0xBF58476D1CE4E5B9) };
    }
    let mut out = alloc::vec::Vec::with_capacity(n);
    RNG.with(|s| {
        let mut x = s.get();
        while out.len() < n {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let bytes = x.to_le_bytes();
            let take = core::cmp::min(8, n - out.len());
            out.extend_from_slice(&bytes[..take]);
        }
        s.set(x);
    });
    out
}
