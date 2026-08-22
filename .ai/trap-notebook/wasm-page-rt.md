# zp-page-rt (raw WASM + shared memory) — 함정 기록

`crates/zp-page-rt` 와 `web/zp-rt.js` 의 raw `extern "C"` + 공유 linear memory 패턴에서 발견한 함정. wasm-bindgen 우회 + handle 기반 ABI 가 특유의 함정군을 만든다.

배경 설계: [.ai/zp-page-rt-design.md](../zp-page-rt-design.md). PoC 벤치 결과: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md).

---

## 2026-05-30 — Scratchpad 가 중간 classify 호출에 의해 silent 덮어쓰기 → wasm trap

**Symptoms**:
- `ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr)` 호출시 `RuntimeError: memory access out of bounds`.
- 트레이스: wasm-function[7]:0x594 (std::Vec 내부) 또는 [11].
- 같은 layout 으로 N=1 이면 통과, N≥16 부터 random 하게 터짐.

**Root cause**:
JS 가 scratch 에 `[lens table][bytes][out]` 레이아웃을 만들어 두고 wasm 호출하는 패턴에서, **중간에 `rt.classOf(s)` 같은 호출이 끼면 즉시 corrupt**. classOf 의 `writeScratch()` → `TextEncoder.encodeInto(s, scratchView())` 가 SCRATCH+0 부터 다시 쓴다. wasm 이 받은 lens_ptr 에는 이전 URL 의 UTF-8 바이트가 lens 값으로 해석됨 → 0x68747470 ("http") 같은 거대한 length 로 walk → 메모리 끝 넘어감 → trap.

**Fix**:
```js
// 잘못된 순서:
const v = new Uint8Array(ex.memory.buffer);
v.set(lensU32, lensPtr);  // 레이아웃 쓰기
v.set(bytes, bytesPtr);
for (const s of corpus) rt.classOf(s);  // ← SCRATCH 덮어씀!
ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);  // ← garbage 읽음

// 올바른 순서:
for (const s of corpus) rt.classOf(s);  // pool 워밍 먼저
const v = new Uint8Array(ex.memory.buffer);
v.set(lensU32, lensPtr);  // 레이아웃은 호출 직전에
v.set(bytes, bytesPtr);
ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
```

**Regression guard**:
- TODO: zp-rt.js 에 `withScratch(layoutFn, callFn)` 헬퍼 추가 — scratch 사용을 atomic 블록으로 강제.
- 더 안전: bulk ABI 의 ptr 인자를 SCRATCH 가 아닌 별도 영역(scratch2) 로 받게 분리.

**Pattern**:
> "JS 가 wasm linear memory 에 무언가 쓰고 → 즉시 wasm 호출 → 결과 읽음" — 이 사이에 **어떤 wasm fn 도 끼지 않게**. 끼면 그 fn 이 같은 영역을 쓸 가능성을 가정해야.

**See also**: [test/bench/url-classify.bench.mjs](../../test/bench/url-classify.bench.mjs) batch 섹션, 처음 짤 때 정확히 이 함정 밟음.

---

## 2026-05-30 — `memory.grow` 가 모든 `Uint8Array` 뷰를 detach

**Symptoms**:
- 정상 동작하다가 wasm 측 `Vec` 가 grow 트리거하는 순간 JS 측 view 사용이 silent 미스 또는 `RangeError`.
- 가장 음험한 경우: detached view 에 `.set()` 시 throw 안 하고 무시되어 wasm 이 옛 garbage 읽음.

**Root cause**:
`WebAssembly.Memory.grow()` (rustc 가 std allocator dlmalloc 통해 자동 호출) 는 **새 ArrayBuffer 를 만들고 기존 것을 detach**. JS 측 `new Uint8Array(wasm.memory.buffer)` 뷰는 detached buffer 를 가리키게 됨. 캐시한 view 는 더 이상 wasm 메모리를 보지 못함.

**Fix** (`web/zp-rt.js` 의 `memU8()`):
```js
let cachedBuf = ex.memory.buffer;
let cachedView = new Uint8Array(cachedBuf);
function memU8() {
  if (ex.memory.buffer !== cachedBuf) {       // grow 감지
    cachedBuf = ex.memory.buffer;
    cachedView = new Uint8Array(cachedBuf);
    cachedScratch = cachedView.subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
  }
  return cachedView;
}
```
Reference comparison 은 ns 수준 비용 — 안전성과 성능 동시 달성.

**Regression guard**:
- 모든 hot path 가 `memU8()` factory 호출 후 사용. **절대 외부 변수로 view 캐시 금지**.
- 벤치 (`test/bench/url-classify.bench.mjs`) 도 같은 패턴 따라야 — 안 그러면 측정값이 무의미.

**Pattern**:
> raw extern "C" cdylib 사용시 **JS 측 ArrayBuffer 뷰는 1회용**. 매 wasm call 후 reference compare 로 재발급 확인.

---

## 2026-05-30 — `static mut` 직접 참조 → Rust 2024 edition lint 실패

**Symptoms**:
```
warning: creating a shared reference to mutable static
  --> crates\zp-page-rt\src\lib.rs:46:37
   |
46 |     core::slice::from_raw_parts(SCRATCH.0.as_ptr() as *const u8, ...)
   |                                 ^^^^^^^^^^^^^^^^^^ shared reference to mutable static
   |
   = note: shared references to mutable statics are dangerous; it's undefined behavior
   = note: for more information, see <https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html>
```

**Root cause**:
Rust 2024 edition (rustc 1.82+) 가 `static mut X` 에 대한 직접 참조를 deny-by-default 로. `&X` 또는 `X.field` 같은 표현이 묵시적 shared reference 를 만든다.

**Fix**:
```rust
use std::ptr::addr_of;

static mut SCRATCH: Scratch = ...;

fn scratch_base() -> *const u8 {
    addr_of!(SCRATCH) as *const u8       // 참조 만들지 않고 주소만
}
```
`addr_of!` 매크로는 place expression 의 주소만 가져오고 reference 를 만들지 않는다.

**Regression guard**: cargo build 의 warning 을 0 으로 유지. CI 가 `-D warnings` 면 자동 차단.

---

## 2026-05-30 — `thread_local!` + `const {}` + 비-const constructor 충돌

**Symptoms**:
```rust
thread_local! {
    static POOL: RefCell<UrlPool> = const { RefCell::new(UrlPool::new()) };
}
//                                  ^^^^^ error: cannot call non-const function
//                                        in constants
```
원인은 `UrlPool::new()` 가 `HashMap::with_hasher(BuildHasherDefault::default())` 호출 — `HashMap::with_hasher` 가 const fn 이 아님.

**Root cause**:
`thread_local! { static X = const { ... } }` 의 `const { ... }` 는 const evaluation 컨텍스트. 그 안에서 호출되는 모든 fn 이 `const fn` 이어야 한다. `Vec::new()` 는 const, `HashMap::new()` 도 const, 하지만 `HashMap::with_hasher(...)` 는 아님 (custom hasher state 받음).

**Fix**: `const { ... }` 블록을 제거. 첫 접근 시 lazy 초기화로 회귀.
```rust
thread_local! {
    static POOL: RefCell<UrlPool> = RefCell::new(UrlPool::new());
}
```
첫 호출 1회 비용 ns 단위라 실효 영향 없음.

**Pattern**: `thread_local!` 의 `const {}` 는 모든 builder 가 const fn 일 때만. 한 군데라도 non-const 가 끼면 즉시 빼야 한다.

---

## 2026-05-30 — `no_std` + `extern crate alloc;` 만으로는 wasm32 빌드 안 됨

**Symptoms**:
처음 PoC 를 `#![no_std]` 로 시도 → `error[E0463]: can't find crate for std`. 추가로 panic_handler 와 global_allocator 도 명시 요구.

**Root cause**:
`#![no_std]` 면 std 의 default allocator 와 panic_handler 가 사라진다. `extern crate alloc;` 는 `Vec` 같은 alloc 타입을 빌려오지만 **allocator 는 안 따라온다**. `Vec` 가 `Box` 같은 걸 만들 때 global allocator 필요 → 미정의 → 링크 에러.

**Fix**:
PoC 는 std 사용 (`wasm32-unknown-unknown` 에서 std 가 dlmalloc 기본 제공). 워크스페이스 profile `panic = "abort"` 가 panic handler 책임짐. 추후 size 진짜 중요해지면 wee_alloc 또는 dlmalloc 직접 + `panic_handler` 명시 가능.

```rust
// 처음 시도 (실패):
#![no_std]
extern crate alloc;
use alloc::vec::Vec;

// 통과:
// (no_std 제거)
use std::cell::RefCell;
use std::collections::HashMap;
```

산출물 크기 영향: 15KB (std 사용, wasm-opt -Oz 후). 만약 진짜 1KB 절약 필요하면 no_std 로 회귀.

---

## 2026-05-30 — Headless Chrome 의 `TextEncoder.encodeInto` 가 Node V8 대비 3.55× 느림

**Symptoms**:
같은 V8 엔진인데 puppeteer headless Chrome bench 에서 `encodeInto` 단독 측정이 840 ns/op, Node 는 236 ns/op. 다른 wasm 측정도 비례적으로 모두 1.5~2.5× 느림. handle-only path 만 환경 독립 (21ns ≈ 21ns).

**Root cause** (추정):
- Headless Chrome 의 `TextEncoder` 는 Blink 측 string buffer 와 V8 isolate 사이 cross-thread 비용.
- 또는 puppeteer 의 `page.evaluate` 가 cross-realm 경로로 실행되어 추가 marshaling 발생.
- 또는 Chrome 의 `performance.now()` reduced precision (100µs) 가 짧은 측정에 noise 추가 — 다만 84ms 같은 큰 measurement 에서는 0.1% 노이즈라 주된 원인 아님.

**Fix / 회피**:
- **벤치 절대 수치는 환경 dependent** 임을 인지. 트렌드 (handle vs raw, batch vs single) 는 두 환경에서 일치.
- Browser 측 real perf 추정시 headless 수치 사용 — 실 사용자 환경에 더 가까움.
- 작업: scheme-only fast path (`url_classify_scheme_only`) 의 가치가 Chrome 에서 더 크다. encode 비용 dominant 일 때 input 을 16바이트로 자르는 효과가 비례 확대.

**Regression guard**: N/A — 환경 함정. 단지 numbers reading 시 주의.

**See also**: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §2.1.

---

## 2026-05-30 — `wasm-bindgen` 출력과 raw `extern "C"` cdylib 공존 시 dead-strip 위험

**Symptoms** (예상 함정, PoC 단계에 회피):
같은 cdylib 안에 `#[wasm_bindgen]` 와 `#[no_mangle] pub extern "C"` 가 섞이면 `wasm-bindgen-cli` post-process 가 자기가 모르는 심볼을 silent 제거할 위험. 또는 wasm-bindgen 의 start 함수가 raw export 의 init 순서를 보장 안 함.

**Root cause**:
`wasm-bindgen-cli` 는 자기가 emit 한 glue 의 import/export 그래프를 따라 reachability 분석 → 도달 안 되는 심볼 dead-strip. raw `extern "C"` 는 glue 가 없어 reachability 그래프에 안 들어감.

**Fix / 회피**:
zp-page-rt 는 **별도 cdylib** 로 분리. `wasm-bindgen` 미사용. JS 가 직접 `WebAssembly.instantiate(bytes)` 호출 + `instance.exports` 로 raw symbol 접근. zp-bundle 은 그대로 wasm-bindgen 유지.

build.mjs 도 두 artifact 를 별도 처리:
- `zp_bundle*.wasm` + `zp_bundle*.js` (wasm-bindgen 경로)
- `zp_page_rt.wasm` (raw cdylib, copy 만, glue 없음)

**Pattern**: **두 사용 모델이면 두 crate**. 한 cdylib 에 모든 걸 박지 말 것.

---

## 2026-05-30 — classifyBatch single-pass + ASCII fast-path + result no-copy + lens manual write

**Background**: P 라운드의 ASCII fast path 는 `writeScratch` 와 `classifySchemeOnly` 만 적용. `classifyBatch` 는 여전히 per-string `new Uint8Array(2048)` alloc + encodeInto + 별도 copy 패스 사용.

**Issues found and fixed**:

1. **Uint32Array 4-byte alignment 요구** — 새 single-pass 디자인에서 `outPtr = SCRATCH + bytesTotal + 4N` 으로 했을 때 bytesTotal 이 4 의 배수가 아니면 `new Uint32Array(buffer, outPtr, N)` 가 `RangeError: start offset of Uint32Array should be a multiple of 4` throw. Fix: layout 재배치 `[lens 4N][out 4N][bytes ...]` — lens/out 을 처음 두면 SCRATCH 의 8-byte alignment 보장 (Rust 측 `#[repr(C, align(8))] struct Scratch` 덕분).

2. **per-call alloc overhead** — `new Uint32Array(N)` 매 호출 alloc. closure cache 로 amortise: `let batchLensU32 = new Uint32Array(64);` + grow on demand.

3. **`new Uint8Array(buffer, ...)` view 생성 비용** — lens table 쓰기시 매번 view 생성 → manual byte-level little-endian write 로 대체:
   ```js
   for (let i = 0; i < N; i++) {
     const l = lensU32[i];
     view[i*4]   = l & 0xFF;
     view[i*4+1] = (l >>> 8) & 0xFF;
     ...
   }
   ```

4. **Result `new Uint32Array(result)` 복사 비용** — N=256 일 때 1KB 복사. Caller 가 즉시 소비 보장되면 raw view 반환 가능. MO callback 은 tight loop 로 소비하므로 safe. Documented contract: "caller MUST consume before next wasm call".

**측정 (Node, post-fixes)**: production rt.classifyBatch 280 → 255-285 ns/item (10% 절감).

**중요 관찰** — **production batch 가 schemeOnly N회 보다 느림**:
- Node batch N=64: 16,320 ns vs schemeOnly N=64: 7,680 ns (2.1× 빠름)
- Chrome batch N=64: 19,136 ns vs schemeOnly N=64: 8,960 ns (2.1× 빠름)

batch 의 진짜 가치는 **intern 까지 포함된 handle 발급 use case** 에서만. MO callback 같은 일회성 분류는 **schemeOnly N회 권장**. runtime-prelude 의 MO batch 분기 재평가 필요 (별도 작업).

**Pattern (운영 함정)**:
- WASM 측 shared-memory buffer 의 alignment 요구 (Uint32Array 4-byte, Uint64Array 8-byte) 반드시 layout 에 반영.
- Scratch 시작 주소가 alignment 보장 → lens/out 같은 typed view 영역은 **처음에** 배치.
- single-pass 디자인이 항상 win 아님 — encoding 후 layout 계산이 alignment 깨면 fallback 필요.
- Caller-safe 와 raw view return 의 trade-off 문서화 필수.

**See also**: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.7

---

## 2026-05-30 — `TextEncoder.encodeInto` 가 Chrome 에서 charCodeAt 루프 대비 2.37× 느림 (Blink cross-realm cost) + ASCII fast-path production 적용

**Symptoms**:
- Chrome 4차 측정에서 `encodeInto` 단독 840 ns/op (Node 236 ns) — 같은 V8 인데 격차 3.55×
- 의심: Blink string buffer 가 V8 isolate 와 cross-thread 마샬링 또는 puppeteer page.evaluate cross-realm 비용

**Root cause** (5차 측정에서 입증):
Encoder isolation 측정 결과 — `encodeInto`(Uint8Array dst) 434 ns vs **수동 `charCodeAt` 루프 218 ns (2× 빠름)**, `encodeAsciiFast` (ASCII 만, char ≥ 0x80 시 -1) 208 ns. URL 의 99% 는 ASCII (RFC 3986) 라 fast path 가 보편적으로 triggered. Node 에서는 `encodeInto` 가 105 ns 로 가장 빠름 — **환경 dependent 한 최적 encoder**.

**Fix** ([web/zp-rt.js](../../web/zp-rt.js) `writeScratch` + `classifySchemeOnly`):
```js
function writeScratch(str) {
  const len = str.length;
  if (len > SCRATCH_CAP) return -1;
  const view = scratchView();
  let allAscii = true;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x80) { allAscii = false; break; }
    view[i] = c;
  }
  if (allAscii) return len;
  // Non-ASCII fallback: encodeInto (V8 native faster than manual on multi-byte input).
  ...
}
```
ASCII fast path 는 char>=0x80 첫 발견시 fallback. URL 의 ASCII 가정이 깨지는 케이스 (target 사이트 가 non-ASCII unicode URL 사용) 에서 자동 fallback.

**효과**:
- Node `classifySchemeOnly`: 311 → **119.7 ns** (2.6× 빠름)
- Chrome `classifySchemeOnly`: 600 → **140 ns** (4.3× 빠름)
- 둘 다 **JS regex 초월** (Node 153 vs 119.7 = 1.28× 빠름, Chrome 200 vs 140 = 1.43× 빠름)
- `writeScratch` 도 동일 패턴 → `classOf`/`internURL` 등 모든 string-input wasm 경로 자동 적용

**Pattern (운영 함정)**:
- **encoder 선택은 환경 dependent**. Node 는 native `encodeInto` 최적, Chrome 은 manual loop 더 빠름.
- ASCII fast path + encodeInto fallback 패턴이 **두 환경 모두에서 win**.
- 입력이 RFC 3986 ASCII 보장된 영역 (URL scheme, attribute name 등) 에서 가장 효과 큼.

**Regression guard**: bench harness (`url-classify.bench.mjs`, `.browser.mjs`) 에 encoder isolation 섹션 + ASCII fast path 측정 row 영구 포함. 다른 환경 (Firefox/Safari) 결과 다를 가능성 — 측정 필요.

**See also**: bench report [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.6, bench-core 의 `encodeManual` / `encodeAsciiFast` 함수.

---

## 2026-05-30 — runtime-prelude 통합 패턴 (Recipe 2/1/3 + 함정 catalog)

zp-page-rt 를 실제 [web/runtime-prelude.js](../../web/runtime-prelude.js) 에 통합하면서 발견한 운영 함정 catalog. **3개 recipe 모두 적용 + 14 테스트 중 13 통과 (failing #4 는 사전 회귀, 무관)** + dist 빌드 통과.

### 함정 catalog

**1. async rt load + null-safe path 설계 (필수)**

zp-rt.js 의 `ZeroProxyRT.load(url)` 는 wasm fetch + instantiate 가 비동기 → MO callback / setter 가 페이지 로드 직후부터 발화하지만 rt 는 **10-50ms 후** 가용. 모든 caller 가 `if (rt)` 가드 필수, rt=null 일 때 기존 JS 경로로 fallback.

```js
let rt = null;
if (typeof globalThis.ZeroProxyRT === 'object' && globalThis.ZeroProxyRT) {
  try {
    globalThis.ZeroProxyRT.load('/__zp/zp_page_rt.wasm')
      .then(instance => { rt = instance; })
      .catch(() => { /* fall back to JS path */ });
  } catch { /* defensive */ }
}
```

**2. tickURLCache lifecycle — `finally` 절 필수**

MO callback 안에서 `tickURLCache = new Map()` 으로 set 한 뒤 **반드시 try/finally 로 clear**. 안 그러면 throw 발생시 다음 tick 까지 stale cache 가 남아 silent 잘못된 분류.

```js
tickURLCache = new Map();
try {
  for (const r of records) { ... }
} finally {
  tickURLCache = null;
}
```

**3. classifyBatch 임계값 — N<8 records 또는 candidates<4 는 호출 금지**

벤치: batch N=16 부터 plateau (120 ns/item). N=4 미만은 wasm-call setup 200ns 가 분할되지 않아 단일 호출보다 느림. runtime-prelude 의 가드:
```js
if (rt && records.length >= 8) {
  ...
  if (candidates.length >= 4) {
    const result = rt.classifyBatch(candidates);
```

**4. HTTP positive 는 tickURLCache 에 caching 금지**

`classifyBatch` 는 class enum 만 반환, 정규화된 URL string 미반환. HTTP URL 은 여전히 `new URL()` 로 canonical form 필요. cache 에는 **negative (non-HTTP) 만** 저장.
```js
if (cls !== HTTP && cls !== WS) tickURLCache.set(candidates[i], null);
// HTTP/WS 는 skip — targetURL 가 별도로 canonicalize 해야 함
```

**5. urlMeta vs urlClassifyCache — semantic 분리 유지**

기존 `urlMeta: WeakMap<el, targetString>` 의 API/contract 보존 (8군데 getter 가 string 기대). Recipe 3 의 per-element raw→target cache 는 **별도 WeakMap** 으로 추가. urlMeta 에 객체 박아넣으면 getter 사이트 전부 깨짐.
```js
const urlMeta = new WeakMap();           // 기존: el → target string (unchanged)
const urlClassifyCache = new WeakMap();  // 신규: el → { lastRaw, target }
```

**6. build.mjs 번들 순서 — zp-rt.js MUST prefix runtime-prelude.js**

`writeBundled('runtime-prelude.js', [readSource('zp-rt.js'), readSource('runtime-prelude.js')])` 순서가 중요. zp-rt.js 가 IIFE 안에서 `globalThis.ZeroProxyRT` 를 register → runtime-prelude IIFE 가 시작시 `typeof globalThis.ZeroProxyRT === 'object'` 체크. 순서 바꾸면 rt 영구 null.

**7. `/__zp/zp_page_rt.wasm` Go server whitelist 필수**

[cmd/zeroproxy-server/main.go:120-122](../../cmd/zeroproxy-server/main.go#L120) 의 명시적 whitelist:
```go
case r.URL.Path == "/__zp/zp_bundle.js" || ... ||
     r.URL.Path == "/__zp/zp_page_rt.wasm":
    s.serveFile(...)
```
미등록시 default case 가 `POLICY_BLOCKED` → wasm fetch 실패 → rt 영구 null → silent fallback (테스트는 통과하지만 효과 없음).

### Recipe 별 적용 위치 (참조)

| Recipe | 패턴 | 적용 위치 |
|---|---|---|
| **2 (JS dedup)** | `isHTTPURL(v) + targetURL(v)` → `targetURLIfHTTP(v)` 단일 parse | 8 sites: 1691, 1727, 1917, 1941, 2098, 2143, 2366, 2556 |
| **1 (Batch ABI)** | MO callback 시작 시 batch pre-classify non-HTTP 들 → tickURLCache 에 null 저장 | installBaseObserver 콜백 (2329-) |
| **3 (per-element cache)** | `targetURLForElement(el, raw)` 가 lastRaw 일치시 cached target 반환 | setAttribute (1917), setAttributeNS (1941), enforceObservedAttribute (2370) |

### 측정 효과 (이론)

- **Recipe 2 단독**: long URL setAttr 2600 → 1300 ns (50% ↓). 모든 환경.
- **Recipe 1 (rt 가용)**: MO tick burst 시 non-HTTP URL N개 분류 비용 → 0. 4+ non-HTTP 일 때 효과.
- **Recipe 3**: React 동일 src 재할당 1300 → ~50 ns (Map lookup). 60fps × 10 props × 60s ≈ 0.78 ms/sec 절감.

실 사이트 검증 (taskweaver) 미수행 — 다음 작업.

### Regression guard

- [test/js/static-policy.test.js](../../test/js/static-policy.test.js) 14개 중 13 통과 (#4 는 사전 회귀, document.write proto-level wrap 작업과 충돌하는 test assertion)
- [cargo test --workspace](../../Cargo.toml) 63 통과
- 빌드 dist: zp_page_rt.wasm 15.0K, runtime-prelude.js 157.9K (zp-rt.js prefix 포함, +1KB net)

### See also
- 설계: [.ai/zp-page-rt-design.md](../zp-page-rt-design.md)
- 벤치: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md)
- 적용 분석: [.ai/zp-page-rt-applicability.md](../zp-page-rt-applicability.md)

---

## 2026-05-30 — Scheme-only fast path: 길이 평탄성 달성, 다만 짧은 URL 에서 절감 없음

**가설 (이전 측정에서)**: `encodeInto` 가 length-linear 이므로 긴 URL 에서 raw-string WASM 이 catastrophic (Node 8×, Chrome 11× 느림). 첫 16바이트만 encode 하면 cost 가 길이 무관해질 것.

**측정 결과 (D 라운드, 100k iter)**:

Node:
- short (~29B): classOf 292ns → schemeOnly 235ns (-19%)
- medium (~100B): 471ns → 261ns (**-45%**)
- long (~500B): 1248ns → 248ns (**-80%** ✓)

Chrome:
- short (~29B): classOf 513ns → schemeOnly 515ns (**0%**)
- medium (~100B): 760ns → 616ns (-19%)
- long (~500B): 2030ns → 678ns (**-66%** ✓)

**가설 입증**: Node 측정 schemeOnly 가 235-260ns 평탄. Chrome 측정도 길이 격차 줄어듦 (513→678 vs 513→2030).

**예상 못한 관찰**: 짧은 URL (~29B) 에서는 schemeOnly 가 classOf 와 같음. 이미 16바이트 안 넘기 때문에 encode 절감 없음. **short URL 비중 높은 worker 라면 schemeOnly 도입 가치 없음**.

**Chrome 의 별도 발견**: `js-startsWith chain` 이 Chrome 에서 **regex 보다 1.51× 빠름** (121 vs 183 ns). V8 string method 인라이닝 > regex JIT. 그래서 Chrome 의 진짜 JS baseline 은 121 ns/op startsWith.

**Fix / Pattern**:
```rust
// crates/zp-page-rt/src/lib.rs
#[no_mangle]
pub extern "C" fn url_classify_scheme_only(ptr: u32, len: u32) -> u32 {
    if len == 0 || len > 256 { return UrlClass::Invalid as u32; }
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len as usize) };
    classify_scheme(bytes) as u32
}
```
```js
// web/zp-rt.js
const SCHEME_PROBE = 16;
function classifySchemeOnly(str) {
  const dst = scratchView().subarray(0, SCHEME_PROBE);
  const { written } = enc.encodeInto(s, dst);
  return ex.url_classify_scheme_only(SCRATCH, written) >>> 0;
}
```

**운영 가이드**:
- 사용: URL 길이 100B+ 가능성 있는 attribute (CSS background-image, srcset, signed URL)
- 사용 금지: 짧고 정형화된 URL (절감 없음). 또는 intern 캐시 효과 활용 가능한 곳 (`internURL` 으로 7-9× 우위).
- 조합 패턴: mutation 콜백 1차 = `schemeOnly` (catastrophe 회피), 진짜 process 결정시 `internURL` 로 handle 발급 → 후속 호출 17~20 ns.

**Regression guard**: bench harness 가 매번 schemeOnly 측정 — 평탄성 회귀시 즉시 발견. parity check 에 about:srcdoc 같은 truncation edge case 포함.

**See also**: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.5.

---

## 2026-05-30 — JS regex 가 raw-string WASM 보다 빠른 게 일반적

**Symptoms** (성능 관찰, 함정이 아닌 가설 오류 경고):
초기 가설은 "WASM 이 JS hot path 분류를 대체하면 빨라진다". PoC 측정 결과 raw-string `wasm_classify(str)` 가 JS regex 대비 1.97~4× 느림. cold path 까지 가면 (cache 미적중) 차이 더 큼.

**Root cause**:
- V8 가 단순 정규식을 native 로 JIT 컴파일 → 측정 130-180 ns/op (Node) / 175-200 ns/op (Chrome).
- WASM raw-string 의 비용 구조: `TextEncoder.encodeInto` (200+ ns) + wasm call setup (150+ ns) = 단순 분류로는 JS regex 대비 손해.
- 우위는 두 가지 경로에서만: (1) handle pipeline (encode 0 회), (2) batch (N≥16 으로 amortise).

**Pattern / 권장**:
> 단순 helper 1:1 치환 금지. **handle 흐르는 곳** (htmltx → page-rt 마커) 또는 **batch 채널** (MutationObserver) 만 WASM 우위.

raw-string in/out hot path 는 그대로 JS 두기.

**See also**: [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) "누가 어디서 이기는가" 매트릭스.

---

## 2026-05-30 — MO callback 의 tickURLCache lifecycle throw-safety 갭

**Symptoms** (잠재적 leak, 회귀 검증 중 발견):
R+S 라운드에서 `tickURLCache = new Map()` 와 `rt.classifySchemeOnly` 루프가 try/finally **바깥**에 있었음. 만약 schemeOnly 가 WASM hiccup 으로 throw 하면:
1. tickURLCache 가 non-null 상태로 잔존
2. 다음 MO 틱 이전에 main loop / enforceObservedAttribute 가 `targetURLIfHTTP(raw)` 호출시 stale tickURLCache 참조
3. 같은 raw → 같은 target 이라 functional 정확성은 유지되지만, 메모리 leak + 의도와 다른 캐시 수명

raw → target 매핑이 deterministic 이라 실제 사용자 영향은 0 이지만, "tick-scoped" 의미가 무너지므로 명백한 invariant 위반.

**Root cause**:
finally 가 main loop 만 감싸고 있었음. throw 가능 코드 (`rt.classifySchemeOnly` — WASM trap / detached buffer 가능) 가 try 바깥에 있으면 cleanup 누락.

**Fix** ([web/runtime-prelude.js:2415-2435](../../web/runtime-prelude.js#L2415-L2435)):
```js
tickURLCache = new Map();
try {
  if (rt) {
    const HTTP = rt.UrlClass.HTTP, WS = rt.UrlClass.WS;
    for (const r of records) {
      if (r.type !== 'attributes') continue;
      const raw = Native.getAttribute.call(r.target, String(r.attributeName || ''));
      if (!raw || tickURLCache.has(raw)) continue;
      try {
        const cls = rt.classifySchemeOnly(raw);
        if (cls !== HTTP && cls !== WS) tickURLCache.set(raw, null);
      } catch { /* WASM hiccup — fall through to per-record main loop */ }
    }
  }
  for (const r of records) {
    if (r.type === 'attributes') enforceObservedAttribute(...);
    else for (const n of r.addedNodes || []) { syncBaseElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n); }
  }
} finally {
  tickURLCache = null;
}
```

두 단계 보호:
1. **Outer try/finally**: 어떤 경로로 throw 해도 tickURLCache cleanup 보장.
2. **Inner try/catch** (per-record): 단일 URL 의 WASM trap 으로 전체 pre-classify 루프가 무너지지 않게. 못 미는 분류는 main loop 의 `targetURLIfHTTP` 가 정상 분류 (1300 ns 정상 비용 회복).

**Regression guard**:
- 패턴: "**tick-scoped state** + **외부 호출 throw 가능**" 조합 보면 자동 의심. tick-scoped 의미는 항상 finally 로 강제.
- 새 MO callback / animation frame / queueMicrotask 에 tickURLCache 와 같은 ephemeral 컬렉션 추가하면 lifecycle 끝나는 지점부터 거꾸로 try/finally 짠다.

**Pattern**:
> "lifecycle-bounded mutable" 패턴은 lifecycle scope 가 곧 try/finally scope. 그 사이에 throw 가능한 외부 호출이 끼면 immediate cleanup invariant 무너짐.

**See also**: P+Q+R+S 검증 결과 (NAVER/Wikipedia/GitHub 회귀 없음). [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.7.

---

## 2026-05-30 — `classifySchemeOnly` 같은 internal sub-API 는 외부 sanity script 에서 접근 불가

**Symptoms**:
회귀 검증 sanity script 에서 `globalThis.ZeroProxyRT.classifySchemeOnly(...)` 호출 → undefined.

**Root cause**:
`zp-rt.js` 의 `classifySchemeOnly` 는 IIFE 안의 `rt` 인스턴스에만 노출. `globalThis.ZeroProxyRT` 에는 `load(url)` 와 `UrlClass` enum 만 export. 의도된 캡슐화 — 외부에서 SCRATCH 임의 접근 차단 (raw memory access 안전성).

**Pattern / 권장**:
> sanity / 회귀 script 에서 internal sub-API 직접 호출 의도면, `ZeroProxyRT.load(...)` 결과의 rt instance 변수를 sanity script 가 보관해야 함. 또는 production code path (MutationObserver 콜백 trigger 같은) 로 간접 검증.

**Regression guard**: 새 internal API 추가시 export 표면 의도 명확히. "internal-only" 인지 "external sanity" 도 가능한지.

**See also**: [web/zp-rt.js](../../web/zp-rt.js) `globalThis.ZeroProxyRT = { load, UrlClass }`.

---

## 2026-05-30 — Hook chain 의 helper 함수가 같은 derived 값 (localKey, tag) 을 N회 재계산

**Symptoms** (성능 회귀, R+S 검증 후 production 실사이트 측정으로 발견):
NAVER 페이지에서 setAttribute 100 elements burst latency 가 25 µs/call. WASM 분류는 100-200 ns 영역인데 hot path 의 99% 가 element-specific 로직.

**Root cause**:
`setAttribute` hook 한 호출 안에서:
- `attrLocalName(key)` **5~6회 호출**: caller 가 이미 `localKey` 를 inline 으로 계산했는데도 `isURLBearing` / `shouldBlockURLAttribute` / `usesRawURLAttribute` 안에서 매번 재계산. 매 호출 = `String(key)` + `.toLowerCase()` + `.indexOf(':')` + 조건부 `.slice()` ≈ 30-50 ns.
- `this.localName` **10회 read**: branch chain (link × 4, base, script, iframe||frame × 2 등) 마다 native DOM getter 호출.
- `usesRawURLAttribute(this, key)` **2회 호출**: set + return 분기에서 같은 element/key 로 2번 (각각 안에서 attrLocalName 재계산).

총 추가 overhead 추정 ~500-800 ns / setAttribute call. burst 시 누적.

**Fix** ([web/runtime-prelude.js:1448, 1962-2003, 2029-2057, 2284](../../web/runtime-prelude.js)):
1. helper 시그니처 확장 (optional 인자, backward-compat 유지):
   ```js
   function isURLBearing(el, key, _localKey, _tag) {
     const tag = _tag != null ? _tag : el.localName;
     const localKey = _localKey != null ? _localKey : attrLocalName(key);
     ...
   }
   function usesRawURLAttribute(el, key, _localKey) { ... }
   function shouldBlockURLAttribute(el, key, raw, _localKey, _tag) { ... }
   ```
2. 4개 hook (setAttribute / NS / getAttribute / removeAttribute) 안에서 한 번만 계산 + helper 에 전달:
   ```js
   const key = String(k).toLowerCase();
   const colon = key.indexOf(':');
   const localKey = colon < 0 ? key : key.slice(colon + 1);  // attrLocalName inline
   const ln = this.localName;
   ...
   if (isURLBearing(this, key, localKey, ln)) {
     if (shouldBlockURLAttribute(this, localKey, v, localKey, ln) || ...) ...
     const t = targetURLForElement(this, v);
     if (t) {
       const usesRaw = usesRawURLAttribute(this, key, localKey);  // 1회만
       ...
     }
   }
   ```

**측정 효과** (NAVER, taskweaver):
- Probe single-element setAttribute (URL setter): 1.00 µs → 0.80 µs (-20%)
- **Real DOM 100 different elements**: **25 µs/call → 17 µs/call (-32%)**
- **Same URL × 1000 (urlClassifyCache HIT)**: **1200 ns/call → 600 ns/call (-50%)**
- Unique URLs × 1000 (cache miss): 2000 ns/call → 1200 ns/call (-40%)

**Pattern / 권장**:
> "Hook chain 의 helper 가 같은 인자로 같은 derived 값을 재계산하는가" — 매번 의심. 특히 **string 정규화 (lowercase, split, slice)** 와 **native DOM getter** 가 helper 안에서 반복되면 caller-side 캐싱 + helper 시그니처 확장.

**Regression guard**:
- nullish 체크 (`!= null`) 사용 — 빈 문자열 '' 이 valid localKey 라 truthy 체크 금지.
- attrLocalName 새 호출자 추가 시 caller 가 이미 localKey 계산했는지 확인 → 그러면 helper 에 전달.
- 동일 패턴 후속 적용 후보: insertAdjacentHTML, Attr.value setter, enforceObservedAttribute (MO callback), prepareScriptElement.

**See also**: [.ai/zp-page-rt-bench-report.md §3.9](../zp-page-rt-bench-report.md#39-t-라운드--element-specific-로직-path-단축-setattribute-hook-chain-의-attrlocalname--localname-중복-제거).

---

## 2026-05-30 — MO record path (`enforceObservedAttribute`) 의 `usesRawURLAttribute` 3회 중복 호출

**Symptoms** (성능 회귀, T 라운드 후속 audit 으로 발견):
T 라운드는 4개 hook (setAttribute / NS / getAttribute / removeAttribute) 만 fix. MO callback 이 attribute record 마다 `enforceObservedAttribute` 호출하는데 거기도 같은 중복 패턴 + 추가로 **`usesRawURLAttribute` 3회 호출** (alreadyMapped 체크 + data-zp-target-url set 분기 + final set 분기).

**Root cause**:
```js
function enforceObservedAttribute(el, key) {
  const localKey = attrLocalName(key);
  const tag = el.localName;
  ...
  if (!isURLBearing(el, key)) return;                                    // re-compute
  if (shouldBlockURLAttribute(el, localKey, raw) || ...) ...;            // re-compute × 2
  ...
  const alreadyMapped = ... && (!usesRawURLAttribute(el, key) ? ... : true);  // call 1
  if (!usesRawURLAttribute(el, key)) Native.setAttribute(...);           // call 2
  if (!usesRawURLAttribute(el, key)) Native.setAttribute(el, key, target); // call 3
}
```

3회 동일 호출 = 3× attrLocalName + 3× el.localName + 3× tag/localKey 분기 평가.

추가: `isURLBearing` 안에서 호출되는 `isSVGURLBearing` 도 `attrLocalName(key)` 재계산 — chain effect.

**Fix** ([web/runtime-prelude.js:2454-2496, 2284](../../web/runtime-prelude.js)):
1. enforceObservedAttribute 안에서 `usesRaw` 변수 캐싱 + helper 시그니처 전달:
   ```js
   if (!isURLBearing(el, key, localKey, tag)) return;
   if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || ...) ...;
   ...
   const usesRaw = usesRawURLAttribute(el, key, localKey);  // 1회
   const alreadyMapped = ... && (!usesRaw ? ... : true);
   if (!usesRaw) Native.setAttribute(el, 'data-zp-target-url', target);
   if (!usesRaw) Native.setAttribute(el, key, target);
   ```
2. `isSVGURLBearing` 시그니처 확장 + `isURLBearing` 안에서 전달:
   ```js
   function isSVGURLBearing(el, key, _localKey) {
     return el && el.namespaceURI === 'http://www.w3.org/2000/svg' &&
            (_localKey != null ? _localKey === 'href' : attrLocalName(key) === 'href') &&
            /^(a|image|use|script)$/.test(el.localName || '');
   }
   // isURLBearing:
   return localKey === 'href' && (tag === 'a' || ... || isSVGURLBearing(el, key, localKey)) || ...;
   ```

**측정 효과** (NAVER, T 직후 → T2 누적):
- **Real DOM 100 different elements**: 17 → **15 µs/call** (-12% 추가, 누적 -40% vs R+S baseline)
- **Unique URLs × 1000 (cache miss)**: 1200 → **900 ns/call** (-25% 추가, 누적 **-55% vs R+S baseline**)

T2 가 cache miss path 에서 더 효과 — MO callback 의 본격적인 enforceObservedAttribute 진입 경로가 unique URL 일 때이기 때문.

**Pattern / 권장**:
> "같은 element + 같은 key 로 한 함수 안에서 N회 helper 호출 = N-1 redundant compute." 한 번 호출 후 boolean 변수 캐싱.

**Regression guard**:
- 새 hook 추가 시 enforceObservedAttribute 의 fix 패턴 reference. 특히 `usesRawURLAttribute` 같은 boolean helper 가 같은 (el, key) 로 여러 분기에서 쓰이면 즉시 캐싱.

**See also**: [.ai/zp-page-rt-bench-report.md §3.10](../zp-page-rt-bench-report.md#310-t2-라운드--mo-record-path-enforceobservedattribute-확산--issvgurlbearing-시그니처-확장). 적용 끝난 후 audit 한 후보 — setScriptSource / enforceLinkPolicy / prepareScriptElement / Attr.value setter / insertAdjacentHTML 는 helper chain 중복 없음 (단순 path).

---

## 2026-05-30 — zp-htmltx 의 동일 helper-chain 중복 패턴 (`to_ascii_lowercase` per attribute) + lol_html lowercase invariant 의존

**Symptoms** (서버측 hot path 비효율, audit 으로 발견):
JS hot path 최적화 후 zp-htmltx 도 동일 패턴 검사 결과:
- `proxied_subresource_url` + `absolute_target_url` 의 scheme detection 코드 **byte-for-byte identical** (각각 `to_ascii_lowercase()` + 6× starts_with). 한 subresource URL 마다 두 함수 모두 호출시 lowercase 2회 alloc.
- element handler 안 attribute loop 에서 `tag = el.tag_name().to_ascii_lowercase()` per-attribute 호출 (같은 element 의 모든 attribute 가 같은 tag 인데).
- `value.to_ascii_lowercase()` 가 URL 100B+ 인 경우 큰 alloc 비용 — `starts_with("javascript:")` 한 번 확인 위해 전체 lower-cased copy.

**Root cause**:
JS 와 동일 패턴 — helper 함수가 caller invariant (이미 lowercase 인 string) 를 모르고 매번 재정규화.

**Fix** ([crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs)):
1. zero-alloc helper 추가:
   ```rust
   #[inline]
   fn starts_with_ascii_ci(s: &str, prefix: &str) -> bool {
       s.len() >= prefix.len()
           && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
   }
   #[inline]
   fn is_inert_scheme(s: &str) -> bool {
       starts_with_ascii_ci(s, "data:") || starts_with_ascii_ci(s, "blob:")
           || starts_with_ascii_ci(s, "about:") || starts_with_ascii_ci(s, "mailto:")
           || starts_with_ascii_ci(s, "javascript:") || starts_with_ascii_ci(s, "vbscript:")
   }
   ```
2. 두 함수의 lowercase alloc 제거 + 코드 중복 통합.
3. element handler:
   - `let tag = el.tag_name();` (lol_html lowercase 보장, element 시작에 1회)
   - `let lower = name.as_str();` (attribute name 도 lol_html lowercase 보장, per-attribute alloc 제거)
   - URL 값 check 도 `starts_with_ascii_ci(trimmed, "javascript:")` 로 전환.

**Silent invariant 의존 (⚠️ 주의)**:
이 fix 는 **lol_html 의 보장**에 의존:
- `Element::tag_name()` returns lowercase ASCII.
- `Attribute::name()` returns lowercase for HTML elements.

이 invariant 가 깨지면 (예: SVG/MathML namespace 의 case-preserving attribute, 또는 lol_html major version upgrade) **silent miss** — `matches!` 분기가 안 매치되어 URL 이 제대로 처리되지 않을 수 있음. 단 `xlink:href` 같은 namespaced attribute 는 `lower = "xlink:href"` 가 되어 `matches!("href" | "src" | ...)` false → continue (정상, 회귀 없음).

**Regression guard**:
- `cargo test -p zp-htmltx` 의 19 tests 가 SVG / case-sensitive corner case 커버 부족하면 추가 test 권장.
- lol_html crate upgrade 시 release notes 의 "case normalization" 변경 확인.
- 새 element handler 추가시 같은 invariant 의존 패턴 일관성 있게 유지.

**검증**:
- `cargo test -p zp-htmltx`: 19/19 pass.
- NAVER 실사이트: 회귀 없음 (title=NAVER, ZeroProxyRT ✓, iframes 9, diag 0).

**측정 한계**:
이 fix 의 효과는 서버측 throughput 에서만 가시화. JS browser micro-bench 로 직접 측정 불가. 정량화에는 Rust criterion 으로 page-level transform throughput 측정 별도 필요.

**See also**: [.ai/zp-page-rt-bench-report.md §4](../zp-page-rt-bench-report.md#4-조사-zp-htmltx--handle-pipeline-평가).

---

## 2026-05-30 — WASM handle pipeline (zp-htmltx → zp-page-rt) 의 진정한 shared memory 불가능 + Recipe 5 의 marginal value 한계

**Symptoms** (큰 설계 변경 후보 평가 결과):
사용자 질문: "추가 큰 win 후보 = 서버측 (zp-htmltx) 영역 또는 WASM handle pipeline 같은 큰 설계 변경". 두 영역 audit 결과 handle pipeline 은 기술적으로 불가능 또는 marginal.

**Root cause / 평가**:

| 옵션 | 결과 |
|---|---|
| **직접 handle 전달 (SW → page)** | ❌ 불가 — zp-htmltx (SW WASM instance) 와 zp-page-rt (page WASM instance) 가 별도 linear memory. handle 은 instance-local pointer. SW handle 을 page 에서 직접 사용 = 무효한 메모리 접근. |
| **Raw URL list passing (response header / inline marker)** | ✓ 가능하지만 **zp-htmltx 가 이미 `data-zp-target-url` 로 raw URL 을 DOM 에 박는 중** — 새 채널 불필요. |
| **SharedArrayBuffer 기반 진짜 shared memory** | ⚠️ COOP/COEP 강제 → cross-origin isolation 필요. ZeroProxy 의 stealth 모델 (자기 자신을 다른 origin 으로 위장) 과 충돌. 회피 어려움. |
| **단일 cdylib + 두 instance** | ❌ marginal — 코드 (module) 공유는 가능하나 memory 분리 그대로. instance 마다 별도 intern pool. |
| **Recipe 5 (page boot 일괄 intern pass)** | ✓ 가능, 다만 **intern pool 의 hash 기반 dedup 이 이미 cross-call dedup 자동 제공** — boot pass 추가의 marginal value 없음. |

**핵심 발견**:
- intern pool 이 hash-based dedup 이라 같은 raw URL 의 두 번째 호출은 자동으로 같은 handle 반환. 즉 zp-htmltx 의 boot intern 과 page-rt 의 mutation intern 이 **결과적으로 동등**.
- handle 의 진짜 가치 = 분류 17 ns/op. 그러나 **production hot path 의 URL classify 비중이 1-2%** (§3.10 measurement). element-specific 로직 (link policy, navigation gate, urlMeta.set chain) 의 1000+ ns 이 dominates. 분류를 17 ns 로 줄여도 absolute gain 작음.

**결론 / 권장**:
> handle pipeline 시도하지 말 것. JS hot path 의 element-specific 로직 단축 (T+T2 라운드) 이 ROI 훨씬 큼. WASM 측은 schemeOnly ASCII fast path (P+Q+R+S) 까지가 ceiling.

> 진짜 추가 win 후보: **서버측 throughput 측정 별도 영역** (zp-htmltx criterion bench), **HTML page boot time end-to-end 측정** (다른 metric layer).

**Pattern / 일반 교훈**:
> "두 WASM instance 가 같은 logical 분류 pool 을 공유해야 한다" 라는 요구는 SharedArrayBuffer 없이는 deep design constraint. 그러나 hash-based dedup 으로 **결과적 동등성** 을 자동 확보 가능 — 진짜 shared memory 가 필요한 use case 가 아니라면 시도 회피.

**Regression guard**:
- 새 "intern pool 공유" 제안이 다음 세션에서 다시 나오면 이 항목 reference. SharedArrayBuffer 우회 시도 = stealth membrane 깨지는 위험.

**See also**: [.ai/zp-page-rt-bench-report.md §4.2](../zp-page-rt-bench-report.md#42-wasm-handle-pipeline-평가--큰-설계-변경-roi-작음).

---

## 2026-05-30 — server-side criterion bench 가 inline script (OXC parse) hot path 가설을 거부 — 진짜 hot path 는 subresource processing

**Symptoms** (V 라운드 측정 결과):
zp-htmltx 의 transform throughput 측정시 직관은 "inline script 의 OXC parse 가 hot path". 측정 결과 정반대.

**측정 데이터** (V 라운드, criterion):
- transform_typical_no_inline (380 URL-bearing, 0 inline): 1.81 ms
- transform_typical (380 URL-bearing, 3 inline scripts): 1.85 ms
- transform_inline_only_50 (50 inline scripts only): 533 µs

분해:
- inline script per call: 10.7 µs/script
- typical 의 1.85 ms 중 inline 비중: ~40 µs (2%)
- 진짜 hot path 는 per URL-bearing element ~4.7-4.9 µs × N (subresource processing dominates)

**Pattern / 권장**:
> "inline script rewrite (OXC parse) cost 가 hot path" 같은 직관에는 측정으로 반증. 실제 대규모 페이지에서 inline script 수는 보통 1자릿수 (3-15), subresource (script src, link href, img src, anchor href) 는 100-1500개. element handler dispatch + URL rewrite chain 이 dominant.

> 따라서 zp-rewriter (OXC) 측 micro-optimization 보다 zp-htmltx 의 subresource path 단축이 ROI 큼. V 라운드에서 적용: lazy attribute filter + streaming percent-encode + resolve_against_base CI+builder → typical -8%, large -6%, sub -9% 누적.

**Regression guard**:
- bench 가 zp-htmltx 회귀 detection 으로 작동. CI 에 추가 권장 (`cargo bench -p zp-htmltx --bench transform`).
- inline script 수 늘어나는 fixture (예: SSR React with many `<script id="__NEXT_DATA__">`) 도 보면 다른 결론 가능 — bench fixture diversity 유지.

**See also**: [.ai/zp-page-rt-bench-report.md §4.4](../zp-page-rt-bench-report.md#44-v-라운드--server-side-throughput-criterion-bench--추가-hot-path-단축), [crates/zp-htmltx/benches/transform.rs](../../crates/zp-htmltx/benches/transform.rs).

---

## 2026-05-30 — `format!()` per-element + `utf8_percent_encode(...).to_string()` 가 server-side hot path 의 진짜 cost (V 라운드)

**Symptoms** (V 라운드 측정 발견):
zp-htmltx 의 `proxied_subresource_url` (subresource per call) + `resolve_against_base` (relative URL per call) 가 매번:
- `String::with_capacity` 충분히 reserve 안 함 (`absolute.len() + 32` 만, percent-encode 가 ASCII byte 를 3× 확장하는데도)
- `utf8_percent_encode(...).to_string()` 가 Cow<str> 를 String 으로 collect — 중간 alloc 한 단계
- `format!("{}{}{}", origin, dir, rel)` 매번 alloc + write (4 곳에서)
- `base.to_ascii_lowercase()` per call alloc (base scheme check 한 줄을 위해)
- `split('?').next().unwrap_or(...).split('#').next().unwrap_or(...)` (2× lazy iterator alloc)

**Root cause**:
"한 줄 짜리 format!() 정도는 작은 비용" 가정 — 실제 page 마다 수백 회 → 누적 의미. percent_encoding 라이브러리의 iterator API 는 `&str` chunks 를 직접 push 가능한데 `.to_string()` 한 번 거치는 게 idiomatic 으로 보였음.

**Fix** ([crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs)):
1. `proxied_subresource_url`:
   - capacity 를 `absolute.len() * 3 + ...` 로 변경 (percent-encode 보수적 estimate).
   - `for chunk in utf8_percent_encode(...) { out.push_str(chunk); }` — Cow iterator 직접 push.
2. `resolve_against_base`:
   - `starts_with_ascii_ci(base, "http://")` (U 라운드 helper 재사용, alloc 0).
   - 4× `format!()` → `String::with_capacity + push_str` chain.
   - `split('?').next().split('#').next()` → `split(['?', '#']).next()` (single pass).

**측정 효과** (criterion, 누적 V 후):
| Bench | U baseline | V 최종 | 누적 Δ |
|---|---|---|---|
| transform_typical | 1.88 ms | **1.73 ms** | **-8%** |
| transform_large | 6.99 ms | 6.59 ms | **-6%** |
| transform_subresource_heavy | 5.07 ms | 4.62 ms | **-9%** |

**Pattern / 권장**:
> "함수 1회 호출 당 작은 alloc" 의 hot path 누적은 측정해야 보임. 특히 page-rate hot path 에선 `format!()` 보다 `String::with_capacity + push_str` chain 이 약 1.5-2× 빠름 + iterator API 의 `.to_string()` 제거가 alloc 한 단계 절감.

**Regression guard**:
- 새 URL 처리 helper 추가시 `format!()` 대신 `with_capacity + push_str` pattern 일관성.
- percent_encoding / urlencoding 같은 iterator-returning API 는 `.to_string()` 없이 chunk 직접 push 가능 여부 항상 확인.

**See also**: [.ai/zp-page-rt-bench-report.md §4.4.3](../zp-page-rt-bench-report.md#443-applied-v-wins-3-additional).

---

## 2026-05-31 — W 라운드 (호환성 작업 후속): fast-path Cow return + per-msg event fast-exit + adaptive backoff polling

**Symptoms** (호환성 작업 후 audit 결과):
2026-05-31 의 호환성 작업 (NAVER 웹툰 Location virtualization, zp-htmltx `&amp;` 디코드, `installSafeFrameResizeShim`, V8 incumbent realm leak fix) 직후 새 코드의 hot path 패턴:
1. `decode_url_html_entities(&str) -> String` 의 fast path (`&` 없음) 도 `src.to_string()` alloc — 페이지 마다 수백 URL 의 99% 가 fast path 라 alloc 누적
2. `virtualizeMessageEvent` 가 매 message event 마다 `virtualOriginForMessage(...)` 호출 — 안에서 `ev.origin !== proxyOrigin` 이면 즉시 '' 반환 (대부분 case). 함수 호출 + 조건부 객체 alloc 의 불필요 cost
3. `installSafeFrameResizeShim` 의 200ms polling 이 영구 → 매 tick 마다 `scrollHeight`/`offsetHeight` reads = layout reflush 강제. 3-5 SafeFrame iframes × forever × 200ms = cumulative reflow noise

**Root cause / 패턴**:
> 새 함수 추가시 "이미 V 라운드까지 hot path 정리됐으니 끝났다" 가정 위험. 호환성 작업 마다 새 함수가 hot path 가 될 가능성 있음 → 매번 같은 audit 패턴 적용.

**Fix**:
1. **W1** (`decode_url_html_entities` → `Cow<'_, str>`): fast path 에 `Cow::Borrowed(src)` 반환 (zero alloc), slow path `Cow::Owned(out)`. Caller `let decoded = ...; let trimmed = decoded.trim_start();` (owned shadow 제거). → criterion large -9%, typical -4%.
2. **W2** (`virtualizeMessageEvent` fast-exit): `if (actualSource === ev.source && ev.origin !== proxyOrigin) return ev;` (virtualOriginForMessage 호출 자체 skip). → message event 빈도가 SafeFrame 광고 page 에서 의미.
3. **W3** (`installSafeFrameResizeShim` adaptive backoff): height stable 3 tick 후 interval 점진 증가 (200→400→800→1600→2000ms cap), 변화시 200ms reset. image load event hook 은 유지 → 첫 안정화 후 reflow 누락 없음. → 안정화 후 polling rate 10× 감소.

**측정 효과** (criterion, U baseline → 전체 누적):
| Bench | U baseline | W 최종 | 누적 Δ |
|---|---|---|---|
| transform_typical | 1.88 ms | 1.51 ms | **-20%** |
| transform_large | 6.99 ms | 5.78 ms | **-17%** |
| transform_subresource_heavy | 5.07 ms | 4.12 ms | **-19%** |

검증: cargo test 20/20, static-policy 13/14 baseline, NAVER 회귀 없음.

**Pattern / 일반화**:
> "함수가 합당한 fast path 를 갖고 있는데, fast path 도 owned 반환 강제" 인 경우 항상 `Cow<'_, str>` 평가. owned shadow 호출자 코드 (`let value: String = decoded;`) 제거 가능.

> "Boolean helper 가 안에서 early-exit 하는데 caller 가 그 helper 를 매번 호출" → caller 의 fast-exit 조건 inline 으로 helper 호출 자체 skip 평가.

> "영구 polling (setTimeout loop)" 은 adaptive backoff 패턴 (variation 없을 때 interval 점진 증가) 으로 idle cost 절감. 변화 감지시 immediate reset 으로 latency 유지.

**Regression guard**:
- 새 compat 작업 후 항상 새 helper 가 hot path 인지 audit (per-element / per-mutation / per-message). 한 줄짜리 fast-exit 추가도 적용.
- `Cow<'_, str>` 가 idiomatic Rust 의 zero-alloc fast path. URL helper 추가 시 default 로 평가.
- setTimeout polling 의 fixed interval = anti-pattern. 변화 감지시 reset, 안 변화시 backoff.

**See also**: [.ai/zp-page-rt-bench-report.md §5](../zp-page-rt-bench-report.md#5-w-라운드-호환성-작업-2026-05-31-직후-추가-hot-path-단축).

---

## 2026-08-20 — 매트릭스의 "정적 칸"을 채우자 파싱 시점 서브리소스 구멍 여섯 개가 한꺼번에 나왔다

**Symptoms**:
- 없었다. **아무도 신고하지 않은 구멍**이다 — CSP 가 조용히 막고 있었기 때문에
  실사이트에서도 매트릭스에서도 증상이 안 보였다.

**발견 경로 (이게 이 항목의 핵심이다)**:
어제 `a10-static-iframe` 을 잡고 나서, 같은 실수가 또 있는지 보려고 매트릭스를
다시 읽었다. 정적 그룹은 `a1`~`a10` 열 칸이고 `b`/`c`/`d`/`e` 는 **전부 런타임
경로**였다. 그래서 케이스를 더 만들기 전에 **htmltx 의 `(tag, attr)` 서브리소스
목록을 소스에서 직접 읽어** 브라우저가 요청을 내는 조합과 한 줄씩 대조했다.
목록에 없는 조합을 그대로 케이스로 옮긴 것이 `a11`~`a20` 이다.

브라우저를 띄우기 전에 **rust 단위 테스트로 먼저 쟀다** — `transform()` 에 후보
마크업을 통째로 넣고 결과에 원본 호스트가 남는지 출력했다. 이게 결정적이었다:
왕복 1초로 여섯 자리가 즉시 드러났고, 브라우저 매트릭스는 확인용으로만 썼다.
**리라이트 누락은 서버 바이트에서 재는 것이 가장 싸다.**

**Root cause**:
htmltx 는 두 단계로 거른다 — ① URL 속성 이름 필터(`href`/`src`/`action`/
`formaction`/`srcset`/`imagesrcset`/`style`) ② `(tag, attr)` 서브리소스 목록.
둘 중 하나만 비어도 그 자리는 통째로 손을 안 탄다.

| 자리 | 왜 빠졌나 |
|---|---|
| `<input type=image src>` | ①은 통과, ②에 `("input","src")` 가 없다 |
| `<video poster>` | `poster` 가 **①에조차 없다** |
| SVG `<image href>` | ②에 `("image","href")` 없음 |
| SVG `<image xlink:href>` | `xlink:href` 가 ①에 없다 |
| 레거시 `<image src>` | 파서는 `img` 로 만들지만 **토크나이저가 보는 이름은 `image`** |
| 레거시 `background` 속성 | ①에 없다. 크롬은 아직 요청을 낸다(대조군 O 로 확인) |

**Fix**: ① 에 `xlink:href`/`poster`/`background` 를, ② 에 위 조합 + `("use","href")`
+ `body/table/td/th/tr` 의 `background` 를 추가. 두 목록은 **반드시 같이** 고쳐야
한다(소스에도 그렇게 적혀 있다 — 갈라지면 스냅샷은 되는데 뒤에서 조용히 걸러진다).

**곁가지 함정 — 프래그먼트를 통째로 인코딩하고 있었다**:
`<use href="s.svg#icon">` 를 리라이트하니 `?url=…%2Fs.svg%23icon` 이 됐다.
`#` 이 쿼리 안으로 들어가면 브라우저가 조각을 못 골라 **외부 `<use>` 가 빈 채로
렌더된다**. 같은 문제가 SVG 스프라이트 `<img src="sprite.svg#icon">` 에도 있었다.
프래그먼트는 프록시 URL **바깥**에 붙였다 — 프래그먼트는 애초에 요청에 안 실리므로
SW 가 받는 URL 은 그대로고 조각 선택만 로컬에서 산다. `proxied_subresource_url`
한 곳에서 잘라 붙이므로 모든 서브리소스가 함께 고쳐졌다.

**판정**: 전부 `csp-only` 였다(진짜 유출 아님). `img-src 'self'` / `default-src 'none'`
이 막고 있었다. 그래도 고치는 이유는 어제와 같다 — **CSP 는 2선이고, 리라이트가
1선이다.** 1선이 비어 있으면 CSP 정책을 한 칸 넓히는 순간 그대로 구멍이 된다.

**교훈**:
1. **매트릭스의 빈 축을 찾는 방법**: 케이스를 상상해서 늘리지 말고, **구현의
   허용 목록을 소스에서 읽어 와 대조**할 것. 여섯 자리가 한 번에 나온 건
   상상이 아니라 목록 대조 덕분이다.
2. `csp-only` 는 "증상이 없다" 와 구별이 안 된다. 그래서 이 부류는 **증상을
   기다리면 영영 안 온다** — 주기적으로 목록 대조를 돌리는 수밖에 없다.
3. 파서가 만드는 이름(`img`)과 토크나이저가 보는 이름(`image`)이 다르다.
   lol_html 기반 리라이터에서 태그 이름으로 매칭할 때마다 이 차이를 의심할 것.

---

## 2026-08-20 — 추론을 실측으로 확인하러 갔더니, 틀린 건 추론이 아니라 **측정 도구**였다

**배경**: 파싱 시점 여섯 자리를 고친 뒤 "고치기 전에는 `csp-only` 였다" 고 적었는데,
그건 **추론**이었다(rust 프로브로 원본 URL 이 남는 것만 쟀고, 거기에 CSP 를 겹친
결과는 안 봤다). 되돌려서 브라우저로 재 봤다.

**나온 것**: 매트릭스가 `a11`~`a15` 를 **LEAK(진짜 유출)** 으로 찍었다. 추론과
정반대다. 여기서 멈추고 테이프를 열었다.

**Root cause (판정 로직이 두 군데서 거짓 양성)**:

1. **"시도" 와 "성공" 을 구분하지 않았다.** CDP 네트워크 테이프에는 CSP 가 막은
   요청도 `request` 로 남는다 — 그 뒤에 `failed` 가 따라올 뿐이다. 러너는 테이프에
   타깃 URL 이 보이기만 하면 "직접 나갔다" 로 셌다.
2. **도착 축이 우리 프록시 경유로도 켜진다.** 멤브레인이 뒤늦게 원본 URL 을 주워
   프록시 경로로 다시 부르면 바이트는 타깃에 도착한다. 실측 테이프:

   ```
   request  http://127.0.0.1:18098/img/a11-…png      → failed   (CSP 차단)
   request  …/zp/api/fetch?url=…a11-…png             → 200      (우리가 대신 가져옴)
   ```

두 신호를 곱하니 `시도 O + 도착 O = 유출` 이 성립해 버렸다. **매트릭스 README 가
경고하던 바로 그 혼동을, 러너 구현이 하고 있었다.**

**Fix**: 판정을 **직접 요청의 결과**로 바꿨다 — 같은 `request_id` 에 `response` 가
붙었으면 유출, `failed` 만 있으면 `csp-only`. 테이프는 정규식 대신 `--output` 으로
받아 JSON 으로 읽는다(`kind`/`request_id` 로 상관 짓는다).

**되돌려서 잰 진짜 수정 전 상태**: `csp-only` **7건**(a11~a16 + a20), 진짜 유출 **0건**.
원래 추론이 맞았다.

**교훈**:
1. **"판정이 바뀔 여지가 없어 보인다" 는 재지 않을 이유가 못 된다.** 판정은 그대로였지만
   그걸 재려고 도구를 돌린 덕분에 **도구의 버그**가 나왔다. 확인의 값은 결론을
   뒤집는 데만 있는 게 아니다.
2. 결과가 예상과 정반대로 나오면 **결론을 적기 전에 원자료(테이프)를 열 것**.
   여기서 "여섯 자리가 사실은 진짜 유출이었다" 로 적었다면 심각도를 통째로 잘못
   기록하고, 다음 세션이 없는 유출을 쫓았을 것이다.
3. 이 프로젝트의 측정 사고가 오늘로 세 번째다(`csp_bypassed` 미확인, 압축된 curl
   출력, 그리고 이번). **판정 도구 자체를 주기적으로 의심할 것** — 특히 신호를
   곱해서 결론을 내는 자리를.

### 후속 (같은 날) — 고치면서 **위험의 방향이 뒤집혔다**

판정을 "직접 요청의 결과" 로 바꾸자 이번엔 **테이프의 결말 이벤트에 의존**하게 됐다.
그 이벤트가 링 버퍼에서 밀리면 진짜 유출이 조용히 `csp-only` 로 내려앉는다 —
과대보고보다 나쁜 방향이다(과대보고는 시끄럽지만, 과소보고는 아무 말이 없다).

셋으로 막았다:

1. **결말이 없으면 `csp-only` 가 아니라 `판정불가`.** 모르는 것을 "막혔다" 로 세면
   유출이 통과한다. 별도 버킷으로 남기고 요약에서 크게 알린다.
2. **`dropped.network > 0` 이면 격리 판정을 믿지 말라고 알린다.** 이번 실행은
   유실 0 / 이벤트 254건이라 괜찮았지만, 케이스가 늘면 성립하지 않는다.
3. **판정을 `classify.cjs` 로 떼어냈다.** 브라우저 안에만 있으면 판정 로직 자체는
   아무도 테스트하지 못한다 — 원래 버그가 그렇게 살아남았다. 합성 테이프로
   결말별 판정을 못 박았다(응답=유출 / failed=csp-only / 결말없음=판정불가 /
   여러 시도 중 하나라도 응답이면 유출 / 프록시 경유는 직접 요청 아님).

**교훈**: 판정 로직을 고칠 때는 **틀리는 방향이 어디로 옮겨 가는지**를 같이 볼 것.
"이제 맞다" 로 끝내면 조용한 실패 쪽으로 옮겨 놓고 안심하게 된다.

---

## 2026-08-20 — 인벤토리를 넓히다 **진짜 탈출**을 찾았다: `<meta http-equiv=refresh>`

**이번 세션 통틀어 가장 심각한 건이다.** 지금까지 찾은 건 전부 `csp-only`(리라이트는
놓쳤지만 CSP 가 막아 줌)였는데, 이건 **막는 게 아무것도 없었다.**

**실측 (픽스처)**:
```
<meta http-equiv="refresh" content="0;url=http://127.0.0.1:18098/…">
→ get-url: http://127.0.0.1:18098/…      (최상위 문서가 프록시 밖으로 나갔다)
→ 타깃 서버 히트 로그: 1건               (타깃이 실제로 요청을 받았다)
```
실제 환경이면 **IP 유출**이다. 프록시 오리진을 떠났으므로 그 뒤 모든 요청이 맨몸이다.

**왜 CSP 가 못 막나**: `navigate-to` 는 표준에서 빠졌고, `form-action` 은 폼에만
걸린다. 문서 내비게이션을 막는 CSP 디렉티브가 **지금은 없다**. 즉 이 표면은
2선 방어가 애초에 존재하지 않는다 — 리라이트가 유일한 방어다.

**왜 여태 안 보였나**: 매트릭스의 판정축이 "바이트가 타깃에 도착했는가"라
**서브리소스 전용**이다. 최상위 내비게이션은 페이지가 떠나 버리므로 같은 표로
못 잰다. 축이 없으면 칸도 없고, 칸이 없으면 영영 안 나온다.

**Fix**: `content` 의 `url=` 부분만 앵커/폼과 같은 `?via=` 경로로 옮긴다
(`proxied_meta_refresh`). 수정 후: 브라우저는 프록시 오리진에 머물고 직접 요청 0건.

**같은 라운드에서 나온 나머지** (전부 csp-only):
- SVG `<feImage href/xlink:href>` — 리라이트 목록에 없었다.
- `image-set()` 의 **맨 문자열** 인자 — `url()` 형태만 AST 의 `Url` 노드라
  `visit_url` 이 못 본다. `image-set("a.png" 1x)` 는 그냥 `Str` 이다.
- `<script type=importmap>` / `object:codebase` — known-gap / deliberate 로 기록.

**★교훈 — 인벤토리에는 "축이 없는 표면"이 숨는다**:
목록 대조는 **같은 축 안에서만** 작동한다. 오늘 여섯 자리를 찾은 방법(htmltx 의
(tag, attr) 목록 대조)은 서브리소스 축을 전수했지만, **내비게이션 축에는 애초에
칸이 하나도 없었다**. 다음에 인벤토리를 넓힐 때는 표면을 나열하기 전에 **축을
먼저 나열할 것** — 서브리소스 / 최상위 내비게이션 / 프레임 내비게이션 / 워커 /
비콘. 축이 빠지면 그 축의 모든 구멍이 통째로 안 보인다.

---

## 2026-08-20 — 프레임 축을 세우니 같은 규칙의 **세 번째 구현**이 갈라져 있었다

**축 목록의 마지막 칸**(서브리소스 / 최상위 내비 / **프레임 내비** / 워커 / 비콘)을
채웠다. 프레임은 페이지가 안 떠나므로 최상위 표에서는 절대 안 잡힌다.

**나온 것**: `f10-frame-meta-refresh` — `<iframe srcdoc='<meta http-equiv=refresh …>'>`
안의 URL 이 **원본 그대로** 남아 있었다. 어제 htmltx 에 meta refresh 리라이트를
넣었는데도 그렇다.

**원인 — 같은 규칙이 세 곳에 따로 있다**:
| # | 어디 | 언제 |
|---|---|---|
| ① | Rust `zp-htmltx` | 문서를 파싱 시점에 고칠 때 |
| ② | SW `proxiedRefreshValue` | 타깃이 `Refresh` **응답 헤더**로 보낼 때 |
| ③ | 프렐류드 `transformHTML` | **페이지 realm 이 HTML 을 만들 때**(srcdoc 등) |

③은 Rust 가 아니라 **JS DOM 워커로 따로 구현**돼 있다. ①에 넣은 규칙이 ③에는
없었고, 그래서 srcdoc 프레임만 새고 있었다. `frame-src 'self'` 가 막아 줘서
`csp-only` 로 끝났지만, 프레임 축이 없었으면 영영 안 보였다.

**★대조군이 판정을 갈랐다**:
첫 실행에서 착지 실패가 3건 나왔다. 프록시 없이 같은 픽스처를 여는 대조군을
붙이니 둘(`target=_blank`, `window.open`)은 **대조군에서도 안 됐다** — 사용자
제스처 없는 팝업이라 크롬이 막는 것이고 우리 결함이 아니다. 대조군이 없었으면
멀쩡한 것 둘을 고치겠다고 달려들었을 것이다. (구멍 매트릭스가 같은 이유로
대조군을 먼저 돌린다. 2026-08-14 교훈이 여기서 또 한 번 값을 했다.)

**교훈**:
1. **"고쳤다" 는 구현 단위가 아니라 경로 단위로 말할 것.** 어제 "meta refresh 를
   고쳤다" 고 적었는데 정확히는 "**세 경로 중 하나에서** 고쳤다" 였다. 헤더 경로는
   오늘 아침에, 페이지 realm 경로는 오늘 저녁에 각각 따로 나왔다.
2. 같은 정책의 구현이 여러 벌이면 **가드로 묶어 둘 것**. 구조를 하나로 합치는 게
   정답이지만(③이 Rust 를 부르면 된다), 그건 별건이고 그때까지는 갈라지는 순간
   실패하게 만들어 두는 것이 현실적이다.
3. 축을 세울 때는 **격리 축과 재현성 축을 같이** 세울 것. 격리만 봤으면 f10 은
   초록불이고(아무것도 안 새니까), 기능이 죽은 것도 못 봤을 것이다.

---

## 2026-08-21 — 구현이 두 벌이면 **표도 두 벌**이어야 한다

어제 srcdoc 안 meta refresh 가 htmltx 에만 고쳐져 있던 것을 보고, 같은 방법
(허용 목록 대조 + 브라우저 실측)으로 **두 구현 전체**를 훑었다.

**만든 것**: 구멍 매트릭스에 `g*` 그룹. 정적 그룹 `a*` 가 **Rust htmltx** 를
전수한다면, `g*` 는 **같은 표면을 srcdoc 으로 보내** JS `transformHTML` 을
전수한다. 케이스 코드는 한 줄짜리 헬퍼로 만들어 a↔g 가 짝을 이룬다.

**첫 실행에서 나온 것 (전부 `csp-only`)**:
| 케이스 | 어디가 갈라졌나 |
|---|---|
| `g4-realm-td-background` | `isURLBearing` 에 `background` 속성이 없었다 |
| `g5-realm-feimage` | SVG 정규식이 `(a|image|use|script)` — `feImage` 누락. **SVG 는 `localName` 의 대소문자가 보존**되므로 `/i` 도 필요했다 |
| `g6-realm-imageset` | `rewriteCSSText` 는 손으로 쓴 **별도 스캐너**라 `image-set` 맨 문자열을 안 봤다(zp-css 에만 넣었다) |

**★목록이 정당하게 다른 자리도 있다**: `g8-realm-legacy-image` 는 그냥 통과했다.
DOM 파서가 `<image>` 를 **`img` 로 바꿔 주므로** 페이지 realm 경로에는 그 태그가
애초에 도달하지 않는다. lol_html 은 토큰 이름을 그대로 보니 htmltx 에는 필요했다
— **두 구현의 차이가 목록의 차이로 나타나는 것이 항상 버그는 아니다.** 그래서
가드는 "두 목록이 같아야 한다" 가 아니라 "인벤토리 항목이 양쪽에 있어야 한다" 로
짰고, 예외는 인벤토리에 이유와 함께 적는다.

**가드 둘**: ① 인벤토리의 rewrite/srcset/navigation 항목이 프렐류드
`isURLBearing` 에도 있는지 ② CSS 두 구현이 같은 형태(`image-set` / `@import`)를
다루는지. 변이로 확인했다 — `background` 를 빼면 정확한 메시지로 실패한다.

**교훈**:
1. **구현이 두 벌이면 표도 두 벌이어야 한다.** 하나짜리 표는 "고쳤다" 를 반쪽만
   증명한다. a↔g 처럼 **짝을 이루는 그룹**으로 만들면 새 표면을 추가할 때 양쪽에
   같이 들어간다.
2. 오늘 사고의 뿌리는 전부 같다 — **같은 정책의 구현이 여러 벌**(htmltx/prelude,
   zp-css/rewriteCSSText, Go policy/SW headers). 합치는 게 정답이지만 그때까지는
   **갈라지는 순간 실패하는 가드**로 묶어 둔다. 오늘 하루에 이 부류로 세 번 걸렸다.
3. 예측을 먼저 적고 재면 표가 **답이 아니라 검증**이 된다. 오늘은 세 자리를
   예측하고 정확히 그 셋이 나왔다 — 목록 대조가 제대로 작동한다는 증거다.

---

## 2026-08-21 — `object[data]` 정정, 그리고 **지표가 틀려서 두 번 오해한 이야기**

### 정정한 것

가드 둘이 서로 반대를 주장하고 있었다 — 인벤토리는 `object:data` 를 `deliberate`
(리라이트 금지), 다른 테스트는 `isURLBearing` 에 있어야 한다고 단언. 모순이
아니라 **질문이 둘**이었다:

| 질문 | 답 | 지키는 주체 |
|---|---|---|
| 로드를 허용하는가 | 아니오 | CSP `object-src 'none'` |
| 원본 URL 이 DOM 에 남아도 되는가 | 아니오 | 리라이트 |

페이지 realm 은 둘 다 지키고 htmltx 만 둘째를 안 했다. 정적 cross-origin 칸이
없어서 안 보이다가 `a23-static-object-cross` 를 넣자마자 `csp-only` 로 찍혔다.

**공허하게 통과하던 테스트도 같이 나왔다**: `plugin_surface_stays_unrewritten_by_design`
가 `contains("t.example")` 로 검사했는데, 리라이트 후에도 **퍼센트 인코딩된
`url=` 파라미터 안에 호스트명이 남으므로** 그 단언은 어느 쪽이든 통과한다.
**"원본이 남았는가" 를 호스트명 부분 문자열로 재면 안 된다** — 속성 형태
(`data="http://…"`)로 재야 한다.

### ★지표가 틀려서 두 번 오해했다

`rendercheck` 이 naver 에서 `err=9` 를 냈다. 조사하면서 두 번 헛짚었다:

1. **"SW-less 프레임 이미지가 깨졌다"** — `complete && naturalWidth===0` 으로 셌는데,
   **`src` 가 아예 없는 placeholder `<img>`** 도 그 조건을 만족한다. 광고 프레임에
   그런 요소가 8개 있었다. 어제 "broken 0" 으로 안심한 것도 **같은 지표**였다 —
   방향만 반대였을 뿐 둘 다 못 믿을 측정이었다. **`naturalWidth` 로 렌더 여부를
   재려면 URL 속성이 실제로 있었던 요소만 대상으로 할 것.**
2. **"srcset 경로일 것"** — 깨진 요소를 열어 보니 `src` 도 `srcset` 도 없었다.

실제 원인은 테이프의 `initiator` 를 보고 나서야 나왔다: 403 요청의 개시자가
**`/zp/api/sync-fetch` 문서**였다. 즉 SW-less 프레임이 릴레이로 받아 온
**스타일시트**를 파싱하면서, 그 안의 `url()` 이미지를 `/zp/api/fetch` 로 부른다.
그 문서는 SW 클라이언트가 아니므로 요청이 Go 까지 가서 403 이다.

**미해결로 남긴다**: 어제 고친 것과 같은 부류(SW-less 문서에 SW 전용 경로를
박는다)인데 **운반체가 요소 속성이 아니라 CSS 텍스트**라 기존 blob 업그레이드
경로가 닿지 않는다. 요소 속성은 프렐류드가 훑지만 릴레이로 받아 온 CSS 안의
URL 은 아무도 안 고친다.

교훈 셋:
1. **결론을 적기 전에 개시자(initiator)를 볼 것.** 두 번의 오해가 전부 "무엇이
   그 요청을 냈는가" 를 안 보고 요소부터 뒤진 데서 나왔다.
2. 어제의 "broken 0" 처럼 **좋은 결과도 같은 지표로 나왔으면 같이 의심할 것.**
3. `csp-only` 판정과 마찬가지로, **"원본이 남았는가" 를 부분 문자열로 재는 단언은
   리라이트 후에도 통과할 수 있다.**

---

## 2026-08-21 — 목록을 없애는 리팩터는 **그 목록을 재던 표가 있을 때만** 안전하다

이틀간 사고 3건의 직접 원인이던 "URL 표면 목록이 두 곳에 손으로 있다" 를 없앴다.
`crates/zp-shared/testdata/url_surfaces.json` 단일 소스 → 빌드가 프렐류드에 박아
넣고, Rust 는 같은 파일을 `transform()` 으로 통과시키는 테스트로 묶인다.

### 하는 김에 드러난 것

픽스처에 **네 표면이 빠져 있었다** — 프렐류드는 다루는데 인벤토리에 없던 것들:
`iframe:src` / `frame:src` / `iframe:srcdoc`(서브리소스가 아니라 **문서**를 만드는
자리라 `special` 로 분류), 그리고 SVG `script:href`(페이지 realm 은 다루는데
htmltx 에는 없어서 `known-gap`). 목록을 하나로 합치려고 양쪽을 나란히 놓고서야
보였다 — **합치는 작업 자체가 감사다.**

### ★어제 만든 표가 오늘 내 회귀를 잡았다

평평한 `tag:attr` 집합으로 바꾸면서 **SVG 의 `localName` 대소문자 보존**을 놓쳤다.
`<feImage>` 의 `localName` 은 그대로 `feImage` 인데 픽스처 키는 소문자라 조회가
빗나갔고, `g5-realm-feimage` 가 `csp-only` 로 떨어졌다.

이 칸은 **어제 만든 것**이다(페이지 realm 전수용 g 그룹). 하루 만에 값을 했다.
표가 없었으면 이 회귀는 실사이트에서 "가끔 광고 이미지가 안 뜬다" 형태로 몇 주
뒤에나 나왔을 것이고, 그때는 원인이 이 리팩터라는 걸 연결하지 못했을 것이다.

**교훈**: 중복 제거는 좋지만, **제거 대상이 무엇을 지키고 있었는지 재는 표가
먼저 있어야 한다.** 순서가 반대면 리팩터가 조용히 표면을 하나씩 떨어뜨린다.

### 가드의 모양도 바뀌었다

목록이 소스에서 사라졌으므로 "양쪽 목록이 같은가" 는 물을 수 없다. 대신:
1. **소스에 손목록이 부활하지 않았는가** (치환 자리가 살아 있는가)
2. **빌드 산출물의 테이블이 픽스처와 일치하는가** — `deliberate` 은 들어가면
   안 되고 나머지는 전부 있어야 한다

②는 리빌드 전에 실제로 실패했다. 낡은 `dist` 를 잡아 준다는 뜻이고, 이건
"빌드가 목록을 나르는" 구조에서 반드시 필요한 검사다.

---

## 2026-08-22 — rt wasm 이 **타깃 서버로** 나갔다 (프록시 로드 1회에 9번)

지문 축을 좁히다 발견. 픽스처 서버가 `GET /__zp/zp_page_rt.wasm?v=<빌드 id>` 를
**9번** 받고 있었다. 타깃은 (a) 프록시를 쓴다는 사실과 (b) 우리 빌드 id 를 공짜로
얻고, 우리는 그 프레임마다 rt 가속 경로를 통째로 잃었다(404 → JS 폴백).
**구멍 매트릭스는 이걸 못 본다 — 도착 축이 `/img/<id>` 만 센다.**

원인이 두 겹이었다.

1. URL 이 루트 상대(`/__zp/…`)였다. 문서 base 는 **가상 base(=타깃)** 이므로
   SW 가 못 잡는 문서(srcdoc/blob)에서는 그대로 타깃으로 나간다.
   → `proxyOrigin + '/__zp/…'` 절대 URL 로.

2. 그걸 고쳐도 9번이 남았다. 글루의 `load(url)` 은 **전역 `fetch`** 를 쓰는데,
   `captureNative` 가 잡은 `Native.fetch` 조차 그 realm 에서는 네이티브가
   아니었다 — **부모가 자식 창을 먼저 계측했기 때문**이다. 프록시 오리진 절대
   URL 을 넘겨도 부모 멤브레인이 가상 오리진으로 다시 매핑한다.
   콘솔 계측으로 확정: 프레임 12개 중 **9개가 프렐류드 시작 시점에 이미
   `__zp_get` 을 갖고 있었다**(= 부모가 먼저 계측). 그 9개가 정확히 그 9번이다.
   → rt 는 분류 가속용 최적화일 뿐이므로 **그런 realm 에서는 아예 부팅하지
   않는다**. 타깃에 존재와 빌드 id 를 알려 주는 것보다 JS 폴백이 싸다.

### 일반 교훈 (다음 사람에게)

**`captureNative` 가 네이티브를 잡았다고 가정하지 말 것.** 자식 realm 은 자기
프렐류드가 돌기 전에 부모가 먼저 계측할 수 있고, 그러면 `Native.*` 는 부모
래퍼다. 판별은 `typeof root.__zp_get === 'function'`(부모가 자식 창에 직접
심는 헬퍼) 로 한다.
