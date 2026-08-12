# taskweaver 기능 요청 2라운드 — 계측이 거짓말하지 않게

1라운드(`taskweaver-feature-request.md`)에서 요청한 `pause --full-memory`,
`debugger-arm --strategy exceptions`, `dump-recording` 수정은 **전부 반영됐고 실제로 결정적이었다.**
특히 `debugger-arm --strategy exceptions` 덕에 NAVER SDK 가 내장 함수를 일부러 오용하는
**엔진 프로브 스위트**를 돌린다는 걸 확인했고, 거기서 wedge 의 근본원인까지 갔다.

이번 라운드는 그 다음 단계에서 **실제로 막혔거나, 도구가 틀린 답을 준** 것만 적는다.
전부 이번 세션에서 측정한 내용이다.

---

## 요청 ① (최우선) — `exec-js --main-world`

**이번 조사에서 가장 비쌌던 한계다. 세 세션을 날렸다.**

`exec-js` 는 격리 월드(isolated world)에서 돈다. 그래서 페이지가 만든 전역이 **안 보인다**:

| 읽으려던 것 | 결과 |
|---|---|
| `window.__BVSD` (계측본이 만든 전역) | `undefined` — 계측이 실패한 줄 알았다 |
| `Error.stackTraceLimit` (페이지 realm 값) | 격리 월드의 값이라 **가설 검증 자체가 불가능** |

`window.__BVSD` 가 안 보이는 걸 "마커 전달 실패" 로 오독해서, 실제로는 정상 동작하던
계측을 몇 번이나 다시 짰다. 지금은 **DOM 속성에 JSON 을 써서 밀반출**하고 있다
(`document.documentElement.setAttribute('data-bvsd', …)`) — DOM 은 realm 을 넘어 공유되니까.

```bash
taskweaver exec-js -i zp --main-world --script "return typeof window.__BVSD"
```

격리 월드가 기본인 건 옳다(페이지 훅에 안 걸림). 다만 **선택지가 없는 게 문제**다.
`exec-js-isolated` 가 이미 따로 있으니, `exec-js` 에 `--main-world` 를 주는 쪽이 자연스럽다.

> 부탁: 이게 어렵다면 최소한 **문서에 "exec-js 는 페이지 전역을 못 본다"** 를 명시해달라.
> CLAUDE.md 에는 적어뒀지만 도구 자체의 `--help` 에는 없다.

---

## 요청 ② — `pause` 가 네이티브 스택을 **심볼라이즈**해서 돌려주기

지금 `pause` 는 `.dmp` 파일 경로와 (렌더러가 살아있을 때만) JS 스택을 준다.
굳은 렌더러에서는 `js_stack: ""` 이고 `cdp_status: "wedged"` 라서, 남는 건 `.dmp` 뿐이다.

그래서 이번 세션에 우리가 직접 만든 것:

- `dump.js` — MINIDUMP_THREAD/CONTEXT_AMD64 파서 (Teb@16, ThreadContext.Rva@44, Rip@0xF8)
- `hist2.js` — ntdll 대기가 아닌 스레드만 골라 RIP 히스토그램
- `symbolize.ps1` — Windows Kits `dbghelp.dll` 을 P/Invoke, `SRV*C:\symcache*msdl…` 로 pdb 다운로드
- `modpath.js` — 덤프가 기록한 msedge.dll 경로/크기 추출

이 네 개를 다 거쳐서야 아래 한 줄이 나왔고, **그 한 줄이 이번 세션의 결론이었다**:

```
0x24b901 => v8::internal::Factory::AllocateRaw+0xf1
```

taskweaver 는 이미 덤프를 뜨고 모듈 목록도 갖고 있다. 심볼 해석만 붙으면 된다:

```bash
taskweaver pause -i zp --symbolize
# → busy_threads: [
#     { tid: 51044, symbol: "v8::internal::StackFrameIterator::Advance+0x16b" }, …
#   ]
```

**세부 요청 두 가지** (둘 다 우리가 직접 부딪힌 것):

1. **바쁜 스레드만 골라줄 것.** 대부분의 스레드는 `ntdll.dll+0x1600e4`(대기)다.
   우리 첫 히스토그램은 `threads[0]` 만 봐서 "12샘플 중 6개가 ntdll" 이라는
   **아무 의미 없는 분포**를 냈다. 대기 스레드를 빼야 신호가 보인다.
2. **모듈 경로는 덤프에서 읽을 것.** WebView2 가 자동 업데이트되면
   하드코딩/캐시된 경로(`…\150.0.4078.105\msedge.dll`)가 사라져 심볼 로딩이 통째로 실패한다.
   실제 덤프에는 `…\151.0.4129.72\msedge.dll` 이 올바르게 들어 있었다.

---

## 요청 ③ (버그) — `--browser-arg "--js-flags=…"` 가 렌더러를 죽인다

**이건 하마터면 틀린 결론을 낼 뻔한 버그다.**

가설(“wedge 는 Error 스택 캡처 폭풍”)을 검증하려고 엔진 플래그를 줬다:

```bash
taskweaver start --id zp --browser-arg "--js-flags=--stack-trace-limit=0"
```

결과는 `WEDGE` 였다. 그런데 **그 데몬은 애초에 아무것도 못 한다**:

```bash
taskweaver navigate -i zp --url "about:blank"
taskweaver exec-js  -i zp --script "return 1"
# → JS_EXECUTION_ERROR: Execution timeout (30000ms)
```

플래그만 빼고 같은 순서로 하면 즉시 정상이다:

```
{"limit":10,"stack":83}   ← status: completed
```

즉 그 `WEDGE` 는 페이지가 아니라 **도구가 만든 것**이었다. 가설 기각으로 읽었으면
같은 유형의 오판을 네 번째로 반복할 뻔했다.

- 원인 추정: WebView2 는 `--js-flags` 를 브라우저 프로세스가 아니라 렌더러에 전달해야 하는데,
  전달 경로/이스케이프가 어긋나 V8 초기화가 깨지는 것으로 보인다.
- 최소 대응: **못 고치겠으면 거부해달라.** `start` 시점에 지원하지 않는 플래그를
  `ignored_flags` 에 넣거나 에러로 반환하면, 조용히 망가진 데몬으로 실험하는 일은 막을 수 있다.
- 곁들여: `start` 직후 자체 헬스체크(빈 페이지에서 `exec-js "return 1"`)를 돌려
  `list` 에 `renderer_ok: true/false` 를 노출해주면 이런 함정이 원천 차단된다.

---

## 요청 ④ — `sw-console` 이 아직 못 붙는다

```json
{ "error": "SW_ATTACH_UNAVAILABLE" }
```

Service Worker 안의 에러를 봐야 하는 상황이 이번에도 나왔다(우리 SW 가 로컬 싱크로
`fetch` 하다 실패했는데 이유를 알 수 없었다). 결국 **에러 메시지를 스크립트 본문으로
돌려주는** 편법을 썼다:

```js
return new Response('console.log("ZP_DEV_SINK_THREW:" + ' + JSON.stringify(msg) + ');',
  { headers: { 'Content-Type': 'text/javascript' } });
```

이러니까 페이지 `console-logs` 에 떠서 겨우 읽었고, 답은 `Failed to fetch` 였다
(원인은 우리 CSP `connect-src 'self'`). SW 콘솔만 읽혔으면 몇 시간 아꼈다.

`SW_ATTACH_UNAVAILABLE` 을 던질 때 **왜** 못 붙었는지(타깃 없음 / attach 거부 / 버전)까지
알려주면 최소한 우회 여부를 판단할 수 있다.

---

## 요청 ⑤ (있으면 좋음) — `pause --samples N --interval-ms M`

"스핀 중" 을 주장하려면 표본이 여러 개여야 한다. 지금은 셸에서 직접 돌렸다:

```bash
for i in 1 2 3 4 5 6; do taskweaver pause -i zp --duration-ms 400; sleep 2; done
```

`pause` 는 매번 **모든 프로세스**를 덤프해서 6회 × 6프로세스 = 42개 파일이 쌓였고,
그중 렌더러만 지문(모듈 22개 / 스레드 25개 이상)으로 골라내는 코드를 또 짜야 했다.

```bash
taskweaver pause -i zp --samples 8 --interval-ms 250 --only-pid 27892
```

`--only-pid` 는 이미 있으니, `--samples`/`--interval-ms` 만 얹으면 된다.
덤으로 `auto_selected_pid` 가 이번에 `null` 이었는데, 렌더러가 후보 중 워킹셋 1위(316MB)였다.
자동 선택이 왜 비었는지도 확인 부탁.

---

## 요청 ⑥ (있으면 좋음) — 요청 **initiator 스택**

이번 조사의 핵심 질문 하나가 **"누가 `27b3366….js` 를 요청했는가"** 였다.
지금은 `get-requests`/`network-log` 가 URL·헤더·타이밍은 주지만 initiator 를 안 준다.
결국 번들을 정적 분석해서 webpack publicPath 유도부를 찾아 역추적했다.

```bash
taskweaver get-requests -i zp --url-pattern "27b3366" --include-initiator
# → initiator: { type: "script", stack: [ …call frames… ] }
```

CDP `Network.requestWillBeSent` 의 `initiator` 를 그대로 흘려주기만 하면 된다.

---

## 우선순위

| 순위 | 항목 | 이유 |
|---|---|---|
| 1 | ③ `--js-flags` 버그 (최소한 거부/헬스체크) | **틀린 결론을 만든다.** 기능 부족보다 나쁘다 |
| 2 | ① `exec-js --main-world` | 세 세션을 날린 원인. 지금은 DOM 속성 밀반출로 우회 중 |
| 3 | ② `pause --symbolize` (+바쁜 스레드 선별) | 굳은 렌더러에서 유일하게 남는 신호. 지금은 자작 도구 4개 필요 |
| 4 | ④ `sw-console` attach | SW 에러가 완전 사각지대 |
| 5 | ⑤ `--samples`, ⑥ initiator | 있으면 편함 |

---

## 참고 — 이번 라운드에 우리가 만든 우회 도구

`.ai/dogfood/wtm/` 아래에 있다. taskweaver 에 흡수되면 지워도 되는 것들이다.

| 파일 | 대체하는 기능 |
|---|---|
| `hist2.js` | 바쁜 스레드 RIP 히스토그램 (②) |
| `modpath.js` | 덤프에서 모듈 경로 추출 (②) |
| `symbolize.ps1` | dbghelp P/Invoke 심볼 해석 (②) |
| `inject-payload.js` | 계측본을 SW 에 base64 인라인 — CSP `connect-src 'self'` 우회 |
| `mainprobe.js` | 페이지 realm 값을 DOM 속성으로 밀반출 (①) |

---

## 0.12.0 확인 결과 (2026-08-12)

| 요청 | 상태 |
|---|---|
| ① `exec-js --world main` | **반영, 동작 확인.** main=`42` / isolated=`undefined` 로 검증. DOM 밀반출을 걷어냈다 |
| ② `pause --symbolize` | 반영. 바쁜 스레드 선별(`waiting_threads`)도 들어갔다. **다만 아래 버그** |
| ③ `--browser-arg` | 문서화됨(전용 user data folder). 여전히 `--js-flags` 는 렌더러를 못 쓰게 만든다 |
| ④ `sw-console` | 미반영 (`SW_ATTACH_UNAVAILABLE` 그대로) |
| ⑤ `pause --samples/--interval-ms` | **반영, 동작 확인.** 8샘플 히스토그램을 한 번에 얻었다 |
| ⑥ `get-requests --include-initiator` | 미반영 |

### 버그 — `--symbolize` 가 pdb 없이 "그럴듯한 쓰레기" 를 낸다

```
symsrv_loaded: false      symbols_downloaded: false
symbol_errors: ["SymFromAddrW(...) failed: win32 error 487"]
```

pdb 를 못 받아 **export 심볼로만** 해석한 결과가 이렇다:

```
IsSandboxedProcess+0x783149                                  ← 7.8MB 오프셋
Microsoft::Applications::Telemetry::LogConfiguration+0x1ae6b8
```

같은 RVA 를 우리 `symbolize.ps1`(pdb 캐시 보유)로 풀면 진짜 이름이 나온다:

```
0x1db6109 => v8::internal::CallSiteInfo::ComputeSourcePosition+0x89
0x6928b28 => v8::internal::Script::IsSubjectToDebugging+0x8
```

두 가지 부탁:

1. **symsrv 를 못 올리면 심볼을 내지 말 것.** `symbol: null` + `frame: "msedge.dll+0x…"` 로 두는 편이
   훨씬 낫다. 지금은 오프셋이 메가바이트 단위여도 함수 이름이 붙어 나와서, 그대로 믿으면 틀린 결론이 된다.
   (실제로 `IsSandboxedProcess` 를 보고 "샌드박스 관련인가" 하고 잠깐 헤맸다.)
2. **`dbghelp` 를 Windows Kits 경로에서 LoadLibrary 할 것.** System32 의 dbghelp 에는 symsrv 가 없어
   심볼 서버를 못 쓴다. 우리 `symbolize.ps1` 이 겪고 해결한 것과 같은 함정이다
   (`symsrv.dll` → `dbgcore.dll` → `dbghelp.dll` 순으로 Kits 경로에서 먼저 로드).
