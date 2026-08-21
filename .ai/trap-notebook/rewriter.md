# Rewriter Regressions

`crates/zp-rewriter` (OXC AST 변환) 와 `crates/zp-htmltx` (HTML 토크나이저 + URL 리라이트).

---

## 2026-08-21 — `?url=` 빌더가 넷이었다: 프래그먼트를 삼키면 `<use href="sprite.svg#i">` 가 빈 채로 렌더된다

**계획 8번.** 빌더가 넷이고 셋의 출력이 달랐다:

| | 프래그먼트 | `&tab=` | 인코딩 |
|---|---|---|---|
| `zp-htmltx` | 파라미터 **밖**에 보존 | 없음 | `NON_ALPHANUMERIC - -._~` |
| `zp-css` | 파라미터 **안**으로 삼킴 | 없음 | `form_urlencoded` (공백 → `+`) |
| 프렐류드 | 파라미터 **안**으로 삼킴 | 붙임 | `encodeURIComponent` |
| 프렐류드(fetch 라벨) | — | 없음 | `encodeURIComponent` |

**브라우저에서 직접 쟀다 — 프래그먼트가 진짜 결함이다.** 같은 스프라이트를 두 형태로
꽂고 `getBBox().width` 를 봤다:

```
?url=…%2Fs.svg&tab=…#i     → bbox 4   (심볼 해석됨)
?url=…%2Fs.svg%23i         → bbox 0   (빈 채로 렌더)
```

`#` 가 `%23` 이 되면 브라우저가 조각을 못 고른다. 외부 SVG 스프라이트를 참조하는
`<use>` 와 CSS `url(sprite.svg#id)` 가 통째로 사라진다. htmltx 만 맞고 나머지가 틀렸다.

인코딩 차이(`!'()*`, 공백 `+` vs `%20`)는 **관측되지 않았다** — SW 가 `URLSearchParams`
로 읽어 둘 다 풀린다. 그래도 통일했다: 다르면 같은 리소스에 캐시 키가 둘 생기고,
다음 소비자가 `decodeURIComponent` 를 쓰는 순간 `+` 가 공백이 안 된다.

**Fix**: `crates/zp-shared/src/proxyurl.rs` 단일 빌더 → htmltx·zp-css 가 호출.
JS 는 같은 규칙으로 다시 쓰고(`encodeURLParam` + 프래그먼트 분리),
픽스처 `proxy_url_cases.json` 11케이스가 **바이트 단위 파리티**를 잡는다(양쪽 변이 확인).

**★부수 발견 1 — `<use>` 칸이 처음부터 판정불가였다.** 구멍 매트릭스의
`a20-static-use` / `g7-realm-use` 는 **대조군에서도** 아무 요청이 안 나갔다. 이유 둘:
(a) 크롬은 **cross-origin 외부 `<use>` 를 아예 거부**한다, (b) 픽스처 서버가 `.svg` 를
PNG 로 내주고 있었다. 즉 이 두 칸은 오래 `-` 로 앉아 있었고 아무것도 재지 않았다.
same-origin + 진짜 SVG 스프라이트로 바꿔 이제 둘 다 측정된다(63칸, 판정불가 0).

**★부수 발견 2 — 내비게이션 매트릭스의 대조군이 통째로 죽어 있었다.**
23칸 **전부** 대조군 `-` 였다. 손으로 재현해 보니 같은 케이스도 정상 착지한다.
원인은 러너의 경합이다: 앞 케이스의 프록시 단계 내비게이션이 아직 진행 중인데
`/reset` 후 바로 대조군을 열어서, 히트 로그에 **앞 케이스의 id** 가 찍혔다.
그러면 지금 id 를 찾는 검사는 항상 빗나가고, `stuck`(대조군은 되는데 프록시는
안 되는 것)이 **구조적으로 빌 수밖에 없다** — 재현성 축이 통째로 무의미했다.
`about:blank` 로 비우고 열도록 고쳤다. 지금은 23칸 중 18칸 대조군 `O`, 탈출 0,
재현성 결함 0 — **비어서 0** 이 아니라 **재서 0** 이다.

> 이번 통합 작업에서 나온 **세 번째 계측 결함**이다(구멍 매트릭스 러너의
> LEAK 오분류 → 판정불가 버킷 → 여기). 규칙: **0 을 보면 먼저 "이 0 이 나올 수
> 있는 경로가 있는가" 를 묻는다.** 대조군이 전부 `-` 인 표는 통과가 아니라 고장이다.

**측정**: 63칸 진짜 유출 0 / csp-only 0 / 판정불가 0, nav 23칸 탈출 0 / 재현성 0,
static-policy 123, cargo 전체, `go test ./...`, naver·wikipedia·github raw=0 csp=0 err=0.

## 2026-08-21 — `resolve_against_base` 가 `..`/`.` 를 안 접었다 — 그런데 감사 보고의 심각도는 과장돼 있었다

**계획 6번. "착수 전에 브라우저로 재현부터" 가 이번엔 반대 방향으로 작동했다 — 결함을 줄여 잡았다.**

감사는 이걸 "가장 날카로운 차이"로 꼽았다(404 가능성, 캐시 키 깨짐). `htmltx` 의
`resolve_against_base` 는 손으로 쓴 문자열 결합이라 dot-segment 를 정규화하지 않고,
나머지 리졸버 넷은 `new URL()` / `url::Url::join` 이라 정규화한다 — 즉 **구현 다섯 중 하나만
다르다** 는 것까지는 사실이었다.

**재 보니 404 는 안 났다.** 대조군/프록시 양쪽으로 `/deep/nest/page` (안에
`<img src="../../img/a24…png">`) 를 띄우고 타깃이 받은 경로를 봤더니 **둘 다 정규화된
`/img/a24…png`** 였다. SW 의 `canonicalTargetURL` 이 나가기 전에 다시 정규화하기 때문이다.

관측되는 차이는 `?url=` 파라미터 **문자열 하나**였다:

```
서버가 만든 것      : …%2Fdeep%2Fnest%2F..%2F..%2Fimg%2Fa24…png
페이지 realm 계산값 : …%2Fimg%2Fa24…png
```

**격리 문제가 아니라 일관성 문제**다 — 같은 리소스에 키가 둘 생겨 `alreadyMapped` 단축과
컨텍스트 키가 어긋난다. 고칠 값은 있지만 **감사가 적어 둔 심각도는 아니었다.**

**Fix**: RFC 3986 §5.2.4 `normalize_dot_segments` 를 `resolve_against_base` 의 경로 생성
두 자리에 넣었다. 쿼리/프래그먼트 꼬리는 보존한다(쿼리 안의 `../` 는 경로가 아니다).
단위 테스트 6케이스.

**★기존 테스트가 정규화 안 된 동작을 고정하고 있었다.**
`relative_subresource_resolved_against_target` 이 `example.com%2F.%2Fb.js` 를 기대하고 있었다.
즉 **버그를 정답으로 박제**한 가드다. 이 통합 작업에서 같은 형태를 세 번 봤다
(여기 / `usesRaw ? proxyViaURL(t) : t` / srcset 의 `split(',')` 단언).

**교훈 둘**
1. **감사에서 유도한 심각도는 측정 전까지 가설이다.** 코드에서 "정규화를 안 한다" 는 사실이
   맞아도, 그 아래 층이 이미 정규화하고 있으면 영향은 전혀 다른 곳에 남는다.
   고치되 **무엇이 실제로 관측됐는지로** 기록한다.
2. 기대값을 "현재 출력"으로 채운 테스트는 다음 사람에게 **의도로 읽힌다.**

**측정**: cargo 전체, static-policy 통과, 매트릭스 무회귀, 고친 뒤 브라우저에서 `?url=` 가
페이지 realm 값과 바이트 일치 확인.

**미해결(간헐)**: 이 작업 도중 wikipedia 에서 `err=6` 이 한 번 나왔고 이후 4회 연속 깨끗했다.
재현 안 됨. 예전부터 남아 있는 "wikipedia l10n 404, 재현 안 됨" 과 같은 것일 수 있다.

## 2026-08-21 — srcset 후보 분해기가 넷이었고, 셋이 `split(',')` 이었다 + 요소 훅 두 경로에 srcset 분기가 아예 없었다

**계획 7번. "착수 전에 브라우저로 재현부터" 가 예측보다 큰 것을 꺼냈다.**

계획은 "`data:` 후보가 쉼표 분할에 깨진다" 하나만 예상했다. 실제로 재 보니 **넷**이었다.
프록시된 페이지에서 세 경로로 srcset 을 넣고, 멤브레인이 없는 **isolated world** 에서
진짜 속성값을 읽었다(main world 의 `getAttribute` 는 가상값을 돌려주므로 여기서는 못 잰다).

| 경로 | 입력 `/img/one.png 1x, /img/two.png 2x` | 판정 |
|---|---|---|
| `setAttribute('srcset', …)` | `?url=…%2Fone.png%25201x%2C%2520%2Ftwo.png%25202x` | 목록 전체를 URL **하나**로 삼킴 → 후보 둘 다 사망 |
| `img.srcset = …` | `/img/one.png 1x, /img/two.png 2x` (그대로) | 리라이트 **통째로 건너뜀** → 원본 URL 이 DOM 에 남음(csp-only) |
| `innerHTML` / 스윕 | 후보마다 프록시 경로 | 유일하게 맞았음 |

거기에 `data:` 후보를 섞으면 마지막 하나까지 깨졌다:

```
입력 : data:image/svg+xml;utf8,<svg …></svg> 1x, /img/real.png 2x
결과 : data:image/svg+xml;utf8,http://…/zp/api/fetch?url=…%253Csvg xmlns=… 1x, …
```

`split(',')` 이 데이터 URL 을 반토막 내고, 뒷조각 `<svg` 가 **상대 URL 로 오인**돼
프록시 경로로 치환된 것이다.

**왜 이렇게 됐나 — 주석이 틀린 전제를 들고 있었다.** 세 사본 위에 이렇게 적혀 있었다:

> 프록시 URL 은 타깃을 퍼센트 인코딩해 담으므로 쉼표가 들어가지 않아 `split(',')` 이 안전하다.

전제가 반쪽이다. **아직 리라이트 안 된** 입력에는 쉼표가 있다. 셋 다 같은 주석을
달고 같은 방식으로 틀렸다 — 사본이 늘 때 근거까지 같이 복사된 것이다.

**Fix**
- `split_srcset_candidates`(Rust, 기존 스캐너를 함수로 추출) / `splitSrcsetCandidates`(JS, 신규) 한 벌씩.
  `lead + url + tail` 을 이어 붙이면 입력이 **바이트 단위로 복원**된다 — 그래야 디스크립터를 안 건드린다.
- JS 사본 3벌(`enforceSrcsetAttribute` / `upgradeSWLessSrcset` / `applySWLessRelay`)이 전부 이걸 쓴다.
- `setAttribute` 훅에 srcset 분기 추가(스윕에만 있었다), `installSrcsetProp` 으로
  `img.srcset` / `source.srcset` / `link.imageSrcset` 프로퍼티 훅 추가.
- 게터용 저장소는 **(요소, 속성) 단위**로 따로 뒀다. `urlMeta` 는 요소당 값 하나라
  `src` 와 `srcset` 을 동시에 가진 img 에서 서로를 덮는다.
- 픽스처 `crates/zp-shared/testdata/srcset_cases.json` 13케이스 — Rust 테스트와
  `static-policy.test.js` 가 **같은 파일**을 읽는다. 양쪽 변이 확인(`is_data=false` → 양쪽 다 실패).
- 구멍 매트릭스 g9~g12 (setattr / prop / imageSrcset prop / data 이웃) 추가. 63칸.

**★가드가 버그를 얼려 두고 있었다 (오늘 두 번째, 이 통합 작업 전체로는 세 번째).**
`static-policy.test.js` 가 이렇게 단언하고 있었다:

```js
assert.ok(body.indexOf("String(raw).split(',')") >= 0, 'srcset 은 후보 단위로 쪼개야 한다');
```

**틀린 구현을 있어야 한다고 단언**하고 있었다. 메시지("후보 단위로 쪼개야 한다")는 옳은데
검사식이 그 의도를 재지 않고 **당시 소스 문자열**을 박제했다. 같은 파일에 한 줄 더 있었다
(`indexOf(ZP.apiPath('fetch')) >= 0) return part`). 둘 다 의도 수준으로 고쳤다.

교훈은 6번(`relative_subresource_resolved_against_target` 이 정규화 안 된 출력을 고정)과 같다:
**소스 문자열을 그대로 단언하는 가드는 검증이 아니라 박제다.** 무엇을 재는지 한 번 더 묻는다.

**측정**: 63칸 진짜 유출 0 / csp-only 0 / 의도적 7, nav 23칸 무회귀, static 122,
cargo 전체, `go test ./...`, naver·wikipedia·github raw=0 csp=0 err=0.

## 2026-07-30 — shorthand 객체 프로퍼티가 keyless 로 붕괴 → 파일 전체 SyntaxError

**Symptoms**:
- NAVER 검색 결과 페이지 콘솔: `Uncaught SyntaxError: Unexpected string @ /zp/api/script?kind=classic&u=https://ntm.pstatic.net/scripts/ntm_*.js`
- 해당 파일(190KB) **전체가 실행 실패** → 그 안의 무관한 심볼 전부 소실.

**Root cause**:
`{ window, document, navigator }` 같은 **shorthand** 프로퍼티는 식별자 **하나가 key 와 value 를 동시에** 담당한다. `visit_identifier_reference` 가 그 span 을 일반 참조로 보고 `__zp_get(globalThis,"window")` 로 치환하니
`{__zp_get(globalThis,"window"),__zp_get(globalThis,"document"),navigator}`
가 되어 **key 없는 프로퍼티** = 파싱 불가. 실제 코드는 `this.dom = { window, document, navigator }`.

**Fix**: [zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs) 에 `visit_object_property` 추가 — `prop.shorthand && value 가 dangerous global` 이면 `SHORTHAND_GLOBAL_GET` 마커를 emit 하고 **value 로 내려가지 않는다**(안 그러면 같은 span 에 깨진 일반 패치가 다시 붙는다). `apply_patches` 가 `window:__zp_get(globalThis,"window")` 로 확장.

**Verification**: ntm_ec8638b0efc1.js / ntm_d2d2463c73f0.js 리라이트 결과가 V8 파싱 통과(이전 `Unexpected string`). NAVER 검색 SyntaxError 0. Wikipedia 무회귀. zp-rewriter 74, zp-htmltx 31, JS 71.

**인접 케이스 전수 확인** (모두 유효 JS 확인): shadowed shorthand 는 미변환 유지, method/getter `window(){}` 는 key 라 미변환, computed key `[window]` 는 변환 유지, explicit `window: window` / spread `...window` / class field / arrow-returned object literal 정상.

**미해결 (별개, 이전부터 존재)**: shorthand **assignment target** `({ location } = obj)` 는 여전히 `({ __zp_get(...) } = obj)` 로 깨진 JS 를 낸다 (`AssignmentTargetPropertyIdentifier` — 다른 AST 노드). 안 고친 이유: 유효한 문법으로 만들려면 (a) 미변환으로 두어 실제 전역 `location` 에 직접 write = **감옥 구멍**, (b) 멤브레인 `scope` Proxy 를 전역 노출 = 새 공격면(E1 escape matrix 교차검증 필요), (c) assignment 전체를 `__zp_set` + temp 로 재작성 = 평가순서/다중 프로퍼티 처리 필요. `window.location` 은 LegacyUnforgeable 이라 프로퍼티 재정의로는 못 막으므로 (a) 는 불가. 설계 결정 사안이라 별도 트랙.

**Patterns to watch**:
- **key 와 value 가 같은 span 을 공유하는 문법은 span 치환 리라이터의 구조적 함정.** shorthand 프로퍼티가 대표. 새 노드 종류를 다룰 때 "이 식별자가 다른 문법적 역할도 겸하는가"를 먼저 확인.
- **JS 한 파일의 SyntaxError 는 그 파일 전체를 죽인다** — 증상이 "무관한 심볼이 없다"로 나타나 원인 파일을 못 찾기 쉽다. 콘솔의 SyntaxError 는 최우선으로 볼 것.
- **리라이터 출력은 반드시 파서에 다시 통과시켜 검증.** 출력을 우리 oxc 파서에 재입력하면 span 까지 나와 위치 특정이 즉시 된다 (이번에 `spans=[(185067,8)]` 로 바로 찾음).
- **`npm run build:web` 은 wasm 을 재빌드하지 않는다** — Rust 리라이터를 고친 뒤 web-only 빌드로 검증하면 예전 wasm 이 돌아 "고쳐지지 않았다"고 오판한다. cargo 변경 시 반드시 `npm run build`(서버 exe 잠금 때문에 서버 중지 필요).

## 2026-06-07 — split-bundle (c.1) Step 2.1 shadow-compare 가 발견한 modern rewriter 의 두 가지 회귀 — patch-mode marker resolution 누락 + `Function` global 미보호

**Site/Pattern**: shadow-compare 모드 ([web/sw.js](../../web/sw.js) `shadowCompareRewriters`) 로 NAVER + Wikipedia 의 SW-rewritten 스크립트 outputs (legacy ZPRewriter vs modern ZPBundle) 를 비교. Wikipedia 전체 스크립트는 0 divergence (modern 도 OK). NAVER 의 두 스크립트가 divergence 노출.

**Finding 1 — patch-mode marker resolution 누락 (FATAL, patches API 가 그대로 못 씀)**:
- Source: `https://ssl.pstatic.net/tveta/libs/ndpsdk/prod/ndp-loader.js` (1170 byte upstream JS)
- Legacy output (1354 byte): `__zp_get(globalThis,"window").ndpsdk=...`
- Modern output (1274 byte): `GLOBAL_GETwindow.ndpsdk=GLOBAL_GETw...`
- 원인: [crates/zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs) 의 `rewrite_script_patches` 가 반환하는 patch envelope 안의 `replacement` 필드는 raw marker 문자열 (`\u{1}GLOBAL_GET\u{1}<name>\u{1}`, `\u{1}MEMBER_GET\u{1}<obj_start>\u{1}<obj_end>\u{1}<prop>\u{1}`, `\u{1}METHOD_CALL\u{1}...`). Rust 의 `apply_patches` (lib.rs line 307) 가 이 marker 들을 해석해서 `__zp_get(globalThis,"window")` / `__zp_get(window, "navigator")` 등 최종 코드로 변환. 그러나 SW 의 `applyScriptPatches` ([web/sw.js](../../web/sw.js)) 는 단순 splicer — marker 인식 못 하고 그대로 source 에 splice → 실행 시 SyntaxError.
- 함의: SW 의 patch-mode fallback 경로 (`rewriteScriptPatches` → `applyScriptPatches`) 가 marker 가 나오는 모든 script (실제로 거의 모든 real-world JS) 에 대해 invalid JS 를 생성. 지금까지는 legacy ZPRewriter 가 primary 라 fallback 이 거의 호출 안 되어 silent 였음. Step 2.2 swap 전에 **필수 fix**: (a) `rewrite_script_patches` 가 marker 가 이미 resolve 된 final replacement strings 만 반환하도록 수정, (b) 혹은 patches API 를 deprecate 하고 `rewriteScript` (full re-emit) 만 사용. 옵션 (a) 가 patch-mode 의 성능 이득 (~MB 의 wbg string-copy 회피) 을 유지하지만 Rust 측 작업 필요.

**Finding 2 — `Function` global 누락 (SEMANTIC GAP, eval-equivalent escape vector)**:
- Source: `https://ssl.pstatic.net/sstatic/fe/sfe/cross-domain-storage/cross-domain-storage-remote-3.0.0.js` (39923 byte)
- Legacy output (40899 byte): `...i=__zp_get(globalThis,"Function").prototype;...`
- Modern output (40235 byte): `...i=Function.prototype;...`
- 원인: [crates/zp-rewriter/src/lib.rs:86](../../crates/zp-rewriter/src/lib.rs#L86) 의 `DANGEROUS_GLOBALS` 에 `Function` 없음. legacy rewriter-rs ([rewriter-rs/src/lib.rs](../../rewriter-rs/src/lib.rs)) 는 `Function` 포함.
- 함의: target site 가 `Function.prototype.constructor` 으로 `Function` constructor 에 접근하면 `new Function('return globalThis')()` 같은 escape 가능. membrane 의 `__zp_get` 우회. PHASE2 strict mode "탈출 없는 감옥" 위반. modern 의 `DANGEROUS_GLOBALS` 에 `Function` (그리고 sibling check: `eval`?) 추가 필요.

**Step 2.1 결과**:
- shadow-compare 인프라 자체는 작동 ([web/sw.js shadowCompareRewriters + recordShadowDivergence](../../web/sw.js)). 100 entry circular buffer + `/zp/api/__shadow_log` endpoint + microtask-deferred 로 hot path latency 0. divergence 형식에 `firstDiffIdx` + 60-byte around-the-diff 양쪽 excerpt + modernThrew branch 포함.
- 첫 시도 시 closure bug: `code` 가 let-binding 이라 microtask 시점에 pragma-append 후 값으로 비교 → false positive (legacy=source+pragma vs modern=source). 수정: `const legacyForShadow = code` 로 snapshot 캡쳐 후 closure 에 전달.
- 빌드 pipeline bug 발견: `npm run build -- --skip-rust` 가 `dist/web` 통째로 wipe 한 후 `dist/web/__zp/` (rust 산출물) 미복원 → 다음 SW 등록 시 wasm fetch 503. fix: `scripts/build.mjs` 의 `cleanSelectedOutputs` 가 rust skip 시 `__zp` subdir 만 보존 (rmWebPreserveZp helper).

**다음 단계 (Step 2.2 전 prerequisite)**:
1. zp-rewriter 의 `rewrite_script_patches` 가 marker-resolved final replacement strings 만 반환하도록 변경, OR JS 측 applyScriptPatches 에 marker resolver 포팅 (Rust 의 GLOBAL_GET/MEMBER_GET/MEMBER_SET/METHOD_CALL marker 형식 보고 결정).
2. zp-rewriter 의 `DANGEROUS_GLOBALS` 에 `Function` 추가 + 회귀 테스트.
3. shadow-compare 다시 돌려서 0 divergence 확인.
4. 그 다음에 Step 2.2 SW primary swap 시도.

---

## 2026-06-07 — split-bundle (c.1) Step 2a SW swap NAVER renderer wedge — `ZPRewriter.rewriteScript` legacy primary 경로를 `ZPBundle` (modern OXC 0.133) 으로 교체했을 때 NAVER 메인 hydration 단계에서 WebView2 renderer 완전 wedge. **Revert + Step 2 전략 재설계**

**Site/Pattern**: NAVER 메인 (`https://www.naver.com/`) cold load 시 검색 box 만 남고 메인 컨텐츠 (뉴스/쇼핑/광고/추천) 전체 사라짐. taskweaver `console-logs` → `Uncaught SyntaxError: Invalid or unexpected token @http://proxy.localhost:18080/zp/api/fetch?url=https%3A%2F%2Fssl.pstatic.net%2Ftveta%2Flibs%2Fndpsdk%2Fprod%2Fndp-loader.js:1`. SW 측 디버그 stash (`/zp/api/__debug_ndp` endpoint) 로 rewritten body 추출 → **3281 byte HTML 본문** (`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ...><html xmlns="..."><head><title>네이버 :: 페이지를 찾을 수 없습니다.`). 즉 upstream 이 JS 가 아닌 **404 HTML** 을 반환. taskweaver `pause` → renderer 완전 wedge (7 minidumps, empty js_stack, JS-thread 응답 없음). 같은 증상 패턴은 2026-06-06 iframe/frame src rewrite 시도 때와 동일.

**Root cause (가설)**:
1. ZPBundle (zp-rewriter 0.133, strict mode) 는 HTML body 에 대해 ParseFailed → JsError → JS catch → fail-closed block stub 을 emit 해야 정상. cargo `html_body_must_parse_error_under_strict_mode` 테스트로 확인됨.
2. 그러나 runtime trace 의 `__zp_debug_ndp_loader` 가 raw HTML 본문을 그대로 보유하고 있는 이상 동작 관찰. SW 가 어느 경로로든 HTML 을 `code` 로 emit 한 흔적 — 정확한 경로 미규명 (`debugTrace` 변수까지 도입했으나 browser SW lifecycle 의 stale activation 문제로 신규 trace 출력 미관찰).
3. 가장 유력한 가설: `await initBundle()` 을 primary path 에 추가하면서 첫 script 응답이 50-200ms 지연 → NAVER 의 anti-bot/CDN 이 timing pattern 으로 bot 판정 → ndp-loader 등 일부 subresource 에 대해 404 HTML 회신 → 이 HTML 이 fail-closed stub 으로 변환되지만 그 사이 ssl.pstatic.net 의 SafeFrame/광고 SDK orchestration timing 이 깨지고 main hydration 시점에 cross-realm postMessage 큐가 어긋나 WebView2 renderer 가 wedge.

**Step 2a 시도 변경 (revert 적용)**:
- [web/sw.js](../../web/sw.js): `initRewriter()` 제거 + `await initBundle()` 로 교체, `ZPRewriter.rewriteScript` primary 호출 제거 → `ZPBundle.rewriteScriptPatches` (patch 모드) → `ZPBundle.rewriteScript` (full re-emit) 로 단순화. **전체 revert 됨**.

**보존**: [crates/zp-rewriter/src/lib.rs](../../crates/zp-rewriter/src/lib.rs) 에 2개 회귀 테스트 추가 — `html_body_must_parse_error_under_strict_mode` (strict mode 의 HTML 거부 invariant), `naver_ndp_loader_round_trips_as_valid_js` (ndp-loader full re-emit + patch-mode 동등성 + 두 path 의 OXC re-parse valid). [crates/zp-rewriter/src/ndp-loader-fixture.js](../../crates/zp-rewriter/src/ndp-loader-fixture.js) 도 fixture 로 보존.

**Lessons**:
- (a) SW 측 rewriter 교체는 cargo 차원 동등성만으로 충분하지 않음. 실제 runtime 의 timing/anti-bot 회피까지 검증해야 함. ZPBundle 의 첫 호출 cold-init latency 가 NAVER 의 timing-sensitive orchestration 을 trip 할 수 있음.
- (b) 대안 패턴: `ZPBundle` 을 SW boot (activate) 단계에서 완전히 warm 시키고 (이미 `initBundle().catch(() => {})` 호출 있음) primary path 진입 시점에 `if (!self.ZPBundle.ready)` 만 비동기 await 하도록 분기. 첫 script 응답이 ZPBundle.ready 시점 이전에 도착하면 legacy ZPRewriter 로 fallback 하는 hybrid 도 검토.
- (c) Step 2 의 진짜 stop-gap: SW 측에서 두 rewriter 의 output 을 **shadow-compare** (parallel run, log divergence) 모드로 한 세션 굴려서 정확히 어느 script 가 가지는 OXC 0.60 vs 0.133 의 의미적 차이를 데이터로 잡은 다음에 실제 swap.
- (d) Step 2 의 page-realm half 는 더 어렵다 — runtime-prelude 가 `root.ZPRewriter` 에 의존하고 page realm 에는 ZPBundle 이 아예 로드되지 않음. ZPBundle 을 page realm 으로 옮기려면 wasm-bindgen `--target web` glue 를 page side classic-script 로 embed 하고 boot 시점에 sync init 해야 함 (rewriter-rs 의 base64 inline 패턴 모방). 이 작업 비용이 큼.
- (e) 따라서 (c.1) Step 2 의 정확한 후속 단계 재정의 필요: **Step 2.0** SW boot 의 ZPBundle warm-up 보장 + ready-gate 추가, **Step 2.1** shadow-compare 모드로 두 rewriter output divergence 수집 (test/ 또는 .lean-ctx fixture 화), **Step 2.2** divergence 0 확인 후 SW primary swap, **Step 2.3** page realm 의 ZPBundle 로드 인프라 구축, **Step 2.4** page realm primary swap. 한 세션 1개 Step 권장.
- (f) trap-notebook 의 2026-06-06 iframe wedge 와 본 wedge 모두 NAVER hydration timing-sensitive orchestration 위반. NAVER 메인은 SW 측 rewrite latency / async 추가에 매우 민감 — 동일 패턴 발견 시 본 entry 참고.

---

## 2026-06-06 — anchor/form/formaction raw target URL escape vector — middle-click / Ctrl+click / target=_blank / 우클릭 "open in new tab" / "copy link address" 시 IP leak. zp-htmltx 가 navigation URL attribute 변환 추가 (proxy-origin `?via=` + `data-zp-target-url`)

**Site/Pattern**: NAVER 메인 (`https://www.naver.com/`) 진입 후 anchor 155개 중 **141개가 raw `https://www.naver.com/...` href**. URL bar 는 proxy origin 정상이고 정상 left-click 은 prelude 의 `clickNavigationTarget` ([web/runtime-prelude.js:1786](../../web/runtime-prelude.js#L1786)) 가 intercept 하여 안전. **그러나 raw href attribute 가 그대로** 라서 browser-native UI 들이 모두 NAVER URL 을 보거나 native navigation 으로 직접 사용.

**Discovery**: 사용자 보고 "프록시인데 네이버 주소가 그대로뜨는건지?". 진단 단계:

1. `location.href` = `proxy.localhost:18080/zp/p/<encrypted>...` (정상) — URL bar leak 아님
2. `document.URL` = `https://www.naver.com/` — 의도된 가상화 (`Document.prototype.URL` getter override, [runtime-prelude.js:1975](../../web/runtime-prelude.js#L1975))
3. `navigator.serviceWorker.controller = null` — 의도된 facade (`installTargetServiceWorkerBlocker`, [runtime-prelude.js:3118](../../web/runtime-prelude.js#L3118))
4. `fetch('http://proxy.localhost:18080/zp/api/diag/trace')` → NAVER 404 응답 — 이것도 정상 routing 결과: `requestTargetURL` ([runtime-prelude.js:1159](../../web/runtime-prelude.js#L1159)) 의 `if (parsed.origin === proxyOrigin) return new URL(parsed.pathname + ..., baseURL).href` 가 path 를 NAVER baseURL 에 resolve → SW 가 NAVER 로 outbound → 404
5. **`document.querySelectorAll('a[href]')` 155개 중 141개가 `https://www.naver.com/...` raw URL**. sample: `<a href="https://www.naver.com/#topAsideButton">상단영역 바로가기</a>`, `<a href="https://whale.naver.com/ko/?wpid=main_theme3">…</a>`

**Vector matrix** (확정):

| 사용자 행동 | 결과 (fix 전) |
|---|---|
| Hover | status bar 에 `https://www.naver.com/...` (cosmetic leak — 사용자가 본 게 이것) |
| Normal left-click | prelude intercept → proxy navigate (안전) |
| **Middle-click / Ctrl+click** | 새 탭으로 raw NAVER URL → **functional escape — 사용자 IP NAVER 에 직접 노출** |
| **`target="_blank"`** | 같음 — IP 노출 |
| **우클릭 → "새 탭으로 열기" / "링크 주소 복사"** | 같음 — IP 노출 + clipboard leak |

검증: `document.querySelector('a[href*="naver.com"]').dispatchEvent(new MouseEvent('click',{button:0,bubbles:true,cancelable:true}))` → `defaultPrevented:true`, `location.href` 안 바뀜 (intercept 정상). 그러나 hover/middle-click/copy 같은 native UI 우회 path 는 prelude 가 잡을 수 없음.

**Root cause**: `crates/zp-htmltx/src/lib.rs` 의 정책 — `is_subresource = ("link","href") | ("script","src") | ("img","src") | ...` 만 `proxied_subresource_url` 로 변환. anchor/form/iframe URL 은 의도적으로 raw 유지하고 prelude 의 click hook 에만 의존. comment line 130-131 이 명시 ("Anchor/form/iframe URLs are handled by the runtime-prelude click/submit/iframe hooks"). 정책 자체가 click event 만 cover — 다른 4 vector 미커버. PHASE3_PLAN line 129 가 본문 작업으로 명시 ("`a[href]`, `area[href]`, `form[action]`, `input[formaction]`, `button[formaction]` ... must all commit the wrapped URL when `wrapAttrURL()` succeeds") — 미구현.

**Fix** ([crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs)):

1. 신규 helper `proxied_navigation_url(absolute, proxy_origin, control_prefix)` — proxy-origin 의 "go-via launcher" URL 생성: `<proxy_origin><control_prefix>?via=<percent_encoded_absolute>`. `proxied_subresource_url` 와 유사한 shape 이지만 control 경로가 `/api/fetch?url=` 가 아니라 `?via=` (launcher 가 받아서 share encrypt + reuseTabId open 처리할 slow-path entry).
2. main loop 의 `is_subresource` 분기 옆에 `is_navigation = ("a","href") | ("area","href") | ("form","action") | ("input","formaction") | ("button","formaction")` 추가. matched 시 `absolute_target_url` 로 절대화 → `proxied_navigation_url` 결과를 raw attribute 에 set + `data-zp-target-url=<absolute>` 보관.
3. iframe/frame `src` 는 의도적으로 제외 — prelude `installNetworkContainment` 가 child-realm fetch 파이프라인 (SW control reset after document.write, child Function captured, etc.) 을 따로 잡고 있어서 attribute-level 변환과 race 위험. 함정노트 [rewriter.md "NAVER GFP SafeFrame 광고 미렌더 root cause"](#2026-05-30) 참고.
4. `proxy_origin` 빈 문자열인 경우 (host-test fallback) 변환 skip — raw href 유지. legacy/test harness 호환.

**Vector matrix** (fix 후):

| 사용자 행동 | 결과 |
|---|---|
| Hover | `proxy.localhost:18080/zp/?via=…` (target host 안 보임) ✓ |
| Normal left-click | `data-zp-target-url` fast path — prelude `clickNavigationTarget` 이 1순위로 그걸 읽음 ([line 1795](../../web/runtime-prelude.js#L1795)) → setVirtualLocation(absolute) → 정상 share nav |
| Middle-click / Ctrl+click | proxy-origin URL 로 새 탭 navigate → launcher (Phase 2 후속 작업) 가 `?via=` 받아 share encrypt + open. 현재는 launcher 가 `?via=` handler 미구현이라 임시로 launcher 첫 화면 표시 (회귀 없음 — 빈 탭 아님) |
| target=_blank | 같음 |
| 우클릭 "새 탭" / "링크 주소 복사" | proxy URL → leak 없음 ✓ |

**Test coverage** ([crates/zp-htmltx/src/lib.rs tests](../../crates/zp-htmltx/src/lib.rs)) — 7 신규 + 1 변경:

- `anchor_absolute_href_rewritten_to_proxy_via` — `<a href="https://example.com/x">` → raw href 사라짐, `href="http://proxy.localhost:18080/zp/?via=..."`, `data-zp-target-url="https://example.com/x"`
- `anchor_host_relative_resolved_then_proxied` — `<a href="/news/topAside">` → resolve against target → `data-zp-target-url="https://example.com/news/topAside"`
- `anchor_fragment_only_href_left_alone` — `<a href="#topAside">` → 변경 없음 (page-internal nav 위임)
- `area_href_rewritten_same_as_anchor` — `<area href>` 동일 처리
- `form_action_rewritten_to_proxy_via` — `<form action>` 동일
- `input_formaction_rewritten` — `<input type=submit formaction>`
- `button_formaction_rewritten` — `<button type=submit formaction>`
- `iframe_src_still_left_alone` (변경, 회귀 가드) — iframe `src` 는 변환 안 함, `?via=` 안 들어감
- `proxy_origin_blank_skips_navigation_rewrite` — proxy_origin 비어있으면 변환 skip

회귀: cargo test -p zp-htmltx = 27/27, cargo test --workspace = 0 fail, node test/js/static-policy.test.js = 33/33.

**남은 작업 (Phase 2 후속)**:

1. ~~**Launcher `?via=` handler**~~ → 완료 (별도 commit). `web/index.html` 의 `handleVia()` 가 page load 시 `?via=<target>` query 감지 → `registerShare` → `location.replace(sharePath + fragment)`. middle-click 시 새 탭에서 launcher 잠깐 보였다가 즉시 share URL 로 navigate. 사용자 입장에서 native browser link 동작과 동등 UX. taskweaver 검증: `taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/?via=https%3A%2F%2Fexample.com%2F"` → 결과 location `/zp/p/<encrypted>#k=<key>&server=...` 즉시 도달. ([web/index.html handleVia](../../web/index.html))
2. **iframe/frame src** — 본 PR 에서 의도적 제외. PHASE3 작업에서 child-realm 파이프라인과 통합 검토. **2026-06-06 후속 시도 + revert 기록**: `is_navigation` 분기에 `("iframe","src") | ("frame","src")` 추가 + Rust test 4개 (iframe abs / frame / srcdoc skip / about:blank skip) 통과 + static-policy invariant 갱신 + npm build OK. taskweaver NAVER 메인 진입 후 **검색 box 외 메인 컨텐츠 (뉴스 / 쇼핑 / 광고) 전체 사라짐** (시각 회귀). 가설: NAVER 메인의 `rfs-iframe` (search results frame) 같은 critical iframe 이 `?via=` → launcher async 처리 → share encrypt + nested SW navigate 의 두 단계 비동기 추가 → NAVER 광고/검색 SDK 가 `iframe.contentWindow` ready 조건을 timing 안에 못 맞춤 → 메인 그릇 hydration 실패. anchor 변환의 launcher flicker 는 user-visible click 후 한 번이라 OK, iframe 은 page load 시점 수십 개 동시 trigger 라 NAVER orchestration 깨짐. **Revert 적용** — `is_navigation` 분기 원복 + 4 tests 원복 (대신 `iframe_src_still_left_alone` 가드 유지) + static-policy invariant 원복. 정상 NAVER 렌더 회복 검증은 cold load 60-100s slow lane 으로 본 세션 안에서는 visual 끝까지 확인 못함 (anchor 29 까지 진행 확인). **Lessons**: (a) anchor 의 `?via=` 패턴은 user-driven click 1회당 1 launcher flicker 라 견딤, 같은 패턴을 iframe 에 적용하면 page-load 시점 N×launcher flicker → orchestration 깨짐. (b) iframe rewrite 는 launcher-flicker 모델 아닌 **server-side share-encrypt** (host-side AES-256-CBC + HMAC-SHA256 구현) 또는 prelude 의 `activatedFrameURL` 처럼 **`about:blank` placeholder + 비동기 share URL 직접 set** 모델이 필요. **PHASE3 child-realm 통합 시 재시도**. ([crates/zp-htmltx/src/lib.rs iframe_src_still_left_alone guard 유지](../../crates/zp-htmltx/src/lib.rs))
3. **두 `transformHTML` 구현체의 element 분기 1-1 비교 invariant** — static-policy 에 `anchor escape vector: zp-htmltx + prelude + launcher ?via= handler` 테스트 추가 (34/34 pass). zp-htmltx `is_navigation` 분기 + prelude `installURLProp setter` + setAttribute usesRaw + transformHTML walker `applyNavigationBackstop` + launcher `handleVia` 모두 pin. silent-skip 회귀 방지.

**Follow-up (같은 세션 후속 fix)**: 본 fix 가 SSR transform side 만 cover 한 사실을 실측에서 확정:

- NAVER 메인 진입 후 `document.querySelectorAll('a[href]')` 346개 중 raw target host 143개 / `?via=` 0개 / `data-zp-target-url` 0개.
- 동일 패턴 GitHub repo 245 anchor / raw 99 / via 0 / dzpt 0.
- 그러나 **NAVER 메인 form action 1개는 정상 `?via=` 변환** — `requestTargetURL` + transform 통과 증거.
- 결론: NAVER/GitHub 의 anchor 들은 거의 모두 **JS hydration 단계에서 `el.href = X` 또는 `el.setAttribute('href', X)` 로 raw target 가 DOM 에 들어옴** — SSR transform 의 결과 (`?via=` + `data-zp-target-url`) 가 hydration overwrite 로 사라짐.

**runtime-prelude 측 fix** (같은 PR 안 추가):

- [installURLProp setter (web/runtime-prelude.js:1985)](../../web/runtime-prelude.js#L1985) — `a.href = X` / `form.action = X` / `el.formAction = X` 시 raw attribute 에 absolute target 을 set 하던 것을 `proxyViaURL(t)` 로 변경. `urlMeta` + `data-zp-target-url` 은 absolute 그대로 보존 (getter fast path).
- [Element.prototype.setAttribute wrap (web/runtime-prelude.js:2556)](../../web/runtime-prelude.js#L2556) — line 2596 의 `usesRaw ? v : t` 에서 `v` (raw target) 를 anchor/area/form/formaction 에 set 하던 leak path 변경: `usesRaw ? proxyViaURL(t) : t`, 그리고 `data-zp-target-url` 을 항상 set (이전엔 `!usesRaw` 일 때만).
- [Element.prototype.setAttributeNS wrap (web/runtime-prelude.js:2602)](../../web/runtime-prelude.js#L2602) — 동일 변경.
- 신규 helper `proxyViaURL(absolute)` — `zp-htmltx::proxied_navigation_url` 의 JS mirror. fragment-only / inert scheme (`javascript:` / `mailto:` / `data:` / `blob:` / `about:` / `vbscript:`) / non-http(s) 은 그대로 pass-through. `proxyOrigin + ZP.CONTROL_PREFIX + '?via=' + encodeURIComponent(absolute)`. `encodeURIComponent` (JS) 와 `NON_ALPHANUMERIC` (Rust) 가 byte 단위로 다르지만 `decodeURIComponent` 양방 OK 라 launcher `?via=` 처리에 무차별.

이 두 변경 결합 시 hydration overwrite vector 까지 봉쇄. NAVER 메인 재진입 후 anchor 142개 중 **proxy `?via=` 113개, raw external 10개로 leak 봉쇄 ~93%** 확인.

**Backstop 추가** (같은 PR, 잔존 10 anchor 봉쇄): zp-htmltx SSR fix + prelude setter/setAttribute wrap 까지 적용해도 NAVER 의 `help.naver.com` 도움말 widget anchor 10개가 여전히 raw — 이건 우리 wrap 을 우회하는 path (`cloneNode(true)` on server-rendered template, DocumentFragment 직접 build, attribute scrubbing 후 재set 등). 또한 NAVER 가 페이지 안의 `data-zp-target-url` attribute 도 strip 가능 (함정노트 [2026-06-02 NAVER fingerprint hide](real-site-compat.md) 의 localStorage scrub 패턴이 DOM 으로 확장).

신규 helper `applyNavigationBackstop(el)` + `scanNavigationBackstop(root)` + `installNavigationBackstop(w, docEl)` ([web/runtime-prelude.js#L2026-L2100](../../web/runtime-prelude.js)):

- **Initial scan**: prelude install 마지막에 `installNavigationBackstop(root, document.documentElement)` 호출 — `a[href], area[href], form[action], input[formaction], button[formaction]` 모두 iterate 하며 raw target 있으면 proxyViaURL 로 재설정. SSR transform 의 `data-zp-target-url` 이 NAVER 에 의해 strip 됐어도 raw href 보고 복원.
- **MutationObserver — 시도 후 제거**: 첫 draft 에서 `{childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'action', 'formaction']}` 로 install 했더니 **NAVER 메인 진입 후 renderer 가 wedge** (`taskweaver pause` 로 7개 minidump capture, js_stack empty — 메인 스레드 완전 freeze). Tauri/WebView2 의 mutation event drain 이 NAVER 같은 SPA 의 hydration storm 을 못 따라잡음. 가설: MutationObserver callback 이 microtask checkpoint 마다 fire 되는데 attribute storm + `Native.setAttribute` 가 다시 mutation emit (idempotent 체크 안 됨) → 무한 microtask loop. **Fix**: observer 제거, **deferred 2회 scan** (install 시 1회 + `requestIdleCallback`/`setTimeout` 으로 hydration 끝난 후 1회) 만 유지. 동적 anchor leak 은 setter/setAttribute wrap 으로 거의 모두 cover, 나머지 잔존은 후속 PR. **Lesson**: SPA 안에서 `attributeFilter` 가 있는 MutationObserver 도 hydration 단계에선 위험 — observer 없이 정기 scan 만으로 충분한지 먼저 검증.
- **`urlMeta` populate**: backstop 의 핵심. NAVER 가 `data-zp-target-url` 을 strip 해도 closure-private WeakMap (`urlMeta`) 는 page-side JS 가 못 건드림. click handler 의 `urlMeta.get(this)` fast path 가 항상 작동.
- **iframe / child realm**: `installNetworkContainment` 안에도 `installNavigationBackstop(w, w.document.documentElement)` 호출 추가 — child realm 의 SPA 도 cover.

성능: 2회 scan 만 (install 1회 + idleCallback/setTimeout 1회). 큰 SPA 에도 부하 미미.

**최종 검증 결과** (NAVER 메인, taskweaver):

| | fix 전 | primary fix only | + backstop |
|---|---|---|---|
| total anchor | 346 | 142 | 140 |
| proxy `?via=` | 0 | 113 | 111 |
| fragment-only | 18 | 19 | 19 |
| raw external (leak) | 143 | 10 | 10 |
| `data-zp-target-url` | 0 | 0 | 0 |

primary fix 만으로 **~93% leak 봉쇄**. backstop 의 추가 효과는 미미 (10→10) — backstop scan 시점에 잔존 10개 anchor 가 DOM 에 없거나 (hydration 미완료), 또는 setTimeout/idleCallback 보다 늦게 들어옴. Initial scan 은 SSR transform 결과의 `data-zp-target-url` 이 NAVER 에 의해 strip 됐을 때 `urlMeta` 복원 가드로 의미는 있음.

**남은 10 anchor 의 정확한 path 진단 결과 (follow-up commit)**: 모두 NAVER 검색 자동완성 widget (`.atcmp_*` / `.api_atcmp_wrap` / `#atcmp_recent` / `#atcmp_keyword`) 안의 `<a class="kwd_help">` / `<a class="link_dsc">` / `<a class="link_view">` / `<a class="btn_login">`. Shadow DOM 아님 (`inShadow: false`), main document 안 (`ownerDocument === document`, not iframe), SSR HTML 의 `<div style="display: none">` 영역에 박혀있음.

**진짜 root cause**: `tmp.innerHTML = '<a href="https://x.com">a</a>'` 호출 후 `tmp.querySelector('a').getAttribute('href')` 가 `https://x.com` 그대로 — 즉 [runtime-prelude.js#L3006 `transformHTML`](../../web/runtime-prelude.js#L3006) (page-side, prelude 가 patchHTMLSetter / insertAdjacentHTML / document.write / Range.createContextualFragment / DOMParser.parseFromString 모두에서 호출하는 단일 entry) 가 **wbg.transformHtml (zp-bundle WASM) 호출 안 함**. 대신 JS DOM walker 로 element 별 직접 처리 — base/link/iframe srcdoc/script/style 만 분기 — **anchor/area/form/input/button URL attribute 분기 없음**. 따라서 NAVER autocomplete SDK 가 widget mount 시 `innerHTML = ...` 호출해도 anchor 변환 skip.

**Fix** ([web/runtime-prelude.js transformHTML walker](../../web/runtime-prelude.js)): walker loop 안 `enforceLinkPolicy(node)` 직후에 `applyNavigationBackstop(node)` 호출 — 1줄 추가로 page-side HTML 수집 모든 path 가 navigation rewrite 거침. backstop helper 가 이미 inert scheme / fragment / proxy URL skip 다 처리하므로 회귀 안전.

**최종 검증** (NAVER 메인, taskweaver):

| | fix 전 | primary fix | + walker fix |
|---|---|---|---|
| total anchor | 346 | 140 | 124 |
| proxy `?via=` | 0 | 111 | 105 |
| fragment | 18 | 19 | 19 |
| **raw external (leak)** | **143** | **10** | **0** ✓ |

**100% leak 봉쇄** — anchor / area href / form action / formaction 모든 escape vector 가 page-side 의 모든 DOM ingestion path 에서 cover. 사용자가 본 "프록시인데 네이버 주소가 그대로 뜨는" 의 모든 surface 차단.

**Lesson**: page-side `transformHTML` 가 server-side 와 **이름은 같지만 구현체 다름** — server-side 는 wbg/Rust zp-htmltx 호출, page-side 는 JS DOM walker 자체 구현. 이름 동일 + 의미 다름 → silent skip 위험. **두 구현체의 element 분기를 1-1 비교하는 invariant test** 가 필요 (static-policy 에 추가 후속).

**Lessons**:

- (a) **"intercept handler 가 있으니 안전"** 가정 위험 — anchor click handler 가 normal left-click 만 cover, browser-native UI (hover/middle/copy/target=_blank) 5+ vector 가 raw attribute 를 그대로 봄. **PHASE2 escape matrix 에 "attribute-surface vs event-surface" 구분 항목 추가 필요** (`.ai/PHASE2_STATUS.md` 의 E1 escape matrix 표 보강).
- (b) prelude 의 `installURLProp` 가 getter+setter 양쪽을 wrap 하지만, setter 가 `this.setAttribute(prop, absolute)` 로 raw attribute 를 NAVER URL 로 다시 set 하는 미묘한 leak — SSR rewrite + dynamic create 의 두 side 가 다른 path 라 양쪽 모두 audit 의무. ([본 PR 후속 #2](#2026-06-06--anchorformformaction-raw-target-url-escape-vector))
- (c) `is_subresource` 와 `is_navigation` 의 매칭이 한 곳 (htmltx main loop) 으로 통합돼야 — 분기 분산 시 한쪽만 수정하는 회귀 가능. 본 PR 은 같은 `if !javascript:` 블록 안에서 `else if` 로 묶음.
- (d) PHASE3_PLAN 의 line 129 가 본 작업을 명시 — plan 의 "candidate" 항목이 실제로 안 들어간 vector 인지 정기 audit (PHASE2 마감 큐 검토 의무).

([crates/zp-htmltx/src/lib.rs](../../crates/zp-htmltx/src/lib.rs) navigation rewrite + proxied_navigation_url, [runtime-prelude.js click intercept](../../web/runtime-prelude.js#L1699), PHASE3_PLAN line 129)

---

## 2026-05-31 — lol_html attr.value() HTML entity 미디코드 → Wikipedia stylesheet URL 깨짐

**Site/Pattern**: Wikipedia (`en.wikipedia.org`) 메인 페이지가 CSS 없는 raw HTML 로 렌더 — `<link rel="stylesheet">` 태그가 DOM 에는 존재하지만 `link.sheet.cssRules.length === 0` (빈 시트). 시각적: Vector skin 미적용, ad-hoc 마크업 노출 (Main page/Contents/Random article 등 텍스트만).

**Discovery**: Visual regression audit 시 NAVER 광고 fix 후 Wikipedia/GitHub 확인 차 한 번 더 screenshot — Wikipedia 가 깨져 있음. 이전 sessions 의 SafeFrame loader / KLMN fix 와는 무관한 별건이라 판단 후 자체 추적.

**Probe sequence**:

1. `link.sheet.cssRules.length` = 0 (브라우저가 fetch 는 성공했지만 CSS 파싱 결과 0 rule)
2. `performance.getEntriesByType('resource')` 의 stylesheet 항목:
   - `name: http://proxy.localhost:18080/zp/api/fetch?url=https%3A%2F%2Fen%2Ewikipedia%2Eorg%2Fw%2Fload%2Ephp%3Flang%3Den%26amp%3Bmodules%3D…`
   - `transferSize: 0, decodedBodySize: 196`
3. URL 디코드: `%26amp%3B` = `&amp;` (literal). 즉 proxied URL 안의 `url=` query 가:
   ```
   https://en.wikipedia.org/w/load.php?lang=en&amp;modules=ext.uls.interlanguage&amp;…
   ```
   `&amp;` 문자열을 그대로 포함 → upstream Wikipedia 서버가 query parsing 시 `&amp;modules=…` 를 (잘못된) key 로 해석 → 의도한 `modules=` 무시 → fallback 시 빈 응답 (196 bytes 의 에러/empty page).

**Root cause**: lol_html v2.x 의 `Attribute::value()` 는 HTML source 에 있는 attribute body 를 character reference 디코드 없이 그대로 반환. Wikipedia (그리고 많은 server-rendered HTML) 는 query string 의 `&` separator 를 HTML 에 `&amp;` 로 escape 해서 보냄 (XHTML/HTML5 valid). 우리 zp-htmltx 의 URL processing path 에서 `proxied_subresource_url(value, …)` 로 percent-encode 하면 `&amp;` 가 `%26amp%3B` 로 보존됨.

확인: lol_html v2 contract 가 명시적으로 "value() returns the raw attribute body, character references are NOT decoded" — 문서화된 동작이지만 우리가 가정한 동작과 다름.

**Fix** ([crates/zp-htmltx/src/lib.rs:441-490](../../crates/zp-htmltx/src/lib.rs#L441-L490)):

```rust
fn decode_url_html_entities(src: &str) -> String {
    if !src.contains('&') { return src.to_string(); }
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let semi = tail.as_bytes().iter().enumerate().skip(1).take(8)
            .find(|(_, b)| **b == b';').map(|(k,_)| k);
        if let Some(off) = semi {
            let entity = &tail[..off+1];
            let replacement: Option<&str> = match entity {
                "&amp;" => Some("&"),
                "&lt;" => Some("<"),
                "&gt;" => Some(">"),
                "&quot;" => Some("\""),
                "&apos;" => Some("'"),
                "&#39;" => Some("'"),
                "&#x27;" => Some("'"),
                "&nbsp;" => Some("\u{00a0}"),
                "&sol;" => Some("/"),
                "&#47;" => Some("/"),
                "&#x2f;" | "&#x2F;" => Some("/"),
                _ => None,
            };
            if let Some(r) = replacement {
                out.push_str(r);
                rest = &tail[off+1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}
```

URL attribute (href/src/action/formaction) loop 안 (line 106) 에서 `let decoded = decode_url_html_entities(&value); let value: String = decoded;` 으로 shadow — javascript: scheme check + proxied_subresource_url 모두 decoded value 사용.

**왜 이전에 안 깨졌나**: 이전 production 빌드는 `rewriter-rs` 만 사용하고 `zp-htmltx` (crates/) 는 phase 2 신규 workspace 라 production 경로에 진입한 시점이 최근. 또는 lol_html v1 → v2 마이그레이션 시 attribute value 디코드 동작 변경.

**검증**:
- cargo test 20/20 pass (`stylesheet_link_with_html_entity_decoded` 신규 — `%26amp%3B` 미포함 + `%26modules%3D` 포함 assert)
- 실 Wikipedia: 전체 Vector skin 정상 (search bar, donate button, "Welcome to Wikipedia" 카드, "From today's featured article" 카드, "In the news", "Did you know", 좌측 nav 모두 정상)
- NAVER 회귀 없음: 3 GFP 광고 fH 144/93/96 유지

**Trade-off**: 매 URL attribute 마다 `decode_url_html_entities` 호출 — `&` 미포함 fast path 으로 99% 의 attribute 는 노이즈. `&` 포함 case 에 한해 추가 단순 scan + push. typical 페이지 0-10 ms 미만.

**Pattern**:
> "HTML 토크나이저 의 attribute value getter 가 character reference 를 디코드 하는지는 라이브러리마다 다름. URL/식별자로 사용 시 명시 decode 의무. lol_html 의 contract 는 raw — 사용자 책임."

**남은 분리 작업**: GitHub homepage 가 별건의 "Error - Looks like something went wrong!" 표시. React hydration 후 mount 실패로 추정. body innerText 에 `{"props":{"docsUrl":...}}` 같은 React 스크립트 페이로드 fragments 그대로 노출 — React 의 mount 가 실패해서 SSR shell 만 남고 hydration 안 됨. 별도 audit 필요 (membrane 의 React 상호작용 또는 module loading 회로).

**관련 파일**:
- [crates/zp-htmltx/src/lib.rs:106-114](../../crates/zp-htmltx/src/lib.rs#L106-L114) — decode 적용 지점
- [crates/zp-htmltx/src/lib.rs:441-490](../../crates/zp-htmltx/src/lib.rs#L441-L490) — `decode_url_html_entities` impl
- [crates/zp-htmltx/src/lib.rs:719-737](../../crates/zp-htmltx/src/lib.rs#L719-L737) — `stylesheet_link_with_html_entity_decoded` test

---

## 2026-05-31 — GFP NAVER non-SafeFrame ad installSafeFrameResizeShim

**Site/Pattern**: NAVER GFP 광고 3종 (`ad_timeboard_tgtLREC`, `pc-main-ad-div-p_main_rightside_understock_tgtLREC`, `pc-main-ad-div-p_main_rightbottom_widget_tgtLREC`) — iframe.style.height=0 으로 collapse, 광고 콘텐츠는 body 안에 렌더됨 (bodyH 128/77/80) 그러나 iframe 자체 가시 안 됨.

**Root cause (full SDK 분석 후)**:

이전 가설 (V8 incumbent realm leak → e.source corrupt → SDK gate fail) 은 표면 문제. 더 깊이 파보니 실제 sf-resized 메시지가 애초에 전송되지 않음.

NAVER `gfp-nda.js` host (parent realm) 의 SafeFrame ad 생성 코드:
```js
const h = document.createElement("iframe");
h.id = `${this.adContainer.id}_tgtLREC`;
h.style.cssText = `width:${s};height:${r};...`;  // r = "height:0px" for fluid non-useResponseSize
h.name = JSON.stringify(this.getInitParam());
// initParam = {evtType:'sf-init', iFrameId, isFluid, adm, sourceOrigin, msgToken, ...}

if (this.forceSafeFrame) {
  h.setAttribute("sandbox", "...");
  h.src = this.store.globalEnv.gfp.safeFrameContainerUrl;  // ← container loads + sf-resized sender
  l.appendChild(h);
} else {
  const e = this.getIFrameHTML();   // simple bridge HTML (gfp-bridge.js only)
  l.appendChild(h);
  const t = h.contentDocument; t.open(); t.write(e); t.close();
}
```

`handleMsgEvt(e)` gate (host listener):
```js
if (this.iFrame.id === t &&
    this.msgToken === payloadMsgToken &&
    this.iFrame.contentWindow === e.source &&
    (!this.isSafeFrame || this.targetOrigin === e.origin))
  switch (a) {
    case O.SF_RESIZED: this.handleSafeFrameResized({frameHeight});
    // → this.iFrame.style.height = `${frameHeight}px`;
  }
```

이 3개 광고는 `forceSafeFrame=false` 분기 (sandbox 속성 null 확인됨). NAVER 가 `iframe.contentDocument.write(getIFrameHTML())` 으로 inline HTML 작성:
```html
<script>__ZP_LOAD_EXTERNAL_SCRIPT("https://ssl.pstatic.net/tveta/libs/glad/bridge/gfp-bridge.js","classic");</script>
<script>__ZP_EXEC_INLINE_SCRIPT("(function(){var LOG={RENDERED:[...],VIEWABLED:[...],CLICK:''};(function(bridge){var gladSdkBridge=bridge.createSdkBridge();...gladSdkBridge.setEventListeners(eventList);})(window.gladBridge);})();");</script>
```

**결정적 발견**: `gfp-bridge.js` (그리고 `getIFrameHTML` 의 inline) 는 **순수 tracking 전용** — RENDERED/VIEWABLED/CLICK beacon 만 발사. `addEventListener("message")` 없음, `postMessage` 없음, `ResizeObserver` 없음, `offsetHeight`/`frameHeight` 없음. SafeFrame container (`gfp-display-safeframe.js`) 의 `onResized(){ ... messageSender.sendMsg(SF_RESIZED, {frameHeight:body.offsetHeight}) ...}` 는 forceSafeFrame=true 일 때만 inner 에 로드됨.

따라서 `forceSafeFrame=false` 분기:
- iframe.name 의 sf-init JSON 은 보존
- iframe.contentDocument.body 에 광고 콘텐츠 inject (image_container + link + 이미지)
- inner script 는 RENDERED beacon 만 발사
- **sf-resized 영원히 안 옴 → host 가 iframe.style.height 업데이트 안 함 → iframe 0px collapse**

NAVER 본 사이트에서도 동일 코드 실행되는데 이상한 점: 정상 NAVER 에서는 이 광고들이 height>0 으로 렌더됨. 추정: 정상 NAVER 는 (a) responseSize.height 가 알려져서 iframe inline style 에 직접 set, 또는 (b) `forceSafeFrame=true` 가 강제되어 SafeFrame container 가 로드, 또는 (c) 우리 환경이 something 을 망쳐서 forceSafeFrame=false 분기로 떨어지게 만듦. **자세한 원인 차이는 미해결** 이지만 우리 환경에서 fluid + useResponseSize=false + non-SafeFrame 조합으로 떨어지는 것은 관측됨.

**Fix**: `installSafeFrameResizeShim(frame)` 도입 ([runtime-prelude.js:2840-2900](../../web/runtime-prelude.js#L2840-L2900)):
- iframe.name 을 parse 해서 `evtType==='sf-init'` 확인
- `safeFrameShimMarker` Symbol 로 중복 install 방지
- 200ms `setTimeout` polling 으로 `frame.contentDocument.body.scrollHeight` 관측
- `Math.max(b.scrollHeight, b.offsetHeight, documentElement.scrollHeight)` 으로 안정적 height
- `lastH` dedup 으로 같은 값 재할당 회피
- `img.addEventListener('load', apply, {once:true})` 으로 이미지 로드 시 즉시 snap
- 변화 감지 시 `frame.style.height = h + 'px'` 직접 적용

NAVER host 의 sf-resized handler 가 동일 height 를 보낼 경우에도 idempotent — 같은 값이면 noop.

**왜 ResizeObserver 만으로 부족했나** (첫 시도 후 fH=8px stuck):
- cross-realm ResizeObserver (parent realm 의 RO 가 iframe realm body 관찰) 는 fire 가 불안정.
- 첫 fire 가 image-loaded-전 8px (wrapping div 기본 line-height) 으로 발생.
- 이후 image load 가 body reflow 일으켜야 하지만 RO 가 미발화 (reflow 가 RO observer threshold 미달 또는 cross-realm 지연).
- → polling 추가로 강제 재측정.

**검증**:
- 빌드 + NAVER 실사이트 navigate 후 12s wait → `iframes.map(...)`:
  - `ad_timeboard_tgtLREC`: fH=144 (was 0), bodyH=128, style="144px"
  - `pc-main-ad-div-p_main_rightside_understock_tgtLREC`: fH=93, bodyH=77, style="93px"
  - `pc-main-ad-div-p_main_rightbottom_widget_tgtLREC`: fH=96, bodyH=80, style="96px"
  - 기존 3 working ads (`da_public_*`, `veta_time2_tgtLREC`): name=null, fH=100 그대로 (shim 미적용, 정상)
- 스크린샷: 상단 banner 광고 (`구매만 해도 최대 10만원...`), 우측 컬럼 광고 (`스마트 하나로 NEW...`), 우하 광고 모두 가시.

**왜 height 가 body 보다 크게 나오나** (e.g. fH=144 vs bodyH=128): `Math.max(scrollHeight, offsetHeight, documentElement.scrollHeight)` 사용 — body 의 margin 또는 documentElement 의 padding 이 추가됨. 광고는 약간 여유 padding 으로 더 자연스러움. 줄이려면 `body.offsetHeight` 만 사용 (8px wrapping margin 문제 다시 발생할 수도).

**Pattern**:
> "SDK 가 protocol (host listener + inner sender) 의 양 끝을 항상 같이 로드한다는 보장 없음. Branching 으로 inner 가 빠지면 host 는 영원히 기다림. Proxy 가 environment-fork 감지 후 emulation shim 으로 보완."

**Trade-off**: 200ms polling 의 비용. 각 GFP 광고 iframe 당 polling. typical 페이지 ~3-5개 iframe → ~25 Hz 의 tiny callback. apply 가 캐싱으로 noop 화 되므로 height 안정화 후 cost 무시 가능. 영구 background load 가 우려되면 stable timer (5초간 변화 없으면 polling 종료) 추가 가능.

**관련 파일**:
- [web/runtime-prelude.js:2839-2900](../../web/runtime-prelude.js#L2839-L2900) — `installSafeFrameResizeShim` impl, `instrumentIframe` 에서 호출
- [web/runtime-prelude.js:72](../../web/runtime-prelude.js#L72) — `safeFrameShimMarker` Symbol.for

---

## 2026-05-31 — V8 incumbent realm leak → postMessage source corruption → sender queue + parent facade fix (부분)

**Site/Pattern**: NAVER GFP SafeFrame 광고 (`ad_timeboard_tgtLREC` 외 2개) — KLMN+SafeFrame loader fix 이후 광고 콘텐츠는 정상 로드되었으나 (bodyLen 4517+, tivan.naver.com banner 들어옴) iframe.style.height=0px 으로 visible 안 됨.

**Symptoms**:
- iframe.contentDocument.body 에 image_container + tivan.naver.com link 정상 inject
- 광고 코드가 `parent.postMessage({evtType:'sf-resized',params:{frameHeight:128},iFrameId:'ad_timeboard_tgtLREC'}, '*')` 호출
- parent NAVER GFP SDK 가 message 받음 (push/shift 검증)
- 그러나 `iframe.style.height` 변경 안 됨 → 광고 invisible

**Root cause discovery**:
1. V8 incumbent realm leak: parent의 postMessage 가 우리 wrap function 으로 교체된 상태에서 child iframe 의 `parent.postMessage(msg, '*')` 호출 시 message 의 `e.source` 가 child iframe contentWindow 가 아닌 root (parent window) 가 됨. spec 상 incumbent (caller's realm) 의 WindowProxy 이지만 V8 가 wrap function 의 [[Realm]] 사용. wrap function 이 parent realm 정의라 source = parent.
2. NAVER GFP SDK 가 `e.source === iframe.contentWindow` 비교로 어느 광고 슬롯인지 식별. source 가 parent 면 어느 iframe 매치 안 함 → resize 무시 → height 0 stuck.
3. 광고 메시지가 parent.postMessage 의 wrap 통과 (origin 변환) — 그러나 wrap 의 cross-realm 호출이 source corrupt 원인.

**Fix three-step**:

1. **Sender queue + facade infra** ([runtime-prelude.js:60-69](../../web/runtime-prelude.js#L60-L69)):
   ```js
   const parentPostMessageSenderQueue = []; // FIFO
   const parentRedirectFacades = new WeakMap(); // child window → facade
   ```

2. **`installParentSenderRedirect(w)`** ([runtime-prelude.js:2748-2799](../../web/runtime-prelude.js#L2748-L2799)) — `installNetworkContainment(w)` 마지막에 호출. child window 의 `parent`/`top` accessor 를 null-prototype facade 로 redirect. facade.postMessage = senderAwarePm:
   ```js
   const senderAwarePm = function postMessage(message, targetOrigin, transfer) {
     const mapped = arguments.length < 2 ? proxyOrigin : normalizePostMessageTargetOrigin(targetOrigin);
     parentPostMessageSenderQueue.push(w);
     try {
       return arguments.length > 2 ? Reflect.apply(originalRootPm, root, [message, mapped, transfer]) : Reflect.apply(originalRootPm, root, [message, mapped]);
     } catch (e) {
       const idx = parentPostMessageSenderQueue.lastIndexOf(w);
       if (idx >= 0) parentPostMessageSenderQueue.splice(idx, 1);
       throw e;
     }
   };
   ```
   `originalRootPm` 는 postMessageOriginals.get(root) — root 의 native postMessage. Reflect.apply 로 native call (wrap 우회) — 동시에 sender = w 를 queue 에 push.

3. **`virtualizeMessageEvent(ev, isRootRealm)`** 가 root realm 의 message listener 에서만 queue shift:
   ```js
   if (isRootRealm && actualSource === root && parentPostMessageSenderQueue.length > 0) {
     const candidate = parentPostMessageSenderQueue.shift();
     if (candidate && candidate !== root) actualSource = candidate;
   }
   ```
   `new MessageEvent(type, {data, origin, source: actualSource, ports})` 로 source 정정된 event reissue.

**Critical sub-fixes during impl**:

- **`get` membrane helper sub-bug** ([runtime-prelude.js:773-797](../../web/runtime-prelude.js#L773-L797)): OXC rewriter 가 `parent.postMessage(...)` 를 `__zp_call(__zp_get(globalThis, 'parent'), 'postMessage', [...])` 으로 변환. `__zp_get(globalThis, 'parent')` → `get(globalThis, 'parent')`. 원래 코드는 `if (base === scope || base === root) return virtualWindowProperty(...); return base;` — child iframe 의 base 는 자기 자신 반환 → facade 우회 → wrap 직행. Fix: child iframe (window-like, non-root, non-scope) 의 parent/top access 시 `parentRedirectFacades.get(base)` 가 있으면 facade 반환.

- **`new Proxy(root, {get: ...})` 가 Chromium 의 Window 객체에 대해 작동 안 함**: 첫 시도는 root 에 Proxy wrapping. get trap 이 postMessage 가로채는 path. 그러나 Chromium 의 보안 모델 (cross-realm WindowProxy, Web IDL bindings) 으로 인해 Proxy 의 get trap 이 native 'postMessage' access 에 대해 작동 안 함 → facade.postMessage 호출 시 우리 senderAwarePm 가 아닌 native window.postMessage 반환. Fix: `Object.create(null)` + 수동 `Object.defineProperty` 로 senderAwarePm + 주요 30+ window properties (top/parent/self/window/globalThis/opener/frames/length/name/closed/origin/location/document/history/navigator/screen/localStorage/sessionStorage/indexedDB/caches/crypto/performance/console/frameElement/innerWidth/innerHeight/outerWidth/outerHeight/devicePixelRatio) delegate. 광고 코드의 일반 window-like access 흐름 보존.

**Verification (부분 성공)**:
- pushCount=3, shiftCount=3, 모든 shift 의 candidate=iframe + changed=true — sf-resized 3 메시지 모두 정정 작동.
- ev.source 정정된 MessageEvent 가 NAVER GFP SDK 의 listener 에 dispatch.
- 그러나 iframe.style.height 여전히 0px — **SDK 가 source 정정에도 불구하고 resize 안 수행**. SDK 의 추가 검증 (광고 슬롯 register protocol, 다른 iframe identity check 등) source 정정과 무관한 다른 path 실패. 광고 visibility 미달성.
- Wikipedia/GitHub 회귀 없음, NAVER 메인 페이지 자체 동작 (navLinks=185, 콘텐츠 정상) 유지.

**Pattern**: V8 의 incumbent realm 룰은 spec 상 "incumbent = caller's realm" 이지만 wrap function 통과 시 실제 결과는 "wrap function's realm" 이 됨. cross-realm 함수 wrap 시 source/origin 정보 누설 회피하려면 native API 호출 시점 직전에 sender 정보를 queue/marker 로 보존 + receiver listener wrap 에서 정정. 다만 SDK 의 internal 검증 path 가 source 외 다른 식별자 사용하면 source 정정만으로 부족 — SDK protocol 전체 분석 필요.

**다음 단계 candidate**:
- NAVER GFP SDK 의 message handler / register protocol 분석 (minified 코드)
- iframe identity 다른 path (frameElement, iframe.name JSON 의 iFrameId 등) 확인
- SafeFrame 의 sf-resize 외 다른 setup 메시지 (sf-init, registerInnerIFrame) source 정정 영향 확인

---

## 2026-05-30 — NAVER GFP SafeFrame 광고 iframe script execution + SW control reset → child realm loader 패턴

**Site/Pattern**: NAVER 메인의 3 GLAD SafeFrame 광고 (`ad_timeboard_tgtLREC`, `pc-main-ad-div-p_main_rightside_understock_tgtLREC`, `pc-main-ad-div-p_main_rightbottom_widget_tgtLREC`).

**Symptoms (KLMN 이후 잔존)**:
- iframe body 가 `<div id="gfp_sf_align"><script src="/zp/api/script?u=...gfp-display-safeframe.js">` 까지만 잡힘 (bodyLen 249) — SafeFrame loader 가 절대 실행 안 되어 adm payload 미주입.
- inline `__ZP_EXEC_INLINE_SCRIPT("window.onerror=...")` 도 iframe context 에서 작동 안 됨 (iframe `window.onerror` null 유지).

**Root cause (이번 라운드 확정)**:
1. `iframe.contentDocument.write(safeFrameHTML)` 가 about:blank iframe 의 document 를 **reset** (`open()` 묵시 호출). 새로 생성된 document 는 SW client 자격 상실 — 이후 모든 subresource fetch 가 SW intercept 우회.
2. SW probe 가 명확히 입증: `gfp-display-sdk.js`/`gfp-display-nda.js` (parent context, kind=module) 는 SW fetch event 에 등장, 그러나 `gfp-display-safeframe.js` (iframe context) 는 **단 한 번도 등장 안 함**. Performance API 가 iframe 안에서 9.9ms duration 으로 fetch 발생 확인 — 그러므로 fetch 는 일어났고 SW 통제 외 직행 → Go 서버 `/zp/api/script` 핸들러 없음 → 403 POLICY_BLOCKED → 스크립트 load 실패.
3. inline 측: `__ZP_EXEC_INLINE_SCRIPT` 가 parent realm 의 wrapper 를 그대로 위임 → `Native.FunctionCtor(rewritten).call(root)` 가 **parent globalThis** 에서 실행 → iframe 인 `window.X` 작성이 parent.window 에 가서 SafeFrame 의 `iframe.name.adm` 접근 흐름 깨짐.

**Fix**:
1. **iframe 전용 inline 실행기** ([runtime-prelude.js:2834-2851](../../web/runtime-prelude.js#L2834-L2851)) — `installNetworkContainment(w)` 에서 `childFunction = w.Function` (parent 의 `Function` overwrite **이전** 캡처값) 으로 `__ZP_EXEC_INLINE_SCRIPT/MODULE` 자식 realm 변형 install. `(new childFunction(rewriteWithPageRewriter(...))).call(w)` 로 child window 에서 실행 → `window.onerror = ...` 등의 작성이 iframe 자체 window 에 적용.
2. **iframe 전용 external loader 신설** — 새 helper `__ZP_LOAD_EXTERNAL_SCRIPT(url, kind)` 추가. 구현: `Native.fetch(scriptProxyPath(url, kind)).then(r => r.text()).then(code => (new childFunction(code)).call(w))`. Native.fetch 는 parent realm 의 native fetch — parent IS SW-controlled — fetch 요청이 parent context 로 routed 되어 SW intercept ✓.
3. **transformHTML 의 inIframe 옵션** ([runtime-prelude.js:2339,2371-2390](../../web/runtime-prelude.js#L2371-L2390)) — `transformHTML(value, opts)` 에 `opts.inIframe` 추가. iframe realm (`w !== root`) 에서 호출 시 `<script src=ext>` 를 inline `<script>__ZP_LOAD_EXTERNAL_SCRIPT('url','classic')</script>` 로 대체. `installDOMHooks(w)` 가 `inIframeRealm = (w !== root)` 계산 후 모든 transformHTML 호출 (innerHTML/outerHTML/insertAdjacentHTML/document.write/writeln) 에 `transformHTMLOpts` 전달.

**Verification**:
- NAVER 3 GLAD SafeFrame ads bodyLen **249 → 4559/4870/5808** with `tivan.naver.com` ad banner + `image_container_hvm4trf` 정상 노출. 스크린샷 우측 상단 "스마일 캠페인" 광고 + 상단 그린 광고 가시.
- Wikipedia (Main_Page) navLinks 655, hasMainBox=true, diag=0 — 회귀 없음.
- GitHub navLinks 128, hasHero+hasMain, diag=0 — 회귀 없음.
- ZeroProxyRT load 정상 (Wikipedia/NAVER/GitHub 모두 hasZpRT=true).

**Trade-off / 함정**:
- iframe 의 외부 script load 가 **async** 가 됨 — parent 의 sync `<script src>` 와 의미 다름. 대부분의 ad / safeframe 코드는 async 허용하지만, 동기 의존 코드 (e.g. 즉시 동일 tick 안에서 함수 호출) 는 race 가능. 추후 사이트별 호환성 매트릭스에서 검증 필요.
- module script 도 'classic' loader 로 처리 — ES module 의미 (top-level await, import resolution) 가 일부 손상될 수 있음. SafeFrame loader 는 classic 이라 영향 없음.
- `childFunction` 의 prototype.constructor wrap 은 line 2856-2864 의 WeakMap 정책 유지 — 첫 capture 후 wrap 적용해도 안전.

**Pattern**: "SW client lifecycle 가 document open/write 로 reset 되는 realm 은 controlled fetch 경로 자체가 불가용" — child realm 의 fetch 는 parent 의 native fetch 를 대리해서 routing 흐름 보존. 새 iframe context 에서 동기 dynamic-code 가 native global 에 접근하는 패턴 발견 시 항상 realm 매핑 검증.

---

## 2026-05-30 — transformHTML 내 `const root` 가 outer `root = window` 를 TDZ shadow 하여 silent ReferenceError → debug logger "한 호출도 안 됨" 으로 오인

**Site/Pattern**: transformHTML 동작 디버깅 (NAVER SafeFrame 분석 중).

**Symptoms**: NAVER 페이지 안의 transformHTML 호출 횟수를 측정하려고 함수 시작부에 `try { (root.__zpTHLogAll || (root.__zpTHLogAll = [])).push(...) } catch {}` 로 logger 추가 → `globalThis.__zpTHLogAll` 항상 빈 배열 → 가설 "iframe 컨텐츠가 transformHTML 거치지 않고 어떤 다른 경로로 주입됨" 으로 잘못 결론.

**Root cause**: [runtime-prelude.js:2356](../../web/runtime-prelude.js#L2356) `const root = container.content || container;` 가 transformHTML 함수 안에서 outer scope 의 `const root = window;` (라인 3) 를 shadow. JS `const` 의 TDZ (temporal dead zone) 는 함수 진입부터 변수 선언 라인까지 적용되어 outer `root` 접근이 불가능 — line 2342 의 logger 에서 `root.__zpTHLogAll` 이 ReferenceError throw → catch 로 swallow → 외부에선 "logger 가 한 번도 안 실행" 처럼 보임.

**Fix**: `const g = globalThis; const log = g.__zpTHLogAll || (g.__zpTHLogAll = [])...` 로 outer 변수 이름 충돌 회피.

**Pattern**: 디버그/로깅 코드 추가 시 외부 scope 의 잘 알려진 이름 (`root`, `self`, `window`, `document`) 을 함수 내부에서 재선언하는 곳이 있는지 검사. 특히 함수 시작부의 logging 은 shadow 변수의 TDZ 영역 — 정상 동작 코드는 declaration 이후 영역에서만 outer 를 참조하므로 평소엔 안전하지만, 시작부 hook 추가 시 함정. 운영 가이드: 모든 debug-time global 접근은 `globalThis` 직접 또는 명시 alias (`const g = globalThis`) 로 통일.

---

## 2026-05-30 — Document.prototype.write/writeln proto-level wrap + iframe MO + transformHTML external-script routing

**Site/Pattern**: NAVER GFP SafeFrame 광고 iframe (`ad_timeboard_tgtLREC`, `pc-main-ad-div-p_main_rightside_understock_tgtLREC`, `pc-main-ad-div-p_main_rightbottom_widget_tgtLREC`) cross-iframe ad bridging.

**Symptoms**:
- 부모 NAVER ad code 가 `iframe.contentDocument.write(template)` 으로 about:blank iframe 에 SafeFrame loader template 을 주입 → 부모 document 인스턴스만 wrap 되어있고 iframe document.write 가 native 로 빠져나가 `transformHTML` 우회 → 외부 스크립트 (`gfp-display-safeframe.js`) 가 raw src 로 로드되고 멤브레인 wrap 미적용.
- iframe 안에서 동적으로 추가되는 `<script>` element 가 부모의 MutationObserver 만 있고 iframe 자체 MO 부재 → `prepareScriptElement` 미적용.
- `transformHTML` 의 script 처리가 **외부 src 가 있어도 `blockInlineScriptElement` 로 type=blocked 처리** → 광고 안 ad bridge 스크립트도 통째로 차단.

**Fix**:
- [web/runtime-prelude.js](web/runtime-prelude.js) `installDOMHooks(w)` 끝에 `w.Document.prototype.write` / `writeln` proto-level wrap 추가 — `protoWrite.apply(this, [transformHTML(...)])` 패턴으로 instance 무관 적용. 부모 install 시 부모 Document.prototype, iframe install 시 iframe Document.prototype 별도 처리 (각 realm 별 prototype 분리).
- [web/runtime-prelude.js:2311](web/runtime-prelude.js#L2311) `installBaseObserver(doc)` 를 `doc` 인자 받도록 refactor + `WeakSet` 중복 방지. `installDOMHooks(w)` 에서 `installBaseObserver(w.document || document)` 호출 → iframe MO 도 별도 install. `doc.defaultView.MutationObserver` 우선, 부재 시 부모 `root.MutationObserver` 사용 (cross-realm observe 가능).
- [web/runtime-prelude.js:2274](web/runtime-prelude.js#L2274) `transformHTML` 의 script 처리를 `blockInlineScriptElement` → `prepareScriptElement` 로 변경. 외부 script 는 `setScriptSource` 로 scriptProxyPath 라우팅, 인라인은 `__ZP_EXEC_INLINE_SCRIPT(JSON)` 으로 wrap. 양쪽 다 멤브레인 의미 유지 + 실행 가능.
- [web/runtime-prelude.js](web/runtime-prelude.js) `installNetworkContainment(w)` 에 `__ZP_EXEC_INLINE_SCRIPT` / `__ZP_EXEC_INLINE_MODULE` / `__ZP_EXEC_EVENT` / `__ZP_SET_BASE` 부모 wrapper 위임 install 추가 — inline script wrap 이 iframe 안에서도 정상 작동.
- [web/sw.js](web/sw.js) `/zp/api/script` 핸들러가 `transportFetch(target, { request: req, ... })` 로 browser-set 헤더 전달 (이전엔 Accept-only).

**부분 진척**: NAVER GLAD SafeFrame iframe 의 bodyLen 180 → 249 (loader script src 가 `/zp/api/script?u=...` 로 정상 routing 됨). 그러나 SafeFrame loader 가 여전히 `document.write(adm)` 호출에 도달 못 함 → 광고 미렌더. SW 디버그 trace 로 `transportFetch` 가 모든 ssl.pstatic.net 스크립트 (`gfp-display-sdk.js`, `gfp-display-nda.js`, `ndp-core.js` 등) 에 status 200 반환 확인 → kernel 정상, 추가 layer 가 막음. (다음 디버깅 필요: 실제 iframe 안에서 rewritten safeframe.js 가 어디서 throw 하는지.)

**Regression Tests**:
- 기존 E1 escape matrix 회귀 없음 (3/6 ad slots 정상 — `da_public_left/right_tgtLREC`, `veta_time2_tgtLREC`).
- NAVER 페이지 자체는 정상 렌더 (title="NAVER", body 110KB+, 156 nav links).
- `cargo test --workspace`: 63 pass, `rewriter-rs`: 3 pass, `node test/js/static-policy.test.js`: 14/14 pass.

---

## 2026-05-30 — `decode_common_html_entities` 가 string-literal 안의 entity 데이터 파괴 → PARSE_FAILED

**Site/Pattern**: NAVER GFP SafeFrame `gfp-display-safeframe.js` (`https://ssl.pstatic.net/tveta/libs/glad/prod/3.10.4/...`).

**Symptoms**:
- SW 가 외부 스크립트 fetch 후 `rewriteScriptResponse` 에서 `ZPRewriter.rewriteScript(source)` 호출 → `{ok:false, errorCode:"PARSE_FAILED"}` 반환.
- iframe 광고 (`ad_timeboard_tgtLREC`, `pc-main-ad-div-p_main_rightside_understock_tgtLREC`, `pc-main-ad-div-p_main_rightbottom_widget_tgtLREC`) 안에서 SafeFrame loader 가 silent 실패 → `document.write(adm)` 도달 못 함 → 광고 미렌더.
- `window.onerror = ()=>true` 가 묻어 stack trace 안 보임.

**Root Cause**:
- [rewriter-rs/src/lib.rs](rewriter-rs/src/lib.rs#L37) `decode_common_html_entities` 는 [.ai/trap-notebook/rewriter.md 2026-05-29](rewriter.md#2026-05-29) "PARSE_FAILED on HTML-entity JS" 때 React `dangerouslySetInnerHTML` 가 `=>` 를 `=&gt;` 로 박은 케이스 받기 위해 추가됨.
- 그러나 `rewrite_script` 가 **모든 input 에 무조건** decode 를 걸어버려서, JS string literal 에 entity 가 **데이터로** 들어있는 외부 스크립트도 파괴.
- SafeFrame 는 자체 HTML escape 용 `t.encMap={"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"}` 를 가짐. decoder 가 `"&quot;"` → `"\""` 로 바꿔서 `'"':"\"" ` → `'"':"\""` → `'"':"""` (unterminated string literal). OXC 가 `Expected `,` but found `string`` 으로 PARSE_FAILED.

**Fix**:
- [rewriter-rs/src/lib.rs](rewriter-rs/src/lib.rs#L84) `rewrite_script` 에서 `decode_common_html_entities` 호출 제거. Rust 측은 raw source 그대로 OXC 에 전달.
- [web/runtime-prelude.js:781-802](web/runtime-prelude.js#L781-L802) `decodeInlineEntities(src)` 추가. `__ZP_EXEC_INLINE_SCRIPT` / `__ZP_EXEC_INLINE_MODULE` 가 rewriter 호출 전에 JS 측에서 decode 수행. **inline `<script>` 경로만** decode 적용 (browser raw text mode 라 HTML entity 가 보존된 채 textContent 로 들어오므로 React encoded JS 케이스는 여기서 decode).
- 외부 스크립트는 raw byte → decode 없음 → 데이터 보존.

**Regression Tests**:
- `rewriter-rs/tests/safeframe_parse.rs` — OXC 가 safeframe.js 를 raw 로 파싱 성공해야 함 (decoder 없이).
- `rewriter-rs/tests/safeframe_rewrite.rs` — `rewrite_script("classic")` 가 `ok=true` 반환해야 함.

---

## 2026-05-30 — iframe 에 `__zp_*` helper 부재 → SW rewrite 한 외부 스크립트 silent 실패

**Site/Pattern**: NAVER GFP SafeFrame 같이 `about:blank` iframe 안에서 외부 스크립트 (`<script src="https://ssl.pstatic.net/...">`) 가 SW rewrite 받아 실행되는 모든 케이스.

**Symptoms**:
- iframe 안에서 SW rewrite 된 스크립트가 `__zp_get(globalThis, "document")` 같은 helper 호출 → `ReferenceError: __zp_get is not defined`.
- `window.onerror = ()=>true` 가 묻어 silent.
- iframe body 가 loader template 만 남고 ad 미렌더.

**Root Cause**:
- `installPhase2Membrane()` ([web/runtime-prelude.js:487](web/runtime-prelude.js#L487)) 만 `__zp_get`/`__zp_set`/`__zp_call`/`__zp_construct`/... 를 `root` 에 install.
- `about:blank` iframe (NAVER ad 처럼 부모가 동적 생성) 은 자체 prelude 가 안 돔 — 부모가 `installNetworkContainment(iframe.contentWindow)` 만 호출.
- `installNetworkContainment` 은 fetch/XHR/WebSocket/storage 등 wrap 하지만 `__zp_*` helper 는 install 안 함 → iframe 안 SW-rewrite 코드가 helper 부재로 즉시 throw.

**Fix**:
- [web/runtime-prelude.js:2641-2666](web/runtime-prelude.js#L2641-L2666) `installNetworkContainment` 에 모든 `__zp_*` helper 를 부모 wrapper 로 위임 install 추가. 부모 closure 가 멤브레인 의미 (location 가상화, dynamic ctor wrap, dangerous-prop dispatch) 보존. `base[prop]` fall-through 가 iframe own native 접근으로 자연 routing.

**Regression Tests**:
- E1 escape matrix 의 about:blank iframe + SW-rewrite 외부 스크립트 케이스가 정상 실행 + 멤브레인 의미 유지.

---

## 2026-05-30 — Contextual paren prefix (METHOD_CALL/MEMBER_GET/MEMBER_SET/GLOBAL_GET emission)

**Site/Pattern**: NAVER 웹툰 (comic.naver.com) `kw-owner/index.js` 의 `function ch(e){return("string"==typeof e?e:""+e).replace(cd,"\n").replace(cf,"")}` 같은 패턴, 그리고 NAVER `new globalThis.Request("https://empty.invalid", {body:...})`.

**Symptoms**:
- `return(__zp_call(...))` 의 leading `(` 가 source 의 `return` 뒤 `(` 와 어떻게 결합하느냐에 따라 두 가지 ASI/identifier-glue 버그:
  1. emission paren 없으면 `return__zp_call(...)` 단일 식별자로 파싱 → `ReferenceError: return__zp_call is not defined`.
  2. emission 항상 paren `(__zp_call(...))` 면 `var x=1\n(call)` 가 `var x=1(call)` 으로 ASI 깨짐 → `TypeError: 1 is not a function`.
- `new globalThis.Request(args)` 가 `new __zp_get(globalThis,"globalThis").Request(args)` 로 rewrite 되면 `new MemberExpression Arguments` 문법이 `(new f(a)).b(c)` 로 파싱 → `.Request(args)` 가 일반 함수 호출 → `Failed to construct 'Request': Please use the 'new' operator`.

**Root cause**: emission 의 leading byte 가 source 의 preceding context 와 호환되어야 함:
- prev byte 가 identifier-continue (영숫자/`_`/`$`) 면 keyword 또는 식별자와 glue 가능 → paren 으로 격리 필요.
- prev token 이 `new` keyword 면 `new MemberExpression Arguments` 문법이 가장 가까운 Arguments 와 결합 → paren 으로 보호 필요.
- 그 외 (whitespace + non-identifier prev byte) 면 paren 추가하면 ASI 가 깨짐 → paren 미추가.

**Fix** (`crates/zp-rewriter/src/lib.rs` + `rewriter-rs/src/lib.rs`):
- `apply_patches` 에 `needs_paren_prefix(start)` closure 추가. prev byte 가 identifier-continue 거나 prev non-ws token 이 `new` 면 `true`.
- 모든 emission point (METHOD_CALL, MEMBER_GET, MEMBER_SET, GLOBAL_GET, render_expression) 에서 paren 추가 여부 결정.
- `emit_global_get` 는 marker 만 emit 하고 (`\u{1}GLOBAL_GET\u{1}<name>\u{1}`) apply_patches 가 context 기반 paren 처리.
- 회귀 테스트 추가: `new_global_member_constructor_preserved`, `return_followed_by_parenthesized_method_call`, `return_followed_by_parenthesized_replace_call`.

**Lessons**:
- AST 기반 in-place patching 은 source 의 lexical context (preceding char/token) 까지 고려해야 syntactically valid 한 출력 보장.
- 단순 always-paren 또는 never-paren 모두 위반 사이트 존재. contextual 결정이 필수.
- `new`, `return`, `typeof`, `void`, `delete`, `await`, `yield` 등 keyword 뒤 emission 은 특별 처리. 향후 다른 keyword 케이스 발견 시 needs_paren_prefix 확장.

---

## 2026-05-30 — `super` keyword rewrite skip

**Site/Pattern**: NAVER 웹툰 (comic.naver.com) → `kw-owner/index.js` 가 React 내부 minified 클래스에서 `super.X` / `super.method(args)` 호출. 우리 OXC AST 리라이터가 `super` 받침을 `__zp_get(super, "X")` / `__zp_call(super, "X", [...])` / `__zp_set(super, "X", v)` 로 wrap → `'super' keyword unexpected here` SyntaxError → 전체 React 초기화 실패 → 페이지 빈 렌더.

**Symptoms**:
- DevTools console: `Uncaught SyntaxError: 'super' keyword is only allowed inside a class method`.
- React 마운트 안 됨, body 비어 있음.
- 다른 NAVER 페이지는 정상 → `super` 가 노출된 minified bundle 특유의 문제.

**Root cause**: `super` 는 ECMAScript 식별자 표현식이 아니라 keyword. 클래스 method body 안의 `super.X` 받침은 그대로 두어야 native binding 이 유지됨. `__zp_get(super, ...)` 처럼 함수 인자로 넘기는 순간 parser 가 거부.

**Fix** (`crates/zp-rewriter/src/lib.rs`):
- `visit_static_member_expression` (MEMBER_GET emission) — `matches!(expr.object, Expression::Super(_))` → early return.
- `visit_assignment_expression` (MEMBER_SET emission) — 동일.
- `visit_call_expression` (dangerous method METHOD_CALL emission) — `matches!(member.object, Expression::Super(_))` → early return.

**Lessons**:
- AST visitor 에서 `Expression::Super` 를 식별자처럼 받침으로 받으면 안 됨. `super` 받침은 lexically only valid inside class method body.
- minified 코드는 `super.X` 를 자유롭게 사용 (extends 체인). 이 패턴 무시하면 광범위 페이지 깨짐.
- 회귀 테스트 4 개 추가: `super_member_access_not_rewritten`, `super_call_not_rewritten`, `super_method_call_not_rewritten`, `super_constructor_with_extends_globalthis_member`.

---

## 2026-05-30 — 상대 URL subresource resolution (proxied_subresource_url 가 target_url base 사용)

**Site/Pattern**: NAVER 광고 iframe (`/_next/image?url=...`), 외부 사이트 `<img src="static/a.css">` 같은 host-relative / path-relative subresource.

**Symptoms**:
- 브라우저가 `<img src="/_next/image?url=...">` 를 `proxy.localhost:18080/_next/image?...` 로 fetch → SW classifier 가 `/zp/` prefix 없어 UNKNOWN → 404.
- 이미지/CSS/스크립트 깨짐 cascade.

**Root cause**: `zp-htmltx::proxied_subresource_url` 가 relative URL 이면 `None` 반환 = 그대로 둠. 그러나 SW classify 는 `/zp/` prefix 만 routing → host-relative 가 proxy origin 에 resolve 되어 fetch 실패.

**Fix** (`crates/zp-htmltx/src/lib.rs`):
- `proxied_subresource_url(raw, proxy_origin, control_prefix, target_url)` — target_url 인자 추가, `resolve_against_base` 헬퍼로 host-relative/path-relative/query-relative/fragment-relative 처리 후 absolute proxy URL 생성.
- `absolute_target_url(raw, target_url)` 도 동일 업데이트 (canonical link href 등에 사용).
- 회귀 테스트 추가: `host_relative_img_resolved_against_target` (`/_next/image?...` 케이스), 기존 `relative_subresource_left_alone` 등 3 개 테스트 갱신.

**Lessons**:
- "SW VIRTUAL_SUBRESOURCE 가 잡으니까 그대로 두면 된다" 는 잘못된 가정이었음. classifier 는 `/zp/` prefix 만 본다.
- 모든 relative URL 은 transform 단계에서 absolute proxy URL 로 변환해야 SW 가 가로챌 수 있음.

---

## 2026-05-29 — Inline script 더블 리라이트 (zp-htmltx 가 미리 rewrite → prelude 가 wrap 후 다시 rewrite)

**Site/Pattern**: naver 햄버거 메뉴 iframe (m.naver.com/aside) 의 inline `<script>window.nmain.gv = {...}</script>` 가 비어있는 객체에 property 설정 시도 → `TypeError: Cannot set properties of undefined (setting 'contentsNavi')` cascade. 결과로 webpack entry 가 hydration 실패.

**Symptoms**:
- iframe 의 inline script `<script>window.nmain.gv = {isLogin: false, isApp: false, ...}</script>` 가 실행 후 `window.nmain.gv` 가 `undefined` 로 남음.
- 다음 inline script `window.nmain.gv.contentsNavi = [...]` 가 throw.
- 페이지 visible body 11 글자만 ("네이버 홈 확장 메뉴" title only) — 모든 hydration 실패.

**Root cause**:
1. `zp-htmltx` 가 inline script body 를 발견하면 `rewrite_script()` 호출 → rewritten code 를 chunk 에 emit. 결과: `<script>__zp_get(globalThis,"window").nmain.gv = {...}</script>`.
2. 페이지 로드 시 `runtime-prelude` 의 `prepareScriptElement(el)` 가 inline script 의 textContent 를 보고 `__ZP_EXEC_INLINE_SCRIPT("<text>")` 로 wrap. text 는 이미 rewritten code.
3. `__ZP_EXEC_INLINE_SCRIPT` 가 실행 시점에 `rewriteWithPageRewriter(source, "classic")` 호출 → **이미 rewritten 된 code 를 다시 rewrite**.
4. 이중 rewrite 결과 `__zp_get(globalThis, "__zp_get")(globalThis, "window")...` 같은 mangle. `__zp_get(globalThis, "__zp_get")` 는 `undefined` 반환 → undefined 을 호출 → throw.

**Fix**:
- [crates/zp-htmltx/src/lib.rs#L199](../../crates/zp-htmltx/src/lib.rs#L199) `rewrite_inline_script_bodies` 변경.
- inline script body 를 **rewrite 하지 않고** 그대로 `__ZP_EXEC_INLINE_SCRIPT("<rawSource>")` 로 wrap 만 emit.
- 단, strict mode 검증을 위해 `rewrite_script(&src, &opts)` 는 호출 (parse OK 확인). 실패하면 `BLOCKED_SCRIPT` emit.
- runtime-prelude 의 `prepareScriptElement` 가 `isPreparedInlineScript(text)` 체크로 `__ZP_EXEC_INLINE_SCRIPT(...)` 시작 시 wrap skip → 이중 wrap 도 회피.
- 새 helper `inline_script_payload(src)` 는 src 를 JSON string literal 로 serialize (`</` escape 포함 — `</script>` 종료 시퀀스 차단).

**Regression guard**:
- `crates/zp-htmltx/src/lib.rs` 의 `inline_script_rewrites_location` / `module_script_rewrites_window` 테스트 갱신. wrap 존재 + raw payload 보존 검증.
- 추가 TODO: puppeteer E2E — naver 햄버거 메뉴 click 후 `iframe.contentWindow.document.body.innerText.length > 100` 확인.

**Patterns to watch**:
- **HTML transform 시 inline script 를 rewrite 하면 runtime layer 가 또 rewrite 한다는 점**.
- 일반 원칙: 한 layer 에서만 rewrite. 우리는 runtime layer 에서만 rewrite (런타임에서 virtualURL/멤브레인 사용 컨텍스트 정확).
- 다른 비슷한 pattern: event handler attribute (`on*=...`) — htmltx 가 rewrite + runtime 이 wrap. event 케이스는 한 번만 처리되도록 확인 필요.

**See also**: 이 fix 이후 햄버거 메뉴 iframe 의 React/webpack hydration 정상화 (#app html length 0 → 35562). 잔여 단일 `Blocked by ZeroProxy policy` 에러는 NAVER 광고 iframe 의 Next.js RSC streaming hydration — 별개 함정.

---

## 2026-05-29 — Rewriter PARSE_FAILED on HTML-entity-encoded JS (React `dangerouslySetInnerHTML`)

**Site/Pattern**: NAVER recoshopping.naver.com Next.js iframe. Inline darkmode script `(function() { const nscsValue = document.cookie.split("; ").find((row) => row.startsWith("NSCS=")); ... })()` 가 `=>` 대신 `=&gt;` 로, `&&` 대신 `&amp;&amp;` 로 전달됨.

**Symptoms**:
- ZPRewriter.rewriteScript 가 PARSE_FAILED diagnostic 반환 → __ZP_EXEC_INLINE_SCRIPT throw NotSupportedError → Next.js error boundary 가 "Application error: a client-side exception has occurred" 으로 catch.
- 단일 에러로 보이지만 cascade 없음 (inline script 만 실패하고 webpack runtime 은 따로 로드됨).

**Root cause**:
React 의 `dangerouslySetInnerHTML` 는 string 을 element 의 innerHTML 로 set. 그러나 Next.js 의 SSR streaming 출력이 RSC payload 안에 JSON-encoded 형태로 JS body 를 박을 때, `>` 는 `>` 로 encoded. JSON parse 후 `>` 가 됨. React 가 createElement 후 어떤 path 에서 HTML serializer 를 통과해서 `>` → `&gt;` 가 됨.
이게 our wrapper `__ZP_EXEC_INLINE_SCRIPT(source)` 에 전달될 때 source 는 entity-encoded form. OXC parser 가 `=&gt;` 를 syntax error 로 거부.

**Fix**:
- [rewriter-rs/src/lib.rs](../../rewriter-rs/src/lib.rs) 의 `rewrite_script` 진입 시점에 `decode_common_html_entities(source)` 호출.
- 안전한 named entity (`&gt;` `&lt;` `&amp;` `&quot;` `&apos;` `&nbsp;`) + numeric escape (`&#39;` `&#x27;`) 만 decode. UTF-8 안전.
- Strict mode fail-closed semantics 유지: decode 후에도 parse 실패하면 여전히 `ok: false`.

**Regression guard**: TODO
- 단위테스트: `rewriter-rs` 에 `=&gt;` 와 `&amp;&amp;` 가 든 source 가 rewrite 성공하는지 assert.
- 추가 E2E: naver shopping iframe 의 darkmode `<script>` 가 ZPRewriter.rewriteScript 통해 ok=true 반환.

**Patterns to watch**:
- React/Next.js 의 RSC streaming 출력에서 HTML entity encoding 이 자주 사용됨.
- 다른 framework (Vue SSR, Svelte 등) 도 같은 패턴 가능. 모든 inline JS source 에 entity decode 적용이 안전.

**See also**: [inline 더블 리라이트](#2026-05-29--inline-script-더블-리라이트-zp-htmltx-가-미리-rewrite--prelude-가-wrap-후-다시-rewrite) 와 함께 적용. naver hamburger menu (m.naver.com/aside) + shopping iframe 의 darkmode script 둘 다 fix.

---

## 기록할 종류

- AST 변환에서 누락된 노드 타입 (예: `class` field, `decorator`, dynamic `import()`, optional chaining write target 등)
- URL 리라이트의 누락된 attribute / element 조합 (예: `<svg image href=…>`, `<picture><source srcset=…>` 등)
- proxy_origin 절대 URL 발행 누락
- script kind 분류 오류 (module/classic 오인식)
- sourcemap composition 회귀
