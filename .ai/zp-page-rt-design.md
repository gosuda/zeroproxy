# zp-page-rt — Shared-Memory Page Runtime (설계)

> 상태: 초안 (PoC 직전). 결정한 사항만 적고, 결정 못한 항목은 OPEN 으로 명시.

## 1. 목표

현재 `web/runtime-prelude.js` (2768L) 의 hot-path 정책 결정 로직을 **wasm-bindgen 의 auto-marshalling 없이** WASM 으로 옮긴다. 핵심 수단은:

- **raw `extern "C"` exports** (wasm-bindgen 의 JsValue 마샬링 미사용)
- **공유 linear memory** + **고정 scratchpad** (`TextEncoder.encodeInto` 으로 zero-copy 쓰기)
- **handle 기반 결과 반환** (u32 ID. 실제 문자열은 JS 가 필요할 때 dec)
- **intern pool** (URL/속성/태그 — 첫 등장만 인코딩, 이후 hash 룩업)

목표 효과:

| 지표 | 현재 | 목표 |
|---|---|---|
| `runtime-prelude.js` 라인 | 2768 | ≤ 2200 (-20%) |
| URL hot-path 분류 처리량 | JS regex 기준선 | ≥ 동등, 캐시 시 5×+ |
| 신규 정책 추가시 동일 로직 중복 | JS+Go 2중 | Rust 단일 진실원 |

비목표:

- Membrane Proxy trap **본체** 이전 (V8 가 JS callback 으로 호출함)
- 모든 DOM mutation 의 in-WASM 처리 (DOM 은 JS-only)
- `wasm-bindgen` 완전 제거 (`zp-bundle` 은 그대로 — `zp-page-rt` 는 별도 cdylib)

## 2. 아키텍처 위치

```
crates/
  zp-bundle/          # 기존: wasm-bindgen, rewriter+htmltx+kernel — cold/medium path
  zp-page-rt/   NEW   # raw extern "C", hot-path 정책 — cdylib (별도 artifact)
```

빌드 산출물:

```
dist/web/__zp/
  zp_bundle.js          # 기존 (page, ES module)
  zp_bundle_sw.js       # 기존 (SW, classic)
  zp_bundle_bg.wasm     # 기존
  zp_page_rt.wasm   NEW # raw exports only, glue 없음
```

JS glue 는 `web/zp-rt.js` (수작업) — `runtime-prelude.js` 가 dlopen 후 사용.

## 3. ABI 규약

### 3.1 raw exports (Rust 측)

```rust
// zp-page-rt 가 노출하는 함수. 모두 #[no_mangle] pub extern "C".
//
//                                  반환                       비고
// -----------------------------------------------------------------------
// version()              -> u32   // major<<16 | minor<<8 | patch
// scratch_ptr()          -> u32   // SCRATCH 영역 시작 ptr (linear mem offset)
// scratch_cap()          -> u32   // SCRATCH 영역 capacity (bytes)
//
// // URL intern + classify
// url_intern(ptr,len)    -> u32   // 새 또는 기존 handle. 0 = invalid input
// url_classify(handle)   -> u32   // enum UrlClass (아래)
// url_view(handle)       -> u64   // (ptr<<32)|len. handle 의 정규화 URL byte view
//
// // 핸들 라이프사이클
// pool_reset()           -> void  // 페이지 이동시 호출. 모든 handle 무효화
// pool_stats()           -> u64   // (count<<32)|bytes_used 진단용
```

`UrlClass` enum (u32):

```
0  INVALID         # parse 실패, ASCII control, length>8192 등
1  HTTP            # http:// 또는 https://
2  WS              # ws:// 또는 wss://
3  BLOB            # blob:
4  DATA            # data:
5  JAVASCRIPT      # javascript: (block)
6  VBSCRIPT        # vbscript: (block)
7  ABOUT_BLANK     # about:blank (special)
8  ABOUT_OTHER     # about:* — block
9  RELATIVE        # scheme 없음. resolve 필요
10 OTHER           # 알 수 없는 scheme. block
```

위 enum 은 `runtime-prelude.js` 의 `isHTTPURL`/`hasDangerousURLScheme`/`hasExecutableURLScheme` 의 union. JS 는 enum 값 1개로 모든 결정 끝.

### 3.2 호출 규약 (JS 측)

```js
// 1. 한 번만 — fetch + instantiate
const rt = await ZeroProxyRT.load('/__zp/zp_page_rt.wasm');

// 2. 매 hot-path 호출:
const handle = rt.internURL(rawString);   // u32. encodeInto → wasm.url_intern
const cls    = rt.classifyURL(handle);    // u32 enum
if (cls === rt.UrlClass.JAVASCRIPT) block();

// 3. (선택) handle 의 정규화 URL 필요시
const normalized = rt.viewURL(handle);    // string. memory view 디코드
```

### 3.3 메모리 안전 규칙 (필수)

1. **`memory.grow()` 직후 모든 `Uint8Array` 뷰는 detached**. `rt` 글루는 매 wasm call **이후** view 재발급. PoC 는 scratchpad 를 페이지 부트시 한 번 grow 한 뒤 더는 grow 안 하도록 capacity 사전 확보 (`Cargo.toml` 의 `[lib] initial-memory = ...`) — OPEN: 정확한 초기 메모리 결정.
2. **JS 가 scratchpad 에 쓰고 → 즉시 wasm fn 호출 → 결과 받음** — 중간에 다른 wasm call 끼지 않음.
3. **handle 은 절대 long-term 캐시 금지**. 페이지 이동시 `pool_reset()` 으로 전체 무효화. JS 측 캐시도 동시 클리어.
4. **JS view 보존 금지** — 매 호출 직전 `mem8 = new Uint8Array(wasm.memory.buffer, scratch_ptr, scratch_cap)` 재발급. (오버헤드 ~50ns, 안전성 가치 비교 불가)
5. **WASM 내부 alloc 실패 → handle 0 반환** (panic 금지, `panic = "abort"` 가 페이지 죽임).

## 4. URL intern pool 자료구조

```rust
struct UrlPool {
    // 모든 정규화된 URL 바이트가 한 buffer 안에 append-only 저장.
    // handle = (offset<<16) | len 가 아니라 단순 인덱스 (Vec<Entry>) — 16bit
    // 제한 피하기 위함.
    bytes: Vec<u8>,
    entries: Vec<Entry>,            // index = handle - 1 (handle 0 = invalid)
    by_hash: HashMap<u64, u32>,     // FxHash, handle
    class_cache: Vec<u8>,           // entries 와 동일 인덱스. UrlClass 값.
}

struct Entry {
    offset: u32,
    len: u32,
}
```

- `url_intern(ptr, len)`:
  1. ptr/len 으로 input bytes view.
  2. trim leading whitespace (HTML attribute 가 white-space 허용).
  3. FxHash 계산 → `by_hash` 룩업. hit 면 기존 handle 반환.
  4. miss: scheme 분류 → `class_cache.push(cls)`, bytes 에 append, entries 에 push, by_hash 에 등록. 새 handle 반환.
- `url_classify(h)`: `class_cache[h-1]` O(1).
- `url_view(h)`: entries[h-1] → (offset, len) → ptr 변환해서 64bit 패킹 반환.

scheme 분류는 case-insensitive prefix match. ASCII only (RFC 3986 scheme grammar). 정규식 없음.

## 5. 분류 로직 (`runtime-prelude.js` 와의 parity)

현재 JS:

```js
function isHTTPURL(raw) { try { const u = new URL(raw, baseURL); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
function hasExecutableURLScheme(raw) { return /^(?:javascript|vbscript|data):/i.test(...); }
function hasDangerousURLScheme(raw) { return /^(?:javascript|vbscript):/i.test(...); }
```

PoC 의 `url_classify` 는 위 3 함수를 enum 한방으로 대체:

| JS 호출 | enum 매핑 |
|---|---|
| `isHTTPURL(x)` | `cls === HTTP` |
| `hasExecutableURLScheme(x)` | `cls in {JAVASCRIPT, VBSCRIPT, DATA}` |
| `hasDangerousURLScheme(x)` | `cls in {JAVASCRIPT, VBSCRIPT}` |

상위 헬퍼 (`shouldBlockURLAttribute`, `hasContextBlockedScheme`) 는 enum 받아서 JS 한 줄.

base URL 해석은 PoC 범위 밖 — `RELATIVE` 만 분류, resolve 는 JS `new URL(raw, base)` 가 처리. (URL resolution 을 Rust 로 옮기면 `url` crate 추가 필요, 다음 단계.)

## 6. JS glue (`web/zp-rt.js`)

```js
// 부트
const wasm = await WebAssembly.instantiateStreaming(fetch(url));
const exports = wasm.instance.exports;
const scratch = exports.scratch_ptr();
const cap = exports.scratch_cap();
const enc = new TextEncoder();
const dec = new TextDecoder();
let mem = () => new Uint8Array(exports.memory.buffer);

function internURL(s) {
  const m = mem().subarray(scratch, scratch + cap);
  const { written } = enc.encodeInto(s, m);
  return exports.url_intern(scratch, written);
}
function classifyURL(h) { return exports.url_classify(h); }
function viewURL(h) {
  const packed = exports.url_view(h);
  const ptr = Number(packed >> 32n);
  const len = Number(packed & 0xffffffffn);
  return dec.decode(mem().subarray(ptr, ptr + len));
}
```

세부 사항:

- `TextEncoder.encodeInto` 가 destination 부족하면 truncate. JS 측에서 input.length > cap/3 (UTF-8 worst case 3 bytes/char) 일 때 fallback 또는 reject.
- `viewURL` 의 `BigInt >>` 비용은 ns 단위 — 매번 hot 호출에서 부담스러우면 `view_ptr(h)` / `view_len(h)` 분리. 일단 패킹.
- `mem()` factory 패턴으로 매번 새 view (memory.grow safe). 사용 측은 캐시 금지.

## 7. wasm-bindgen 와의 분리 전략

`zp-page-rt` 는 **별도 cdylib** — wasm-bindgen 무사용. 이점:

- glue JS 없음 → 30KB 손실 회피
- start 함수 / `__wbindgen_*` 임포트 없음 → instantiate 가 단일 step
- 미래에 raw wasm32 thread model (atomic intrinsic) 도입할 때 wasm-bindgen 제약 없음

단점:

- 디버깅 어려움 (스택 트레이스 없음). 진단용 `extern "C" fn last_error_code() -> u32` 만 노출.
- panic handler 부재 — `panic = "abort"` 가 wasm trap 일으켜 페이지 죽음. PoC 는 절대 panic 안 하도록 입력 검증 100%.

## 8. 마이그레이션 단계 (수정 대상 코드)

PoC 후 `runtime-prelude.js` 변경 패치:

1. 부트 시 `await ZeroProxyRT.load(...)` 추가 (page bootstrap async 화).
2. `isHTTPURL`/`hasExecutableURLScheme`/`hasDangerousURLScheme` 삭제 → `ZPRT.classifyURL` 호출로 치환.
3. `shouldBlockURLAttribute` 한 줄로 축소.
4. URL intern → 동일 raw 가 반복 등장하는 mutation observer 콜백에서 자연 캐시 효과.

라인 감축 추정: ~40L (URL helper) + ~80L (related call sites 단축) = ~120L. **PoC 기준 작은 숫자지만 패턴 검증이 목적.**

확장 단계 (PoC 통과 시):

- `attr_classify(tag_id, attr_id, val_handle) -> action` — Phase 2 hot path 흡수
- `mutation_batch_process(ptr, count) -> actions_handle` — MutationObserver SoA
- `native_source_table_lookup(key) -> view_handle` — toString masking ROM
- `cookie_*` — cookie jar persistent state (server cookiejar 와 통합)

## 9. 위험 / OPEN 사항

| # | 위험 | 완화 |
|---|---|---|
| R1 | `memory.grow` 가 hot path 에서 발생하면 view detach → 다음 call 까지 무한 grow 루프 가능 | 부트시 initial pages 충분히 (4MB?) 미리 확보. PoC 는 `pool_reset` 만으로 reuse. |
| R2 | wasm-bindgen 와 raw export 가 같은 wasm 안에 섞이면 wasm-bindgen-cli 가 raw 심볼 dead-strip | 별도 cdylib 로 회피 |
| R3 | bench 결과 JS 대비 큰 이득 없음 (V8 JIT 강력) | PoC 단계에서 일찍 판명. 다음 단계(MutationObserver batch 등)로 가치 재증명 |
| R4 | 페이지 navigation 시 handle 동기화 누락 | `pool_reset` 호출 위치 = `prelude` 의 `replaceVisibleProxyURL` 직후로 픽스 |
| R5 | SW 와 page 양쪽 로딩 (sw.js 가 url 분류도 함) | PoC 범위 page-only. SW 통합은 후속. |
| O1 | initial memory pages 값 | bench 후 실측 결정 |
| O2 | scratchpad capacity | 64KB 시작 — 최대 URL 길이 8KB × 8 안전마진 |
| O3 | `url` crate 추가 여부 (URL resolution Rust 화) | PoC 범위 밖. relative resolution 은 JS. |
| O4 | SharedArrayBuffer 필요 여부 | 불필요 (단일 스레드). 향후 atomics 도입시 재고. |

## 10. 벤치 기준 (C 단계 입력)

- 입력 URL 세트: 1000 개 (실측 큰 페이지의 attribute 분류 호출 분포 모방)
  - 50% HTTP/HTTPS (절반은 중복)
  - 20% blob: / data:
  - 10% javascript: (악성)
  - 10% relative
  - 10% wss: / about:blank / 기타
- 반복: 100,000 iter (외부 loop), 측정 항목:
  - 단순 throughput (ops/sec)
  - 첫 호출 latency (cold)
  - intern cache hit 비율 (재호출시 WASM 우위 가설 검증)
- 비교 대상:
  - 기존 `isHTTPURL`/`hasDangerousURLScheme`/`hasExecutableURLScheme` 합본
  - 새 `internURL` + `classifyURL` (cold + warm)
- 환경: Node 22 `--experimental-vm-modules` 불필요, 단순 native `WebAssembly.instantiate`. CI 미통합 (수동 로컬 실행).

수용 기준:

- WARM (intern 캐시 적중) 처리량 ≥ JS × 3
- COLD (매번 unique URL) 처리량 ≥ JS × 0.8 (마샬링 손해 허용 한도)

위 미달이면 hot-path 정책의 Rust 이전을 보류하고 cold-path 통합 (cookie/SSE/form) 으로 우회.
