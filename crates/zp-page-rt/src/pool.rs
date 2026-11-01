//! Host-testable URL classification and intern pool behind the `zp-page-rt` ABI.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

// URL classification: first-pass scheme partitioning. Mirrors the union of
// runtime-prelude.js's isHTTPURL, hasExecutableURLScheme, and
// hasDangerousURLScheme in a single enum so the JS caller branches once per
// attribute set.

#[repr(u32)]
#[derive(Copy, Clone, PartialEq, Eq)]
pub(crate) enum UrlClass {
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

pub(crate) const MAX_URL_LEN: usize = 8192;

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

pub(crate) fn classify_scheme(input: &[u8]) -> UrlClass {
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
            // First non-scheme char (e.g. '/', '?', '#') before any colon
            // indicates a relative URL.
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


// Bulk results pack `(class & 0xF) << 28 | (handle & MAX_HANDLE)` into one u32.
// `UrlClass` needs 4 bits and a handle gets the remaining 28, so the pool stops
// issuing handles at `MAX_HANDLE`; truncating a handle to fewer bits would make
// two distinct URLs share an id.
pub(crate) const MAX_HANDLE: u32 = 0x0FFF_FFFF;
const _: () = assert!(UrlClass::Other as u32 <= 0xF);

/// Pack one `bulk_intern_and_classify` result. Handle 0 (invalid) packs with
/// class `Invalid`, so a rejected URL never aliases a live handle.
#[inline]
pub(crate) fn pack_bulk_result(class: u32, handle: u32) -> u32 {
    ((class & 0xF) << 28) | (handle & MAX_HANDLE)
}

// URL intern pool: append-only, handle = index + 1 (0 reserved for invalid).
// `class_cache` stores the precomputed UrlClass for O(1) classify after
// intern. Hash uses an FxHash-style multiplier without allocations.

struct UrlEntry {
    offset: u32,
    len: u32,
    // Previous handle whose URL has the same 64-bit hash; 0 ends the chain.
    next_same_hash: u32,
}

// IdentityHasher: keys fed into the map are already pre-hashed u64 values, so
// identity hashing avoids a redundant SipHash pass.
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

pub(crate) struct UrlPool {
    bytes: Vec<u8>,
    entries: Vec<UrlEntry>,
    class_cache: Vec<u8>, // UrlClass as u8 per entry index
    // Maps pre-hashed key to the newest handle with that hash. Older handles
    // with the same hash hang off `UrlEntry::next_same_hash`, so two URLs that
    // collide on all 64 bits both stay resolvable and keep distinct handles.
    by_hash: FastMap<u32>,
}

impl UrlPool {
    pub(crate) fn new() -> Self {
        Self {
            bytes: Vec::new(),
            entries: Vec::new(),
            class_cache: Vec::new(),
            by_hash: HashMap::with_hasher(BuildHasherDefault::default()),
        }
    }

    pub(crate) fn reset(&mut self) {
        self.bytes.clear();
        self.entries.clear();
        self.class_cache.clear();
        self.by_hash.clear();
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn bytes_used(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn intern(&mut self, input: &[u8]) -> u32 {
        self.intern_with_hash(input, fxhash(ascii_trim(input)))
    }

    // Split out so tests can force a hash collision.
    fn intern_with_hash(&mut self, input: &[u8], h: u64) -> u32 {
        let trimmed = ascii_trim(input);
        if trimmed.is_empty() || trimmed.len() > MAX_URL_LEN {
            return 0;
        }
        let head = self.by_hash.get(&h).copied().unwrap_or(0);
        let mut cur = head;
        while cur != 0 {
            let e = &self.entries[(cur - 1) as usize];
            let start = e.offset as usize;
            if &self.bytes[start..start + e.len as usize] == trimmed {
                return cur;
            }
            cur = e.next_same_hash;
        }
        // Handles are 1-based, so the pool is full once the count reaches the
        // largest handle the bulk ABI can carry. A byte offset must also fit u32.
        if self.entries.len() >= MAX_HANDLE as usize
            || self.bytes.len() + trimmed.len() > u32::MAX as usize
        {
            return 0;
        }
        let offset = self.bytes.len() as u32;
        let len = trimmed.len() as u32;
        self.bytes.extend_from_slice(trimmed);
        let cls = classify_scheme(trimmed);
        self.entries.push(UrlEntry { offset, len, next_same_hash: head });
        self.class_cache.push(cls as u8);
        let handle = self.entries.len() as u32; // 1-based
        self.by_hash.insert(h, handle);
        handle
    }

    pub(crate) fn class_of(&self, handle: u32) -> u32 {
        if handle == 0 || handle as usize > self.class_cache.len() {
            return UrlClass::Invalid as u32;
        }
        self.class_cache[(handle - 1) as usize] as u32
    }

    /// Canonical (trimmed) bytes behind `handle`, or `None` for an unknown handle.
    pub(crate) fn bytes_of(&self, handle: u32) -> Option<&[u8]> {
        if handle == 0 || handle as usize > self.entries.len() {
            return None;
        }
        let e = &self.entries[(handle - 1) as usize];
        let start = e.offset as usize;
        Some(&self.bytes[start..start + e.len as usize])
    }
}

// FxHash using the same multiplier constant as rustc-hash.
pub(crate) fn fxhash(input: &[u8]) -> u64 {
    let mut h: u64 = 0;
    for &b in input {
        h = (h.rotate_left(5) ^ b as u64).wrapping_mul(0x517cc1b727220a95);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_result_keeps_handles_above_16_bits_distinct() {
        let low = pack_bulk_result(UrlClass::Http as u32, 0x0001_0001);
        let wrapped = pack_bulk_result(UrlClass::Http as u32, 0x0000_0001);
        assert_ne!(low, wrapped);
        assert_eq!(low & MAX_HANDLE, 0x0001_0001);
        assert_eq!(low >> 28, UrlClass::Http as u32);
    }

    #[test]
    fn bulk_result_round_trips_the_largest_handle_and_class() {
        let packed = pack_bulk_result(UrlClass::Other as u32, MAX_HANDLE);
        assert_eq!(packed >> 28, UrlClass::Other as u32);
        assert_eq!(packed & MAX_HANDLE, MAX_HANDLE);
    }

    #[test]
    fn bulk_result_for_invalid_handle_has_invalid_class() {
        let mut pool = UrlPool::new();
        let handle = pool.intern(b"   ");
        assert_eq!(handle, 0);
        let packed = pack_bulk_result(pool.class_of(handle), handle);
        assert_eq!(packed, 0);
    }

    #[test]
    fn intern_dedupes_and_trims() {
        let mut pool = UrlPool::new();
        let a = pool.intern(b"https://example.com/");
        let b = pool.intern(b"  https://example.com/
");
        assert_ne!(a, 0);
        assert_eq!(a, b);
        assert_eq!(pool.len(), 1);
        assert_eq!(pool.bytes_of(a), Some(&b"https://example.com/"[..]));
    }

    #[test]
    fn hash_collision_keeps_both_urls_resolvable() {
        let mut pool = UrlPool::new();
        let a = pool.intern_with_hash(b"https://a.example/", 7);
        let b = pool.intern_with_hash(b"https://b.example/", 7);
        let c = pool.intern_with_hash(b"javascript:void(0)", 7);
        assert!(a != 0 && b != 0 && c != 0);
        assert!(a != b && b != c && a != c);
        // Re-interning each colliding URL must find its original handle, not
        // append a duplicate or return the newest entry.
        assert_eq!(pool.intern_with_hash(b"https://a.example/", 7), a);
        assert_eq!(pool.intern_with_hash(b"https://b.example/", 7), b);
        assert_eq!(pool.intern_with_hash(b"javascript:void(0)", 7), c);
        assert_eq!(pool.len(), 3);
        assert_eq!(pool.bytes_of(a), Some(&b"https://a.example/"[..]));
        assert_eq!(pool.class_of(c), UrlClass::JavaScript as u32);
    }

    #[test]
    fn oversized_and_empty_inputs_are_rejected() {
        let mut pool = UrlPool::new();
        assert_eq!(pool.intern(b""), 0);
        let long = vec![b'a'; MAX_URL_LEN + 1];
        assert_eq!(pool.intern(&long), 0);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn reset_invalidates_handles() {
        let mut pool = UrlPool::new();
        let h = pool.intern(b"data:text/plain,hi");
        assert_eq!(pool.class_of(h), UrlClass::Data as u32);
        pool.reset();
        assert_eq!(pool.class_of(h), UrlClass::Invalid as u32);
        assert!(pool.bytes_of(h).is_none());
    }

    #[test]
    fn schemes_classify_case_insensitively() {
        assert_eq!(classify_scheme(b"JaVaScRiPt:alert(1)") as u32, UrlClass::JavaScript as u32);
        assert_eq!(classify_scheme(b"about:blank") as u32, UrlClass::AboutBlank as u32);
        assert_eq!(classify_scheme(b"/relative/path") as u32, UrlClass::Relative as u32);
        assert_eq!(classify_scheme(b"wss://x") as u32, UrlClass::Ws as u32);
    }
}
