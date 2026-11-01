//! Raw `extern "C"` exports of `zp-page-rt`.

// We use std for the default wasm32 allocator (dlmalloc). The workspace
// profile sets `panic = "abort"`, so panics still trap. The cdylib never
// emits start glue or std::thread; the only std touch points are Vec and
// HashMap-free hot paths.

use std::cell::RefCell;
use std::mem::MaybeUninit;
use std::ptr::addr_of;

use crate::pool::{classify_scheme, pack_bulk_result, UrlClass, UrlPool};

// Scratchpad: JS writes UTF-8 here via TextEncoder.encodeInto, then calls
// url_intern(ptr, len). The pointer is a fixed offset within the WASM linear
// memory so JS can cache it across calls (subject to memory.grow refresh).
//
// Size: 64 KiB. Chrome's practical URL limit is ~32 KiB; JS rejects inputs
// larger than cap/3 (UTF-8 worst case).

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

thread_local! {
    static POOL: RefCell<UrlPool> = RefCell::new(UrlPool::new());
}
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
/// intern call may grow the bytes Vec; JS must decode immediately.
#[no_mangle]
pub extern "C" fn url_view(handle: u32) -> u64 {
    POOL.with(|p| match p.borrow().bytes_of(handle) {
        Some(bytes) => ((bytes.as_ptr() as u32 as u64) << 32) | bytes.len() as u64,
        None => 0,
    })
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
        ((pool.len() as u64) << 32) | (pool.bytes_used() as u64)
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

/// Scheme-only classification without interning or pool side effects. Reads at
/// most `len` bytes (callers typically cap at 16 bytes for ASCII schemes) and
/// returns the `UrlClass` value.
///
/// `about:` differentiation between `blank` and other targets is preserved when
/// the caller passes at least 12 bytes (`about:blank` is 11 bytes); shorter
/// inputs classify as `AboutOther`.
#[no_mangle]
pub extern "C" fn url_classify_scheme_only(ptr: u32, len: u32) -> u32 {
    if len == 0 || len > 256 {
        return UrlClass::Invalid as u32;
    }
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    classify_scheme(bytes) as u32
}

/// Process `count` URLs whose lengths are at `lens_ptr` (u32 each) and whose
/// concatenated bytes start at `bytes_ptr`. Writes `count` u32 results to
/// `out_ptr`. Each result = `(class << 28) | handle` where `handle` fits 28 bits
/// (see `pack_bulk_result`). Returns the
/// number of items processed (0 if `count == 0`).
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
            let packed = pack_bulk_result(cls, handle);
            unsafe {
                core::ptr::write_unaligned(out_cur, packed);
                out_cur = out_cur.add(1);
                byte_cur = byte_cur.add(len as usize);
            }
        }
        count
    })
}
