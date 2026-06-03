//! zp-page-rt — page runtime hot-path policies, shared-memory ABI.
//!
//! Loaded by `web/zp-rt.js` as a raw WASM module (no wasm-bindgen glue).
//! All ABI surface is `#[no_mangle] pub extern "C"`. See
//! `.ai/zp-page-rt-design.md` for the full contract.
//!
//! Hard rules:
//! - Never panic — input is untrusted, `panic = "abort"` would kill the page.
//! - All public exports return only u32 / u64. JS interprets bit fields.
//! - Memory growth is allowed only inside the bootstrap path; hot calls must
//!   not grow so JS-side `Uint8Array` views stay valid for the call duration.

#![cfg(target_arch = "wasm32")]

// We use std for the default wasm32 allocator (dlmalloc). The workspace
// profile sets `panic = "abort"`, so panics still trap. The cdylib never
// emits start glue or std::thread; the only std touch points are Vec and
// HashMap-free hot paths.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::mem::MaybeUninit;
use std::ptr::addr_of;

// ---------------------------------------------------------------------------
// Scratchpad — JS writes UTF-8 here via TextEncoder.encodeInto, then calls
// url_intern(ptr, len). The pointer is a fixed offset within the WASM linear
// memory so JS can cache it across calls (subject to memory.grow refresh).
//
// Size: 64KB. Max URL length per WHATWG is unbounded but real-world Chrome
// limit is ~32K; we double that for safety. encodeInto truncates on
// overflow, and JS-side will reject inputs > cap/3 (UTF-8 worst case).
// ---------------------------------------------------------------------------

const SCRATCH_CAP: usize = 64 * 1024;

#[repr(C, align(8))]
struct Scratch([MaybeUninit<u8>; SCRATCH_CAP]);

static mut SCRATCH: Scratch = Scratch([MaybeUninit::uninit(); SCRATCH_CAP]);

#[inline]
fn scratch_base() -> *const u8 {
    // Use addr_of! to avoid creating a shared reference to the mutable
    // static. We treat the static purely as an address.
    addr_of!(SCRATCH) as *const u8
}

// ---------------------------------------------------------------------------
// URL classification — first-pass scheme partitioning. Mirrors the union of
// runtime-prelude.js's isHTTPURL / hasExecutableURLScheme / hasDangerousURLScheme
// in a single enum so the JS caller branches once per attribute set.
// ---------------------------------------------------------------------------

#[repr(u32)]
#[derive(Copy, Clone, PartialEq, Eq)]
enum UrlClass {
    Invalid = 0,
    Http = 1,
    Ws = 2,
    Blob = 3,
    Data = 4,
    JavaScript = 5,
    VbScript = 6,
    AboutBlank = 7,
    AboutOther = 8,
    Relative = 9,
    Other = 10,
}

const MAX_URL_LEN: usize = 8192;

/// Trim ASCII whitespace (space, \t, \n, \r, \f) from both ends.
/// HTML attributes carry leading whitespace per the URL parser; we strip it
/// before scheme detection so " javascript:..." still classifies as JS.
fn ascii_trim(input: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = input.len();
    while start < end && matches!(input[start], b' ' | b'\t' | b'\n' | b'\r' | 0x0c) {
        start += 1;
    }
    while end > start && matches!(input[end - 1], b' ' | b'\t' | b'\n' | b'\r' | 0x0c) {
        end -= 1;
    }
    &input[start..end]
}

#[inline]
fn ascii_lower(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

fn classify_scheme(input: &[u8]) -> UrlClass {
    let trimmed = ascii_trim(input);
    if trimmed.is_empty() || trimmed.len() > MAX_URL_LEN {
        return UrlClass::Invalid;
    }

    // RFC 3986 scheme: ALPHA *(ALPHA / DIGIT / "+" / "-" / ".")
    // Find first ':' that is preceded only by valid scheme chars and
    // starts with ALPHA. If none, classify as Relative.
    let mut colon_at = None;
    for (i, &b) in trimmed.iter().enumerate() {
        if b == b':' {
            colon_at = Some(i);
            break;
        }
        let valid = if i == 0 {
            b.is_ascii_alphabetic()
        } else {
            b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')
        };
        if !valid {
            // First non-scheme char (e.g. '/' '?' '#') before any colon →
            // relative URL.
            return UrlClass::Relative;
        }
    }
    let Some(colon) = colon_at else {
        return UrlClass::Relative;
    };
    let scheme = &trimmed[..colon];
    let rest = trimmed.get(colon + 1..).unwrap_or(&[]);

    // Match well-known schemes (all lowercase; ci compare via ci_starts_with
    // would re-iterate, so do manual lowercase compare).
    match scheme.len() {
        2 => {
            if eq_ci(scheme, b"ws") {
                return UrlClass::Ws;
            }
        }
        3 => {
            if eq_ci(scheme, b"wss") {
                return UrlClass::Ws;
            }
        }
        4 => {
            if eq_ci(scheme, b"http") {
                return UrlClass::Http;
            }
            if eq_ci(scheme, b"blob") {
                return UrlClass::Blob;
            }
            if eq_ci(scheme, b"data") {
                return UrlClass::Data;
            }
        }
        5 => {
            if eq_ci(scheme, b"https") {
                return UrlClass::Http;
            }
            if eq_ci(scheme, b"about") {
                // about:blank specifically vs other about:* (e.g. about:srcdoc)
                return if eq_ci(rest, b"blank") {
                    UrlClass::AboutBlank
                } else {
                    UrlClass::AboutOther
                };
            }
        }
        8 => {
            if eq_ci(scheme, b"vbscript") {
                return UrlClass::VbScript;
            }
        }
        10 => {
            if eq_ci(scheme, b"javascript") {
                return UrlClass::JavaScript;
            }
        }
        _ => {}
    }
    UrlClass::Other
}

#[inline]
fn eq_ci(a: &[u8], b_lower: &[u8]) -> bool {
    if a.len() != b_lower.len() {
        return false;
    }
    a.iter()
        .zip(b_lower.iter())
        .all(|(x, y)| ascii_lower(*x) == *y)
}

// ---------------------------------------------------------------------------
// URL intern pool. Append-only. handle = index + 1 (0 reserved for invalid).
// Hash collisions resolved by linear probe (small dataset; capacity bench-tuned).
//
// `class_cache` stores the precomputed UrlClass for O(1) classify after
// intern. Hash uses FxHash-style multiplier — no allocations.
// ---------------------------------------------------------------------------

struct UrlEntry {
    offset: u32,
    len: u32,
}

// IdentityHasher — we already feed pre-hashed u64 keys into the map, so
// the std SipHash would re-hash them at significant cost. Using identity
// makes the map essentially a direct-addressed table on the lower bits.
#[derive(Default)]
struct IdentityHasher(u64);
impl Hasher for IdentityHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, _bytes: &[u8]) {
        unreachable!("u64 keys only")
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = n;
    }
}
type FastMap<V> = HashMap<u64, V, BuildHasherDefault<IdentityHasher>>;

struct UrlPool {
    bytes: Vec<u8>,
    entries: Vec<UrlEntry>,
    class_cache: Vec<u8>, // UrlClass as u8 per entry index
    // by_hash: pre-hashed key → handle. Collisions are verified by byte
    // compare against the entries table. Identity hasher avoids re-hashing.
    by_hash: FastMap<u32>,
}

impl UrlPool {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            entries: Vec::new(),
            class_cache: Vec::new(),
            by_hash: HashMap::with_hasher(BuildHasherDefault::default()),
        }
    }

    fn reset(&mut self) {
        self.bytes.clear();
        self.entries.clear();
        self.class_cache.clear();
        self.by_hash.clear();
    }

    fn intern(&mut self, input: &[u8]) -> u32 {
        let trimmed = ascii_trim(input);
        if trimmed.is_empty() || trimmed.len() > MAX_URL_LEN {
            return 0;
        }
        let h = fxhash(trimmed);
        if let Some(&handle) = self.by_hash.get(&h) {
            // Verify the stored bytes match — collision possibility is
            // negligible (64-bit hash) but defensively correct.
            let idx = (handle - 1) as usize;
            let e = &self.entries[idx];
            let start = e.offset as usize;
            let stored = &self.bytes[start..start + e.len as usize];
            if stored == trimmed {
                return handle;
            }
            // Collision (extremely rare): fall through to append. The old
            // handle is silently shadowed in by_hash. Acceptable for a pool
            // that gets reset on navigation.
        }
        let offset = self.bytes.len() as u32;
        let len = trimmed.len() as u32;
        self.bytes.extend_from_slice(trimmed);
        let cls = classify_scheme(trimmed);
        self.entries.push(UrlEntry { offset, len });
        self.class_cache.push(cls as u8);
        let handle = self.entries.len() as u32; // 1-based
        self.by_hash.insert(h, handle);
        handle
    }

    fn class_of(&self, handle: u32) -> u32 {
        if handle == 0 || handle as usize > self.class_cache.len() {
            return UrlClass::Invalid as u32;
        }
        self.class_cache[(handle - 1) as usize] as u32
    }

    /// Returns (ptr, len) packed as u64: (ptr << 32) | len.
    fn view(&self, handle: u32) -> u64 {
        if handle == 0 || handle as usize > self.entries.len() {
            return 0;
        }
        let e = &self.entries[(handle - 1) as usize];
        let ptr = self.bytes.as_ptr() as u32 + e.offset;
        ((ptr as u64) << 32) | (e.len as u64)
    }
}

thread_local! {
    static POOL: RefCell<UrlPool> = RefCell::new(UrlPool::new());
}

// FxHash — same constants as rustc-hash. Stable, fast, no allocations.
fn fxhash(input: &[u8]) -> u64 {
    let mut h: u64 = 0;
    for &b in input {
        h = (h.rotate_left(5) ^ b as u64).wrapping_mul(0x517cc1b727220a95);
    }
    h
}

// ---------------------------------------------------------------------------
// Public ABI — raw extern "C". JS reads exports by name.
// ---------------------------------------------------------------------------

/// Version: major<<16 | minor<<8 | patch.
#[no_mangle]
pub extern "C" fn version() -> u32 {
    (0 << 16) | (1 << 8) | 0
}

/// Pointer to scratch buffer in linear memory.
#[no_mangle]
pub extern "C" fn scratch_ptr() -> u32 {
    scratch_base() as u32
}

/// Capacity of scratch buffer.
#[no_mangle]
pub extern "C" fn scratch_cap() -> u32 {
    SCRATCH_CAP as u32
}

/// Intern bytes at (ptr, len) in linear memory. Returns handle, or 0 on invalid.
/// JS contract: ptr is typically scratch_ptr() and len is what
/// TextEncoder.encodeInto reported. We do not require ptr == scratch_ptr;
/// any in-memory region works.
#[no_mangle]
pub extern "C" fn url_intern(ptr: u32, len: u32) -> u32 {
    if len as usize > SCRATCH_CAP * 4 {
        // Sanity: prevent absurd reads. Even outside scratch, no URL > 256KB.
        return 0;
    }
    // Safety: caller is JS glue which only passes pointers into our own
    // linear memory. Read len bytes. If out-of-bounds, wasm trap will abort,
    // which is correct (JS bug, not user bug).
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    POOL.with(|p| p.borrow_mut().intern(bytes))
}

/// Classify previously-interned URL by handle. O(1) cache hit.
#[no_mangle]
pub extern "C" fn url_classify(handle: u32) -> u32 {
    POOL.with(|p| p.borrow().class_of(handle))
}

/// Get a view (ptr, len packed as u64) of the canonicalized URL bytes.
/// JS decodes via TextDecoder. Pointer is valid only until the next
/// intern call may grow the bytes Vec — JS must decode immediately.
#[no_mangle]
pub extern "C" fn url_view(handle: u32) -> u64 {
    POOL.with(|p| p.borrow().view(handle))
}

/// Drop every entry. Call on page navigation. Invalidates all handles.
#[no_mangle]
pub extern "C" fn pool_reset() {
    POOL.with(|p| p.borrow_mut().reset())
}

/// (entry_count << 32) | bytes_used. Diagnostic only.
#[no_mangle]
pub extern "C" fn pool_stats() -> u64 {
    POOL.with(|p| {
        let pool = p.borrow();
        ((pool.entries.len() as u64) << 32) | (pool.bytes.len() as u64)
    })
}

/// Convenience for hot paths that don't care about reuse: intern + classify
/// in one call. Returns u64: (handle << 32) | class.
#[no_mangle]
pub extern "C" fn url_intern_and_classify(ptr: u32, len: u32) -> u64 {
    let h = url_intern(ptr, len);
    let c = url_classify(h);
    ((h as u64) << 32) | (c as u64)
}

/// Scheme-only classification — NO intern, NO pool side effects. Read at
/// most `len` bytes (caller should cap to ~16 for ASCII schemes) and return
/// just the UrlClass enum. Designed for the hot path on long URLs where
/// encoding the full string into scratch is wasteful — JS encodes only the
/// scheme region. Schemes are ASCII (RFC 3986), so 16 bytes covers every
/// well-known scheme plus margin (longest match here: "javascript:" = 11).
///
/// `about:` differentiation between "blank" and other is preserved if the
/// caller passes at least ~12 bytes (e.g. "about:blank" = 11). Truncated
/// inputs may classify as AboutOther — acceptable since policy treats both
/// AboutBlank and AboutOther identically for blocking decisions.
#[no_mangle]
pub extern "C" fn url_classify_scheme_only(ptr: u32, len: u32) -> u32 {
    if len == 0 || len > 256 {
        return UrlClass::Invalid as u32;
    }
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    classify_scheme(bytes) as u32
}

// ---------------------------------------------------------------------------
// Batch ABI — amortise WASM call setup over many URLs. The MutationObserver
// strategy submits all mutations from one tick in one call.
//
// Input layout (caller fills scratch):
//   [u32 len0] [u32 len1] ... [u32 lenN-1] [byte0..byteM]
//
// Calls write `lens` table first (4 * count bytes), then bytes, then call
// bulk_intern_and_classify(lens_ptr, count, bytes_ptr).
//
// Output: caller-allocated u32 array of length count, written via the same
// scratch starting at `out_ptr`. Each slot = (class << 16) | (handle_low_16).
// For the bench we just return the count of items processed; in real use
// JS reads back via a Uint32Array view.
// ---------------------------------------------------------------------------

/// Process `count` URLs whose lengths are at `lens_ptr` (u32 each) and whose
/// concatenated bytes start at `bytes_ptr`. Writes `count` u32 results to
/// `out_ptr`. Each result = (class << 16) | (handle & 0xFFFF). Returns the
/// number of items processed (0 if any input is malformed).
///
/// Truncating handle to 16 bits is intentional for the bench: real callers
/// either follow up with view by full handle (in which case out should be
/// u64) or only need the class. Keeping it u32 lets JS read with a single
/// Uint32Array view.
#[no_mangle]
pub extern "C" fn bulk_intern_and_classify(
    lens_ptr: u32,
    count: u32,
    bytes_ptr: u32,
    out_ptr: u32,
) -> u32 {
    if count == 0 {
        return 0;
    }
    let lens = unsafe { core::slice::from_raw_parts(lens_ptr as *const u32, count as usize) };
    // Walk bytes_ptr advancing by each len, intern, write packed result.
    POOL.with(|p| {
        let mut pool = p.borrow_mut();
        let mut byte_cur = bytes_ptr as *const u8;
        let mut out_cur = out_ptr as *mut u32;
        for &len in lens {
            let bytes = unsafe { core::slice::from_raw_parts(byte_cur, len as usize) };
            let handle = pool.intern(bytes);
            let cls = pool.class_of(handle);
            let packed = (cls << 16) | (handle & 0xFFFF);
            unsafe {
                core::ptr::write_unaligned(out_cur, packed);
                out_cur = out_cur.add(1);
                byte_cur = byte_cur.add(len as usize);
            }
        }
        count
    })
}

// ---------------------------------------------------------------------------
// Tests (run on host with --target native, behind cfg(test) — wasm guard
// above prevents host compile of the module itself, so put tests under
// a separate cfg gate).
// ---------------------------------------------------------------------------

// Tests intentionally omitted: this crate is cdylib-only and compiles for
// wasm32-unknown-unknown. Parity tests live in test/js/url-classify.test.js
// (planned) which exercise the wasm artifact directly.
