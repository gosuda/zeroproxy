# zp-page-rt — 역사적 함정 범주 요약

`crates/zp-page-rt`·`web/zp-rt.js`의 raw `extern "C"`·linear memory 및 연관 리라이트 경로에 관한 **역사적 기록이며, 현재 승인 사양이 아니다**. 측정·검증은 당시 결과이고 이번 문서 편집에서 런타임 실행이나 새 측정은 없었다. 당시 제안된 테스트·구현 공백은 역사적/미검증 상태이지 현재 TODO가 아니다. 후속 정정이 앞선 가설보다 우선하며, 제한된 회귀 관찰로 GitHub·CF/Cloudflare·CNN 미해결 사례의 해결을 뜻하지 않는다.

배경: [.ai/zp-page-rt-design.md](../zp-page-rt-design.md), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md).

<a id="2026-05-30--scratchpad-가-중간-classify-호출에-의해-silent-덮어쓰기--wasm-trap"></a>
## 2026-05-30 — Scratchpad 중간 덮어쓰기

- **원인:** JS가 `[lens][bytes][out]`을 쓴 뒤 `rt.classOf()`를 호출하면 `writeScratch()`가 시작부터 덮어썼다. URL 바이트를 거대한 length로 해석하여 WASM bounds trap 발생.
- **수정/규칙:** 워밍을 먼저 하고 layout은 bulk 호출 직전에 작성한다. 메모리 쓰기→호출→결과 소비 사이에 다른 WASM 함수를 끼우지 않는다.
- **근거/상태:** [test/bench/url-classify.bench.mjs](../../test/bench/url-classify.bench.mjs) batch에서 발견. `withScratch()` 원자 블록·별도 scratch2는 당시 제안이며 구현 검증 기록은 없다.

<a id="2026-05-30--memorygrow-가-모든-uint8array-뷰를-detach"></a>
## 2026-05-30 — `memory.grow`와 detached view

- **원인:** 당시 메모리에서 allocator가 grow하면 기존 ArrayBuffer가 detach되어 캐시한 typed view로는 새 WASM 메모리를 볼 수 없었다.
- **수정/규칙:** `web/zp-rt.js`의 `memU8()`가 `ex.memory.buffer` 참조 변경을 감지하여 전체 view와 scratch subarray를 재생성한다. 외부 변수에 view를 장기 캐시하지 않는다.
- **근거/상태:** 모든 hot path와 `test/bench/url-classify.bench.mjs`에 같은 접근 패턴 필요. WASM 호출 후에도 buffer 변경을 확인해야 한다.

<a id="2026-05-30--static-mut-직접-참조--rust-2024-edition-lint-실패"></a>
## 2026-05-30 — `static mut` 참조 lint

- **원인:** `SCRATCH.0.as_ptr()` 같은 표현이 mutable static에 묵시적 shared reference를 만들어 Rust 2024의 제한과 충돌했다.
- **수정/규칙:** 참조를 만들지 않는 `addr_of!(SCRATCH)`로 raw 주소를 얻는다.
- **근거/상태:** `crates/zp-page-rt/src/lib.rs:46`; [Rust 2024 static-mut-references](https://doc.rust-lang.org/edition-guide/rust-2024/static-mut-references.html). warning 0·CI `-D warnings`는 당시 가드 권고.

<a id="2026-05-30--thread_local--const---비-const-constructor-충돌"></a>
## 2026-05-30 — TLS `const` 초기화 충돌

- **원인:** `thread_local!`의 `const { RefCell::new(UrlPool::new()) }` 내부 builder가 당시 non-const여서 컴파일 실패.
- **수정/규칙:** `const {}`를 제거하고 최초 접근 시 lazy 초기화. const 사용 여부는 전체 constructor chain과 해당 toolchain에 달려 있다.
- **상태:** 당시 수정 기록. 원문의 개별 `HashMap` API const 여부 설명을 현재 Rust 사양으로 일반화하지 않는다.

<a id="2026-05-30--no_std--extern-crate-alloc-만으로는-wasm32-빌드-안-됨"></a>
## 2026-05-30 — `no_std`에 allocator 누락

- **원인:** `extern crate alloc`은 타입만 제공하며 global allocator와 panic handler를 제공하지 않는다. 초기 PoC는 빌드 실패.
- **수정/규칙:** PoC는 `std`·기본 dlmalloc과 workspace `panic = "abort"` 경로로 전환하여 통과했다.
- **상태:** 직접 allocator·panic handler를 갖춘 `no_std` 재도입은 당시 크기 최적화 후보였고 검증된 구현이 아니다.

<a id="2026-05-30--headless-chrome-의-textencoderencodeinto-가-node-v8-대비-355-느림"></a>
## 2026-05-30 — Headless Chrome encoder 비용

- **원인/가설:** Chrome의 `encodeInto`가 Node보다 느렸다. Blink 경계·`page.evaluate` realm 비용은 추정이며, 타이머 정밀도만으로 큰 측정 차이를 설명하기 어렵다고 보았다.
- **규칙:** 절대 성능은 환경 의존적이다. 당시 handle/raw·batch/single 추세는 일치했으며 브라우저 추정에는 headless 결과를 참고했다.
- **근거/상태:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §2.1. 후속 encoder isolation은 속도 차이를 확인했지만 cross-thread/realm 메커니즘까지 입증한 것은 아니다.

<a id="2026-05-30--wasm-bindgen-출력과-raw-extern-c-cdylib-공존-시-dead-strip-위험"></a>
## 2026-05-30 — wasm-bindgen/raw cdylib 혼용 위험

- **예상 원인:** 같은 cdylib의 raw export가 wasm-bindgen 후처리에서 제거되거나 start/init 순서가 어긋날 가능성을 우려했다. 실제 재현된 장애는 아니다.
- **회피:** `zp-page-rt`는 별도 raw cdylib, 직접 `WebAssembly.instantiate()` 사용. `zp-bundle`은 wasm-bindgen 유지.
- **근거/상태:** `build.mjs`가 `zp_bundle*.wasm`·`.js`와 copy-only `zp_page_rt.wasm`을 분리 처리한 PoC 설계.

<a id="2026-05-30--classifybatch-single-pass--ascii-fast-path--result-no-copy--lens-manual-write"></a>
## 2026-05-30 — classifyBatch layout·할당·결과 수명

- **원인:** bytes 뒤의 out 위치가 4-byte 정렬을 깨뜨려 `Uint32Array` 생성 실패. per-string 임시 버퍼·별도 copy·lens/result 할당도 비용이었다.
- **수정/규칙:** `[lens 4N][out 4N][bytes]`로 배치하고 Rust scratch 정렬을 활용했다. single-pass/ASCII 경로, grow-on-demand lens cache, little-endian 수동 쓰기 적용. raw 결과 view는 **다음 WASM 호출 전에 소비**해야 한다.
- **근거/상태:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.7. 당시 production batch는 schemeOnly 반복보다 느렸고, batch 가치는 intern/handle 발급에 있었다. MO batch 재평가는 후속 schemeOnly 경로 기록이 우선한다.

<a id="2026-05-30--textencoderencodeinto-가-chrome-에서-charcodeat-루프-대비-237-느림-blink-cross-realm-cost--ascii-fast-path-production-적용"></a>
## 2026-05-30 — ASCII encoder fast path

- **원인:** 당시 isolation 측정에서 Chrome은 수동 `charCodeAt` 루프가 native encoder보다 빨랐고 Node는 반대였다. 이는 encoder 선택의 환경 의존성을 확인한 결과다.
- **수정/규칙:** [web/zp-rt.js](../../web/zp-rt.js)의 `writeScratch`·`classifySchemeOnly`에 ASCII 복사를 적용하고 첫 non-ASCII에서 `encodeInto`로 fallback. URL 전체를 ASCII라고 단정하지 않는다.
- **근거/상태:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.6; bench-core `encodeManual`/`encodeAsciiFast`, `url-classify.bench.mjs`·`.browser.mjs`. 당시 두 환경에서 개선·regex 대비 우위 관찰. Firefox/Safari는 미검증이었다.

<a id="2026-05-30--runtime-prelude-통합-패턴-recipe-213--함정-catalog"></a>
## 2026-05-30 — runtime-prelude 통합

- **원인/수정:** 비동기 RT load 전·실패 시 `rt=null` JS fallback. MO cache는 `finally`로 제거하고 HTTP/WS는 canonical URL이 필요하므로 enum만으로 positive cache를 만들지 않는다.
- **불변식:** `urlMeta: el→target string` 계약을 유지하고 raw→target cache는 별도 `urlClassifyCache`로 둔다. `build.mjs`는 `zp-rt.js`를 prelude 앞에 넣어야 하며, [Go whitelist](../../cmd/zeroproxy-server/main.go#L120)에 `/__zp/zp_page_rt.wasm`이 없으면 정책 차단 뒤 silent fallback한다.
- **역사적 구현:** [web/runtime-prelude.js](../../web/runtime-prelude.js)에서 `targetURLIfHTTP` 단일 parse, MO non-HTTP pre-classify, `targetURLForElement` 재사용을 적용했다. 초기 batch guard는 records≥8·candidates≥4였으나 후속 schemeOnly 기록이 우선한다.
- **검증:** [static-policy](../../test/js/static-policy.test.js) 13/14, 실패 #4는 기존 document.write assertion 회귀로 기록; [workspace tests](../../Cargo.toml) 63 통과, dist 빌드 통과. 당시 taskweaver 실사이트 검증은 미수행이고 성능 효과 일부는 이론값이었다.
- **참조:** [.ai/zp-page-rt-design.md](../zp-page-rt-design.md), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md), [.ai/zp-page-rt-applicability.md](../zp-page-rt-applicability.md).

<a id="2026-05-30--scheme-only-fast-path-길이-평탄성-달성-다만-짧은-url-에서-절감-없음"></a>
## 2026-05-30 — Scheme-only 길이 비용 제한

- **원인/수정:** 전체 문자열 encoding의 길이 비례 비용을 피하려고 첫 16-byte probe만 `url_classify_scheme_only`에 전달했다. Rust 측 빈 입력·과도한 길이 검사도 포함.
- **관찰/정정:** 초기 측정은 긴 URL의 비용 평탄화를 확인했지만 Chrome 짧은 URL에서는 절감이 없었다. “약 29B가 16B를 넘지 않는다”는 원문 설명은 수치상 맞지 않으며, 이후 ASCII 최적화 결과가 초기의 “짧은 URL에는 가치 없음” 일반화를 대체한다.
- **근거/상태:** `crates/zp-page-rt/src/lib.rs`, `web/zp-rt.js`; [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.5. 당시 Chrome startsWith가 regex보다 빨랐다. `about:srcdoc` truncation parity·평탄성 측정은 당시 가드 기록.

<a id="2026-05-30--js-regex-가-raw-string-wasm-보다-빠른-게-일반적"></a>
## 2026-05-30 — Raw-string WASM 우위 가설 기각

- **원인:** 단순 regex는 V8 native JIT로 빠르지만 raw-string WASM에는 encoding·호출 경계 비용이 추가된다.
- **규칙/정정:** 초기 PoC는 JS helper의 기계적 1:1 치환을 지지하지 않았다. handle 재사용·batch amortization을 구분해야 하며, 후속 ASCII schemeOnly의 개선과 일회성 batch 열세가 초기의 “두 경로만 우위” 단정을 제한한다.
- **근거/상태:** [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) “누가 어디서 이기는가”. 당시 측정이지 WASM/JS의 보편적 순위가 아니다.

<a id="2026-05-30--mo-callback-의-tickurlcache-lifecycle-throw-safety-갭"></a>
## 2026-05-30 — MO cache throw-safety 공백

- **원인:** R+S에서 cache 생성·schemeOnly 루프가 main-loop `try/finally` 밖에 있어 trap 시 tick cache가 잔존했다. 당시 deterministic 매핑이라 기능 영향은 없다고 평가했으나 수명 불변식 위반이었다.
- **수정/규칙:** pre-classify부터 outer `try/finally`로 감싸고, URL별 inner catch로 WASM 실패를 JS main-loop 분류에 넘겼다. lifecycle scope와 cleanup scope를 일치시킨다.
- **근거/상태:** [web/runtime-prelude.js:2415-2435](../../web/runtime-prelude.js#L2415-L2435), [.ai/zp-page-rt-bench-report.md](../zp-page-rt-bench-report.md) §3.7. 당시 P+Q+R+S의 NAVER/Wikipedia/GitHub 회귀 없음은 제한된 관찰이며 다른 미해결 건의 해결 증거가 아니다.

<a id="2026-05-30--classifyschemeonly-같은-internal-sub-api-는-외부-sanity-script-에서-접근-불가"></a>
## 2026-05-30 — Internal API sanity 접근 실패

- **원인:** `globalThis.ZeroProxyRT`에는 `load`·`UrlClass`만 있고 `classifySchemeOnly`는 load 결과 인스턴스에만 있다.
- **규칙:** sanity script가 `load()` 결과를 보관하거나 MO 등 production 경로로 검증한다. 외부 SCRATCH 임의 접근을 막는 캡슐화를 우회하지 않는다.
- **근거/상태:** [web/zp-rt.js](../../web/zp-rt.js)의 export 표면; 전역에서 undefined였던 것은 의도된 API 경계다.

<a id="2026-05-30--hook-chain-의-helper-함수가-같은-derived-값-localkey-tag-을-n회-재계산"></a>
## 2026-05-30 — Hook helper 파생값 중복

- **원인:** attribute hook chain에서 `attrLocalName`, native `localName` getter, `usesRawURLAttribute`를 같은 인자로 반복 계산했다. 분류보다 element-specific 로직이 지배적이었다.
- **수정/규칙:** setAttribute/NS/getAttribute/removeAttribute에서 localKey·tag·usesRaw를 한 번 계산해 optional helper 인자로 전달했다. 빈 localKey가 유효하므로 truthy 대신 `!= null` 사용.
- **근거/상태:** [web/runtime-prelude.js:1448, 1962-2003, 2029-2057, 2284](../../web/runtime-prelude.js), [벤치 §3.9](../zp-page-rt-bench-report.md#39-t-라운드--element-specific-로직-path-단축-setattribute-hook-chain-의-attrlocalname--localname-중복-제거). 당시 NAVER taskweaver에서 개선 관찰; 나머지 hook 확산은 당시 후보였다.

<a id="2026-05-30--mo-record-path-enforceobservedattribute-의-usesrawurlattribute-3회-중복-호출"></a>
## 2026-05-30 — MO record helper 중복

- **원인:** 앞선 hook 수정 밖의 `enforceObservedAttribute`는 `usesRawURLAttribute`를 세 번 호출했고 `isSVGURLBearing`도 localKey를 재계산했다.
- **수정/규칙:** usesRaw boolean을 캐시하고 localKey·tag를 helper chain에 전달했다.
- **근거/상태:** [web/runtime-prelude.js:2454-2496, 2284](../../web/runtime-prelude.js), [벤치 §3.10](../zp-page-rt-bench-report.md#310-t2-라운드--mo-record-path-enforceobservedattribute-확산--issvgurlbearing-시그니처-확장). 당시 NAVER 추가 개선 관찰. 후속 audit의 setScriptSource/enforceLinkPolicy/prepareScriptElement/Attr.value/insertAdjacentHTML에는 같은 중복이 없었다.

<a id="2026-05-30--zp-htmltx-의-동일-helper-chain-중복-패턴-to_ascii_lowercase-per-attribute--lol_html-lowercase-invariant-의존"></a>
## 2026-05-30 — zp-htmltx 정규화 중복·lowercase 의존

- **원인:** URL scheme 검사마다 전체 lowercase 할당, element tag를 attribute마다 재계산했다.
- **수정/불변식:** [crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs)에 byte-prefix `starts_with_ascii_ci`·`is_inert_scheme`을 공통화하고 tag를 element당 한 번 읽었다. lol_html의 HTML 이름 정규화에 의존하므로 namespace·버전 변경 시 silent miss 위험이 있다.
- **검증/후속 정정:** 당시 tests 19/19·NAVER 회귀 없음, 서버 throughput 효과는 미정량. SVG/case 테스트 확대는 당시 권고였다. 당시 `xlink:href` 누락을 “정상”으로 본 평가는 **8월 정적 SVG 누락 발견으로 폐기**한다.
- **참조:** [벤치 §4](../zp-page-rt-bench-report.md#4-조사-zp-htmltx--handle-pipeline-평가).

<a id="2026-05-30--wasm-handle-pipeline-zp-htmltx--zp-page-rt-의-진정한-shared-memory-불가능--recipe-5-의-marginal-value-한계"></a>
## 2026-05-30 — SW→page handle 공유 평가

- **원인:** SW의 zp-htmltx와 page RT는 별도 instance/memory/pool이다. 동일 module도 이를 합치지 않으며 **다른 instance의 handle을 직접 사용하면 안 된다**.
- **평가/보안:** raw URL은 기존 `data-zp-target-url`로 전달 가능. SharedArrayBuffer의 COOP/COEP 요구는 당시 stealth 모델과 충돌하므로 이를 우회하는 공유 시도는 금지 대상으로 기록했다.
- **상태/한계:** hash dedup은 각 pool 안의 반복 intern을 줄일 뿐 cross-instance handle 호환성을 만들지 않는다. boot intern pass는 당시 marginal, 분류의 production 비중도 작아 element-specific 최적화를 우선했다. 서버 throughput·boot E2E는 별도 평가 영역이었다.
- **참조:** [벤치 §4.2](../zp-page-rt-bench-report.md#42-wasm-handle-pipeline-평가--큰-설계-변경-roi-작음).

<a id="2026-05-30--server-side-criterion-bench-가-inline-script-oxc-parse-hot-path-가설을-거부--진짜-hot-path-는-subresource-processing"></a>
## 2026-05-30 — OXC hot-path 가설 기각

- **원인/반증:** criterion fixture에서 inline script 파싱보다 다수 URL-bearing element의 dispatch·rewrite가 throughput을 지배했다.
- **수정:** lazy attribute filter·streaming percent-encode·case-insensitive scheme 검사와 builder를 subresource 경로에 적용했다.
- **근거/상태:** [벤치 §4.4](../zp-page-rt-bench-report.md#44-v-라운드--server-side-throughput-criterion-bench--추가-hot-path-단축), [crates/zp-htmltx/benches/transform.rs](../../crates/zp-htmltx/benches/transform.rs). 당시 개선 측정이며 inline-heavy fixture에는 일반화 불가. CI bench·fixture 확대는 당시 제안.

<a id="2026-05-30--format-per-element--utf8_percent_encodeto_string-가-server-side-hot-path-의-진짜-cost-v-라운드"></a>
## 2026-05-30 — 서버 URL builder 임시 할당

- **원인:** 부족한 capacity, percent-encode의 중간 `.to_string()`, 반복 `format!()`·base lowercase가 per-element 비용을 누적시켰다.
- **수정:** [crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs)에서 보수적 capacity·encoder chunk 직접 push·`with_capacity + push_str`·ASCII CI prefix를 사용하고 query/fragment split을 단일 pass로 줄였다.
- **근거/상태:** [벤치 §4.4.3](../zp-page-rt-bench-report.md#443-applied-v-wins-3-additional)의 당시 criterion 개선. 원문의 split iterator “할당” 설명과 개별 변경 효과를 누적 benchmark만으로 확정하지 않는다.

<a id="2026-05-31--w-라운드-호환성-작업-후속-fast-path-cow-return--per-msg-event-fast-exit--adaptive-backoff-polling"></a>
## 2026-05-31 — 호환성 후속 Cow·message·polling 최적화

- **원인:** Location virtualization·HTML entity decode·SafeFrame resize·incumbent realm 수정 뒤, fast path의 owned 복사·불필요한 message helper·영구 고빈도 layout read가 남았다.
- **수정:** `decode_url_html_entities`는 `Cow::Borrowed/Owned`; message는 source 불변·non-proxy origin이면 helper 전 fast-exit; SafeFrame은 안정 시 adaptive backoff, 변화 시 reset하며 image-load hook 유지.
- **근거/상태:** [벤치 §5](../zp-page-rt-bench-report.md#5-w-라운드-호환성-작업-2026-05-31-직후-추가-hot-path-단축). 당시 criterion 개선, cargo 20/20·static-policy 13/14 baseline·NAVER 회귀 없음. 새 compat helper의 hot-path audit가 교훈이며 모든 polling에 대한 현재 금지 사양은 아니다.

<a id="2026-08-20--매트릭스의-정적-칸을-채우자-파싱-시점-서브리소스-구멍-여섯-개가-한꺼번에-나왔다"></a>
## 2026-08-20 — 정적 서브리소스 누락·fragment 손실

- **원인:** htmltx의 속성 필터와 `(tag, attr)` 목록이 각각 누락되어 input image src, video poster, SVG image href/xlink:href, legacy image src, background가 미처리였다. 토크나이저 `image`와 DOM 파서 `img`도 달랐다.
- **수정/보안:** 두 목록에 해당 표면·use href·body/table/td/th/tr background를 함께 추가. CSP는 2선이며 리라이트 누락을 방치하거나 CSP 완화로 덮으면 안 된다.
- **별도 버그:** `s.svg#icon` 전체를 query에 인코딩하면 SVG fragment 선택이 사라졌다. `proxied_subresource_url`에서 fragment를 떼어 프록시 URL 바깥에 붙여 요청 경로는 유지했다.
- **근거/상태:** `a10-static-iframe` 후 소스 목록 대조→Rust transform probe→`a11`~`a20` 브라우저 확인. 최초 csp-only 평가는 추론이었고 다음 항목의 되돌림 측정이 이를 확인했다.

<a id="2026-08-20--추론을-실측으로-확인하러-갔더니-틀린-건-추론이-아니라-측정-도구였다"></a>
## 2026-08-20 — 누출 판정 도구의 거짓 양성·과소보고 위험

- **원인:** runner가 CSP 차단 request도 직접 유출로 세고, 후속 프록시 fetch의 타깃 도착을 곱해 거짓 LEAK를 만들었다.
- **수정/검증:** `--output` JSON의 `kind`·`request_id`로 직접 요청 결과를 상관시켰다. 되돌린 수정 전 상태는 `a11`~`a16`·`a20`의 csp-only 7건, 진짜 유출 0건으로 확인되어 앞선 LEAK 판정을 기각했다.
- **후속 안전장치:** response=유출, failed-only=csp-only, **결말 없음=판정불가**. 여러 시도 중 응답 하나라도 유출이며 프록시 요청은 직접 요청이 아니다. `dropped.network>0`이면 격리 판정을 신뢰하지 않도록 경고한다.
- **근거/상태:** `classify.cjs`로 로직을 분리해 합성 테이프 테스트. 당시 실행은 network 유실 0. 과거 `csp_bypassed` 미확인·압축 curl 출력 사고와 함께, 신호 결합과 원자료 검토의 필요성을 기록했다.

<a id="2026-08-20--인벤토리를-넓히다-진짜-탈출을-찾았다"></a>
## 2026-08-20 — Meta refresh 최상위 탈출

- **원인:** `<meta http-equiv=refresh>`가 원본으로 최상위 이동했다. 당시 CSP의 `form-action`은 이를 막지 않고 `navigate-to` 방어도 없었다. 서브리소스 도착 축만으로는 탐지할 수 없었다.
- **수정/보안:** `proxied_meta_refresh`가 content의 `url=`만 앵커/폼과 같은 `?via=` 경로로 옮겼다. 이 표면에서는 리라이트가 유일한 방어이며 직접 이동은 IP 노출 위험이다.
- **검증/공백:** fixture에서 수정 전 프록시 이탈·타깃 도착, 수정 후 프록시 잔류·직접 요청 0 확인. 같은 라운드의 feImage href/xlink:href·`image-set()` bare string은 csp-only 누락. importmap·object:codebase는 당시 known-gap/deliberate로 남겼다.

<a id="2026-08-20--프레임-축을-세우니-같은-규칙의-세-번째-구현이-갈라져-있었다"></a>
## 2026-08-20 — 프레임 meta refresh의 세 번째 구현

- **원인:** 같은 정책이 Rust htmltx, SW `proxiedRefreshValue` 응답 헤더, prelude `transformHTML`에 따로 있었다. Rust 수정만으로 srcdoc의 `f10-frame-meta-refresh`는 고쳐지지 않아 `frame-src 'self'`에 막혔다.
- **수정/규칙:** 헤더·페이지 realm 경로를 각각 따로 다뤘다는 후속 기록. “meta refresh 수정”은 전체가 아니라 경로별로 판정해야 하며 격리와 착지 재현성을 함께 검사한다.
- **검증:** 대조군에서도 `_blank`·`window.open` 착지 실패가 나와 사용자 제스처 없는 Chrome 팝업 차단으로 구분했다. 구현 통합·갈림 가드는 당시 방향이며 모든 경로 완료를 단일 결과로 증명하지 않는다.

<a id="2026-08-21--구현이-두-벌이면-표도-두-벌이어야-한다"></a>
## 2026-08-21 — Rust/페이지 realm 짝 매트릭스

- **원인:** srcdoc용 `g*`에서 background, case-preserving SVG feImage, 별도 CSS scanner의 `image-set` bare string 누락이 csp-only로 드러났다.
- **수정/규칙:** 정적 `a*`와 realm `g*`를 짝지어 인벤토리·CSS 형태(`image-set`/`@import`) 가드로 묶었다. DOM의 legacy image→img 변환처럼 정당한 차이는 이유를 기록하며 목록의 문자적 동일성을 요구하지 않는다.
- **검증:** 예측한 세 누락이 실측과 일치했고 background 제거 변이가 정확한 가드 실패를 냈다. htmltx/prelude·zp-css/rewriteCSSText·Go/SW처럼 중복 정책은 경로별 검증이 필요했다.

<a id="2026-08-21--objectdata-정정-그리고-지표가-틀려서-두-번-오해한-이야기"></a>
## 2026-08-21 — `object[data]` 정정·렌더 지표 오판

- **정정/보안:** `object-src 'none'`의 **로드 금지**와 DOM 원본 URL 제거는 별개다. `object:data` deliberate/unrewritten 판단을 정정하여 htmltx도 리라이트했다. `a23-static-object-cross`가 기존 csp-only 누락을 드러냈다.
- **측정 오류:** `plugin_surface_stays_unrewritten_by_design`의 호스트 substring은 encoded query에도 남아 공허하게 통과했다. 원본 속성 형태를 검사해야 한다. `complete && naturalWidth===0`도 URL 없는 placeholder를 세므로 과거 “broken 0”와 새 오류 수치 모두 신뢰할 수 없었다.
- **실제 원인/미해결:** initiator는 `/zp/api/sync-fetch` 문서였다. SW-less 프레임이 릴레이 CSS의 `url()`을 SW 전용 `/zp/api/fetch`로 호출하여 Go 403 발생. **src/srcset 가설은 기각**했으며 CSS 텍스트에는 기존 element blob 업그레이드가 닿지 않아 당시 미해결로 남았고, 이후 [SW-less CSS 수정](sw-integration.md#2026-08-21--해결-릴레이로-받은-css-안의-url-이-sw-less-문서에서-403)으로 이어졌다.

<a id="2026-08-21--목록을-없애는-리팩터는-그-목록을-재던-표가-있을-때만-안전하다"></a>
## 2026-08-21 — URL 표면 단일 소스 리팩터 회귀

- **변경/공백:** `crates/zp-shared/testdata/url_surfaces.json`을 빌드 주입 단일 소스로 삼고 Rust transform 테스트로 묶었다. 통합 audit에서 iframe:src/frame:src/iframe:srcdoc는 문서 생성 `special`, SVG script:href는 htmltx `known-gap`으로 새로 드러났다.
- **회귀:** 평평한 소문자 key 집합이 SVG `localName=feImage`와 어긋나 `g5-realm-feimage`가 csp-only로 떨어졌다. 중복 제거 전부터 존재한 짝 매트릭스가 회귀를 잡았다.
- **가드/검증:** 손목록 부활·치환 자리 제거를 막고 dist table과 fixture를 대조한다. deliberate는 제외, 나머지는 포함해야 했다. 실제 리빌드 전 실패로 낡은 dist 탐지를 확인했다.

<a id="2026-08-22--rt-wasm-이-타깃-서버로-나갔다-프록시-로드-1회에-9번"></a>
## 2026-08-22 — RT WASM 요청의 타깃 서버 노출

- **원인:** srcdoc/blob의 가상 base가 루트 상대 `/__zp/zp_page_rt.wasm?v=…`를 타깃으로 보냈다. 절대 프록시 URL로 고쳐도 부모가 먼저 계측한 realm의 `Native.fetch`는 이미 래퍼여서 다시 타깃으로 매핑했다.
- **수정/보안:** URL을 `proxyOrigin + '/__zp/…'`로 만들고, 시작 시 `typeof root.__zp_get === 'function'`인 선계측 realm에서는 RT 부팅 자체를 생략했다. 가속보다 프록시 존재·빌드 ID 비노출을 우선하며 JS fallback을 택했다.
- **근거/상태:** fixture 서버의 RT 요청 9건과 prelude 전 선계측된 프레임 9개가 일치하여 원인을 확인했다. `/img/<id>`만 세는 기존 매트릭스는 이 노출을 놓쳤다. 수정 후 별도 재측정 결과는 원문에 없으며, `captureNative`가 진짜 native를 잡았다고 가정해서는 안 된다.
