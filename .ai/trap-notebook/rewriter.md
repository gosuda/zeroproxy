# Rewriter Regressions

`crates/zp-rewriter` (OXC AST 변환) 와 `crates/zp-htmltx` (HTML 토크나이저 + URL 리라이트).

---

## srcset 쉼표와 숫자 엔티티 — 이미지 400 이 56건이었다 (2026-08-24, CNN)

CNN 정지를 고친 뒤 콘솔에 `400 (Bad Request)` 이 33건 남아 있었다. 네트워크
테이프로 보니 전부 `media.cnn.com` **이미지**였다(광고 프레임이 아니다).

### ① srcset 을 첫 쉼표에서 끊고 있었다

실패한 요청의 **원본**(디코드하지 말고 볼 것):

```
?url=…iran-crisis-economy.jpg%3Fc%3D16x9%26q%3Dh_1080,http://proxy.localhost:18080/zp/api/fetch?url=…
                                                     ^^^ 인코딩이 끊기고 두 번째 URL 이 붙었다
```

성공한 건은 `…%2Cw_270%2Cc_fill` 로 쉼표가 인코딩돼 있다. 차이는 **URL 이 어디서
끊겼는가** 뿐이다.

CNN 이미지 URL 은 쿼리에 쉼표를 담는다(`?c=16x9&q=h_1080,w_1920,c_fill`).
HTML srcset 문법에서 후보 URL 은 **공백까지의 비공백 런**이고, 쉼표는 URL
**뒤에 붙었을 때만** 구분자다. 그런데 구현은 첫 쉼표에서 끊고 `data:` 만
예외로 뒀다 — 그래서 **쿼리에 쉼표가 든 평범한 URL 이 반토막** 났다.

**바로 위 주석이 이미 올바른 규칙을 적어 두고 있었다.** 코드가 그 규칙을
구현하지 않고 예외만 덧댄 것이다. 예외를 덧대는 순간 "규칙이 뭔지" 를 다시
묻지 않게 된다.

Rust(`split_srcset_candidates`)와 JS(`splitSrcsetCandidates`) **양쪽 다** 같은
버그였고, 양쪽을 규칙대로 고쳤다. `data:` 예외는 필요 없어져 지웠다 —
쉼표가 URL 안에 있으면 후행이 아니므로 규칙만으로 살아난다.
파리티 픽스처에 실측 케이스 3개 추가(변이 4/4, JS·Rust 각 2).

### ② 숫자 HTML 엔티티가 표에 없었다

①을 고치니 400 이 56 → 5 로 줄고 `.mp4?c&` 형태만 남았다. **대조군에는 그런
요청이 0건**이라 우리 것이 확실했다. 격리 월드로 DOM 을 보니:

```
source[src] = …%2Ftupac-cnn-loop2.mp4%3Fc%26#x3D;original
```

원본 속성은 `…mp4?c&#x3D;original` 이고 `&#x3D;` 는 **`=`** 다. 엔티티를 안 푼
채 URL 인코딩을 하니 `&` 는 `%26` 이 되고 남은 `#x3D;original` 이
**프래그먼트로** 흘렀다.

`decode_url_html_entities` 는 있었지만 **손으로 적은 표**였다(`&amp;`, `&sol;`,
`&#x2f;` …). 숫자 엔티티는 무한하므로 표로 못 따라간다 — **규칙으로** 풀도록
`numeric_entity_char` 를 넣었다(`&#61;` / `&#x3D;` / `&#X3D;`). 숫자가 아닌
`&#zz;` 같은 것은 그대로 둔다.

**오늘 두 번째로 같은 교훈이다**: 목록/표로 따라가려는 자리는 결국 뚫린다.
컬렉션 표면(`prop in raw`)도, 여기도 규칙으로 바꿨다.

### 실측

| | 총 400 | media.cnn 400 | 요소 |
|---|---|---|---|
| 고치기 전 | 33 | 56* | 3,996 |
| ① 후 | 6 | 5 | 4,034 |
| ①+② 후 | **1** | **0** | **4,034** |

\* 응답 이벤트 기준(요청 재시도 포함). 대조군 요소 수는 4,015~4,025 로
프록시가 이제 그 범위 위다.

### 남은 것 — 프레임 수

대조군 30~34(3회 측정: 34/30/30) vs 프록시 **11**. 요소 수는 붙었는데 광고
iframe 만 안 뜬다. 남은 신호: `Blocked script execution in 'about:blank' …
sandboxed` 7건, `__zp_get(...).turner_getGuid is not a function` 5건,
`Uncaught NotSupportedError: Blocked by ZeroProxy rewrite policy` 1건.
**아직 조사 안 했다.**

## CNN 이 렌더러를 세운 진짜 원인 — 교차창 프록시의 parent 가 자기 자신이었다 (2026-08-24)

### 결론부터

`safeCrossWindow` 가 만드는 교차창 프록시의 `top`/`parent` 가 **자기 자신**을
돌려주고 있었다. 광고/동의(CMP) 코드는 거의 예외 없이 이렇게 조상을 훑는다:

```js
while (!found) {
  try { if (w.frames.__cmpLocator) found = w; } catch {}
  if (w === window.top) break;      // ← 유일한 탈출구
  w = w.parent;
}
```

**손자 프레임(깊이 2 이상)** 에서는 `window.top` 과 `window.parent` 가 서로 다른
프록시다. 그런데 부모 프록시의 `.parent` 가 자기 자신이니 `w` 는 거기서 영원히
멈추고, `w === window.top` 은 영원히 false 다 — **무한 루프.**

깊이 1(부모가 곧 top)에서는 우연히 수렴한다. **그래서 얕은 픽스처로는 재현이
안 됐다.**

### 어떻게 좁혔나 — 도구를 세 번 바꿨다

1. **JS 계수기(문서 시작 주입)** — DOM API 를 프레임별로 셌다. 1차 원인
   (getAttribute 1.7M, O(N²) 컬렉션)을 여기서 잡았다. 고친 뒤에도 정지가
   남았고 계수기는 조용했다 → **DOM 을 안 쓰는 정지**.
2. **트레이스(CDP Tracing, 브라우저 프로세스)** — 메인 스레드 마지막 이벤트가
   `v8.run` **시작만 있고 끝이 없었다.** 즉 우리가 실행시킨 인라인 스크립트가
   돌아오지 않는다. 인라인 실행 지점(`__ZP_EXEC_INLINE_SCRIPT`)에 임시 로그를
   넣어 `[ZPINLINE]` 은 찍히고 `[ZPINLINE-DONE]` 이 안 찍히는 것으로 범인을
   **PubMatic 인라인 스크립트(22,198자)** 로 특정했다.
3. **CPU 샘플러(`--categories disabled-by-default-v8.cpu_profiler`)** — 결정타.
   샘플러는 별도 스레드라 **JS 가 무한 루프여도 찍힌다.** 마지막 구간 상위:

   ```
   13,901  Oi       @ runtime-prelude.js:32
    5,682  no       @ runtime-prelude.js:13
    4,181  get top
   ```

   `get top` 이 상위에 뜬 순간 방향이 정해졌다.

### 소스를 받아서 본 것

인라인 소스를 콘솔로 1,800자씩 청크 덤프해 재구성했다(선언 길이와 정확히 일치
= 완전). 그 안에 같은 모양의 상승 루프가 **6개**(`__cmpLocator`, `__tcfapiLocator`,
`__uspapiLocator`, `__gppLocator` …). 즉 이 패턴은 PubMatic 하나의 특이사항이
아니라 **광고/동의 생태계의 표준 관용구**다.

### 틀린 가설 하나 — 기록해 둔다

"프레임 사슬이 수렴하지 않는다" 는 **처음에 세웠다가 반증했다.** 2단 픽스처에서
`top`/`parent` 동일성과 수렴을 재니 정상이었다(walkSteps 0/1, converged true).
그래서 이 가설을 접고 다른 데를 봤다.

**틀린 것은 가설이 아니라 픽스처였다.** 깊이 1 은 우연히 수렴하는 케이스라
음성 대조가 될 수 없었다. **재현이 안 되면 "가설이 틀렸다" 와 "재현 조건이
부족하다" 를 먼저 구분할 것.** 이번엔 CPU 샘플러가 되돌려 세워 줬다.

### 고친 것

`climbCrossWindow(targetWindow, prop, fallback)` — 진짜 사슬을 한 칸 올라간다.
`top`/`parent` 는 교차 출처에서도 읽을 수 있는 몇 안 되는 속성이라 접근 자체는
막히지 않는다. 프록시 캐시가 **실제 창을 키로** 쓰므로 올라가다 보면 결국
`window.top` 과 **같은 객체**에 닿는다. 못 읽거나(던지거나) 자기 자신이면
제자리에 머문다(= 사슬의 끝).

### 검증

| | 직접 로드 | 프록시(고치기 전) | 프록시(고친 뒤) |
|---|---|---|---|
| CNN 요소 수 | 3,963 | — (렌더러 정지) | **3,977** |
| 프레임 | 29 | — | 11 |
| 40초 생존 | 예 | **아니오** | **예** |

가드는 창 3단을 흉내 내 **CMP 루프를 실제로 돌린다**(변이 3/4 뭄. 나머지 하나는
캐시 때문에 무해함이 같은 측정으로 증명된다).

### 남은 것

프레임 수가 대조군 29 vs 프록시 11 이다. 정지는 사라졌지만 **일부 프레임이 안
뜨는 것은 그대로**다 — 별도 항목으로 남긴다. 중첩 픽스처에서도 프록시는 한 단만
만들어졌다(깊이 3 요청에 iframe 1개). 같은 뿌리일 가능성이 있다.

## 설치 검증이 값 비교라 객체 게터에서 영원히 실패했다 — navigator.userAgentData (2026-08-24)

### 어떻게 찾았나 — 엔진이 던지는 예외

CNN 정지 원인을 쫓다가 `debugger-arm --strategy exceptions` 를 걸었더니 예외
1,476건이 잡혔고, 그중 **우리 것**이 있었다:

```
ReferenceError: Cannot access 'Sr' before initialization
    at Wo (runtime-prelude.js)         ← targetBrandList
    at Ho (runtime-prelude.js)         ← virtualUserAgentData
    at Navigator.userAgentData (runtime-prelude.js)
```

**이 예외는 페이지의 `Error` 를 감싸서는 절대 안 보인다**(엔진이 던진다).
`debugger-arm --strategy exceptions` 가 유일한 통로였다.

### 첫 진단은 절반만 맞았다

TDZ 는 진짜였다 — `defineOnProto` 가 설치 직후 **게터를 부르는데**
(`instance[key] === get.call(instance)`), 그 게터가 참조하는
`let cachedUADataBrands` 가 모듈 본문 뒤쪽에 있어 아직 초기화 전이었다.
선언을 위로 올렸다.

**그런데 고쳐도 증상이 그대로였다.** 그래서 다시 봤고 진짜 원인이 나왔다:

`virtualUserAgentData` 는 **호출마다 새 객체**를 만든다. 그러니
`instance[key] === get.call(instance)` 는 두 개의 다른 객체를 비교하는 셈이라
**영원히 false** 다. 매번 폴백으로 빠져 그 속성만 navigator **인스턴스에도**
정의됐다.

같은 블록의 `userAgent`·`appVersion`·`platform`·`languages` 는 문자열을
돌려주므로 멀쩡했다 — **"대부분 맞으니 맞겠지" 가 통하지 않는 자리**였고,
그래서 오래 안 보였다.

### 대조군이 판정했다

| | 직접 로드 | 프록시(고치기 전) |
|---|---|---|
| `getOwnPropertyNames(navigator)` 에 `userAgentData` | **false** | **true** |
| `navigator` own 속성 개수 | 0 | 1 |

한 줄짜리 탐지기다.

### 고친 것

1. **설치 확인을 서술자로 한다 — 게터를 부르지 않는다.**
   확인하려는 것은 "프로토타입에 우리 접근자가 놓였고, 인스턴스에 그걸 가리는
   own 속성이 없다" 뿐이고 둘 다 `getOwnPropertyDescriptor` 로 알 수 있다.
   부작용(TDZ)도 같이 사라진다.
2. **가상 UAData 가 진짜 `NavigatorUAData.prototype` 을 상속한다.**
   값은 **중간 프로토타입**에 접근자로 올린다 — 인스턴스에 직접 얹으면
   실제 프로토타입의 읽기전용 접근자와 충돌해 던지고(측정: `Cannot set property
   brands of #<NavigatorUAData> which has only a getter`), 무엇보다 진짜
   인스턴스는 own 속성이 **0개**다.

### 최종 실측 — 열 항목이 대조군과 일치

| | 직접 | 프록시 |
|---|---|---|
| `navigator` own 에 노출 | false | false |
| `navigator` own 개수 | 0 | 0 |
| `instanceof NavigatorUAData` | true | true |
| `constructor.name` | NavigatorUAData | NavigatorUAData |
| `Object.prototype.toString` | `[object NavigatorUAData]` | 같음 |
| UAData 자신의 own 속성 개수 | 0 | 0 |
| `mobile` / `platform` / `getHighEntropyValues` | false / Windows / function | 같음 |

### 재 보길 잘한 것

`navigator.userAgentData === navigator.userAgentData` 를 "동일성이 흔들리면
지문" 이라고 고치려다 **대조군을 먼저 쟀다 — 실제 브라우저도 false 다.**
안 쟀으면 실제와 **다르게** 만들어 놓고 고쳤다고 적을 뻔했다.

### 아직 안 닫혔다

CNN 정지의 진짜 원인은 이게 아니다. 트레이스상 마지막 메인 스레드 이벤트는
`v8.run` 의 **시작만 있고 끝이 없다** — 즉 우리가 실행시킨 인라인 스크립트가
돌아오지 않는다. 계측으로 범인을 특정했다: **PubMatic 광고 스크립트(인라인
22,198자)**. `__ZP_EXEC_INLINE_SCRIPT` 에 임시 로그를 넣어 `[ZPINLINE]` 은
찍히고 `[ZPINLINE-DONE]` 이 안 찍히는 것으로 확인했다(계측은 걷어냈다).

프레임 사슬 가설(`ap.top||ap` 상승 루프)은 **반증됐다** — 합성 픽스처에서
`top`/`parent` 동일성과 수렴을 재니 정상이었다(walkSteps 0/1, converged true).

## "잉여니까 지우자" 가 진짜 결함 하나를 꺼냈다 — 컬렉션 표면 (2026-08-24)

### 출발점

CNN 의 O(N²) 를 고치며 넣은 스냅샷 루프 5벌이 변이 시험에서 **잉여**로 판정됐다
(메모이제이션만 load-bearing). 지우려고 **실제 DOM 이 뭘 노출하는지 먼저 쟀다.**

### 측정 (example.com, 프록시 없음)

| | `forEach`/`values`/`keys`/`entries` | `@@iterator` |
|---|---|---|
| `NodeList` (`querySelectorAll`) | **있음** | `Array.prototype.values` |
| `HTMLCollection` (`document.scripts`, `getElementsByTagName`) | **없음** | `Array.prototype.values` |
| `NamedNodeMap` (`attributes`) | **없음** | `Array.prototype.values` |

그리고:

- `NodeList.prototype.forEach === Array.prototype.forEach` → **true**.
  `values`/`keys`/`entries` 도 전부 `Array.prototype.*` 와 같은 객체.
- **브랜드 체크가 없다** — `NodeList.prototype.forEach.call({length:0}, f)` 가 돈다.
  ⇒ 우리 프록시를 `this` 로 넘기면 `length`/인덱스 트랩을 타므로 **필터가 유지된다**.
- 메서드는 접근할 때마다 **같은 객체**(`nl.forEach === nl.forEach`).
- live 컬렉션은 순회 중 원본이 자라면 **그걸 본다**(측정: 순회 중 append → 2개).

### 드러난 결함

우리 필터 Proxy 는 **여섯 호출처(그중 넷이 live)에 한 벌의 가짜 표면**을 씌우고
있었다. 그래서 `'forEach' in c === false` 인데 `typeof c.forEach === 'function'` 인
**자기모순**이 났다. 탐지기에 축을 넣어 재니 **사이트와 무관하게 매번 15건**
(naver / wikipedia / HN 전부 15). 고친 뒤 **0건**, 7개 사이트 전부.

15건의 내역: `document.scripts`·`attributes` 의 네 메서드 ×2 = 8,
`@@iterator` 동일성 ×3, `NodeList.forEach` 동일성 1, 접근마다 흔들리는 동일성 3.

### 고친 것 — 규칙 하나로

**표면은 raw 가 실제로 가진 것만 노출한다**(`prop in raw`). 유지할 목록이 따로
없다 — 감싼 대상이 곧 명세다. 순회 메서드는 흉내 내지 않고 `Array.prototype.*`
**그 자체**를 돌려준다. 결과:

- 스냅샷 루프 5벌 → 규칙 2줄. **지우고 싶던 잉여가 실제로 사라졌다.**
- live/static 구분이 저절로 맞는다.
- 동일성이 맞는다(`c[Symbol.iterator] === Array.prototype.values`).
- live 순회가 원본 변화를 다시 본다(스냅샷은 못 봤다).
- `item`/`getNamedItem` 과 폴백 bind 를 인스턴스마다 캐시해 **동일성 안정화**.
- 빈 결과에 배열 대신 **진짜 빈 NodeList** 를 쓴다(분리된 요소에 네이티브 qSA).
  안 그러면 `item` 없고 `forEach` 있는 잡종이 된다.

### 재현 안 된 것은 고치지 않았다 — 이름 기반 접근

`get` 폴백이 `raw[prop]` 이라 HTMLCollection 의 **named getter** 로 숨긴 노드가
되돌아 나올 수 있다고 코드에서 유도했다(`isZPAssetNode` 가 `id === '__zp-boot'` 를
숨김 근거로 쓴다). **브라우저에서 재현되지 않았다**: `clearBootConfig()` 가 그
노드를 제거하고(runtime-prelude.js), 숨기는 나머지 노드에는 id/name 이 없다
(격리 월드 실측: script 5개, id 0개). named getter 는 id/name 으로만 찾으므로
**도달 가능한 대상이 없다.**

**잠재 조건은 남는다**: 숨기는 노드가 언젠가 id 나 name 을 갖게 되면 그 폴백이
필터를 우회한다. 지금 고치면 재현도 안 되는 것에 코드를 더하는 셈이라 두었다.

### 변이 시험 — 이번엔 8/8

지난번 3/6 때 "안 무는 변이" 셋은 가드 약점이 아니라 **그 변경이 무해하다는
증거**였다. 이번에도 하나 나왔다: `@@iterator` 에 걸어 둔 `inRaw` 게이트를 떼도
아무 가드가 안 물었다 — 셋 다 @@iterator 를 가지므로 **한 번도 발화하지 않는
조건**이었다. 그래서 가드를 늘리는 대신 **그 게이트를 지웠다.** 나머지 miss 하나
(폴백 bind 동일성)는 진짜 가드 구멍이라 케이스를 추가했다. **miss 를 만나면 먼저
"이 변이가 실제로 해로운가" 를 묻는다** — 아니면 지울 코드를 찾은 것이다.

## 우리 필터 컬렉션이 O(N²) 이라 CNN 이 렌더러를 세웠다 (2026-08-24)

### 증상

`https://www.cnn.com/` 을 프록시로 열면 렌더러가 멎는다. 직접 로드는 멀쩡하다
(iframe 29개, 요소 3,963, 응답 정상).

### 조사 — 무엇이 통했고 무엇이 헛다리였나

**헛다리 1: "프레임이 많아서(같은 오리진이라 프로세스 하나) 프렐류드 부팅
비용이 누적된다".** 합성 픽스처(같은 오리진 iframe N개)로 재니 **n=12 까지
전부 정상**(WS 147MB). 반증됐다.

**헛다리 2: 첫 관측의 "8초 만에 먹통".** 그건 **앞 실행에서 이미 먹통이 된
데몬**을 그대로 쓴 탓이었다. `about:blank` 로는 안 살아난다 — 프로브마다
`taskweaver kill/start` 를 해야 한다. 오늘 reddit 에서 한 번 밟고 **같은 함정을
한 시간 뒤에 또 밟았다.**

**헛다리 3(치명적): 고침 검증을 옛 SW 로 했다.** 데몬만 새로 띄우고
`clear-site-data` 를 안 해서 **옛 SW 가 캐시에서 옛 자산을 서빙**했다. 스택의
minify 열 번호가 고침 전과 **바이트 단위로 같다**는 것이 단서였고, 결정적
증거는 페이지가 쓰는 `?v=388e2647e61e` 와 디스크 빌드 ID `44acfb3f9388` 의
불일치였다. **"고쳤는데 그대로다" 를 만나면 실행 중인 빌드 ID 부터 확인한다.**

**통한 것: 문서 시작(메인 월드) 주입 + CDP 콘솔.** 콘솔은 데몬 메모리에 쌓여
렌더러가 멎어도 읽힌다. DOM API 계수기를 심어 "어느 호출이 폭주하는가" 를
프레임별로 뽑고, 임계마다 `new Error().stack` 을 찍어 호출자를 특정했다.

### 원인

```
HTMLScriptElement.getAttribute
  ← isZPAssetNode          (script 마다 getAttribute)
  ← querySelectorAll 훅의 필터 술어
  ← filteredCollection 의 nth/length
  ← Proxy get 트랩
  ← Generator.next
  ← pubads_impl.js (GPT)
```

`querySelectorAll` 결과는 **우리 자산 스크립트를 숨기려고** 필터 Proxy 로 감싼다.
그 Proxy 의 `nth`/`length` 가 **부를 때마다 원본 전체를 다시 훑었고**, 순회는
`for (i = 0; i < length(); i++) yield nth(i)` 라 걸음마다 두 번 훑었다.
**순회 한 번이 O(N²)** 이고 술어는 script 마다 `getAttribute` 를 부른다.

CNN 은 script 가 ~900개다. 900 × 1800 ≈ 1.6M — 실측 **1,733,614회**와 맞는다.

### 대조군이 판정했다

| | 최대 getAttribute (한 프레임) |
|---|---|
| 직접 로드 | **2,087** |
| 프록시 | **1,733,614** |
| 프록시(고친 뒤) | **4,768** |

830배는 페이지 코드로 설명이 안 된다. **우리가 만든 호출이다.**

### 고친 것

한 번만 훑어 배열로 만들어 캐시한다. 원본 길이가 바뀌면 다시 만든다 —
`querySelectorAll` 결과는 정적이라 한 번이면 끝이고, live 컬렉션(`attributes`,
`document.scripts`)은 항목이 늘거나 줄 때 길이가 바뀐다.

### 내 패치의 절반은 잉여였다 — 변이 시험이 알려 줬다

순회/인덱스 루프도 `items()` 를 쓰도록 같이 고쳤는데, **변이로 되돌려도 가드가
안 문다.** 메모이제이션이 들어가면 `nth`/`length` 가 O(1) 이라 옛 루프 모양도
O(N) 이기 때문이다. 즉 **load-bearing 은 메모이제이션 하나**다(변이 3/6 뭄:
메모이제이션 제거 / 캐시 무효화 제거 / 필터 무력화). 루프 재작성은 가독성일 뿐
이라고 적어 둔다 — 나중에 "이것도 성능 때문" 이라고 오해하지 않도록.

### 아직 안 닫혔다 — 두 번째 원인

폭주는 364배 줄었는데 **CNN 은 여전히 ~7초에 멎는다.** 이번에는 하트비트가
그 직전까지 규칙적이고(500ms × 14) 계수기도 조용하다(setAttr 6,463 /
getAttr 4,768). 렌더러 프로세스는 살아 있고(572MB) CDP 만 응답이 없다 —
**DOM API 를 거의 안 쓰는 두 번째 정지 원인**이 남아 있다. 다음 세션은 여기부터.

### 곁가지로 나온 것 (미확인, 별개 경로)

reddit 탐지기에 1건: `document.scripts` 에 `/zp/error/POLICY_BLOCKED…`.
차단된 스크립트의 자리표시자다. `blockExecutableURL` 이 `urlMeta` 를 지우고
`data-zp-target-url` 을 '' 로 두므로 `.src` 게터의 되돌리기가 풀 근거를 못 찾고,
`deproxyURL` 도 `/zp/error/…` 는 매핑하지 못한다. **이 경로는 이번 변경과
무관하므로 이전부터 있었을 가능성이 높지만, 옛 빌드로 대조하지는 않았다.**

## "레이스처럼 보였는데 원인은 용량이었다" — 문서가 자기 기록을 밀어냈다 (2026-08-24)

### 증상

`clear-site-data` 직후 첫 방문에서 MDN 문서가 `encodedBodySize == decodedBodySize`
(140,659/140,659) = **압축 안 됨**으로 보였다. 2/2 결정적. 웜 로드는 14,010/140,659
로 정상(5/5). 앞 커밋이 "문서 압축을 닫았다" 고 적어 둔 그 자리다.

### 조사에서 틀린 길로 두 번 샜다 — 기록해 둔다

1. **"첫 방문이라 SW 가 아직 문서를 안 다룬다"** → 틀렸다. 격리 월드에서
   `navigator.serviceWorker.controller` 는 cold/warm 둘 다 **참**이고
   `workerStart` 도 둘 다 > 0. SW 가 양쪽 다 서빙했다.
2. **"SW 인스턴스가 갈려서 인메모리 맵이 날아갔다"** → 틀렸다. 진단용
   `SW_INSTANCE_ID` 를 심어 재니 cold/warm **동일 인스턴스**였다.

그리고 첫 프로브에 **측정 결함**이 있었다: 맵 키를 `slice(0,4)` 로만 봤다(상한 32).
"문서 키가 없다" 를 확인했다고 착각했는데, 4개만 본 것이었다. **부분 관측을
전체 관측으로 읽지 말 것.**

### 진짜 원인

전체 키를 세니 `totalKeys: 32` — **맵이 상한에 걸려 있고 전부 텔레메트리 비컨**
이었다. 문서와 서브리소스를 **같은 FIFO(상한 32)** 에 넣고 있었으므로,
서브리소스가 많은 페이지는 **자기 문서 기록을 스스로 밀어낸다.**

- 웜: 페이지 부팅이 빨라 pull 질의가 축출을 **이긴다** → 통과
- 콜드: wasm 컴파일 등으로 부팅이 느려 질의가 **항상 진다** → 2/2 실패

즉 겉보기는 레이스인데 **원인은 용량**이다. "가끔 된다" 를 레이스로 단정하고
타임아웃을 늘렸다면 이 자리를 영영 못 찾았다. 되는 쪽과 안 되는 쪽의 **상태**
(맵 크기 / 키 구성)를 재야 보인다.

### 고친 것

문서 기록을 서브리소스와 **다른 칸**(`docEncodedByUrl`, 상한 8)에 넣는다.
내비게이션은 탭당 하나뿐이라 작은 칸으로 충분하고, 서브리소스가 아무리 쏟아져도
문서를 못 밀어낸다. 질의는 문서 칸을 먼저 본다. 버퍼/스트리밍 두 경로 모두
`isNavigationRequest(event.request)` 로 문서 여부를 넘긴다.

검증: cold 2/2 → `14010/140659`(고치기 전 `140659/140659`). 격리 월드는 여전히
`140659/140659` — **페이지 realm 만 가리고 브라우저의 진짜 측정은 안 건드린다.**

### 조사 중에 내가 만든 함정 — 되돌렸다

진단으로 `__zpTraceDump` 응답에 `encodedKeys: [...streamEncodedByUrl.keys()]` 를
실었다. 이 맵의 안전 근거는 주석에 적힌 대로 **"키는 페이지가 이미 아는 자기
URL 이라 새로 알려주는 것이 없다"** 인데, 키 목록을 통째로 내주면 **다른 탭의
타깃 URL 까지** 나간다 — A2(multi-tab leak) 와 같은 부류다. 제거했고, 가드가
`encodedKeys` 재등장을 막는다.

**진단을 심을 때도 그 진단이 무엇을 노출하는지 본다.** 임시라는 이유로 통과시키면
임시가 아니게 된다.

## 세정기가 못 걷는 곳을 직렬화기는 걷는다 — `<template>` (2026-08-24, reddit)

### 무엇이 샜나

reddit 을 처음 대자 탐지기가 2건을 물었다.

```
outerHTML attr | data-zp-target-url
outerHTML url  | /zp/api/fetch?url=https%3A%2F%2Fexternal-preview…
```

라이트 DOM 은 멀쩡했다. 실측(격리 월드에서 진짜 DOM 을 셈):

| | zp 속성 | 프록시 URL |
|---|---|---|
| 라이트 DOM | 241 | 293 → **전부 세정됨** |
| `<template>` 14개 안 | 1 | 2 → **그대로 나감** |

### 원인

`<template>` 의 내용은 문서 트리의 자식이 **아니다** — 별도 `DocumentFragment`
(`template.content`)다. 그래서 **어떤 `querySelectorAll` 로도 도달하지 않는다.**
`scrubbedClone` 은 `qSA('*')` 로 두 트리를 나란히 걸으므로 템플릿 안을 통째로
못 본다. 그런데 **HTML 직렬화는 그 안을 그대로 뱉는다.**

즉 **세정기가 못 걷는 곳을 직렬화기는 걷는다.** 이 함수의 안전 조건은
"무엇을 걷는가" 가 아니라 **"직렬화기가 걷는 것을 빠짐없이 걷는가"** 이다.

### 같은 부류를 이미 밟았다

앞 세션의 "멤브레인 qSA 가 우리 자산을 숨겨서 세정기가 자기 은폐에 눈이 멀었다"
와 정확히 같은 모양이다. 그때는 **훅** 때문에 못 봤고 이번엔 **DOM 구조** 때문에
못 봤다. 두 번 다 증상은 "라이트 DOM 은 깨끗한데 직렬화에만 남는다" 였다.

### 고친 것

- `Native.fragmentQuerySelectorAll` (= `DocumentFragment.prototype.querySelectorAll`)
  를 새로 붙들었다. `DocumentFragment` 는 Element 도 Document 도 아니라서 둘 중
  하나로 부르면 **던지고**, 던지면 `catch` 가 세정을 통째로 삼킨다(조용히 원본이
  나간다). nodeType 11 분기를 명시적으로 뒀다.
- `Native.templateContent` (= `HTMLTemplateElement.prototype.content` 게터).
  `el.content` 는 페이지가 갈아끼울 수 있다.
- walk 을 재귀로 바꿔 중첩 template 까지 내려간다(깊이 8 상한). 루트 자체가
  `<template>` 인 경우(`serializeToString(tpl)`)도 처리한다.

### 검증 — 양성 대조로

고친 뒤에도 **진짜 DOM 에는 그대로 있어야** 한다(우리가 페이지를 바꾸면 안 된다).

| | 진짜 DOM (격리 월드) | 세정된 직렬화 (메인 월드) |
|---|---|---|
| 템플릿 안 zp 속성 | 1 | **0** |
| 템플릿 안 프록시 URL | 2 | **0** |
| `<template>` 개수 | 4 | 4 (구조 보존) |

탐지기 reddit 2건 → **0건**. 회귀: naver / wikipedia / github / HN / stackoverflow
전부 0건. static-policy 134 pass, 새 가드 변이 5/5 뭄.

### 규칙

**직렬화 세정을 고칠 때는 "직렬화기가 보는 노드 집합" 과 "내가 걷는 노드 집합"
을 명시적으로 맞춰 볼 것.** `querySelectorAll` 로는 안 걸리는데 직렬화에는 나오는
자리가 최소 둘이다 — `template.content`, 그리고 (선언적) shadow root.
후자는 reddit 에서 `shadowrootmode` 0개라 이번엔 안 밟았지만 **미확인으로 남는다.**

## 2026-08-22 — 지문 축: 전역 스크러버가 **적이 서지 않는 자리**에 걸려 있었다 (리라이트 경유로 보면 24개가 그대로 보인다)

지문 축을 세웠다(`test/browser/fingerprint/detect.js`). 방식이 핵심이다 — **우리
목록을 점검하는 게 아니라 실제 탐지 코드가 하는 짓을 그대로 한다**: 전역 이름 열거,
`outerHTML` 훑기, `getAttributeNames`/`attributes[]`, `document.scripts`, 저장소 키,
후킹 함수의 `toString`/디스크립터 모양, 리소스 타이밍, 문서 정체.

첫 실행 **52건**. 그중 최대가 `window` 전역 24개(`__zp_diagnostics`, `__zp_trace`,
`__ZP_SET_BASE`, `__zp_get` …).

### ★그런데 스크러버는 분명히 있었다 — 그리고 "measured clean" 이라고 적혀 있었다

`hideFrom(Object, 'getOwnPropertyNames')` / `Object.keys` / `Reflect.ownKeys` +
심볼 필터까지 촘촘하게 있고, 주석에 *"Measured: getOwnPropertyNames(window) was
correctly clean"* 이라고 적혀 있다. 실제로 `exec-js` 로 그냥 재면 **0개**다.

그런데 같은 코드를 `eval()` 로 감아 재면 **24개**다. 최소 재현:

```
eval(atob(<같은 코드>))  →  n=24
그냥 실행                →  n=0
```

원인을 좁혔다. `eval` 안의 `window` 는 바깥 `window` 와 **다른 객체**였다
(`evalWindowIsOuter: false`, 이름 수 1285 vs 1259). 멤브레인이 리라이트된 코드에
주는 **가상 window(스코프 프록시)** 다. 그런데 스크러버의 판정은

```js
const isGlobalObj = o => o === globalThis || o === root || o === self;
```

라서 가상 window 를 전역으로 안 본다 → 필터가 안 걸린다.

**즉 방어는 진짜 window 에만 걸려 있었는데, 타깃 코드는 진짜 window 를 못 본다.**
타깃 스크립트는 예외 없이 리라이터를 거치므로 사실상 아무도 못 막고 있었다.
원래 측정이 "리라이트를 안 거친 프로브" 에서 이뤄져 깨끗해 보인 것이다.

**Fix**: 스코프 프록시는 이 블록보다 나중에 만들어져 이름으로 못 부르므로,
멤브레인 자신이 쓰는 오리 검사를 같이 쓴다 — `o.window === o`(진짜/가상 둘 다 만족).
고친 뒤 **두 시점 모두 0**.

### 남은 것 (28건) — 다음 시작점

| 자리 | 건수 | 메모 |
|---|---|---|
| `outerHTML` 의 `data-zp-*` | 9 | `getAttribute` 는 가렸는데 **직렬화가 샌다** |
| `outerHTML` 의 `/zp/assets/zp-core.js` | 1 | 우리가 주입한 스크립트 태그 |
| 리소스 타이밍 | 18 | 우리 에셋 이름. `PerformanceEntry.name` 디프록시 게터가 있는데도 남는다 |

리소스 타이밍 항목에 **`http://127.0.0.1:18099/null/zp/api/fetch?url=…`** 처럼
경로에 `null` 이 박힌 URL 이 섞여 있다 — 별개 버그로 보인다. 다음에 볼 것.

> **교훈(이 세션에서 반복된 것의 결정판)**: 방어를 넣을 때 **적이 실제로 서는 자리**
> 에서 재야 한다. 여기서는 방어도 있었고 측정도 했고 주석에 "clean" 이라고까지
> 적혀 있었는데, 그 측정 시점만 적이 서지 않는 자리였다. 계측 결함 여섯 중 이번 것이
> 가장 비쌌다 — **틀린 안심을 주석으로 굳혀 놨기 때문**이다.

**측정**: static-policy 126, 구멍 66칸 유출 0 / csp-only 0 / 선언 밖 깨짐 0,
실사이트 3종 raw=0 csp=0 err=0.
### 후속(2026-08-22) — 직렬화 세정이 `<html>` 껍데기를 벗기고 있었다 + 낡은 주석 정정

**(a) 주석부터 고쳤다.** 앞 항목에서 문제가 된 *"Measured: getOwnPropertyNames(window)
was correctly clean"* 이 그대로 남아 있었다. 그걸 지우지 않으면 다음 사람이 **똑같이
안심한다** — 이번 사고의 본체가 코드가 아니라 그 문장이었다. 정정문에 "어느 시점에서
잰 clean 인지" 를 반드시 같이 적으라고 남겼다.

같은 부류가 더 있는지 `navigator` / `Location.prototype` / window 심볼도 **적의
시점(리라이트 경유)** 으로 재봤다 — 셋 다 두 시점이 일치하고 깨끗하다(각각 0 / 1 /
0, 크롬과 같은 값). 그 버그는 window 전역 스크럽에 한정된 것이었다.

**(b) `documentElement.outerHTML` 이 `<html` 로 시작하지 않았다.**

```
대조군(프록시 없이) : <html><head><meta charset="utf-8"><title…
프록시              : (html 껍데기 없음)
```

원인: 세정기가 문자열을 `div.innerHTML` 에 넣고 다시 뽑는 **문자열 왕복**이었다.
HTML 파서는 `div` 안에서 `<html>/<head>/<body>` 를 벗긴다. 재현성 결함이면서
`/^<html/.test(...)` 한 줄로 끝나는 지문이다.

**Fix**: 문자열 왕복 대신 **복제본을 세정**한다 — `cloneNode(true)` → 우리 속성만
제거 → 네이티브 게터로 직렬화. 구조가 그대로 보존되고 재파싱이 없어 더 싸다.
고친 뒤 `startsWithHtml: true`(대조군과 일치).

**남은 것 — 정확히 어디인지 짚었다**: `data-zp-target-url` 9건이 아직 보이는데,
`hasEl: false` 였다(그런 속성을 가진 **요소는 DOM 에 없다**). 실제 위치는
**`<iframe srcdoc="…">` 속성 값 안의 중첩 마크업**이다(`&quot;` 로 이스케이프됨).
세정기는 살아 있는 속성을 훑지 **속성 값 안의 HTML** 까지는 안 들어간다.
그리고 `XMLSerializer().serializeToString(document.documentElement)` 은 아예
훅이 없어 **38건**이 나온다 — 별도 표면이다.

**측정**: static-policy 126, 구멍 66칸 유출 0 / csp-only 0 / 선언 밖 깨짐 0,
실사이트 3종 raw=0 csp=0 err=0.


## 2026-08-22 — 스토리지/쿠키 격리 축을 처음 세웠다: 결함 둘 + **내 측정이 만든 가짜 누출 하나**

프록시는 서로 다른 타깃을 **같은 브라우저 오리진**에 담는다. 진짜 웹이라면 오리진이
갈라 주던 것을 우리가 직접 갈라야 한다. 파사드는 잘 만들어져 있었는데(이름 기반
접근 문제까지 이미 잡혀 있다) **브라우저로 검증된 적이 한 번도 없었다.**

새 축 `test/browser/storage-matrix/` — A 에 쓰고 → B 에서 읽고 → A 로 돌아와 확인.
여섯 표면(localStorage / 이름 기반 / sessionStorage / cookie / CacheStorage / IndexedDB)을
격리·지속성·위생 세 눈으로 본다.

### ★가짜 누출 둘 — 둘 다 내 측정이 만들었다

**(1) 픽스처가 틀렸다.** 첫 실행에서 `cookie` 가 LEAK 으로 찍혔다. A/B 를
`127.0.0.1` 의 두 포트로 잡았는데 **쿠키는 원래 포트를 구분하지 않는다**. 대조군
(프록시 없이 직접 로드)에서도 똑같이 공유되는 것을 확인했다 — 프록시가 브라우저와
**같게** 동작한 것이지 결함이 아니었다. `localhost` vs `127.0.0.1` 로 바꾸니
대조군에서는 공유가 안 된다(확인).

**(2) 측정이 자기 과거를 쟀다.** 호스트를 고친 뒤에도 `cookie` LEAK 이 남았다.
추적해 보니 **픽스처를 고치기 전 실행이 남긴 쿠키**(도메인 `127.0.0.1`)가 SW
저장소에 살아 있다가 B 로 흘러든 것이었다. 러너에 `clear-site-data` + 하드 리로드를
넣고 다시 재니 격리 누출 0.

> 두 번 다 "누출을 찾았다" 로 끝낼 뻔했다. **대조군과 초기화가 없는 격리 측정은
> 자기 픽스처와 자기 과거를 잰다.**

### 진짜 결함 ① — sessionStorage 가 탭 세션을 안 따른다

같은 탭에서 A → B → A 로 돌아오면 A 의 sessionStorage 가 **사라졌다.**
대조군(프록시 없이 같은 순서)은 남는다 — 실측으로 확인한 재현성 결함.

원인: 접두가 `boot.tabId` 인데 그건 런처에서 Open 할 때마다 새로 발급된다.
진짜 탭 세션의 수명을 가진 것은 **네이티브 sessionStorage 자신**이다(탭마다 다르고
탭 안 내비게이션에는 살아남는다). 거기 id 를 한 번 심어 그걸 쓰면 브라우저 의미와
정확히 같아진다. 타깃별 격리는 `originHash` 가 계속 담당한다.

### 진짜 결함 ② — 우리 진단 키가 페이지에 보였다 (지문)

페이지가 `localStorage.key(i)` 로 열거하면 `__zp_hb` / `__zp_trace_log` 가 그대로
보였다. 네이티브 저장소를 열어 보니 접두 없는 사본과 `zp:l:<hash>:` 접두가 붙은
사본이 **둘 다** 있었다 — 어떤 경로는 네이티브로, 어떤 경로는 파사드를 타고 타깃
네임스페이스로 들어갔다(프렐류드가 자식 realm 에서 다시 평가될 때 캡처 순서가
뒤집힌다).

realm 마다 캡처 순서를 맞추는 것보다 **파사드에서 거르는 쪽**이 확실하다 — 어느
경로로 들어오든 페이지에는 안 보인다. `__zp_` 로 시작하는 이름을 `length`/`key()`/
`getItem`/열거에서 전부 숨긴다.

### 측정

고친 뒤 여섯 표면 전부 `ok`: 격리 누출 0 / 지속성 유실 0 / 페이지에 보이는 내부 키 0
(페이지가 보는 키는 자기가 쓴 둘뿐). static-policy 126, 실사이트 3종 raw=0 csp=0 err=0.

**측정 범위**: BroadcastChannel·SharedWorker 는 아래 후속에서 이어 잰다.

### 후속(2026-08-22) — 채널 축(BroadcastChannel / SharedWorker)도 세웠다. 그리고 **프레임 인덱스를 믿었다가 또 밟을 뻔했다**

`run.mjs` 는 A 에 쓰고 B 에서 읽는 **순차** 방식이라 채널을 못 잰다 — 채널은
지속되지 않고 양쪽이 **동시에** 살아 있어야 한다. 그래서 A 문서 안에 프레임 둘을
띄운다: 같은 타깃 A 하나, 다른 타깃 B 하나(`crossdoc.mjs`).

**★첫 시도가 틀렸다.** `--frame 1` 을 B 라고 **가정**하고 수신기를 심었다. 결과는
"B 못 받음 = 격리됨" 이었는데, 프레임 신원을 확인해 보니 **인덱스 1 은 A 였다.**
게다가 그 A 프레임조차 못 받았다는 뜻이라, 사실은 *재현성 결함일 수도 있는* 신호를
"격리 성공" 으로 읽을 뻔했다. 원인은 픽스처 선택 실수였다 — 매트릭스 `/page` 는
자기 iframe 이 18개다.

고친 것 셋:
- 프레임이 없는 최소 페이지(`/hdrprobe`)를 쓴다.
- **심기 전에 `document.baseURI` 로 프레임 신원을 확인**하고, 못 찾으면 판정 불가로 멈춘다(인덱스를 추측하지 않는다).
- **재현성 대조를 같이 잰다**: 같은 타깃 프레임은 **받아야** 한다. 그게 0 이면 "다른 타깃이 못 받았다" 는 아무 증거가 아니다.

결과(양성 대조 있음):

| | 같은 타깃 | 다른 타깃 |
|---|---|---|
| BroadcastChannel | `FROM-A` 수신 ✅ | 없음 ✅ |
| SharedWorker(접속 순번) | 1 → 2 (인스턴스 공유) ✅ | 다시 1 (별도) ✅ |

> 이번 세션에서 같은 실수를 **세 번째**로 했다(구멍 러너 오분류 → nav 대조군 →
> 여기). 전부 **"이 0 이 어디서 나온 0 인지" 를 안 물은 것**이다. 이제 규칙으로 쓴다:
> **측정 대상의 신원을 먼저 확인하고, 양성 대조 없이는 0 을 읽지 않는다.**

## 2026-08-21 — 재현성 축에는 '의도적'이라는 개념이 없었다: 7칸이 늘 앉아 있는 목록에 새 회귀가 끼면 안 보인다

**"아는 것부터가 첫걸음" 의 연장.** 계획 0~10 을 끝내고 *아직도 못 재는 것*을 찾다가
매트릭스가 매번 찍는 이 줄에 걸렸다:

```
[재현성] 대조군에서 되는데 프록시에서 안 되는 것:
  a23-static-object-cross, b8-preload-link, b9-object-data, b10-embed-src,
  c7-worker, c8-worker-cross, c11-ping-attr
```

**러너는 이걸 찍기만 한다. 기대 집합이 없다.** 격리 축에는 `deliberate` + `why` 가
픽스처에 강제되는데(`url_surfaces.json`), 재현성 축에는 그 개념 자체가 없었다.
그래서 **새 재현성 회귀가 저 7칸 옆에 끼면 원래 있던 것들과 구분이 안 된다** —
목록이 늘 같은 모양이라 눈이 미끄러진다. 이번 계획에서 다섯 번 본
"0 을 못 뒤집는 계측" 과 정확히 같은 병이다.

### 먼저 7칸이 정말 의도된 것인지 확인했다

특히 워커 둘(`c7`/`c8`)이 의심스러웠다 — 워커 부트스트랩이 있으니 동작해야 할 것
같았기 때문이다. 코드를 따라가 보니 **의도된 차단**이 맞았다: `URL.createObjectURL`
훅이 JS 타입 Blob 을 **차단 스텁으로 갈아끼운다**(리라이트를 안 거친 코드를 워커에서
돌리면 멤브레인 밖이 된다). 나머지 다섯도 각각 근거가 있었다.

### Fix — 선언하고 양방향으로 문다

`server.mjs` 의 `EXPECT_BLOCKED` 에 **id → 이유**로 선언하고 `/cases` 로 실어 보낸다.
러너는:

  ① 선언에 없는데 깨졌다      → `[!!] 회귀다`
  ② 선언했는데 이제 동작한다   → `[!] 선언이 낡았다`

**②를 같이 보는 것이 핵심이다.** 이번 통합 작업에서 "가드가 옛 동작을 박제한" 사고를
넷 봤다(srcset 의 `split(',')` 단언, 정규화 안 된 리졸버 기대값, `usesRaw` 삼항,
`encodeURIComponent` 정규식). **기대 목록도 똑같이 썩는다** — ②가 없으면 정확히 같은
함정을 새로 파는 것이다.

`static-policy` 가 선언마다 **이유 20자 이상**을 강제한다. 이유 없는 선언은 다음
세션에 결함으로 읽히기 때문이다(격리 축의 `why` 규칙과 같은 이유).

### 양방향 변이 확인

- `c7-worker` 를 선언에서 빼기 → `[!!] 선언에 없는데 깨졌다 — 회귀다: c7-worker` ✅
- 잘 되는 칸(`a10-static-iframe`)을 거짓 선언 → `[!] 선언이 낡았다: a10-static-iframe` ✅
- 이유를 `'막음'` 으로 줄이기 → static-policy 실패 ✅

> **곁다리 교훈**: 첫 변이 시도는 `a1-static-img` 로 했는데 **그런 케이스 id 가 없었다**
> — 아무 일도 안 일어나는 걸 보고 "가드가 안 문다" 로 결론낼 뻔했다. 변이가 실패하면
> **변이 자체가 유효한지부터** 확인할 것. 계측을 의심하라는 규칙은 변이 테스트에도 적용된다.

## 2026-08-21 — preconnect 계측을 안정화했다: 원인은 브라우저가 아니라 **내가 만든 계측 쪽 버그 둘**이었다

**계획의 마지막 잔여 항목.** `preconnect` 는 HTTP 요청을 만들지 않아 바이트 도착
축으로 못 잰다. 그래서 "요청 없이 열려만 있던 소켓" 을 세는 계측을 만들었는데
**간헐적이었다** — 대조군이 0 이 되는 실행이 섞였다. 즉 양성을 못 만드는 실행이
있었고, 그런 실행에서는 프록시 0 이 아무 증거가 아니다.

원인을 브라우저 사정으로 넘기고 싶었지만, 재 보니 **둘 다 내 계측 결함**이었다.

### 결함 1 — 재사용되는 소켓을 세고 있었다

preconnect 대상을 CDN(18098)에 두었는데, 같은 페이지의 `prefetch`/`preload` 가
**같은 오리진**이라 그 소켓을 곧바로 재사용했다. 그러면 "안 쓴 소켓" 이 안 남는다.

**Fix**: 아무도 요청을 보내지 않는 **전용 오리진(18097)** 을 만들고 preconnect 만
거기로 보낸다. 그 포트에 열린 소켓은 preconnect 말고 나올 데가 없다.

### 결함 2 — 조기 종료를 놓치고 있었다 (이게 진짜였다)

```js
const t = setTimeout(() => { if (!sock.__zpUsed) idleConns[port] += 1; }, 1500);
sock.on('close', () => clearTimeout(t));   // ← 여기
```

크롬은 **안 쓴 preconnect 소켓을 1.5초보다 빨리 닫는다.** 그러면 `close` 가
타이머를 지워서 **영영 안 세어졌다.** 세려고 만든 이벤트가 세는 걸 취소하고
있었던 셈이다.

**Fix**: 타임아웃이든 조기 종료든 **먼저 오는 쪽**에서 센다(중복 방지 플래그).

### 그리고 계측이 자기 상태를 말하게 했다

`미사용/전체` 를 같이 찍는다. 대조군의 **전체가 0** 이면 크롬이 애초에 preconnect
를 안 한 것이고(힌트라 건너뛸 수 있다) 그건 브라우저 사정이라 그 실행은 **판정
불가**로 찍는다. 전체>0 인데 미사용이 0 이면 그때가 계측을 의심할 자리다.
두 경우를 다른 문구로 구분한다 — 예전에는 둘 다 그냥 `0` 이었다.

**결과**: 고치기 전 대조군 양성이 1/3 → 고친 뒤 **3연속 `대조군 1/1 · 프록시 0/0`**.
이제 "프록시는 타깃에 preconnect 소켓을 열지 않는다" 가 **양성 대조를 가진** 주장이다.

**`dns-prefetch` 는 여전히 못 잰다** — 소켓을 아예 안 열고, 대상이 숫자 IP 면 DNS
조회 자체가 없다. 못 잰다는 사실을 러너 주석에 남겼다.

> **교훈**: 계측이 흔들릴 때 "환경이 원래 그렇다" 로 넘기기 전에 계측 코드를 먼저
> 의심한다. 여기서는 **세려고 단 이벤트 핸들러가 세는 것을 취소하고 있었다.**
> 이번 계획에서 나온 계측 결함 다섯 중 마지막이고, 다섯 다 "0 이 나왔는데 그 0 이
> 나올 수 있는 경로를 안 물었다" 는 같은 모양이었다.

## 2026-08-21 — SRI 를 안 벗겨서 스크립트가 통째로 차단되고 있었다 + meta CSP 는 페이지 realm 에서 그대로 먹혔다 (상호 결손)

**계획 10번의 마지막 갈래.** 두 구현이 **서로의 구멍을 하나씩** 갖고 있었다:

| | `integrity` | meta CSP |
|---|---|---|
| htmltx (서버) | **처리 없음** ✗ | 무력화 ✓ |
| 프렐류드 (페이지 realm) | 세 경로로 벗김 ✓ | **안 봄** ✗ |

### ① SRI — 조용한 전면 차단이었다

우리는 스크립트를 OXC 로 리라이트해 내려주므로 본문이 원본과 다르다. 그러면
브라우저의 SRI 검증이 **반드시** 실패한다. 실측(`/sripage`):

```
대조군 : RAN
프록시 : BLOCKED
크롬   : "Failed to find a valid digest in the 'integrity' attribute
          for resource … The resource has been blocked."
```

**정적 HTML 은 스윕으로 못 막는다** — 파서가 `<script src>` 를 가져오는 시점이
프렐류드 스윕보다 앞선다. 그래서 반드시 **서버(htmltx)에서** 벗겨야 한다.
CDN 라이브러리에 SRI 를 다는 사이트가 흔하므로 영향 범위가 넓다.

**Fix**: htmltx 가 `script`/`link` 의 `integrity` 를 벗기고 원본을
**프렐류드와 같은 백업 속성**(`data-zp-integrity`)에 넣는다. 그래야 페이지가
`el.integrity` 로 되읽었을 때 자기가 쓴 값이 나온다(실측: attr/prop 모두 원본,
`hasAttribute` true). 고친 뒤 프록시에서도 RAN.

### ② meta CSP — 페이지 realm 이 꽂으면 실제로 적용된다

`document.head.appendChild(meta[http-equiv=CSP])` 로 `img-src 'none'` 을 넣고 쟀다:
주입 전 **LOADED** → 주입 후 **BLOCKED**. 이 엔진은 파싱 이후 삽입된 meta CSP 도
적용한다(명세상 무시될 거라 예상했는데 아니었다 — 그래서 쟀다).

**탈출은 아니다.** 정책은 교집합이라 타깃이 느슨하게 만들 수 없다. 더 무서운
쪽(`report-uri` 로 릴레이 우회 egress)도 **브라우저가 막는다** — 크롬이 직접
이렇게 찍는다: *"'report-uri' is ignored when delivered via a `<meta>` element"*.
실측으로도 타깃 오리진 히트 0.

남는 실제 피해는 **우리 런타임을 죽일 수 있다는 것**이다 — `script-src 'none'`
이면 멤브레인이 붙인 스크립트가, `connect-src 'none'` 이면 릴레이 트랜스포트가
막힌다. 그리고 "정책이 먹히는가" 자체가 지문이다.

**Fix**: 프렐류드가 htmltx 와 같은 방식으로(`data-zp-blocked-http-equiv`) 무력화.
**세 경로 전부** — `setAttribute` 훅 / `HTMLMetaElement.httpEquiv` 프로퍼티 훅 /
`transformHTML`(HTML 주입). 항목 7 에서 배운 그대로다: 프로퍼티 대입은
`setAttribute` 훅을 안 탄다. 셋 다 안 넣었으면 `m.httpEquiv = …` 로 그냥 통과했다.

**주의**: 우리 자신의 정책 meta 는 살아 있어야 한다. 실측으로 확인 —
주입 3건은 전부 `data-zp-blocked-http-equiv` 로 내려앉고 살아 있는 `http-equiv` 는
우리 것 하나뿐이며, 그 뒤 이미지가 다시 LOADED 로 돌아온다.

**측정**: 구멍 66칸 진짜 유출 0 / csp-only 0, static 125(새 가드 둘 변이 확인),
cargo 전체(zp-htmltx 54), `go test ./...`, 실사이트 3종 raw=0 csp=0 err=0.

> **이번 항목의 교훈**: "두 구현이 갈라졌다" 를 볼 때 **한쪽만 보면 안 된다.**
> 여기서는 A 가 가진 것을 B 가, B 가 가진 것을 A 가 각각 빠뜨리고 있었다.
> 한 방향만 검사하는 가드였다면 둘 다 통과했을 것이다(항목 5 의 Go⊆SW 단방향
> 가드가 정확히 그 사각지대를 만들었다).

## 2026-08-21 — `<base href>` 를 리라이터가 무시하고 있었다. 그리고 `link rel` "서버측 부재" 는 재 보니 결함이 아니었다

**계획 10번.** 네 갈래를 각각 재고 갈렸다 — **하나는 진짜 결함, 하나는 비결함,
하나는 계측 자체가 불가능, 하나는 이미 정상.**

### ① `<base href>` — 진짜 재현성 결함 (고침)

`<base href="http://cdn/deep/">` + `<img src="rel.png">` 를 대조군/프록시로 나눠 쟀다:

```
대조군 : 18098 ← /deep/base-rel.png     (맞다)
프록시 : 18099 ← /base-rel.png          (오리진도 경로도 틀렸다)
```

htmltx 는 상대 URL 을 항상 **문서 URL** 에 대고 풀고 `<base>` 를 아예 안 봤다.
유출은 아니다(프록시를 통해 엉뚱한 곳으로 간다) — 하지만 base 를 쓰는 사이트는
서브리소스가 통째로 어긋난다.

**Fix**: lol_html 이 스트리밍이라 문서 순서가 보장된다는 점을 이용해
`Rc<RefCell<String>>` 기준을 들고, `<base href>` 를 만나면 갱신한다.
명세대로 **`<base>` 뒤에 파싱된 것에만** 적용된다(테스트로 고정).
`<base href>` 속성 자체는 리라이트하지 않는다 — 페이지 realm 의
`updateVirtualBase` 가 원본을 읽어야 하기 때문. 고친 뒤 재측정: 대조군과 바이트 일치.

### ② 서버측 `link rel` 정책 부재 — **결함이 아니었다**

페이지 realm 은 `preload/prefetch/preconnect/dns-prefetch/prerender/manifest` 를
**삼키는데**(rel 을 떼어 요청 자체를 못 만들게) htmltx 에는 그 분기가 없다.
"서버측 부재" 로 적혀 있었지만 재 보니 유출이 아니다 — htmltx 가 `("link","href")` 를
서브리소스로 리라이트하므로 브라우저는 **프록시 오리진으로** 간다.
`a28-prefetch` / `a29-preload` / `a30-modulepreload` 전부 대조군 O · 프록시 O · 격리 ok.

남은 것은 유출이 아니라 **비대칭**이다: 같은 링크가 정적이면 동작하고 런타임 생성이면
삼켜진다. 격리 축에 해가 없으므로 이번엔 건드리지 않고 적어 둔다.

### ③ `preconnect` / `dns-prefetch` — **계측이 불가능하다는 것을 알아냈다**

이 둘은 **HTTP 요청을 만들지 않는다**. 그래서 바이트 도착 축으로는 영영 판정불가다
(실측: 대조군도 `-`). 칸으로 두면 영구 회색이라 칸에서 빼고, 픽스처 서버에
소켓 카운터를 넣었다.

첫 시도는 **틀렸다**: 단순 연결 수는 대조군 6 / 프록시 7 이 나왔는데, 그 대부분이
**우리 프록시 서버 자신의 다이얼**이었다(같은 머신에서 타깃에 직접 붙는다).
구분자를 찾았다 — preconnect 로 열린 소켓은 **아무 요청도 안 보낸다.**
그래서 "요청 없이 열려만 있던 소켓" 만 세도록 고쳤다.

**그 계측은 간헐적이다.** 첫 실행은 대조군도 0 이었고(크롬이 preconnect 로 연
소켓을 곧바로 이어지는 prefetch/preload 에 재사용해 유휴 소켓이 안 남는 것으로
보인다), 다음 실행은 **대조군 1 / 프록시 0** 이 나왔다. 즉 양성을 만들 수는
있지만 매번은 아니다. 그래서 러너가 **대조군이 0 이면 크게 경고**하도록 했다 —
그 실행에서는 프록시 0 이 증거가 아니기 때문이다. 대조군 1 / 프록시 0 이 나온
실행만이 "프록시는 타깃에 유휴 소켓을 안 남긴다" 의 근거다. 안정화는 남는다.

### ④ worker bootstrap `?v=` — 이미 정상

`importScripts('/zp/assets/worker-prelude.js?v=__ZP_BUILD_ID__')` 의 치환을
산출물에서 확인했다: `?v=d6fc984c9134`. 계획의 지적은 이미 해소돼 있었다.

**손 안 댄 것**: `integrity` / CSP-`<meta>` 비대칭은 이번에 재지 않았다. 남긴다.

**측정**: 구멍 66칸 진짜 유출 0 / csp-only 0, static 123, cargo 전체(52 htmltx),
`go test ./...`, naver·wikipedia·github raw=0 csp=0 err=0.

> **이번 계획 전체에서 계측 결함이 넷 나왔다** (구멍 러너 오분류 → nav 대조군 사망 →
> `<use>` 칸 영구 회색 → preconnect 계측의 양성 대조 부재). 규칙으로 굳힌다:
> **새 계측을 만들면 양성이 실제로 나오는지부터 확인한다.** 0 을 못 뒤집는 계측은
> 통과가 아니라 고장이다.

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

---

## 2026-08-22 — 지문 축 2회차: **직렬화는 표면이 하나가 아니다**, 그리고 세정기가 자기 은폐에 눈멀었다

앞 항목이 남긴 28건을 좁혔다. 넷 다 별개 원인이었고, 셋은 "방어는 있는데 다른
문으로 들어오면 안 걸린다" 는 같은 모양이다.

### 1. `iframe.srcdoc` — 값을 덮어써 놓고 읽기 표면을 안 고쳤다 (9건)

`srcdoc` 은 우리가 프렐류드 주입 + URL 리라이트를 해서 **통째로 덮어쓴다**.
살아 있는 속성은 세정기가 훑지만 **속성 값 안의 중첩 마크업**까지는 안 들어가서,
`outerHTML` 에 우리 스크립트 태그와 `data-zp-*` 가 그대로 나왔다.

값을 사후에 문자열로 씻는 대신 **페이지가 준 원본을 붙들어 둔다**(`srcdocMeta`
WeakMap). 주입 경로를 `setInjectedSrcdoc` 하나로 모으고 읽기 세 표면
(`getAttribute` / `srcdoc` 프로퍼티 / 직렬화)이 원본을 돌려준다. 재현성도
같이 맞는다 — 페이지가 쓴 값을 그대로 돌려주는 게 원래 옳다.

**가드가 안 물었던 이야기**: 처음 건 가드는
`setAttribute.call(…, 'srcdoc', injectSrcdoc(` 를 찾는 정규식이었는데, 실제로
되돌려 보니 **안 물었다** — 원래 코드는 속성 이름을 리터럴이 아니라 변수 `k` 로
넘긴다. 호출부를 훑는 대신 `injectSrcdoc(` 가 나타나도 되는 자리를 통째로
못박는 형태로 바꿨다. (변이 5종 전부 무는 것 확인.)

### 2. `XMLSerializer.serializeToString` — 훅이 아예 없었다 (38건)

`innerHTML`/`outerHTML` 만 세정하고 있었다. 같은 문서를 `XMLSerializer` 로
뽑으면 38건이 그대로 나온다. 세정을 게터가 아니라 **복제본**(`scrubbedClone`)에
걸어 둔 덕에 재사용은 쉬웠다. 단, `XMLSerializer` 는 **Document 도 받는다** —
`outerHTML` 경로를 재사용하면 안 되고, 트리 순회도 Document(9)/Element(1) 를
갈라 써야 한다(틀리면 던져서 세정이 통째로 생략된다).

### 3. ★세정기가 **자기 은폐에 눈멀었다** — `outerHTML` 에 우리 스크립트 태그

`isZPAssetNode` 판정은 멀쩡했는데도 `zp-core.js`/`zp-page-bundle.js` 태그가
남아 있었다. 원인: 세정기가 복제본을 `clone.querySelectorAll('*')` 로 훑는데
**그 `querySelectorAll` 이 멤브레인 것**이고, 멤브레인은 우리 에셋 스크립트를
숨긴다. 세정기가 지워야 할 노드를 **볼 수 없었다**. 네이티브로 훑도록 고쳤다.

같은 자리에서 SW 가 문서 앞에 박는 **인라인** 스크립트(`zp_chain` prewarm)와
CSP meta 도 드러났다 — src 가 없어 URL 로는 판별이 안 된다. `data-zp-internal`
표식을 달아 세정기가 알아보게 했다.

### 4. 남은 하나: 직렬화가 **프록시 URL** 을 보여 준다

`getAttribute('src')` 는 타깃 URL 을 돌려주는데 `outerHTML` 은 프록시 URL 을
그대로 보여 줬다. **그 불일치 자체가 한 줄짜리 탐지기다.** 복제본에서 URL 지는
속성을 타깃 값으로 되돌린다(srcset 은 `recalledSrcset`).

### 교훈

`innerHTML` 을 고쳤다고 "직렬화를 고쳤다" 가 아니다. 그리고 **은폐 계층과 세정
계층이 서로를 못 보면 은폐가 세정을 무력화한다** — 세정기는 언제나 네이티브
시점에서 훑어야 한다.

---

## 2026-08-22 — 통합 2차: 되돌리기가 세 벌, 자산 목록이 세 벌, 그리고 죽은 세정기

지문 축 작업을 끝내고 "하나로 안 된 느낌" 을 세어 봤다. 계획서(1~9)는 실제로
닫혀 있었다 — `?url=` 빌더는 Rust 단일 소스에 JS 파리티 픽스처가 **실행**까지
하고, `resolve_against_base` 도 정규화 + 테스트가 있다. **갈라진 건 그 뒤에
새로 생긴 것들이었다. 그중 하나는 이번 세션에 내가 만들었다.**

### 1. 프록시 URL → 타깃 되돌리기 3벌 (표가 서로 달랐다)

| | `?url=` | `&u=` | `?via=` | `/zp/p/` | 값 안 여럿 |
|---|---|---|---|---|---|
| `deproxyNavigationURL` | ✗ | ✗ | ✓ | virtualURL | ✗ |
| `deproxyEntryName` | ✓ | ✓ | ✓ | virtualURL | ✗ |
| `deproxySerializedValue` (2026-08-22 추가) | ✓ | ✓ | ✗ | ✗ | ✓ |

내비게이션판이 제일 약했다: 모르는 모양이면 **현재 문서 URL** 을 돌려준다.
틀렸는데 그럴듯해서 조용히 지나가는 값이다. `deproxyURL(raw, { scan, fallback })`
한 벌로 묶고 호출자별 차이를 옵션 둘로만 남겼다. 가드는 **표를 실행**한다.

### 2. "우리 자산" 목록 3벌 — prelude 쪽이 부분집합이었다

```
sw.js internalPath : 7개 + /__zp/* 접두
prelude            : 3개  ← 부분집합
main.go            : /__zp/ 파일명 하드코딩
```

프렐류드가 못 알아보는 자산은 **직렬화 세정에서 안 지워진다**. 목록을 zp-core
(`INTERNAL_ASSET_SCRIPTS` / `isInternalPath`)로 올리고 둘 다 거기서 읽는다.
Go 는 "파일을 서빙한다" 는 별개 관심사라 목록을 따로 두되, 스크립트 자산은
반드시 서빙 가능해야 한다는 가드를 걸었다.

### 3. `sanitizeSerializedHTML` — 호출자 0

복제본 방식으로 갈아타면서 죽었는데 남아 있었다. 같은 규칙의 세 번째 사본이라
지웠다.

### ★목록을 옮기다 드러난 것: 가드가 엉뚱한 걸 재고 있었다

`assert.match(sw, /assetPath('zp-page-bundle.js')/, "SW must inject … script tag")`
— 주입은 `assetURL` 로 하는데 이 가드는 `assetPath` 를 찾았고, 그건 주입이
아니라 **`internalPath` 목록**에 매치하고 있었다. 목록을 지우자마자 빨간불이
됐다. **가드가 재는 것과 말하는 것이 달랐다** — 중복을 지우면 이런 게 같이
드러난다는 것이 통합의 부수 이익이다.

### 슬라이스 경계 함정 (두 번 밟았다)

소스를 잘라 `new Function` 으로 실행하는 가드가 여럿인데,
(a) 죽은 함수를 경계로 쓰면 정리할 때마다 깨지고,
(b) 슬라이스가 `//` 주석 줄에서 끝나면 뒤에 붙인 `return` 이 **그 주석에
먹혀** `new Function` 이 undefined 를 돌려준다. 개행을 반드시 넣을 것.

---

## 2026-08-22 — 마지막 직렬화 표면: `<style>`/인라인 `<script>` 텍스트, 그리고 또 하나의 낡은 측정 주석

### 발견: 직렬화만의 문제가 아니었다

`style.textContent` 는 우리가 리라이트한 CSS 를, `script.textContent` 는 실행
래퍼를 **살아 있는 읽기에서** 그대로 돌려주고 있었다. 실측(픽스처): style 8개 중
4개가 `zp/api` 를, script 2개 중 1개가 `__ZP_EXEC_INLINE_REWRITTEN(` 을 노출.
자기 소스를 읽는 건 흔한 anti-debug 관용구다.

### style — 원본을 붙들어 둔다

세터에서 원본을 WeakMap 에 넣고 게터가 그걸 돌려준다(srcdoc 과 같은 방식).
서버가 고친 것은 WeakMap 이 없으므로 값 안의 프록시 URL 을 푼다 — CSS 는 URL 만
바뀌므로 사실상 원본이 된다. → 4/8 → **0/0**.

### ★script — "수십 초" 라는 주석이 오늘은 사실이 아니었다

`zp-htmltx` 는 인라인 스크립트를 **서버에서 미리 리라이트**해
`__ZP_EXEC_INLINE_REWRITTEN(<리라이트된 코드>)` 로 감쌌다. 그러면 원본이
사라져 페이지가 자기 소스를 읽으면 `__zp_get(…)` 이 보인다.

주석에 적힌 근거는 *"NAVER 는 ~200KB + ~150KB 인라인을 싣는데 두 번 리라이트하면
메인 스레드가 수십 초 멈춘다"* 였다. **재봤다**:

| 입력 | 페이지측 `rewriteScript` |
|---|---|
| 합성 194KB | 36.9ms |
| **NAVER 실물 최대 인라인 178KB** | **6.7ms** |

옛 리라이터 시절 숫자가 주석으로 굳어 있었다(이 세션 세 번째 사례 —
"measured clean", "n13 탈출", 그리고 이것).

그래서 기본을 뒤집었다: 256KB 이하 인라인은 **원본 그대로** 내려보내고 페이지가
리라이트한다(`__ZP_EXEC_INLINE_SCRIPT`, 동적 주입이 쓰는 검증된 경로). 넘으면
서버측 단일 리라이트로 돌아간다.

**끝단 실측(naver, 인라인 217KB)**: 22개 스크립트 중 래퍼 노출 **0**, 최대 인라인
184,886바이트가 `window["EAGER-DATA"] = …` 라는 **진짜 원본**으로 읽힌다.
로드 시간 domInteractive 274ms / loadEnd 784ms — 직접 로드 대조군(413 / 739)과
차이 없음.

### 남은 함정 하나: "기억해 둔 원본" 이 원본이 아닐 수 있다

`recalledSrcset` 이 돌려준 값이 이미 프록시 URL 이었다 — 서버가 고쳐 내려보낸
정적 `srcset` 을 멤브레인이 나중에 스윕하면서 **그 순간의 값**을 원본으로
기억했기 때문이다. 그걸 그대로 돌려주면 복원한 것처럼 보이면서 샌다.
되돌리기를 **마지막에 항상** 한 번 더 태우는 것으로 닫았다.

### 결과

지문 탐지기 **0건**, `outerHTML`/`XMLSerializer` 흔적 **0건**
(세션 시작 시 52건 → 28 → 1 → 0).

---

## 2026-08-22 — 지문 탐지기를 실사이트에 대다: 새 표면 하나, 그리고 **탐지기 자신의 오탐**

픽스처에서 0을 만든 뒤 naver / wikipedia / github 에 같은 탐지기를 댔다.
픽스처가 못 만든 것 둘이 나왔다.

### 1. 위키피디아 — 120KB `<style>` 하나가 살아 있는 읽기에서 샜다

`style.textContent` 가 프록시 URL 60개를 그대로 돌려줬다. 방금 고친
자리인데도 샌 이유는 **`recalledSrcset` 과 정확히 같은 함정**이다:
서버가 고쳐 내려보낸 CSS 를 멤브레인이 나중에 다시 심으면서 **그 순간의 값**
(=이미 프록시된 CSS)을 "원본" 으로 기억했다. 그걸 그대로 돌려주면 복원한
것처럼 보이면서 샌다.

**규칙은 하나다: 되돌리기는 마지막에 항상 한 번 더 태운다.** 보관한 값이든
방금 읽은 값이든, 내보내기 직전에 한 번 더. srcset / style / script 셋 다
같은 모양이라 같은 규칙으로 닫았다.

### 2. ★github — 탐지기가 **페이지 자신의 래퍼**를 우리 흔적으로 셌다

`fetch => async(e,r)=>{try{let t=await a(e,r),o=t.headers.get("X-Fetch-Nonce")…`

**대조군(프록시 없이 직접 로드)에서 바이트 단위로 같은 문자열이 나왔다.**
github 이 자기 `fetch` 를 감싼 것이고 우리와 무관하다. 탐지기가
"네이티브가 아니면 우리 탓" 으로 세고 있었다 — **페이지가 자기 API 를 감싸는
건 정상**이라는 걸 놓친 규칙이다.

우리 식별자(`__zp` / `ZeroProxy` / `proxy.localhost` / `/zp/`)가 드러난
때만 세도록 좁혔다. 안에서는 '누가 감쌌는가' 를 알 수 없으니 이게 안에서
가능한 최선이고, 실제로 적에게 보이는 tell 도 그것이다.

**대가**: 우리 훅이 노출됐는데 그 소스에 우리 식별자가 하나도 없으면 놓친다.
지금 훅들은 전부 `__zp_*` 전역을 부르므로 성립하지만, 그 전제가 깨지면 이
축은 조용해진다 — 다음 사람이 알아야 할 경계다.

### 양성 대조군 (측정이 양성을 낼 수 있는가)

toString 축: 가짜 래퍼를 심으니 즉시 잡았다 — 살아 있다.
전역 / 속성 축: 이번 주입(`__zp_positive_control`, `data-zp-positive`)은
**우리 스크러버가 먼저 가려서** 안 잡혔다. 즉 이 둘은 "스크러버가 실패할 때만"
울리는 축이고, 그건 설계대로다 — 오늘 실제로 울렸다(전역 24건, 속성 9건).

### 결과

naver / wikipedia / github **전부 0건**, 픽스처 0건.

---

## 2026-08-22 — 타이밍 축 신설: **우리가 하는 말과 타이밍이 서로 모순이었다**

이름은 디프록시해 뒀는데 **타이밍 필드는 손대지 않았다.** github 을 대조군과
나란히 재니 네 가지가 갈렸다.

| | 대조군(직접) | 프록시(전) |
|---|---|---|
| `workerStart > 0` | 0/140 | **196/196** |
| `nextHopProtocol` | h2 / h3 | 전부 `''` |
| `secureConnectionStart > 0` | 136/140 | 0 |
| nav `deliveryType` / `transferSize` | `''` / 117731 | `cache` / **0** |

### 핵심은 값이 다르다는 게 아니라 **자기모순**이다

명세상 `workerStart` 는 서비스 워커를 지난 요청에만 붙는다. 그런데 우리는
페이지에게 `navigator.serviceWorker.controller === null` 을 말해 둔다(실측 확인).
즉 **없다고 한 워커가 모든 리소스의 타이밍에 찍혀 있었다.** 한 줄이면 끝난다:

```js
!navigator.serviceWorker.controller &&
performance.getEntriesByType('resource').every(e => e.workerStart > 0)
```

같은 논리로 `nextHopProtocol: ''` 도, `deliveryType: 'cache'` + `transferSize: 0`
(= 캐시 적중 주장) 도 우리 진술과 어긋난다.

### 원칙: 지어내지 않고 **이미 한 진술과 일치시킨다**

- `workerStart` → 0 (워커가 없다고 했으니)
- `nextHopProtocol` → 이름의 스킴대로 `h2` / `http/1.1`
- `deliveryType` → `''`, `transferSize` → `encodedBodySize + 300`(헤더분)
- `secureConnectionStart` → **https 일 때만** `connectStart`
  (재사용된 연결의 명세 모양이 `connectStart == secureConnectionStart == connectEnd`)

고친 뒤 프록시 모양이 대조군과 일치한다(workerStart 0/204, TLS 204/204,
proto h2, nav transferSize 612711, deliveryType `''`).

### 프로브 자신의 결함 하나

처음 프로브는 connect 는 **지속시간**(`end-start>0`), TLS 는 **타임스탬프**
(`>0`)로 재고 있었다. 둘을 나란히 놓으면 "connect 0인데 TLS 는 있다" 가
이상해 보이는데, 실은 서로 다른 걸 재고 있었을 뿐이다. 재사용 연결에서는
지속시간 0 + 타임스탬프 유의미가 정상이다.

### 남은 것 (측정값과 함께)

**우리 응답은 전부 "압축 안 됨" 으로 보인다.** SW 가 합성한 본문이라 브라우저가
`encodedBodySize == decodedBodySize` 로 잰다. 실측(github): 대조군 **118/135**
가 압축, 프록시 **0/200**. naver 도 117건 전부.

이건 **지어내면 안 되는 값**이다 — 진짜 압축 크기는 트랜스포트만 안다. 고치려면
SW 가 상류 응답의 실제 encoded 크기를 헤더로 넘겨 프렐류드가 그 값을 보고해야
한다. 지문 탐지기에 `known open item` 으로 넣어 뒀으니 잊히지는 않는다.

---

## 2026-08-23 — 압축 배관: 커널 → SW → 페이지. 0/200 → 198/200

앞 항목이 남긴 "우리 응답은 전부 비압축으로 보인다" 를 닫았다.

### 먼저 확인한 것: 우리는 이미 압축을 받고 있었다

상류로 보내는 헤더는 `gzip, deflate, br, zstd` 이고(2026-08-16 에 identity 를
뗐다) 커널이 전부 푼다. 즉 **압축 크기는 커널이 알고 있는데 아무도 안
넘겨주고** 있었다. 지어낼 필요가 없었다는 뜻이다.

### 배관

1. **커널** (`unwrap_response_body`, http1/http2 양쪽) — 디코드 **직전**의
   `body.len()` 을 `X-ZP-Encoded-Size` 헤더로 싣는다.
2. **SW** — fetch 리스너에서 그 헤더를 읽고 **지우고**, 요청한 클라이언트에게만
   `postMessage({type:'ZP_ENCODED_SIZE', url, size})`.
   *브로드캐스트하지 않는다*: 메시지에 타깃 URL 이 들어 있어 다른 탭에 뿌리면
   그 자체가 탭 간 유출이다(함정노트 A2 와 같은 부류).
3. **프렐류드** — Map 에 받아 두고 `encodedBodySize` 게터가 **아는 것만** 바꾼다.
   모르면 손대지 않는다.

**결과(github)**: 압축으로 보이는 항목 `0/200 → 198/200`. 대조군은 118/135.

### 남은 하나 — 문서. 그리고 **헤더로는 원리적으로 불가능**하다

내비게이션 항목만 아직 `encoded == decoded` 다. 이유가 구조적이다:

- 문서는 **스트리밍 경로**로 간다. 커널이 gunzip 하며 평문을 흘려보내므로
  `Content-Encoding`/`Content-Length` 를 떨군다.
- 상류가 길이를 알려 준 경우엔 실을 수 있게 해 뒀지만 **그것으로 안 닫힌다**:
  스트리밍 대상 오리진은 대개 Content-Length 를 안 보낸다. 실측 —
  github.com 문서 응답에 `content-encoding: gzip` 은 있고 `content-length` 는
  **없다**.
- 진짜 수는 스트림을 끝까지 읽어야 알 수 있고, 그때는 **헤더가 이미 나간 뒤**다.

닫으려면 커널이 인코딩 바이트를 세서 **스트림 종료 시점에** SW 로 올려 보내야
한다(그리고 SW 가 그때 한 번 더 postMessage). 별건이라 지문 탐지기에
`navigation body uncompressed — known open item (streaming path)` 로 박아 뒀다.

### 교훈

"지어내지 않는다" 를 지키려면 **진짜 값이 어디에 있는지부터 찾아야 한다.**
여기서는 이미 우리 손에 있었고(커널), 문제는 배관이 없다는 것뿐이었다.
반대로 문서 쪽은 값이 늦게 생기는 구조라 같은 방법이 안 통한다 — 그 차이를
적어 두지 않으면 다음 사람이 "헤더 하나 더 실으면 되겠네" 로 시작해서 같은
자리에 도착한다.

---

## 2026-08-23 — 문서 압축까지 닫았다. 그리고 **"구조적으로 안 된다" 는 내 진단이 틀렸다**

앞 항목에서 나는 문서 압축을 *known open item* 으로 접었다. 근거는
"진짜 수는 스트림을 끝까지 읽어야 알고 그때는 헤더가 이미 나간 뒤" 였다.
**앞 절반은 맞고 뒤 절반이 틀렸다** — 헤더로 못 싣는 건 사실이지만 그게
"못 한다" 는 아니었다. 펌프를 열어 보니 이미 세고 있었다:

```rust
let mut total_in = 0usize;   // http2.rs pump_body
total_in += len;             // gunzip 이전 = 인코딩된 바이트
```

### 배관 (값이 늦게 생기는 것을 그대로 받아들인다)

1. **커널** — 응답에는 `X-ZP-Stream-Id` 만 싣는다. 펌프가 끝나는 지점
   (deflate-end / END_STREAM) 에서 `total_in` 을 SW 전역
   `__zpStreamEncoded[id]` 에 쓴다.
2. **SW** — transform 의 `flush()` 가 그 id 로 값을 집는다. flush 는 스트림이
   끝난 뒤라 값이 이미 있다.
3. **페이지** — `encodedBodySize` 게터가 쓴다.

### ★여기서 한 번 더 틀렸다: 내비게이션은 클라이언트를 못 잡는다

flush 에서 `clients.get(clientId)` 로 밀어 보내려 했는데 안 왔다. 계측으로
확정: register 도 flush 도 **둘 다 돌았는데** `clients.get` 이 undefined 였다.
내비게이션의 클라이언트는 `event.resultingClientId` 이고, 스트림이 끝나는
시점에는 아직 잡히지 않는다.

그래서 **밀지 말고 당기게** 바꿨다: SW 는 URL 로 남겨 두고, 페이지가 자기
`virtualURL.href` 로 물어본다. 경쟁이 사라지고, 페이지가 이미 아는 자기 URL 로만
묻기 때문에 새로 알려 주는 정보도 없다(탭 간 노출 없음).

### 실측

| | 인코딩 | 디코딩 |
|---|---|---|
| github (대조군 직접) | 117,433 | 574,730 |
| github (프록시) | **117,437** | 612,413 |
| naver | 44,258 | 268,976 |
| wikipedia | 50,534 | 353,924 |

github 의 인코딩 값이 대조군과 **네 자리까지 같다** — 지어낸 값이 아니라 진짜
와이어 바이트다(디코딩 쪽이 큰 건 우리가 리라이트해서 늘어난 것).

지문 탐지기: naver / wikipedia / github **전부 0건**.

### 교훈

"구조적으로 불가능" 이라고 적기 전에 **그 구조를 한 번 더 열어 볼 것.**
여기서는 (a) 값은 이미 세고 있었고, (b) 늦게 생기는 값은 늦게 보내면 됐고,
(c) 밀어서 안 되면 당기면 됐다. 세 번 다 "안 된다" 로 접을 뻔했다.

---

## 2026-08-23 — 사이트를 넓히니 또 나왔다: script src 스태시 누락 + 문서 압축의 두 번째 경로

3개 사이트에서 0건이 됐다고 끝이 아니었다. HN / MDN / stackoverflow 를 추가로
대니 둘이 더 나왔다.

### 1. stackoverflow — `document.scripts` 에 우리 내부 API 경로가 보였다

```
http://proxy.localhost:18080/zp/api/script?kind=classic&u=…&ref=…
```

69개 스크립트 중 **1개**. 원인은 `setScriptSource` 의 `CONTROL_PREFIX` 분기 —
**이미 프록시 URL 인 값은 스태시 없이 통과**시킨다(서버측 htmltx 가 고쳐 내려보낸
정적 태그, 또는 페이지가 복사해 재대입한 값이 여기로 온다). 스태시가 없으니
읽기 표면이 되돌릴 근거를 못 찾는다.

두 가지를 같이 고쳤다:
- 그 분기에서 값 안의 타깃을 복구해 `urlMeta` + `data-zp-target-url` 에 남긴다
  — 다른 모든 표면과 **같은 자리**.
- `script:src` 는 `url_surfaces.json` 에 **없다**(전용 경로로 다루므로). 그래서
  `getAttribute` 훅의 `isURLBearing` 분기를 안 타고 원시 값이 나갔다. 전용
  분기를 추가했다. 프로퍼티는 가려지는데 속성은 안 가려지는 비대칭은 이
  저장소가 이미 한 번 밟은 함정이다(NAVER 폼 제출).

### 2. MDN / HN — 문서 압축이 **버퍼 경로**에서는 안 왔다

앞 커밋에서 닫은 건 **스트리밍 경로**뿐이었다. `br` 같은 비-스트리밍 코딩은
버퍼 경로로 가고, 거기서는 `X-ZP-Encoded-Size` 헤더가 실리지만 **밀어 보내기가
실패**한다 — 내비게이션은 `resultingClientId` 라 그 시점에 클라이언트가 없다.
버퍼 경로에도 URL 맵(pull) 폴백을 달았다.

같은 이유로 **밀어 보내기가 성공해도 맵에서 지우지 않게** 바꿨다. 지우면
페이지의 리스너가 아직 안 붙은 경우 메시지도 잃고 질의할 것도 없어진다.

### 실측

| | 인코딩 | 디코딩 |
|---|---|---|
| MDN | 14,010 | 140,659 |
| HN | 5,653 | 70,442 |

naver / wikipedia / github / MDN / HN **탐지 0건**.

### stackoverflow 는 재확인 못 했다 — 그리고 그걸 적어 둔다

수정 후 SO 는 `Oops! Something Bad` 에러 페이지를 준다(반복 자동 로드에 대한
차단으로 보인다). 그래서 **실제 페이지로는 재확인하지 못했고**, 대신 합성
프로브로 확인했다: 프록시 URL 을 `setAttribute('src')` 로 넣은 스크립트의
`.src` 가 이제 타깃을 돌려준다(고치기 전에는 프록시 URL 이었다).

### stackoverflow 재확인 — 했다 (2026-08-23 추가) {#stackoverflow-재확인}

앞 절에 "재확인 못 했다" 고 적어 뒀는데, 하루 뒤 SO 는 정상 로드된다(에러
페이지는 일시적인 것이었다). **실제 페이지로 재확인: 누출 0.**

| | |
|---|---|
| `document.scripts` (메인 월드) | 59 |
| 진짜 script 요소 (격리 월드) | 63 — 차이 4 = 우리 자산 3 + prewarm 인라인 1 |
| 프록시 URL 인 src | 40 |
| 그중 스태시 보유 | 37 — 나머지 3 은 우리 자산(`/zp/assets/…`) |
| `.src` 가 프록시 URL 로 읽히는 것 | **0** |

### 그리고 "미해명" 이라고 적어 둔 것은 — 틀린 기록이었다

같은 절에 "`.src` 게터의 `!masked` 분기가 왜 되돌리기를 안 태우는지 못 밝혔다"
고 적었다. **그런 분기는 그때 없었다.** `git show 6b4612e` 를 보면:

```
-          if (!masked) return d.get.call(this);
+          if (!masked) return deproxyURL(d.get.call(this), { scan: true });
```

되돌리기는 **바로 그 커밋에서 처음 들어갔다.** `deproxyURL` 이 img/style 에서
도는 것을 확인하고는, 그게 이 자리에도 이미 걸려 있다고 **착각한 채** "왜 여기만
안 되나" 를 쫓았다. 증상은 같은 커밋의 다른 두 변경(쓰기 스태시 / getAttribute
전용 분기)이 닫았으므로, 원인 미상인 채 증상만 사라진 것처럼 보였다.

**규칙**: "고쳤는데 안 듣는다" 를 조사하기 전에, **그 수정이 정말 그 경로에
들어가 있는지 diff 로 먼저 확인한다.** 다른 경로에서 도는 것을 보고 "구현이
있다" 로 일반화하지 않는다. 이 세션에서 같은 부류를 세 번 밟았다 — 기억한
'원본' 이 이미 프록시 값이었던 srcset/style/script 도 같은 모양이다.

### 셋은 중복이 아니다 — 측정으로 확인

스태시(쓰기) 하나로 충분해 보이지만 아니다. 격리 월드에서 **네이티브로**
스태시 없는 프록시 `src` 를 심고(멤브레인을 안 탄다) 메인 월드에서 읽으면:

```
s.src        → https://cdn.cookielaw.org/scripttemplates/202604.2.0/otBannerSdk.js
getAttribute → 같음
outerHTML    → 같음
```

읽기 쪽 되돌리기가 없으면 이 값은 프록시 URL 로 나간다. 스태시는 **멤브레인을
탄 대입만** 덮는다. 그래서 세 자리를 `static-policy.test.js` 가 각각 고정한다
(변이 4/4 뭄).

### 교훈

**"N개 사이트에서 0건" 은 "0건" 이 아니다.** 사이트마다 다른 코드 경로를 밟는다 —
여기서는 (a) 이미 프록시 URL 인 script src, (b) br 인코딩 문서라는 두 경로가
앞선 3개 사이트에서는 한 번도 안 나왔다.

---

## `<base href>` 한 줄이면 문서째 프록시 밖으로 나갔다 (2026-08-25) {#base-href-탈출}

nav-matrix `n3-base-href` 가 오래 "탈출" 로 떠 있었다. 계획 항목 10(`<base href>`
초기 문서 미처리)의 기존 갭으로 짐작만 하고 파지 않았는데, 대조군이 정상인 상태로
다시 재니 **계측 착시가 아니라 진짜**였다.

### 착지 주소가 원인을 말해 준다

```
http://127.0.0.1:18086/zp/p/23YKGo5m…#k=…&server=ws://proxy.localhost:18080/…
         ^^^^^ 타깃 오리진      ^^^^^^^ 우리 프록시 경로
```

**우리 경로인데 오리진이 타깃이다.** 링크 리라이트는 제대로 됐고(합성 픽스처로
확인: 상대/루트상대/절대 href 전부 `http://proxy.localhost:18080/zp/?via=…` 로
바뀐다), **내비게이션을 실행하는 단계**에서 나갔다.

`location.assign` / `location.replace` / `history.pushState` 는 인자를 **문서의
base URL** 로 푼다. 프렐류드는 프록시 경로를 **루트 상대**(`/zp/p/<토큰>`)로
넘기고 있었고, 타깃이 `<base href="http://other/">` 를 두면 그게 그 오리진에
붙는다. 타깃이 한 줄만 쓰면 성립하는 탈출이다.

### 같은 파일 안에서 한쪽만 배운 교훈이었다

`activatedFrameURL` 은 이미 `proxyOrigin + ZP.makeSharePath(...)` 로 **절대 URL**
을 만들고 있었다. 프레임 경로는 이 함정을 이미 알고 있었고, 내비게이션·히스토리·
폼 경로만 몰랐다. 고침은 규칙 하나(`proxyAbsoluteURL()`)를 다섯 자리에 적용:

- `navigateToTarget` (assign / replace / `location.href`)
- `commitVirtualHistory` (push/replaceState)
- `replaceVisibleProxyURL` (replaceState)
- 폼 제출 (`?zp_submit=`)
- `REQUEST_BODY_TOO_LARGE` 에러 페이지 이동

곁들여 닫힌 것: `<base href>` 문서에서는 히스토리 동기화도 **조용히** 깨지고
있었다 — cross-origin 으로 풀린 `pushState` 는 SecurityError 를 던지고 `catch` 가
삼킨다. 증상이 없어서 안 보였을 뿐이다.

### 실측

| | 전 | 후 |
|---|---|---|
| n3-base-href | **밖** (착지 `-`) | 프록시 (착지 O) |
| nav-matrix 탈출 | 1 | **0** |
| 나머지 22칸 | ok | ok (변화 없음) |

회귀: static 145(새 가드 **변이 5/5**), 홀 매트릭스 유출 0/csp-only 0/선언 밖 0,
렌더체크 3사이트 raw=0 csp=0 err=0, 탐지기 기존 known-open 1건뿐.

### 교훈

**같은 저장소 안에서 이미 배운 교훈이 다른 경로에 안 옮겨졌는지 본다.** 오늘만
두 번째다(srcset 은 주석이 규칙을 적어 뒀는데 코드가 안 따랐고, 여기는 프레임
경로가 절대 URL 을 쓰는데 내비게이션 경로가 안 썼다). "이 파일 어딘가에 이미
맞게 한 자리가 있는가" 를 먼저 찾는 편이 빠르다.

---

## `document.location` 이 프록시 주소를 그대로 흘렸다 — 별칭 한 번이면 멤브레인이 꺼졌기 때문 (2026-08-25) {#document-location-유출}

CNN 프레임이 대조군 34 vs 프록시 21 로 남아 있었다. 빠진 것은 **APS(Amazon) 계열과
OMID 검증 프레임**이었고, 콘솔에 `__zp_get(...).turner_getGuid is not a function`
이 5건 있었다.

### 사슬

```
document.location.protocol → "http:"          ← 프록시 스킴이 샜다
   ↓ 벤더 코드(loadScriptFromUrl):
     (protocol === "https:" ? "https://" : "http://") + "www.ugdturner.com/xd.sjs"
http://www.ugdturner.com/xd.sjs → 502          ← 그 호스트는 http 로는 응답하지 않는다
   ↓ 그 스크립트가 정의하는 전역
turner_getGuid → undefined (대조군: function)
   ↓
FAVE/APS 체인 중단 → apstag-iframe · OMID · 동기화 프레임 다수 미생성
```

대조군에서 같은 스크립트는 **https** 로 로드된다. 즉 우리가 흘린 스킴 하나가
광고 스택 전체를 끌어내렸다.

### 왜 마스킹으로는 못 막나

실측: `Object.getOwnPropertyDescriptor(document,'location').configurable === false`,
Location 인스턴스의 `href/protocol/host/…` 도 전부 **own + non-configurable**
(unforgeable). 프로토타입을 덮어 봐야 **인스턴스 own 이 그걸 가린다** — 실제로
프로토타입 게터는 `https:` 를 주는데 페이지가 읽는 own 게터는 `http:` 를 줬다.

### 왜 트랩도 안 탔나 — **이게 본체다**

리라이터의 위험 멤버 래핑에 이런 규칙이 있었다:

```rust
if let Expression::Identifier(recv) = &expr.object {
    if self.is_shadowed(recv.name.as_str()) { return; }   // 지역 수신자면 통째로 skip
}
```

주석의 의도는 `function f(location){ location.href }`(가려진 전역은 지역 값) 하나인데,
실제로는 **모든 지역 수신자**에서 멤브레인이 꺼진다. 즉 **별칭 한 번이면 우회**다:

```js
var u = n.location;  u.protocol      // 우회
n.location?.protocol                 // 디슈가하면 위와 같은 모양 — 벤더 코드가 이것
```

### 고침 (세 겹)

1. 트랩에 `document.location` 추가 — get/set/has/**getOwnPropertyDescriptor** 네 표면
   전부. 마지막이 빠지면 `gopd(document,'location').get.call(document)` 한 줄로 다시 샌다.
2. **base 가 진짜 Location 이면** URL 성분을 가상값으로. 브랜드 체크는 `instanceof`
   가 아니라 **네이티브 게터 직접 호출**이다 — 페이지가 `Symbol.hasInstance` 를 갈아
   끼우면 `instanceof` 는 속는다.
3. 리라이터 shadow 규칙을 **의도대로** 좁힘: 수신자 **이름 자체가** 가려진 위험
   전역일 때만 skip. 지역 이름을 감싸는 것은 의미상 안전하다 — 트랩은
   window/Location/document 가 아닌 base 를 Reflect 로 그대로 흘린다.

### 실측

| | 전 | 후 | 대조군 |
|---|---|---|---|
| `turner_getGuid` | undefined | **function** | function |
| 프레임 | 21 | 21 | 34 |
| iframe 생성 | 23 | 25 | 36 |
| pbjs 이벤트 | 83 | **95** | 72 |

회귀: static 146(새 가드 **변이 5/5**), cargo workspace ok(zp-rewriter 84),
nav-matrix 탈출 0/재현성 결함 0, 홀 매트릭스 유출 0, 렌더체크 3사이트
raw=0 csp=0 err=0, 탐지기 기존 known-open 1건뿐.

### 함정 둘

- **측정 창이 짧으면 회귀로 오인한다.** 리라이터를 고친 직후 프레임 14 / 이벤트 10
  이 나와 회귀인 줄 알았는데, CNN 광고 스택은 60초 이상 걸린다. 안정 후 21 / 95.
  **"고친 뒤 나빠졌다" 는 먼저 같은 시점에서 쟀는지 확인할 것.**
- 두 스위트를 겹쳐 돌리지 말 것(같은 taskweaver 데몬). 그리고 rendercheck 은 `zp`
  데몬을 **직접 띄우지 않는다** — 내가 정리하려고 kill 해 놓고 실행해 전부 `?` 가 나왔다.

### 후속 (같은 날) — 넓게 감싼 대가로 렌더러가 굳었다, 그리고 좁히니 더 좋아졌다

위 ③(리라이터 shadow 규칙 좁힘)을 넣은 뒤 CNN 이 **간헐적으로 굳었다**
(`return 1+1` 조차 30초 타임아웃, 렌더러 662MB, 한 스레드가 msedge.dll 안에서 스핀).

원인 둘을 갈라서 재고 각각 고쳤다.

**(a) 브랜드 체크가 뜨거운 경로에서 예외를 던졌다.** `isNativeLocation` 이
네이티브 게터를 바로 호출해 성공/예외로 판정했는데, `href`/`origin`/`host` 는
앵커·URL·설정객체에서 흔한 이름이라 **Location 이 아닌 base 마다 예외가 하나씩**
났다. 실측(200k 회): 진짜 Location 34ms vs 앵커 **734ms** / 평범한 객체 **796ms**.
고침 — 위조 불가능한 `[[Class]]` 태그로 값싸게 1차 판정하고 통과한 것만 게터로
확증(+ WeakSet 캐시). 재측정: 앵커 **28ms**, 평범한 객체 **13ms**(26~61배).

**(b) 창 사슬까지 감싼 것이 진짜 정지 원인이었다.** (a)를 고쳐도 정지가 남았다.
넓힌 규칙은 `top`/`parent`/`frames`/`opener`/`contentWindow` 도 **지역 별칭에서**
프록시로 보내는데, 그 자리는 광고/동의(CMP) 코드의 상승 루프가 도는 뜨거운
경로다 — **2026-08-24 에 CNN 렌더러를 세운 바로 그 자리다.**

그래서 **URL 성분만** 지역 별칭에서 감싸도록 좁혔다. 구멍은 남지 않는다:
`window` 식별자는 이미 **스코프 프록시**를 돌려주므로 `var w = window; w.parent`
는 그 프록시의 get 트랩을 탄다. 반면 `document` 는 **진짜 객체**를 돌려주므로
URL 성분 쪽만 별칭 경로가 열려 있었다.

실측(좁힌 뒤, 2회 연속 정지 없음): 프레임 **23~25**(좁히기 전 21), iframe 생성
25~27, pbjs 이벤트 79~85, `turner_getGuid` function.

**교훈**: 방어를 넓힐 때는 **어디가 뜨거운 경로인지** 먼저 본다. 이 저장소는
같은 자리(창 사슬 상승 루프)에서 이미 한 번 굳었다 — 그 기록이 있었는데도
넓히면서 그 축을 다시 건드렸다.

### 남은 것

`apstag-iframe` 은 여전히 안 뜬다(프레임 23~25 vs 대조군 34). turner 전역은
살아났으므로 다음 갈래는 APS 초기화 경로다.

## <a id="postmessage-incumbent"></a>창의 postMessage 를 갈아끼우면 자식→부모 e.source 가 부모로 뒤집힌다 (2026-08-25, CNN)

멤브레인이 창 자신의 `postMessage` 를 **소유 속성**으로 교체하고 있었다
(`define(w, 'postMessage', wrapper)`). 그 래퍼는 그 창의 realm 함수다. 자식이
`parent.postMessage(...)` 를 부르면 마지막으로 실행된 사용자 함수가 그 래퍼라
V8 이 incumbent realm 을 **부모**로 잡고, 도착한 이벤트의 `e.source` 가 자식이
아니라 **부모 자신**이 된다. `frameWindowOrigins.get(e.source)` 도 당연히 실패해
`e.origin` 까지 부모의 타깃 오리진으로 뒤집힌다.

### 대조군이 아니었으면 못 봤다

프록시만 보면 "메시지가 4,700건이나 오는데?" 로 정상처럼 보인다. 전부 자기
자신이 보낸 것으로 집계된다는 걸 알려면 **원래 몇 건이 어디서 와야 하는지**를
알아야 한다:

| | 프레임→부모 메시지 | 프레임 수 |
|---|---|---|
| 대조군(직접) | **59건 / 20개 프레임** | 28 |
| 프록시(고치기 전) | **0건** (4,741건 전부 `source === window`) | 25 |
| 프록시(고친 뒤) | 300+ (버퍼 상한), 전부 올바른 오리진 | 28 |

최소 재현으로 기전도 못 박았다 — 부모 realm 래퍼를 끼우면 source 가 부모,
네이티브를 **자식 realm 함수에서** `Reflect.apply` 하면 자식이다.

### 이게 막고 있던 것

bounce 의 저장소 프레임 핸드셰이크가 `e.origin === "https://" + bouncex.website.biu`
로 오리진을 검사한다. 영영 거짓이라 `bouncex.cookie`(did/vid) 가 안 생기고
device_id → `state/js` → `sspConfig` → APS 가 통째로 막혀 있었다. 고친 뒤
`sspConfig` 가 `{aps, criteo, equativ, index, magnite, openpath, pbm}` 로 채워졌다.
SafeFrame 의 `e.source === iframe.contentWindow` 식별도 같은 이유로 깨져 있었다.

### 규칙

**창 자신의 `postMessage` 는 네이티브로 둔다.** 페이지가 보는 경로는 멤브레인
get 트랩이 래퍼를 돌려주므로 targetOrigin 매핑은 그대로 산다. 지문도 같이
사라진다 — 래퍼는 `length: 3` / `configurable: false`, 진짜는 `1` / `true` 였다.

곁가지: `installParentSenderRedirect` + `parentPostMessageSenderQueue` 는 이
문제를 보정하려던 장치인데 **아무 데서도 호출되지 않는 죽은 코드**였다
(`parentRedirectFacades` 도 쓰기만 하고 읽지 않았다). 즉 보정은 한 번도 동작한
적이 없다. 원인을 없앴으므로 **삭제했다**(331c67e, 70줄). 실제로 이번에 그 코드를
읽고 한동안 "이미 처리돼 있네" 로 잘못 판단했다 — 죽은 방어 코드는 다음 사람의
시간을 먹는다.

### 계측 함정

주입 스크립트는 리라이트되지 않으므로 그 안의 `window.location.origin` 은
**언제나 날 값**이다. 이걸 "멤브레인이 떴는지" 신호로 쓰면 영영 안 뜬다.
그리고 `window.addEventListener` 를 document-start 에 붙들어 등록하면 **네이티브
리스너**가 되어 가상화 **전**의 이벤트를 본다 — 그러면 자기 자신이 보낸 것도
프록시 오리진으로 보이고, 위 표의 결론이 정반대로 나온다. 멤브레인이 올라온
신호는 `window.addEventListener !== <document-start 에 붙든 것>` 으로 본다.
