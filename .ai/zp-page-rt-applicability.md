# zp-page-rt — 적용 가능성 분석 (2026-05-30 기록)

> 역사 기록: 아래의 코드 행 번호, 적용 후보, 성능 수치는 당시 분석이다. 현재 구현 계약은 [Rust ABI](../crates/zp-page-rt/src/lib.rs)와 [JS glue](../web/zp-rt.js), 현재 작업 범위는 [compatibility refactor plan](design/website-compat-refactor.md)을 기준으로 한다. 이 문서는 최신 성능 또는 완료 판정이 아니다.

> 2026-05-30. 벤치 결과(`.ai/zp-page-rt-bench-report.md`) 와 현재 [web/runtime-prelude.js](../web/runtime-prelude.js) / [crates/zp-htmltx](../crates/zp-htmltx) / [crates/zp-rewriter](../crates/zp-rewriter) 코드 audit.

목적: 측정된 4개 경로 (`classOf`, `classifySchemeOnly`, `bulk_intern_and_classify`, `handle-only`) 중 **어느 경로가 어느 call site 에 적용 가능한지** 매핑. 가설 검증된 패턴만 권장.

## 1. 현재 분류 helper anatomy

### 1.1 primitives ([runtime-prelude.js:285-287](../web/runtime-prelude.js#L285))

| 함수 | 구현 | 비용 (Node ns) | 길이 의존성 |
|---|---|---|---|
| `isHTTPURL(raw)` | `new URL(raw, base).protocol === 'http:'\|...` | ~140 (short) / **~1300** (long) | **선형 (`new URL()`)** |
| `hasExecutableURLScheme(raw)` | `/^(?:javascript\|data\|vbscript):/i.test(s.trim())` | ~150-200 | 무관 (regex 가 scheme 매치 후 stop) |
| `hasDangerousURLScheme(raw)` | `/^(?:javascript\|vbscript):/i.test(s.trim())` | ~150-200 | 무관 |

**핵심 관찰**: regex helper 2개는 **이미 length-independent + V8 JIT 로 최적화 완료**. WASM 으로 옮길 가치 없음. **유일한 hot 비용은 `isHTTPURL` 의 `new URL()`** — 길이 선형, long URL 에서 catastrophic.

### 1.2 composers ([runtime-prelude.js:288-305](../web/runtime-prelude.js#L288))

```js
shouldBlockURLAttribute(el, key, raw)   // → strict ? hasExecutableURLScheme : hasDangerousURLScheme
hasContextBlockedScheme(el, raw)        // blob: gating for script/iframe/frame/embed/object
blockExecutableURL(el, key, raw)        // 실제 block 동작
```

## 2. Call site 분류 (hot → cold)

| # | Call site | 빈도 | 호출 패턴 | 적용 후보 |
|---|---|---|---|---|
| 1 | [MutationObserver callback (2329-2333)](../web/runtime-prelude.js#L2329) | **최고** (hydration burst) | N records → 각각 `enforceObservedAttribute` | **Batch ABI** ⭐ |
| 2 | [enforceObservedAttribute (2365-2366)](../web/runtime-prelude.js#L2365) | 최고 (1 결과) | `shouldBlock` + `hasContextBlocked` + `isHTTPURL` + `targetURL` | Recipe 2 (JS dedup) |
| 3 | [setAttribute setter (1916-1917)](../web/runtime-prelude.js#L1916) | 높음 (JS 코드의 모든 setAttr) | 동일 패턴 | Recipe 2 (JS dedup) |
| 4 | [setAttributeNS setter (1940-1941)](../web/runtime-prelude.js#L1940) | 중간 (namespace 만) | 동일 패턴 | Recipe 2 |
| 5 | [link.href setter (2142-2143)](../web/runtime-prelude.js#L2142) | 높음 (link 요소) | `shouldBlock` + `isHTTPURL` + `targetURL` | Recipe 2 + Handle cache |
| 6 | [setScriptSource (2098)](../web/runtime-prelude.js#L2098) | 중간 (dynamic script) | `hasExecutableURLScheme` + `isHTTPURL` + `targetURL` | Recipe 2 |
| 7 | [installURLProp accessor (1401)](../web/runtime-prelude.js#L1401) | 중간 (a.href, area.href getter/setter) | `urlMeta.get` 또는 `targetURL(...)` | Handle cache |
| 8 | [setSafeNavigationTarget (1691, 1727)](../web/runtime-prelude.js#L1691) | 낮음 (target 속성) | `isHTTPURL(v)` | — (저빈도) |
| 9 | [clickNavigationTarget (1321-1322)](../web/runtime-prelude.js#L1321) | 매우 낮음 (user click) | `hasExecutableURLScheme` + `isHTTPURL` | — (저빈도) |
| 10 | [installPopupHooks (1345)](../web/runtime-prelude.js#L1345) | 매우 낮음 (window.open) | `isHTTPURL` | — (저빈도) |

## 3. urlMeta WeakMap — 이미 있는 handle pipeline 후보

[runtime-prelude.js:35](../web/runtime-prelude.js#L35) 의 `urlMeta` 가 **이미 per-element URL state** 보유. 현재 저장 값: target URL string. **handle 추가 저장하면 즉시 handle pipeline 가능**.

현재 패턴 (8군데 동일):
```js
urlMeta.set(this, t);
Native.setAttribute.call(this, 'data-zp-target-url', t);
```

handle 캐시 적용:
```js
const handle = rt && rt.internURL(t);
urlMeta.set(this, { target: t, handle });
Native.setAttribute.call(this, 'data-zp-target-url', t);
```

getter 측 (예: [installScriptProp 2126](../web/runtime-prelude.js#L2126)):
```js
get() { return urlMeta.get(this) || ...; }
```
→ 동일하게 `meta.target` 추출.

**이점**: 동일 요소에 MutationObserver 재발화시 (React re-render 흔함) `meta.handle` 로 17ns 분류 가능. 단 같은 URL 재분류가 같은 element 에서 일어나야 효과. cross-element 캐시 효과는 page-rt 의 intern pool 이 hash 기반이라 두 번째 URL 도 캐시 hit.

## 4. zp-htmltx — server-side handle pipeline 가능성

[crates/zp-htmltx/src/lib.rs:76-150](../crates/zp-htmltx/src/lib.rs#L76) 가 **이미 모든 URL 어트리뷰트를 walk** 하고 `data-zp-target-url` 을 emit. 즉 페이지 boot 시점에 모든 외부 리소스 URL 이 attribute 로 노출됨.

**문제**: rewrite 는 SW context, handle pool 은 page context — **handle 직접 전달 불가**.

**우회**: page prelude 가 boot 시 `document.querySelectorAll('[data-zp-target-url]')` 로 일괄 intern. 이후 동일 URL 마주칠 때 intern pool hit (handle 재사용).

복잡도: 중간. 효과: 이미 intern pool 이 hash 기반이라 자동 dedup — 추가 boot pass 의 marginal 가치는 unclear. **defer.**

## 5. 권장 Recipe (우선순위 순)

### Recipe 0: 측정된 anti-pattern (적용 금지)

| 시도 | 이유 |
|---|---|
| `hasExecutableURLScheme` → WASM | regex 가 V8 JIT 후 ~150ns, length-independent. WASM 마샬링 비용 ~200ns 가 무조건 손해 |
| `hasDangerousURLScheme` → WASM | 동일 |
| `isHTTPURL` short URL → `classOf` | Node 측정: 140 vs 309 ns, **2.2× 손해** |
| `isHTTPURL` short URL → `classifySchemeOnly` | Node 측정: 140 vs 235 ns, 1.7× 손해 |
| 단순 helper 1:1 WASM 치환 | 모든 케이스에서 손해 또는 무이득 |

---

### Recipe 1 (HIGH ROI) — Batch ABI for MutationObserver

**대상**: [installBaseObserver callback (2329-2333)](../web/runtime-prelude.js#L2329)

**현재**:
```js
new MO(records => {
  for (const r of records) {
    if (r.type === 'attributes') enforceObservedAttribute(r.target, ...);
    else for (const n of r.addedNodes || []) {
      syncBaseElement(n); enforceSubtreePolicies(n); instrumentDescendantIframes(n);
    }
  }
}).observe(doc.documentElement, { ... attributeFilter: ['href','src','srcdoc','action',...] });
```

**제안**:
1. 첫 pass: records 순회하며 **분류 대상 URL 만 수집** — `(el, attr, raw, isLong)` tuple 배열로
2. 분류 batch 호출: `rt.raw.bulk_intern_and_classify(scratch layout, N)` — N 개 결정을 한 번에
3. 두 번째 pass: 결정에 따라 `blockExecutableURL` / 정상 rewrite / no-op 디스패치

**측정 근거**:
- 단일 wasm 호출 (cached view): 270 ns (Node) / 590 ns (Chrome)
- batch N=16: **120 ns/item (Node)** / **145 ns/item (Chrome)** — JS regex 대비 0.96× ~ 1.27× 빠름
- 50 mutation × 평균 3 URL = 150 URL 분류 / tick:
  - 현재: 150 × `isHTTPURL` ~140ns = 21µs (short) / 150 × ~1300ns = **195µs (long)**
  - batch: ~18µs 어느 길이든

**복잡도**: 중간. 1 callback 의 refactor + scratch layout builder. zp-rt.js 에 `withScratch(layoutFn)` 헬퍼 추가 권장 (함정노트의 scratchpad-corruption 회피).

**기대 효과**: hydration 시 long URL 다수 (signed CDN, srcset data) 처리 시 **10× 효과**, short URL 만 있을 때 **동등**.

---

### Recipe 2 (HIGH ROI, JS-only) — `isHTTPURL` + `targetURL` 의 중복 `new URL()` 제거

**대상**: 8군데 (lines 1917-1918, 1941-1942, 2143-2144, 2366-2368, 등)

**현재 패턴**:
```js
if (isHTTPURL(v)) {             // new URL() #1 — 1300ns for long
  const t = targetURL(v);        // new URL() #2 — 1300ns for long
  urlMeta.set(this, t);
  ...
}
```

총 **2600 ns / long URL setAttr**. catastrophic.

**제안**:
```js
let parsed;
try { parsed = new URL(String(v), baseURL); } catch { return; }
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
const t = parsed.href;          // canonical form 동일
urlMeta.set(this, t);
...
```

또는 `targetURL` 가 이미 `canonicalTargetURL` 호출하니 `isHTTPURL` 을 try/catch 흡수:
```js
let t;
try { t = targetURL(v); } catch { return; }
urlMeta.set(this, t);
```

**측정 근거**: WASM 측 무관. 순수 JS dedup. 1300ns 절감.

**복잡도**: 낮음. 8군데 동일 패턴.

**기대 효과**: long URL setAttr **50% 비용 절감** (2600 → 1300 ns). short URL 도 200 → 100 ns. 모든 환경 (Node/Chrome) 적용.

⚠ **WASM 작업 전 선행 권장**: 이 recipe 후 Recipe 1 의 batch 비교 baseline 이 더 공정해짐.

---

### Recipe 3 (MEDIUM ROI) — Handle cache via urlMeta 확장

**대상**: 8군데 `urlMeta.set(this, t)` (lines 1254, 1697, 1730, 1919, 1943, 2101, 2145, 2370)

**현재**:
```js
urlMeta.set(this, t);  // t = string
// nearby: urlMeta.get(el) returns string
```

**제안**:
```js
urlMeta.set(this, { target: t, handle: rt ? rt.internURL(t) : 0 });
// getter sites:
const meta = urlMeta.get(this);
const target = (meta && typeof meta === 'object') ? meta.target : meta;
```

또는 더 깔끔하게 별도 `urlHandleMap` WeakMap 신설.

**측정 근거**:
- 첫 intern: 270 ns (cached view, Node), 590 ns (Chrome)
- 이후 handle-only classify: **17-21 ns** (환경 독립, 7-9× faster than JS regex)
- 단 같은 element 에 같은 URL 재분류시에만 효과

**복잡도**: 낮음. 8군데 setter + 4-5군데 getter.

**기대 효과**: React/Vue re-render 시 동일 URL 재분류 cost 거의 0. 단 cross-element 효과는 intern pool hash dedup 으로 이미 무료.

**언제 가치 있는가**:
- React diff 가 동일 src 로 재설정하는 경우 흔함 → `enforceObservedAttribute` 재호출 → handle classify 17ns
- vs 현재 isHTTPURL 140-1300 ns 재실행

---

### Recipe 4 (CONDITIONAL ROI) — `classifySchemeOnly` 적용

**대상**: `setScriptSource` (line 2098) 의 `isHTTPURL(value)` — 단, **value 가 long 일 가능성 있는 경로만**

**측정 근거**:
- Long URL: schemeOnly 248 ns (Node) / 678 ns (Chrome) vs isHTTPURL ~1300 ns. **80% 회복 (Node), 66% (Chrome)**
- Short URL: schemeOnly 235 ns vs isHTTPURL 140 ns. **1.7× 손해**

**제안**: 분기 — `value.length > 64 ? classifySchemeOnly : isHTTPURL`. 다만 분기 자체 ~5ns 비용 + 코드 복잡도.

**대안 더 권장**: Recipe 2 (`new URL()` 단일화) 가 이미 long URL 의 절반 비용을 해결. schemeOnly 의 추가 가치는 그 후에 측정 권장.

**복잡도**: 낮음. 다만 **Recipe 2 적용 후 재평가** 권장. Recipe 2 가 isHTTPURL 비용을 절반으로 줄이면 schemeOnly 의 상대 이득 작아짐.

---

### Recipe 5 (DEFER) — zp-htmltx 가 boot 시 handle 일괄 발급

**대상**: page prelude boot 시 `document.querySelectorAll('[data-zp-target-url]')` 일괄 intern.

**상태**: intern pool 의 hash dedup 으로 이미 자동으로 cross-call dedup 됨. boot pass 추가의 marginal 가치는 minor.

**권장**: Recipe 1+3 통합 후 실측 boot intern 누락률이 의미있을 때만 검토.

## 6. 권장 작업 순서

```
1. Recipe 2 (JS new URL() dedup) — 모든 환경 1300ns 절감, WASM 비의존
   ↓
2. Recipe 1 (Batch ABI MutationObserver) — hydration 폭주 시 효과 최대
   ↓ (Recipe 1 시 zp-rt.js 에 withScratch() 헬퍼 추가)
3. Recipe 3 (Handle cache via urlMeta) — re-render 비용 거의 0
   ↓
4. Recipe 4 재평가 — Recipe 2 후 isHTTPURL 가 이미 빨라졌으면 가치 작음
   ↓
5. Recipe 5 (zp-htmltx boot intern pass) — 측정 후 결정
```

## 7. 즉시 시작 가능한 가장 큰 win

**Recipe 2 단독**: 8군데 패턴 치환, WASM 무관, 모든 환경 hot path 의 50% 비용 절감. risk 낮음 (`new URL()` 의미 동일).

WASM 작업의 진짜 가치는 **Recipe 1 (batch)** 에서 나옴. Recipe 2 후 batch baseline 이 더 공정해진다 (현재 baseline 이 의도하지 않게 isHTTPURL 의 이중 parse 비용까지 포함하고 있었음).

## 8. 적용 후 검증

- Recipe 1: `taskweaver` 로 NAVER/Wikipedia 같은 large hydration 사이트 페이지 로드 시간 측정. trap notebook 의 회귀 매트릭스 사용
- Recipe 2: `cargo test --workspace` + `node test/js/static-policy.test.js` 의 14 정책 테스트
- Recipe 3: 동일 + React 사이트 re-render 패턴 회귀 테스트 추가
