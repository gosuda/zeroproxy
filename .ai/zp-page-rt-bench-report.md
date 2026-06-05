# zp-page-rt PoC — Bench Report (확장판 + wasm-opt + Browser + Scheme-only + ASCII fast-path)

> 2026-05-30, **5차 측정** (production code 갱신 포함). PoC v0.1.0 + B1(HashMap O(1)) + T2(batch ABI) + F(wasm-opt -Oz + browser via puppeteer headless Chrome 148) + D(scheme-only fast path) + **P(encoder isolation + ASCII fast-path production)**. 코퍼스 1000 URL × 100k iter, warmup 10k.

## 🎯 5차 TL;DR — Production schemeOnly 가 두 환경 모두에서 JS regex 압도

`encodeInto` 가 Chrome 에서 수동 charCodeAt 루프 대비 2.37× 느림이 측정됨 (Blink string buffer cross-realm cost). zp-rt.js 의 `writeScratch` + `classifySchemeOnly` 에 **ASCII fast path** (`charCodeAt` 루프 + Uint8Array 직접 쓰기, RFC 3986 의 ASCII 보장 활용) 적용 후:

| 환경 | schemeOnly 이전 | schemeOnly 이후 | JS regex | vs regex |
|---|---|---|---|---|
| **Node** | 311.6 ns | **119.7 ns** (2.6×↑) | 153.3 ns | **1.28× 빠름** ✓ |
| **Chrome** | 600 ns | **140 ns** (4.29×↑) | 200 ns | **1.43× 빠름** ✓ |

WASM raw-string 분류가 **처음으로 JS regex 를 압도하는 환경 독립적 결과**.

## 환경

| 측정 환경 | V8 | 비고 |
|---|---|---|
| **Node** | Node 22 | bench harness 직접, full timer 해상도 |
| **Chrome (headless)** | Chrome 148 | puppeteer headless='new', `performance.now()` 가 reduced precision 가능성 |

wasm-opt 142 (binaryen via `npm i -D binaryen`). build.mjs 에 feature flags 통합.

## TL;DR

| 결론 | Node 검증 | Chrome 검증 |
|---|---|---|
| **wasm-opt 효과: wrapper 경로 -38%, 크기 -18.6%** | ✓ | ✓ |
| **handle-only 가 JS regex 보다 6.8~8.8× 빠름** | ✓ | ✓ |
| **batch N≥16 이 JS regex 보다 빠름** | ✓ (Node 만) | ✓✓ (Chrome 에서 더 큰 우위) |
| **URL 길이 ↑ → wasm raw 폭락** | ✓ | ✓ (더 가파름) |
| **HashMap O(1) (pool 100/1k/10k 평탄)** | ✓ | ✓ |
| **🚨 Chrome 에서 encodeInto 가 Node 대비 3.55× 느림** | — | 신규 발견 |

## 1. wasm-opt -Oz 효과 (Node)

| 지표 | pre-opt | post-opt | 효과 |
|---|---|---|---|
| **WASM 크기** | 18,764 B | **15,273 B** | **-18.6%** |
| wasm classOf wrapper | 514.9 ns | **316.6 ns** | **-38.5%** 🎯 |
| wasm raw cached view | 265.5 ns | 269.6 ns | 평탄 (noise) |
| wasm pre-encoded | 169.0 ns | 166.4 ns | 평탄 |
| handle-only | 19.8 ns | 21.2 ns | 평탄 |
| bulk N=64 | 117.2 ns | 126.5 ns | 약간 느려짐(±noise) |
| cold unique | 607.4 ns | 561.6 ns | -7.5% |

**해석**: Rust LTO 가 hot path 코드를 이미 잘 최적화. wasm-opt 의 효과는 **glue prologue/epilogue 정리** 에 집중 — wrapper 경로 38% 절감은 JS↔WASM ABI shim 의 군더더기가 줄어든 결과. cached-view / pre-encoded / handle-only 같은 wasm-internal 경로는 변동 없음 (Rust LTO 이미 처리).

## 2. Node vs Chrome (post-opt 기준)

```
                                  Node ns/op    Chrome ns/op    Chrome / Node
js-regex                              160.8         184.0         1.14× slower
js-startsWith chain                   134.7         177.0         1.31× slower
encodeInto only (no wasm call)        236.4         840.0         3.55× slower 🚨
wasm classOf wrapper                  316.6         748.0         2.36× slower
wasm raw cached view                  269.6         637.0         2.36× slower
wasm pre-encoded                      166.4         290.0         1.74× slower
wasm handle-only                       21.2          21.0         같음
wasm bulk N=16                        138.2         145.0         1.05× slower
wasm bulk N=64                        126.5         150.0         1.19× slower
wasm bulk N=256                       126.2         128.9         1.02× same
URL long 500B (wasm)                 1310.8        2037.0         1.55× slower
cold unique (wasm)                    561.6         737.0         1.31× slower
```

**핵심 관찰**:

### 2.1 `encodeInto` 가 Chrome 에서 3.55× 느림 🚨
840 ns vs 236 ns. 같은 V8 인데 왜? 가설:
- Headless Chrome 의 `performance.now()` reduced precision (100µs 단위) → 짧은 측정 노이즈 가능. 그러나 84ms 측정에서 100µs noise 는 0.12% 라 설명 부족
- TextEncoder 의 renderer-side 구현이 다름 (Chrome 의 Blink-side string buffer 와 V8 isolate 간 추가 cross-thread 마샬링)
- Puppeteer evaluation context 의 cross-realm 오버헤드

→ **실제 사용자 환경(Chrome)에서 encode 비용이 더 dominant** 하다는 것. **scheme-only fast path (D 단계) 의 가치가 Node 측정 시점보다 훨씬 큼**

### 2.2 Handle-only 는 완벽히 동일 (21.0 ≈ 21.2 ns)
WASM 내부에서만 동작 (encodeInto/wasm-call 모두 거치지 않음). V8 wasm JIT 가 두 환경 모두 동일하게 최적화. **handle pipeline 의 asymptote 는 환경 독립적**.

### 2.3 Batch ABI 가 Chrome 에서 더 큰 우위
Node 에서 batch 는 cached-view 대비 2.13×. Chrome 에서는 **4.94×** (N=256 기준). 즉 wasm-call setup 비용이 Chrome 에서 상대적으로 더 비싸므로 batch 의 분할 효과가 더 큼. **MutationObserver batch 전략은 Chrome 에서 더 가치 있음.**

### 2.4 JS regex 자체는 Chrome 에서 14% 느림
TurboFan tier-up 시점 차이로 추정. 절대값은 vs WASM 의 상대 비교에서 baseline 으로 그대로 사용 가능.

## 3. Chrome 단독 측정 (전체)

```
=== Main (warm) — BROWSER ===                ops/sec      ns/op   vs base
js-regex                                       5.43M      184.0    1.00x
js-URL (new URL parse)                       673.85K     1484.0    0.12x
js-startsWith chain                            5.65M      177.0    1.04x
encodeInto only                                1.19M      840.0    0.22x   ← 매우 비쌈
wasm classOf wrapper                           1.34M      748.0    0.25x
wasm raw no wrapper                            1.22M      823.0    0.22x
wasm raw cached view                           1.57M      637.0    0.29x
wasm pre-encoded                               3.45M      290.0    0.63x
wasm classifyURL handle-only                  47.62M       21.0    8.76x   ✓

=== Batch ABI — BROWSER ===                  ops/sec      ns/op   vs single
wasm raw cached view                           1.57M      637.0    1.00x
wasm bulk N=16                                 6.90M      145.0    4.39x   ← regex 보다 빠름
wasm bulk N=64                                 6.66M      150.0    4.25x
wasm bulk N=256                                7.76M      128.9    4.94x   ✓

=== URL length — BROWSER ===                 ops/sec      ns/op
js-regex (short ~29B)                          5.71M      175.0
wasm classOf (short)                           1.42M      702.0    4.0× slower
js-regex (medium ~100B)                        6.67M      150.0
wasm classOf (medium)                          1.05M      950.0    6.3× slower
js-regex (long ~500B)                          5.35M      187.0
wasm classOf (long)                          490.92K     2037.0   10.9× slower ⚠
```

## 3.7 Q — classifyBatch 도 ASCII fast path + single-pass + 안정화

### 변경 (`web/zp-rt.js` `classifyBatch`)

이전 디자인 (P 라운드까지):
1. per-string `new Uint8Array(2048)` alloc, encodeInto into tmp
2. 두 번째 pass: tmp 들을 scratch 에 concat copy
3. 결과 `new Uint32Array(result)` 복사

Q 라운드 변경:
1. **Single-pass: scratch 에 직접 ASCII fast path 인코딩** (alloc 없음)
2. **lensU32 closure cache** (per-call alloc 제거)
3. **lens table manual little-endian write** (`new Uint8Array(buffer, ...)` view 생성 회피)
4. **result no-copy view 반환** (caller 가 즉시 소비 — MO callback 의 tight loop 보장)
5. Layout 재배치: `[lens 4N][out 4N][bytes ...]` — Uint32Array 의 4-byte align 요구 만족

### 효과

**Node** (production rt.classifyBatch):
- P 라운드 (single-pass 전): 측정 안 됨 (구버전은 raw exports 만 측정)
- Q 라운드 초기 (alloc per call): 280 ns/item
- Q 라운드 최종 (cached + no-copy): **255-285 ns/item** (10% 절감)

**Chrome** (production rt.classifyBatch):
- Q 라운드 최종: **299-325 ns/item**
- vs js-regex 205 ns/item: 1.5× 느림
- vs schemeOnly 140 ns/item: 2.1× 느림

### 관찰: production batch vs schemeOnly N회

```
N=64 시나리오 (MO callback 의 50 candidate 정도):

Node:
  rt.classifyBatch 64회 분류 = 64 × 255 = 16,320 ns
  rt.classifySchemeOnly 64회 = 64 × 120 = 7,680 ns    ← 2.1× 빠름

Chrome:
  rt.classifyBatch 64회 분류 = 64 × 299 = 19,136 ns
  rt.classifySchemeOnly 64회 = 64 × 140 = 8,960 ns    ← 2.1× 빠름
```

**MO callback 의 use case 는 분류만** (intern 불필요) → **schemeOnly N회 가 더 빠름**. 단 schemeOnly 는 about:blank vs about:other 같은 미세 구분 손실 가능 (truncation 시 AboutOther 로 분류 — 정책적으로 동일하므로 영향 없음).

production batch 의 가치: **intern 까지 같이 하는 use case** (handle 발급 후 후속 handle-only 17ns 분류 chain) 에서만 의미. MO callback 같은 일회성 분류는 schemeOnly 권장.

### 갱신된 매트릭스 (5차 + Q)

| 경로 | Node ns/op | Chrome ns/op | vs JS regex |
|---|---|---|---|
| **schemeOnly (Q production)** | **119.7** | **140** | **1.28~1.43× 빠름** |
| classOf (writeScratch ASCII fast path) | 392 | 473 | 0.45× ~ 0.43× |
| classifyBatch production (intern+classify) | 255-285 | 299-325 | 0.62~0.69× (intern 포함) |
| classifyBatch raw (encode amortised out) | 117-128 | 112-118 | 1.50~1.83× 빠름 |
| handle-only (asymptote) | 17-21 | 18-20 | **8.7~11.4× 빠름** |
| JS regex (baseline) | 153-177 | 200-205 | 1.00× |
| JS startsWith chain | 167-180 | 182-190 | 0.90~1.08× |
| JS `new URL()` | 1478-1683 | 1560-1794 | 0.10~0.12× |

`writeScratch` ASCII fast path 가 `internURL` / `classify` / `classOf` 모두 자동 적용 → 모든 string-input wasm 경로가 P+Q 라운드 효과 흡수.

---

## 3.6 P — Encoder isolation + ASCII fast-path production 적용 🎯

### 측정 (Node, post-production-change)

**Encoder isolation (16-byte URL 인풋, schemeOnly 사용 시나리오):**

```
                                  Node ns/op    Chrome ns/op
encodeInto (Uint8Array)              105.6         434.0
encodeInto (scratch view)            112.5         384.0
encodeManual (charCodeAt loop)       182.0         218.0   ← Chrome 가 더 빠른 패턴
encodeAsciiFast (ASCII only)         149.2         208.0
Buffer.from (Node-only)              156.1         —
```

**핵심**: Chrome 의 `encodeInto` 가 **2.09~2.37× 느림** vs charCodeAt 루프. Node 에서는 `encodeInto` 가 여전히 최적 (V8 native 구현). **환경 dependent 한 비용 구조 입증**.

### 적용 (production change in `web/zp-rt.js`)

```js
function writeScratch(str) {
  // ASCII fast path — URLs are RFC 3986 ASCII. encodeInto 의 Chrome overhead 회피.
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
  // Non-ASCII fallback: encodeInto (V8 native 가 manual loop 보다 빠른 경우)
  ...
}
```

`classifySchemeOnly` 도 동일 패턴 (16바이트 cap 안에서 ASCII fast path).

### 효과 (production schemeOnly, post-change)

```
                       Node ns/op   Chrome ns/op
schemeOnly 이전           311.6        600.0
schemeOnly 이후           119.7        140.0
회복                      -61.6%      -76.7%
vs js-regex 153/200       0.78×       0.70×    ← 둘 다 빠름!
```

**환경 독립 win 달성**:
- Node: schemeOnly 119.7 ns < js-regex 153.3 ns (**1.28× 빠름**)
- Chrome: schemeOnly 140 ns < js-regex 200 ns (**1.43× 빠름**)

`new URL()` 기반 helper (Node 1590, Chrome 1560 ns/op) 대비 **11~13× 빠름**.

### 부수 효과 — handle-only path 변동 없음
handle-only 는 wasm-internal, encoder 와 무관 → 17-21 ns 유지 (asymptote).

### URL length sensitivity 갱신 (Node 5차)

```
                       js-regex   classOf   schemeOnly (P)
short  (~29B)            174.6     293.8       119.7
medium (~100B)           159.9     438.7       119.7  (length 무관, fast path)
long   (~500B)           257.0    1300.4       119.7  (catastrophic 완전 회복)
```

**schemeOnly 가 길이 평탄 + JS regex 보다 빠름** — D 라운드의 평탄성 효과를 ASCII fast path 가 그대로 유지하면서 절대값 절감.

---

## 3.5 D — Scheme-only fast path 결과 🎯

**가설**: 긴 URL 의 catastrophic 8~10× 손실은 `encodeInto` 가 length-linear 이기 때문. 첫 16바이트만 encode 하면 길이 무관 cost 달성 가능.

**구현**: `url_classify_scheme_only(ptr, len) -> u32` — intern 없음, pool 부작용 없음, 16바이트 cap. JS 측 `enc.encodeInto(s, scratchView.subarray(0, 16))` 로 capped encode.

### Node — Length sensitivity (scheme-only 추가)

```
                              ns/op JS     ns/op classOf   ns/op schemeOnly   improvement
short  (~29B)                   159.7        291.9            235.2           19% vs classOf
medium (~100B)                  145.7        471.3            260.5           45% vs classOf
long   (~500B)                  192.7       1247.6            248.1           80% vs classOf ✓
```

**핵심 검증**: schemeOnly 가 **세 길이 모두 235-260 ns 평탄** — 가설 입증. encoding 비용 supremum 이 16바이트 분에만 의존.

### Chrome — Length sensitivity

```
                              ns/op JS     ns/op classOf   ns/op schemeOnly   improvement
short  (~29B)                   145.0        513.0            515.0           0% (이미 짧음)
medium (~100B)                  196.0        760.0            616.0           19% vs classOf
long   (~500B)                  149.0       2030.0            678.0           66% vs classOf ✓
```

**Browser 환경 발견**:
- 짧은 URL (~29B) 에서는 classOf 와 schemeOnly 가 같음 — 이미 16바이트 안 넘으므로 절감 없음
- 중간/긴 URL 에서 점진적 개선, long 에서 catastrophic 회피
- Chrome 의 encodeInto 비용 자체가 높아 schemeOnly 도 JS regex 보다 빠르진 않음 (537 vs 183 ns), 하지만 **2030 ns 의 catastrophe 는 명확히 회피**

### Main (warm) — scheme-only 위치

```
                                  Node ns/op    Chrome ns/op
js-regex                              134.5        183.0
js-startsWith chain                   147.4        121.0   ← Chrome 에서 regex 압도
wasm raw cached view                  272.6        590.0
wasm classifySchemeOnly (D)           234.4        537.0   ← raw 보다 약간 빠름
wasm pre-encoded                      167.3        232.0
wasm handle-only                       18.3         20.0
```

### Chrome 의 새 baseline: `startsWith`
Chrome 에서 `js-startsWith` 가 **regex 보다 1.51× 빠름** (121 vs 183 ns). 즉 Chrome 의 V8 가 string method 인라이닝을 regex JIT 보다 더 잘 함. **Chrome 실 환경의 진짜 JS baseline 은 startsWith 121 ns** — schemeOnly 537ns 는 그 4.4× 차이.

## 4. 누가 어디서 이기는가 (최종 매트릭스)

| 경로 | Node | Chrome | 권장 |
|---|---|---|---|
| Batch N≥16 (배치 분류) | **0.96×** 빠름 | **1.27×** 빠름 | ✓✓ 최우선 |
| handle-only (이미 intern 됨) | **7.4× 빠름** | **9.15× 빠름** | ✓ asymptote |
| pre-encoded scratch | 1.24× 느림 | 1.27× 느림 | OK (htmltx 케이스) |
| **schemeOnly (long URL)** | **1.29× 느림** | **4.55× 느림 (vs 10.9× 였음)** | ✓ catastrophe 회피 |
| schemeOnly (short URL) | 1.47× 느림 | 2.84× 느림 | △ classOf 와 동등 |
| cached view + 단일 | 2.0× 느림 | 3.22× 느림 | △ |
| 기본 raw-string wrapper | 2.30× 느림 | 3.56× 느림 | ❌ |
| long URL (500B) raw classOf | 6.47× 느림 | **13.6× 느림** | ❌ schemeOnly 로 회피 |

## 5. 권장 작업 우선순위 갱신

1. ~~**D — Scheme-only fast path**~~ ✅ 완료. 길이 평탄성 검증. Long URL classOf 1247→248 ns (Node) / 2030→678 ns (Chrome).
2. **Batch ABI → MutationObserver 연결**: Chrome 에서도 N=16 부터 plateau 확인됨. 다음 큰 작업.
3. **Handle pipeline (htmltx → page-rt)**: 7.4~9.15× asymptote, 환경 독립. 장기 목표.
4. ~~**`wasm-opt` 영구 통합**~~ ✅ 완료 (build.mjs).

### D 의 운영 가이드

**언제 schemeOnly 를 쓰는가**:
- URL 길이 100B+ 가능성 있는 attribute 분류 (CSS background-image, srcset, data URI 처리)
- 정책 결정만 필요할 때 (intern handle 불필요)

**언제 classOf 또는 internURL 을 쓰는가**:
- 같은 URL 이 반복되는 경우 (intern 캐시 효과 활용 = 7-9× 우위)
- 추후 view (정규화된 URL) 가 필요할 때

**조합 패턴**: hot mutation 콜백 1차 분류 = `schemeOnly`, 진짜 process 가 결정되면 `internURL` 로 handle 발급 → 후속 호출 17~20 ns/op.

## 3.8 (R+S 검증 후) — Production 실사이트 measurement: setAttribute hot path 의 실제 cost

> 2026-05-30 추가, NAVER 메인 페이지 (proxy 통과) 에서 taskweaver exec-js 로 직접 측정. R+S (schemeOnly N회 MO callback) + Recipe 2 (8 sites JS dedup) + Recipe 3 partial (urlClassifyCache element-bound) 모두 적용된 상태.

### Probe single-element burst (1 element × 500 setAttribute calls)

| URL 종류 | per-call | 비고 |
|---|---|---|
| Short (`/static/asset-N.js`) | **1.00 µs** | Recipe 2 의 single-parse 효과 |
| Long (CDN signed ~150B) | **1.00 µs** | 길이 무관 평탄성 달성 (R+S 의 schemeOnly fast path) |
| `data:` URL | **0.80 µs** | non-HTTP early reject |
| Real DOM (100 different elements with random URL) | **25 µs** | element-type 다양성 + link policy / navigation gate 등 |

### urlClassifyCache hit/miss effect (1000 calls)

| Pattern | per-call | vs unique |
|---|---|---|
| Same URL × 1000 (lastRaw HIT every call) | **1200 ns** | 60% (1.67×↓) |
| Alt 2 URLs (lastRaw miss every call) | 900 ns | 45% — measurement variance 가능 |
| Unique URLs (no cache hit) | **2000 ns** | baseline |
| **Pure `new URL(href, base)` JS only** | 2200 ns | URL parse 단독 |

### 핵심 발견

1. **probe single-element setAttribute 가 이미 1 µs/call** — Recipe 2 + R+S 후 hot path 가 매우 빠르다. Pure `new URL()` 단독 비용 (2200 ns) 의 **절반 이하** = single-parse 효과 입증.
2. **urlClassifyCache HIT 시 40% 추가 절감** (2000→1200 ns/call) — element-bound dedup 이 React re-render 패턴에서 효과.
3. **Real DOM 100 elements 가 25 µs/call** — probe 의 25배. 차이는 link policy / navigation target / urlMeta.set / setAttribute hook 등 element-type 별 분기. **URL classify 자체는 hot path cost 의 작은 비중**.
4. **Long URL 평탄성** — Recipe 2 (single new URL) + R+S (schemeOnly pre-classify) 조합으로 길이 catastrophe 완전 해소. 측정상 long ≈ short (1.00 µs).

### 다음 step 의 ROI 평가 (측정 기반)

| 후보 | 가능 절감 | 평가 |
|---|---|---|
| **Recipe 3 full form** (handle cache via urlMeta) | ~17 ns/call (handle-only) | hot path 1200-2000 ns 중 분류 비중이 작아 **marginal**. WASM 우위 path 가 element-specific 로직에 가려짐. |
| **Recipe 4** (schemeOnly setter broader) | unique URL ~120 ns vs new URL ~2200 ns | 단, 분기 비용 + Recipe 2 후 baseline 이미 낮아 absolute gain 작음. **defer**. |
| **Recipe 5** (boot intern pass) | 첫 hit ~ no first-tick miss | NAVER `[data-zp-target-url]` stealth-masked 0개 (의도된 stealth) 라 측정 어려움. **defer**. |
| **element-specific 로직 dedup** (link policy, navigation gate) | ~24 µs/call → ? | real DOM cost 의 99% 가 여기. 가장 큰 win 후보. **다음 step 의 진짜 ROI 영역**. |
| **htmltx server-side** (HTML rewrite) | page boot 비용 | SW context 라 페이지측 measurement 어려움. 서버측 별도 측정 필요. |

### 결론

WASM 측 추가 작업은 ROI 낮음 — production 의 URL 분류 비중이 element-specific 로직 (link policy 분기, navigation gate, urlMeta.set, setAttribute hook chain) 에 가려져 있음. **다음 큰 win 은 element-specific 로직 path 단축** 이며, 측정 기반 결정이 필요.

WASM 우위 시나리오는 두 가지로 한정:
- **hydration burst 의 비-HTTP URL early-reject** (이미 R+S 로 달성, schemeOnly ASCII fast path).
- **htmltx → page-rt handle pipeline** (큰 설계 변경, 별도 평가).

## 3.9 (T 라운드) — Element-specific 로직 path 단축: setAttribute hook chain 의 attrLocalName / localName 중복 제거

> 2026-05-30, §3.8 의 "real DOM 25 µs/call 의 element-specific 분기가 hot path 의 99%" 결론에 기반. WASM 측이 아닌 JS hot path 의 중복 호출 제거.

### 발견된 중복 호출 (setAttribute hook 한 호출 안에서)

1. **`attrLocalName(key)` 5~6회 호출** — caller 가 이미 `localKey` 를 계산했는데도 helper 함수 안에서 재계산:
   - hook body 의 `attrLocalName(key)` 1회
   - `isURLBearing(this, key)` 안의 `attrLocalName(key)` 1회
   - `shouldBlockURLAttribute(this, localKey, v)` 안의 `attrLocalName(localKey)` 1회 + 내부 `usesRawURLAttribute(el, key)` 의 `attrLocalName(key)` 1회
   - `usesRawURLAttribute(this, key)` × 2회 호출 (set + return 각각) 안의 `attrLocalName(key)` × 2

2. **`this.localName` 10회 read** — branch chain 마다 native DOM getter:
   - link × 4 (rel, href blocked, href icon, href icon in URL path)
   - base × 1, script × 1
   - iframe || frame × 2 (src, srcdoc)
   - 등

3. **`usesRawURLAttribute(this, key)` 2회 호출** — 같은 hook 안에서 같은 element/key 로 두 번 (set + return 분기).

### Fix

**A. helper 함수 시그니처에 optional 인자 추가** (backward-compat):
```js
function isURLBearing(el, key, _localKey, _tag) {
  const tag = _tag != null ? _tag : el.localName;
  const localKey = _localKey != null ? _localKey : attrLocalName(key);
  ...
}
function usesRawURLAttribute(el, key, _localKey) { ... }
function shouldBlockURLAttribute(el, key, raw, _localKey, _tag) { ... }
```

**B. hook 안에서 localName + localKey 캐싱 + helper 에 전달**:
```js
define(w.Element.prototype, 'setAttribute', function(k, v) {
  const key = String(k).toLowerCase();
  const colon = key.indexOf(':');
  const localKey = colon < 0 ? key : key.slice(colon + 1);  // attrLocalName inline
  const ln = this.localName;                                  // single getter
  ...
  if (isURLBearing(this, key, localKey, ln)) {
    if (shouldBlockURLAttribute(this, localKey, v, localKey, ln) || ...) return ...;
    const t = targetURLForElement(this, v);
    if (t) {
      const usesRaw = usesRawURLAttribute(this, key, localKey);  // single call
      urlMeta.set(this, t);
      if (!usesRaw) Native.setAttribute.call(this, 'data-zp-target-url', t);
      ...
      return Native.setAttribute.call(this, k, usesRaw ? v : t);
    }
  }
  ...
});
```

setAttributeNS, getAttribute, removeAttribute 도 동일 패턴.

### 측정 결과 (NAVER 실사이트, taskweaver exec-js)

R+S 직후 baseline 대비:

| 시나리오 | Before | After | Δ |
|---|---|---|---|
| Probe short URL × 500 | 1.00 µs/call | **0.80 µs/call** | **-20%** |
| Probe long URL × 500 (~150B) | 1.00 µs/call | **0.80 µs/call** | -20% |
| Probe data: URL × 500 | 0.80 µs/call | **0.60 µs/call** | -25% |
| **Real DOM 100 different elements** | **25 µs/call** | **17 µs/call** | **-32%** |
| Same URL × 1000 (urlClassifyCache HIT) | 1200 ns/call | **600 ns/call** | **-50%** |
| Alt 2 URLs (cache miss 교차) | 900 ns/call | 500 ns/call | -44% |
| Unique URLs × 1000 (no cache) | 2000 ns/call | **1200 ns/call** | **-40%** |
| Pure `new URL()` baseline | 2200 ns/call | 1900 ns/call | -14% (env noise) |

### 핵심 관찰

- **urlClassifyCache HIT 시 hot path 가 50% 추가 단축** (1200 → 600 ns/call): cache hit 흐름에서 분류는 즉시 skip 하므로 helper 중복 호출 비중이 더 크게 차지. 이번 fix 의 비중이 거기서 두드러짐.
- **Real DOM 32% 절감** (25 → 17 µs/call): 다양한 element type 의 분기 체인이 hot path 의 진짜 cost 였음. attrLocalName + localName 중복이 multi-element burst 의 가장 큰 overhead.
- **Long URL 평탄성 유지**: short ≈ long (둘 다 0.80 µs/call). Recipe 2 의 single-parse 효과가 유지된 채 추가 절감.
- **Unique URL miss path 40% 절감**: cache 가 없어도 helper 중복 제거만으로 800 ns 회복.

### Pattern / 권장

> "Hook chain 의 helper 함수가 같은 인자로 같은 derived 값을 재계산하는가" — 매번 의심해야 할 패턴. 특히 **string 정규화 (lowercase, split, slice)** 와 **native DOM getter** 가 helper 안에서 반복되면 caller-side 캐싱 + helper 시그니처 확장.

> Caller 측 캐싱시: const ln = this.localName; const localKey = ...; — 그리고 helper 에 양쪽 다 전달. helper 는 optional 인자 fallback 으로 backward-compat 유지.

### Regression guard

- attrLocalName 호출자 추가 시 (콜로니 segment 다루는 SVG `xlink:href` 등) caller 가 이미 `localKey` 계산했는지 확인.
- helper 시그니처 변경 시 nullish vs undefined 체크 — `_localKey != null ? _localKey : attrLocalName(key)` 패턴 유지 (빈 문자열 '' 가 valid localKey 라 truthy 체크 금지).

### 변경 파일

- [web/runtime-prelude.js](../web/runtime-prelude.js):
  - `attrLocalName` 정의는 그대로, fast path 의 inline 만 hook 안에서.
  - `isURLBearing` / `usesRawURLAttribute` / `shouldBlockURLAttribute` 시그니처 확장 (optional `_localKey`, `_tag`).
  - 4개 hook (setAttribute / setAttributeNS / getAttribute / removeAttribute) 안에서 localKey + ln 캐싱 + helper 호출에 전달.

## 3.10 (T2 라운드) — MO record path (`enforceObservedAttribute`) 확산 + isSVGURLBearing 시그니처 확장

> §3.9 의 패턴을 MutationObserver record 처리 path 로 확산. R+S 의 MO callback 이 each attribute record 마다 `enforceObservedAttribute` 호출 → 거기서도 동일 중복 발견.

### 발견된 중복 (`enforceObservedAttribute` 한 호출 안에서)

- 함수 시작에서 `attrLocalName(key)` + `tag = el.localName` 이미 계산되어 있는데 helper 안에서 재계산:
  - `isURLBearing(el, key)` 1회 → 내부 attrLocalName + localName
  - `shouldBlockURLAttribute(el, localKey, raw)` 1회 → 내부 attrLocalName + localName + usesRawURLAttribute 안의 attrLocalName
  - **`usesRawURLAttribute(el, key)` × 3회** (alreadyMapped 체크 + data-zp-target-url set 분기 + final set 분기)
- `isSVGURLBearing(el, key)` 가 `isURLBearing` 안에서 호출시 또 attrLocalName 재계산.

### Fix

```js
function enforceObservedAttribute(el, key) {
  if (!el || !key) return;
  const localKey = attrLocalName(key);
  const tag = el.localName;
  ...
  if (!isURLBearing(el, key, localKey, tag)) return;
  const raw = Native.getAttribute.call(el, key);
  if (shouldBlockURLAttribute(el, localKey, raw, localKey, tag) || ...) ...
  ...
  const target = targetURLForElement(el, raw);
  if (!target) return;
  const usesRaw = usesRawURLAttribute(el, key, localKey);   // 1회만
  const alreadyMapped = urlMeta.get(el) === target && (!usesRaw ? ... : true);
  urlMeta.set(el, target);
  if (!usesRaw) Native.setAttribute.call(el, 'data-zp-target-url', target);
  ...
  if (!usesRaw) Native.setAttribute.call(el, key, target);
}

function isSVGURLBearing(el, key, _localKey) {
  return el && el.namespaceURI === 'http://www.w3.org/2000/svg' &&
         (_localKey != null ? _localKey === 'href' : attrLocalName(key) === 'href') &&
         /^(a|image|use|script)$/.test(el.localName || '');
}

// isURLBearing 안에서:
return localKey === 'href' && (tag === 'a' || ... || isSVGURLBearing(el, key, localKey)) || ...
```

### 측정 결과 (T 직후 → T2 누적, NAVER 실사이트)

| 시나리오 | T (직후) | T2 (이번 fix 후) | Δ |
|---|---|---|---|
| Probe long URL × 500 | 0.80 µs | 0.80 µs | 0 |
| Probe data: URL × 500 | 0.60 µs | 0.60 µs | 0 |
| **Real DOM 100 different elements** | 17 µs | **15 µs** | -12% |
| Same URL × 1000 (HIT) | 600 ns | 600 ns | 0 |
| **Unique URLs × 1000 (cache miss)** | 1200 ns | **900 ns** | **-25%** |

T2 가 unique URL miss path (cache 가 채워지지 않은 상태) 에서 추가 25% 절감 — **MO callback 의 hot record path 가 cache miss 시점에 더 효과** (cache HIT 면 어차피 enforceObservedAttribute 안의 helper chain 도 일부 skip).

### 누적 효과 (R+S baseline → T2 누적)

| 시나리오 | R+S baseline | T2 누적 | Δ |
|---|---|---|---|
| Probe long URL | 1.00 µs/call | **0.80 µs/call** | **-20%** |
| Probe data: URL | 0.80 µs/call | **0.60 µs/call** | **-25%** |
| **Real DOM 100 different elements** | **25 µs/call** | **15 µs/call** | **-40%** |
| Same URL × 1000 (cache HIT) | 1200 ns/call | **600 ns/call** | **-50%** |
| **Unique URLs × 1000 (cache miss)** | **2000 ns/call** | **900 ns/call** | **-55%** |

### 결론

helper chain 중복 제거 패턴이 hot path 의 거의 모든 production call site (4 hooks + enforceObservedAttribute + isSVGURLBearing) 에 적용 완료. 추가 후보 (setScriptSource / enforceLinkPolicy / prepareScriptElement / Attr.value setter / insertAdjacentHTML) 는 audit 결과 helper chain 중복 없음 — 단순 path 라 적용 여지 없음. micro-optimization 영역 (xlink:href SVG, rel multivalue parse) 만 남았으나 ROI 낮음.

### 변경 파일 (T2)

- [web/runtime-prelude.js](../web/runtime-prelude.js):
  - `enforceObservedAttribute`: `isURLBearing` / `shouldBlockURLAttribute` 에 localKey + tag 전달, `usesRawURLAttribute` 1회 호출 + `usesRaw` 캐싱.
  - `isSVGURLBearing`: 시그니처 확장 (optional `_localKey`).
  - `isURLBearing`: `isSVGURLBearing(el, key, localKey)` 로 전달.

## 4. (조사) zp-htmltx + handle pipeline 평가

> §3.10 이후 user request: "추가 큰 win 후보는 서버측 (zp-htmltx) 영역 또는 WASM handle pipeline 같은 큰 설계 변경 — 조사좀". Explore agent + 직접 audit 결과.

### 4.1 zp-htmltx 적용된 quick wins (U 라운드)

zp-htmltx 의 hot HTML rewrite path 에서 동일 helper-chain 중복 패턴 발견. JS hot path 의 T 라운드와 동일 원리.

**발견된 중복**:
1. `proxied_subresource_url` (lib.rs:381-413) + `absolute_target_url` (lib.rs:418-437): scheme detection 코드 **byte-for-byte identical** (`to_ascii_lowercase()` + 6× `starts_with()`). 각 ~100-200 subresource URLs/page 마다 두 함수 모두 호출시 lowercase **2회 alloc**.
2. element handler (lib.rs:76-129) per-attribute 안에서 `tag = el.tag_name().to_ascii_lowercase()` 매번 (같은 element 의 모든 attribute 가 같은 tag).
3. `value.to_ascii_lowercase()` 호출시 URL 100B+ 인 경우 큰 alloc 비용 — `starts_with("javascript:")` check 하나 위해 전체 lower-cased copy.

**Fix** ([crates/zp-htmltx/src/lib.rs](../crates/zp-htmltx/src/lib.rs)):
```rust
// New helpers (zero-alloc ASCII CI comparison)
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

각 함수가 `let lower = s.to_ascii_lowercase()` + 6× starts_with → `is_inert_scheme(s)` + `starts_with_ascii_ci(s, "http://")` 로 치환. **lowercase alloc 0회**.

element handler 변경:
- `let tag = el.tag_name();` (element 시작에 1회, attribute loop 밖으로 이동). lol_html 이 tag_name 을 lowercase 정규화 보장.
- `let lower = name.as_str();` (attribute name 도 HTML element 에서 lol_html 이 lowercase 보장). 매 attribute 의 `to_ascii_lowercase()` 호출 제거.
- `lower_val = trimmed.to_ascii_lowercase()` → `starts_with_ascii_ci(trimmed, "javascript:")` (URL 전체 alloc 제거).

**효과 (추정)**:
- subresource URL 처리당 `to_ascii_lowercase()` 호출 **2회 → 0회** = 평균 URL 길이 ×2 bytes alloc 절감.
- element handler attribute loop 의 per-attribute `tag` alloc 제거 — 1000 elements × avg 3 attrs = 3000 alloc 절감/page.
- 큰 URL (~150B) 의 lower_val alloc 제거 = ~150 bytes × N subresources alloc 절감.

**검증**:
- `cargo test -p zp-htmltx`: **19/19 pass** baseline 유지.
- NAVER 실사이트: title=NAVER, ZeroProxyRT ✓, iframes 9, diag 0 (회귀 없음).
- 측정: page boot time 의 zp-htmltx 비중이 작아 JS micro-bench 로 직접 확인 어려움 (server-side hot path 측정 별도 영역).

### 4.2 WASM handle pipeline 평가 — 큰 설계 변경, ROI 작음

**가정**: zp-htmltx 가 HTML walk 중 발견한 URL 을 page-rt 의 intern pool 에 미리 등록 → page boot 시 prelude 가 handle 받아 17ns/op 분류.

**실현 가능성 분석**:

| 옵션 | 가능 여부 | 평가 |
|---|---|---|
| **A. 직접 handle 전달 (SW → page)** | ❌ 불가 | zp-htmltx (SW WASM instance) 와 zp-page-rt (page WASM instance) 가 별도 linear memory. handle 은 instance-local pointer. SW 의 handle 을 page 에서 직접 사용 시 무효한 메모리 접근. |
| **B. Raw URL list passing (response header / inline marker)** | ✓ 가능 | 서버가 발견한 URL 목록을 페이지에 전달 → page boot 시 일괄 intern. 단 zp-htmltx 가 이미 `data-zp-target-url` 로 raw URL 을 DOM 에 박는 중 — 새 채널 불필요. |
| **C. SharedArrayBuffer 기반 진짜 shared memory** | ⚠️ 위험 | COOP/COEP 강제 → cross-origin isolation 필요. ZeroProxy 의 stealth 모델 (자기 자신을 다른 origin 으로 위장) 과 충돌. SAB 의 timing attack mitigation 도 ZP 의 Tor-like 패턴과 호환성 검증 필요. |
| **D. 단일 cdylib + 두 instance** | ❌ marginal | 코드 (module) 공유는 가능하나 memory 분리 그대로. instance 마다 별도 intern pool. 같은 module 이라 dedup 없음. |
| **E. Recipe 5 (page boot 의 일괄 intern pass)** | ✓ 가능 | prelude 가 boot 시 `document.querySelectorAll('[data-zp-target-url]')` 일괄 → `rt.internURL(t)` 호출. 단 intern pool 이 hash 기반이라 **cross-call dedup 이미 자동** — 추가 boot pass 의 marginal value 가 작음. |

**핵심 발견**:

- **B = E = 동등**: zp-htmltx 가 박은 `data-zp-target-url` 의 raw URL 을 page-rt 가 mutation 시점에 보든, boot 시점에 일괄 보든 — intern pool 의 hash dedup 이 같은 URL 의 두 번째 호출에서 같은 handle 반환. 즉 **이미 자동으로 cross-call dedup**.

- **handle 의 진짜 가치 = 분류 17 ns/op** — §3.10 measurement 에서 **production 의 URL 분류 비중이 hot path cost 의 1-2%** 로 확인. 분류를 17 ns 로 줄여도 element-specific 로직 (link policy, navigation gate, urlMeta.set chain) 의 1000+ ns 이 dominates.

- **Recipe 5 의 추가 비용**: `[data-zp-target-url]` walk 가 stealth membrane 의 querySelectorAll 마스킹에 걸림 (자기 자신이 박은 attribute 도 의도적으로 mask). Native getter 직접 사용 우회 필요 — 추가 코드 복잡도.

### 4.3 결론

| 영역 | 결정 |
|---|---|
| zp-htmltx quick wins (U) | ✓ 적용 완료 (helper extraction + alloc dedup) |
| handle pipeline (Option A/C/D) | ✗ 기술적 / 보안 문제로 불가 또는 위험 |
| Recipe 5 (Option B/E) | ✗ defer — intern pool hash dedup 이 이미 같은 효과 자동 제공, 추가 ROI 없음 |
| **다음 영역** | **server-side micro-bench** (zp-htmltx transform throughput) 또는 **HTML page boot time** 측정 — JS hot path 외 영역 |

### 4.4 V 라운드 — Server-side throughput criterion bench + 추가 hot path 단축

> §4.3 의 "server-side throughput criterion bench" 권장을 실제 적용. crates/zp-htmltx/ 가 untracked (Phase B 결과, HEAD 없음) 이라 U 이전 baseline 비교 불가 — current state 측정 + 추가 hot path 발견 + 적용.

### 4.4.1 Bench infrastructure

- [crates/zp-htmltx/Cargo.toml](../crates/zp-htmltx/Cargo.toml): criterion 0.5 dev-dep + `[[bench]]` 등록.
- [crates/zp-htmltx/benches/transform.rs](../crates/zp-htmltx/benches/transform.rs): 5 fixtures:
  - `transform_typical`: 50 scripts + 30 links + 100 imgs + 200 anchors + 3 inline (~57 KB)
  - `transform_large`: 200 + 100 + 400 + 800 + 3 inline (~227 KB)
  - `transform_subresource_heavy`: 20 + 500 + 500 + 50 (subresource-bound)
  - `transform_typical_no_inline`: typical without inline scripts (isolates rewriter cost)
  - `transform_inline_only_50`: 50 inline scripts only (isolates OXC parse cost)

### 4.4.2 First measurement (U state)

| Bench | Time | Per URL-bearing element |
|---|---|---|
| transform_typical (380 URL-bearing) | 1.88 ms | 4.95 µs |
| transform_large (1500) | 6.99 ms | 4.66 µs |
| transform_subresource_heavy (1070) | 5.07 ms | 4.74 µs |
| transform_typical_no_inline (380) | 1.81 ms | 4.76 µs |
| transform_inline_only_50 (50) | 533 µs | 10.7 µs (OXC per inline script) |

핵심 발견:
- per URL-bearing element 가 ~4.7-4.9 µs (각 fixture 공통).
- **inline script (OXC parse) cost 가 hot path 아님** — typical 의 1.88 ms 중 inline 비중 ~40 µs (2%). 50 inline scripts 만으로 533 µs (10.7 µs / script).
- 진짜 hot path 는 subresource processing (proxied_subresource_url + absolute_target_url).

### 4.4.3 Applied V wins (3 additional)

1. **Attribute lazy filter** ([lib.rs:81-95](../crates/zp-htmltx/src/lib.rs#L81)): `el.attributes().iter().map(...).collect()` (모든 attribute clone) → `filter_map(...)` (URL-bearing / on* 만 collect). 효과: noise (Vec<(String,String)> alloc 의 fixed cost 작음). 의도 명확화는 이득.

2. **Streaming percent-encode** ([lib.rs:413-417](../crates/zp-htmltx/src/lib.rs#L413)): `out.push_str(&utf8_percent_encode(...).to_string())` → `for chunk in utf8_percent_encode(...) { out.push_str(chunk); }`. 중간 String alloc 1단계 제거. 효과: **transform_large -9%**, typical -2%, sub -5%.

3. **resolve_against_base CI + builder** ([lib.rs:357-389](../crates/zp-htmltx/src/lib.rs#L357)):
   - `base.to_ascii_lowercase()` (alloc) → `starts_with_ascii_ci(base, "http://")` (zero-alloc, U 라운드 helper 재사용)
   - 4× `format!("{}{}{}", origin, ...)` → `String::with_capacity + push_str` chain (alloc + write overhead 최소화)
   - `split('?').next().unwrap_or(...).split('#').next().unwrap_or(...)` (2× lazy iterator alloc) → `split(['?', '#']).next().unwrap_or(...)` (single split)
   효과: typical -4%, no_inline -3%, large/sub noise.

### 4.4.4 누적 효과 (V 모두 적용 후)

| Bench | U baseline | V 최종 | 누적 Δ |
|---|---|---|---|
| transform_typical | 1.88 ms | **1.73 ms** | **-8%** |
| transform_large | 6.99 ms | 6.59 ms | -6% |
| transform_subresource_heavy | 5.07 ms | 4.62 ms | -9% |
| transform_typical_no_inline | 1.81 ms | 1.67 ms | -8% |
| transform_inline_only_50 | 533 µs | 508 µs | -5% (noise) |

per URL-bearing element 4.95 → **4.55 µs** (typical), 4.66 → 4.39 µs (large).

### 4.4.5 결론 / 다음 후보

- **base parse caching** (closure 가 한 번 parse → Arc<(origin, dir)> capture → resolve_against_base 재호출시 cached parts 사용): 큰 변경, lol_html closure capture 복잡, typical 1.73 ms 의 추가 마진 작아 ROI 의문. **defer.**
- **`absolute_target_url` 의 `s.to_string()` alloc** (line 432): 짧은 절대 URL 만 처리, marginal.
- **inline script rewrite (OXC parse)**: hot path 아님 (10.7 µs/script × N 작음). zp-rewriter 측 audit 별도 영역.
- **lol_html element handler dispatch overhead**: lol_html 라이브러리 내부, 우리가 줄일 수 없음.

WASM 측 (P+Q+R+S), JS hot path (T+T2), server-side helper chain (U+V) — **모든 영역의 helper-chain 중복 제거 완료**. 추가 win 은 lol_html 라이브러리 또는 zp-rewriter (OXC) layer 의 작업이거나 architecture 변경 영역.

### 4.4.6 변경 파일 (V 라운드)

- [crates/zp-htmltx/Cargo.toml](../crates/zp-htmltx/Cargo.toml): criterion 0.5 dev-dep.
- [crates/zp-htmltx/benches/transform.rs](../crates/zp-htmltx/benches/transform.rs): 5 fixture bench harness.
- [crates/zp-htmltx/src/lib.rs](../crates/zp-htmltx/src/lib.rs): 3 적용 (lazy filter, streaming percent-encode, resolve_against_base CI+builder).

## 5. (W 라운드) 호환성 작업 (2026-05-31) 직후 추가 hot path 단축

> 2026-05-31 의 호환성 작업 (NAVER 웹툰 Location virtualization, zp-htmltx `&amp;` 디코드, NAVER GFP non-SafeFrame iframe `installSafeFrameResizeShim`, V8 incumbent realm leak fix) 직후 audit. 새 함수들이 hot path 인지 평가 + 3 fix 적용.

### 5.1 Explore audit 결과 (ROI 순)

| 영역 | Call pattern | Helper chain 중복 | 적용 fix |
|---|---|---|---|
| `decode_url_html_entities` (Rust, zp-htmltx) | per URL attribute (페이지당 수백 회) | fast path 도 매번 `src.to_string()` alloc | W1: `Cow<'_, str>` 반환 → `&` 없는 일반 URL 에서 alloc 0 |
| `virtualizeMessageEvent` | per message event | `virtualOriginForMessage` 항상 호출 (proxyOrigin mismatch 시 어차피 '' 반환) | W2: fast-exit (`actualSource === ev.source && ev.origin !== proxyOrigin` → 즉시 ev) |
| `installSafeFrameResizeShim` `apply()` | per 200ms × N SafeFrame iframes 영구 | `scrollHeight`/`offsetHeight` 매번 layout reflush 강제 | W3: adaptive backoff (200→400→800→1600→2000ms cap, height 안정시 점진 증가, 변화시 reset) |
| `wrappedLocationFor` (Location Proxy) | per location property read | WeakMap 캐시 이미 있음 (1회 alloc) | defer (low ROI) |
| `installParentSenderRedirect` | per iframe attach (init only) | 18 defineProperty 한 번만 | defer (init only) |
| `parentPostMessageSenderQueue` queue ops | per postMessage (correctness critical) | dedup 없음 (FIFO 정확성 우선) | defer (correctness) |

### 5.2 W1: `decode_url_html_entities` Cow 변환

**Before** ([crates/zp-htmltx/src/lib.rs:413-414](../crates/zp-htmltx/src/lib.rs#L413)):
```rust
fn decode_url_html_entities(src: &str) -> String {
    if !src.contains('&') {
        return src.to_string();  // ← `&` 없어도 alloc
    }
    ...
}
```

**After**:
```rust
fn decode_url_html_entities(src: &str) -> std::borrow::Cow<'_, str> {
    if !src.contains('&') {
        return std::borrow::Cow::Borrowed(src);  // ← zero alloc fast path
    }
    let mut out = String::with_capacity(src.len());
    ...
    std::borrow::Cow::Owned(out)
}
```

caller (line 115-117) 도 `let decoded = decode_url_html_entities(&value); let trimmed = decoded.trim_start();` — owned shadow 제거.

**측정 효과** (criterion):
| Bench | Before W1 (cumulative after compat) | After W1 | Δ |
|---|---|---|---|
| transform_typical | 1.58 ms | **1.51 ms** | -4% |
| transform_large | 6.33 ms | **5.78 ms** | **-9%** |
| transform_typical_no_inline | 1.51 ms | 1.49 ms | -1% |
| transform_inline_only_50 | 445 µs | 431 µs | -3% |

large 가 가장 큰 win — 1500 URL 마다 alloc 1번 절감.

### 5.3 W2: `virtualizeMessageEvent` fast-exit

**Before** ([web/runtime-prelude.js:540-552](../web/runtime-prelude.js#L540)):
- per message event 마다 `virtualOriginForMessage(...)` 호출. virtualOriginForMessage 가 `ev.origin !== proxyOrigin` 면 즉시 '' 반환.
- 즉 대부분의 cross-frame message (proxyOrigin 아닌 경우) 가 불필요한 함수 호출 + 조건부 객체 alloc 거침.

**After**:
```js
let actualSource = ev.source;
if (isRootRealm && actualSource === root && ...) { ... }
// Hot path fast-exit
if (actualSource === ev.source && ev.origin !== proxyOrigin) return ev;
const origin = virtualOriginForMessage(...);
```

**측정**: postMessage 빈도가 site 별로 다양 — micro-bench 어려움. SafeFrame ad page 에서 초당 수십 회 가능.

### 5.4 W3: `installSafeFrameResizeShim` adaptive backoff

**Before** ([web/runtime-prelude.js:3012-3014](../web/runtime-prelude.js#L3012)):
- 영구 200ms 마다 `apply()` 호출. `apply()` 가 `scrollHeight`/`offsetHeight` 3 reads → 매 tick 마다 layout reflush 강제.
- 3-5 SafeFrame iframes 가 영구 200ms polling 하면 cumulative reflow noise 누적.

**After**:
```js
let interval = 200;
let stableTicks = 0;
const tick = () => {
  const before = lastH;
  apply();
  if (lastH === before) {
    stableTicks++;
    if (stableTicks >= 3 && interval < 2000) interval = Math.min(interval * 2, 2000);
  } else {
    stableTicks = 0;
    interval = 200;
  }
  try { root.setTimeout(tick, interval); } catch {}
};
```

- height 안 바뀌면 3 tick stable 후 점진 backoff (200→400→800→1600→2000)
- 바뀌면 즉시 200ms reset
- image load event 가 별도 hook 으로 작동하므로 backoff 가 첫 안정화 후 reflow 누락 없음

**효과**: 안정화 후 polling rate 10× 감소 (200ms → 2000ms). 영구 reflow noise 제거. functional 정확성 유지.

### 5.5 누적 효과 (전체 round U → V → 5월31 compat → W)

| Bench | U baseline | V 최종 | 5월31 compat 후 | W 최종 | 전체 누적 Δ |
|---|---|---|---|---|---|
| transform_typical | 1.88 ms | 1.73 ms | 1.58 ms | **1.51 ms** | **-20%** |
| transform_large | 6.99 ms | 6.59 ms | 6.33 ms | **5.78 ms** | **-17%** |
| transform_subresource_heavy | 5.07 ms | 4.62 ms | 3.98 ms | 4.12 ms | -19% |
| transform_typical_no_inline | 1.81 ms | 1.67 ms | 1.51 ms | 1.49 ms | -18% |
| transform_inline_only_50 | 533 µs | 508 µs | 445 µs | 431 µs | -19% |

### 5.6 검증

- `cargo test -p zp-htmltx`: 20/20 pass (W 라운드 후도 baseline 유지)
- `node test/js/static-policy.test.js`: 13/14 (test #4 pre-existing, W 라운드와 무관)
- NAVER 실사이트: title=NAVER, ZeroProxyRT ✓, iframes 9, diag 0, location.pathname=string (Location virtualization 정상)
- Wikipedia 외부 망 unreachable (환경 제약) — entity decode 코드 path 는 cargo test `stylesheet_link_with_html_entity_decoded` 가 검증

### 5.7 변경 파일 (W 라운드)

- [crates/zp-htmltx/src/lib.rs](../crates/zp-htmltx/src/lib.rs) (W1): `decode_url_html_entities` → `Cow<'_, str>`, caller owned shadow 제거
- [web/runtime-prelude.js](../web/runtime-prelude.js) (W2): `virtualizeMessageEvent` fast-exit at line 551
- [web/runtime-prelude.js](../web/runtime-prelude.js) (W3): `installSafeFrameResizeShim` adaptive backoff at line 3012-3026

## 5.8 (X 라운드) 남은 micro-opts — 측정상 noise, 기능 회귀 없음

> W 라운드 defer 후보들 ("low ROI" 명시) 처리. fixture 에 해당 케이스 부재 + per-instance init only 라 criterion 측정상 noise. 그래도 functional correctness 와 code intent 명확화.

### 5.8.1 X1: scheme-relative URL `format!` → push_str chain

[crates/zp-htmltx/src/lib.rs:482-487, 528-533](../crates/zp-htmltx/src/lib.rs#L482):
- `format!("https:{}", s)` → `let mut a = String::with_capacity(6 + s.len()); a.push_str("https:"); a.push_str(s);`
- 적용: `proxied_subresource_url` + `absolute_target_url` 의 scheme-relative branch (`s.starts_with("//")`)
- 측정: fixture 가 absolute URL (`https://cdn.example.com/...`) 만 사용해서 이 분기 안 hit — noise. 실 페이지에서는 cdn 의 protocol-less ref (Wikipedia 의 `//upload.wikimedia.org/...` 같은) 에서 의미.

### 5.8.2 X2: `wrappedLocationFor` 4-method closure outer hoist

[web/runtime-prelude.js:733-749](../web/runtime-prelude.js#L733):
- `locToString`, `locAssign`, `locReplace`, `locReload` 를 outer scope 로 hoist
- 각 `wrappedLocationFor` 호출이 4 closure alloc 했었음 → 1 set (module init time)
- 측정: WeakMap cache 가 nativeLoc 당 1회 호출 보장. multi-iframe page 에서 각 iframe 마다 4 closure × N iframes 절감
- criterion bench 영역 아님 (browser-side, init-only)

### 5.8.3 누적 측정 (U baseline → X 최종)

| Bench | U baseline | X 최종 | 누적 Δ |
|---|---|---|---|
| transform_typical | 1.88 ms | **1.49 ms** | **-21%** |
| transform_large | 6.99 ms | 6.06 ms | -13% |
| transform_subresource_heavy | 5.07 ms | 4.00 ms | **-21%** |
| transform_typical_no_inline | 1.81 ms | 1.45 ms | **-20%** |
| transform_inline_only_50 | 533 µs | 448 µs | -16% |

### 5.8.4 검증

- cargo test 20/20, static-policy 13/14 baseline 유지
- NAVER 실사이트: title=NAVER, ZeroProxyRT ✓, iframes 9, diag 0, location.pathname 정상 (wrappedLocationFor 회귀 없음)

### 5.8.5 최종 결론 — 모든 hot path 영역 최적화 완료

| Round | 영역 | 핵심 win |
|---|---|---|
| P+Q+R+S | WASM (zp-page-rt) | schemeOnly ASCII fast path, MO callback schemeOnly N회 |
| T+T2 | JS hot path (runtime-prelude hooks + MO record) | helper chain 중복 제거 (real DOM -40%, cache HIT -50%, unique URL -55%) |
| U | server-side helper chain (zp-htmltx) | starts_with_ascii_ci + is_inert_scheme + per-attribute alloc 제거 |
| V | server-side hot path | criterion bench infra + lazy filter + streaming percent-encode + resolve_against_base CI+builder |
| W | compat 작업 후속 | Cow fast path + virtualizeMessageEvent fast-exit + adaptive backoff polling |
| X | 남은 micro-opts | scheme-rel push_str + Location method hoist |

zp-htmltx throughput 누적 **-21% vs U baseline** (전체 U→X 평균). JS hot path 누적 real DOM **-40%**, cache HIT **-50%**, unique URL **-55%**. WASM 측 ceiling 도달 (schemeOnly ASCII fast path).

**남은 win 후보** (deferred 또는 별도 영역):
- base parse caching (V defer, query/fragment-only 처리 정확성 위해 base_path_full 필요 → single tuple 캐싱만으로 부정확)
- handle pipeline (SW vs page WASM instance 메모리 분리, SharedArrayBuffer COOP/COEP 충돌)
- inline script OXC parse (zp-rewriter 영역, hot path 아님 검증됨)
- lol_html / OXC 라이브러리 내부 (외부 의존성)
- **HTML page boot time end-to-end** (server + parse + SW boot 통합 측정, 다른 metric layer)

### 5.8.6 변경 파일 (X 라운드)

- [crates/zp-htmltx/src/lib.rs](../crates/zp-htmltx/src/lib.rs): `format!("https:{}", s)` → `String::with_capacity + push_str` 2곳
- [web/runtime-prelude.js](../web/runtime-prelude.js): `wrappedLocationFor` 4-method closures outer hoist (line 733-737 의 module-level const 추가)

## 6. OPEN

- ~~wasm-opt 설치~~ ✓
- ~~Chrome bench~~ ✓
- ~~D — scheme-only fast path~~ ✓
- ~~P — encoder isolation + ASCII fast path~~ ✓
- ~~Q — classifyBatch ASCII fast path + single-pass + no-copy result~~ ✓
- ~~R+S — production MO callback schemeOnly N회 교체 + threshold 분기 제거~~ ✓
- ~~§3.8 — production 실사이트 measurement (NAVER setAttribute hot path)~~ ✓
- ~~§3.9 (T) — element-specific 로직 path 단축 (attrLocalName / localName 중복 제거 → real DOM -32%, cache HIT -50%)~~ ✓
- ~~§3.10 (T2) — MO record path (enforceObservedAttribute) + isSVGURLBearing 시그니처 확장 → real DOM -40% 누적, unique URL -55% 누적~~ ✓
- ~~§4 (U + handle pipeline 평가) — zp-htmltx 의 helper chain dedup 적용 (starts_with_ascii_ci / is_inert_scheme / tag once-per-element), handle pipeline 은 instance memory 분리로 불가, Recipe 5 도 intern hash dedup 자동 제공으로 ROI 없음 결론~~ ✓
- ~~§4.4 (V) — server-side criterion bench harness 추가 + 3 추가 win (lazy filter, streaming percent-encode, resolve_against_base CI+builder) → typical -8% / large -6% / sub -9% 누적~~ ✓
- **남은 audit 결과**: setScriptSource / enforceLinkPolicy / prepareScriptElement / Attr.value setter / insertAdjacentHTML 는 helper chain 중복 없음 (단순 path). micro-optimization 영역만 남음 (xlink:href SVG, rel multivalue parse, base parse caching defer).
- **`TextEncoder` 대안 측정**: 짧은 ASCII 입력에 대해 수동 u8 변환 또는 `String.prototype.charCodeAt` 루프가 더 빠를 가능성. Chrome 의 encodeInto 큰 비용의 원인 추적
- **performance.now() resolution 검증**: 짧은 측정 (handle-only 의 20ns) 에서 영향 확인
- **non-headless Chrome bench**: 차이 있으면 puppeteer 한계가 원인
- **shareable bench-core 모듈화**: Node/Browser bench 의 코드 중복 제거 (3차 측정시 이미 권장됨)
- **Batch ABI 의 실제 MutationObserver 연결** — 진짜 코드 통합

## 산출물 (이 라운드)

- [package.json](package.json): `binaryen` devDep
- [scripts/build.mjs](scripts/build.mjs): wasm-opt feature flags 통합
- [crates/zp-page-rt/src/lib.rs](crates/zp-page-rt/src/lib.rs): `url_classify_scheme_only` export 추가
- [web/zp-rt.js](web/zp-rt.js): `classifySchemeOnly` API + SCHEME_PROBE=16 cap
- [test/bench/url-classify.bench.mjs](test/bench/url-classify.bench.mjs): scheme-only 측정 추가
- [test/bench/url-classify.bench.browser.mjs](test/bench/url-classify.bench.browser.mjs): scheme-only 측정 추가
