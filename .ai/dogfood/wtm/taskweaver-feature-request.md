# taskweaver 기능 요청 — 굳은(wedged) 렌더러 진단

## 배경

ZeroProxy(멤브레인 프록시)에서 NAVER 로그인 페이지를 열면 anti-bot 번들
(`wtm.pstatic.net/fce46da/3e66f2f66f0a10a01bbd.js`, 389KB)이 실행된 뒤
**렌더러 메인 스레드가 영구히 굳는다**. 재현은 100% 안정적이다.

여러 세션에 걸쳐 **계측 축 15개 · 토글 실험 11건**을 소진했고, 지금 병목은
가설이 아니라 **관측 수단**이다. 아래는 그 과정에서 확인된 taskweaver 의
한계와, 그걸 넘기 위해 필요한 기능이다.

## 지금까지 확인된 도구 한계 (실측)

| 도구 | wedge 상태에서 | 확인된 사실 |
|---|---|---|
| `exec-js` / `get-html` / `console-logs` | ❌ | 30s 타임아웃. 메인 스레드와 같은 스레드 |
| `profile-start` → `profile-stop` | ❌ | **wedge 전에 걸어도** `profile-stop` 이 CDP 응답 대기 → `PROFILER_STOP_FAILED` |
| `heap-snapshot` | ❌ | `HEAP_USAGE_FAILED` (CDP 타임아웃) |
| `trace` | ⚠️ | 수집 채널은 살아있지만 **굳은 렌더러가 이벤트를 방출하지 않는다** → wedge *이전* 활동만 담긴다 |
| `dump-recording` (`start --record`) | ❌ | `counts: {console:0, exceptions:0, network:0}` — 버퍼가 항상 비어 있다 (2026-06-01 에도 동일 보고, 미수정) |
| `debugger-arm` | ⚠️ | `--strategy first-script\|url` 뿐. **예외 기반 트리거 없음** |
| `pause` (minidump) | ✅ | **유일하게 작동**. 커널 API 라 wedge 무관. 단 아래 ①의 제약 |

## 요청 ① (최우선) — `pause --full-memory`

**문제**: `pause` 가 만드는 덤프는 **2.19MB** 다. 대상 프로세스는 워킹셋 수백
MB~GB인데, 덤프에는 **스택 + 모듈 목록 + 스레드 컨텍스트만** 들어 있고 힙이
없다. 실제로 덤프 내 문자열을 세면 `ThreadPoolForegroundWorker`(15회),
`MemoryReclaimerPressureListener`(4회) 같은 **런타임 인프라 문자열뿐**이고
페이지/JS 객체 문자열은 **0건**이다.

즉 `MiniDumpWriteDump` 가 최소 플래그로 호출되고 있다.

**요청**: `MiniDumpWithFullMemory`(+`MiniDumpWithFullMemoryInfo`,
`MiniDumpWithHandleData`) 로 덤프하는 옵션.

```
taskweaver pause --id zp --full-memory [--only-pid <PID>]
```

- `--only-pid` 도 함께: 현재 `pause` 는 렌더러 프로세스 **6~7개를 전부** 덤프한다.
  full-memory 면 파일이 GB 급이 되므로 대상 하나만 뜨는 옵션이 필수.
- (선택) `--max-bytes` 로 상한을 두고 초과 시 실패 대신 경고.

**이것이 열어주는 것**: "무엇이 대량으로 할당되는가" 에 답할 수 있다. 현재
RIP 히스토그램(20샘플)은 `MarkCompactCollector::Evacuate`, scavenger,
`StackFrameIterator`, `CaptureSimpleStackTrace`, `TryCatch::capture_message`
같은 **GC·예외 기구**를 가리키는데, 이게 원인인지 증상인지 가르려면 **힙 내용**이
필요하다. 지금은 그 질문에 답할 경로가 하나도 없다.

**수용 기준**: WS 300MB 프로세스에서 덤프 크기가 워킹셋에 비례하고, 덤프 안에서
페이지 출처 문자열(예: `nid.naver.com`, 페이지 DOM 텍스트)이 검색된다.

## 요청 ② — `debugger-arm --strategy exceptions`

**문제**: 예외 폭주 가설을 **직접** 검증할 방법이 없다. 페이지 realm 에서
`Error`/`TypeError` 전역 생성자 7종을 래핑해도 **0회**로 나온다 — 엔진이 던지는
예외(Proxy 불변식 위반 TypeError, `Illegal invocation` 등)는 JS 전역 생성자를
거치지 않기 때문이다.

**요청**: CDP `Debugger.setPauseOnExceptions("all"|"uncaught")` 를 wedge **전에**
무장하고, `Debugger.paused` 의 콜프레임을 **데몬 측 버퍼**에 쌓은 뒤 자동 resume.
기존 `debugger-arm`/`debugger-snapshot` 구조를 그대로 재사용하면 된다.

```
taskweaver debugger-arm --id zp --strategy exceptions [--uncaught-only]
taskweaver debugger-snapshot --id zp        # 예외별 스택 + 메시지
```

- 폭주 상황을 전제로 **샘플링/상한**이 필요하다: `--max-frames N`,
  `--sample-every N`(N번째 예외만 기록).

**수용 기준**: 굳은 렌더러에서도 `debugger-snapshot` 이 예외 메시지와 콜프레임을
반환한다(= 데몬 버퍼 읽기이므로 wedge 무관).

## 요청 ③ (버그) — `dump-recording` 이 항상 비어 있다

`start --record` 후 `dump-recording` 이 `counts: {console:0, exceptions:0,
network:0}`, `returned` 도 전부 0. wedge 전/후 무관하게 비어 있다.
`renderer_wedged_at_ms` 도 `null` 로만 나온다.

문서상 이 기능은 "wedge 를 넘기는 유일한 채널"로 소개되는데, 실제로는 동작하지
않아 **로컬 HTTP 싱크(`fetch(keepalive)` → `127.0.0.1:<port>`)를 직접 만들어**
우회해야 했다. 2026-06-01 에도 같은 증상을 기록했으므로 회귀가 아니라 미수정
상태로 보인다.

**수용 기준**: `--record` 로 띄운 인스턴스에서 콘솔 로그 1줄을 찍은 뒤
`dump-recording --filter console` 이 그 줄을 반환한다.

## 요청 ④ (있으면 좋음) — 브라우저 인자 주입

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 를 통해 Chromium 플래그를 넘길 수 있는
공식 경로. 특히 `--enable-heap-profiling`, `--enable-logging --log-file=...`,
`--js-flags=...` 를 쓰고 싶다.

```
taskweaver start --id zp --browser-arg "--enable-heap-profiling" --browser-arg "--js-flags=--stack-trace-limit=0"
```

요청 ①이 되면 우선순위는 낮아진다.

## 우선순위

**① > ③ > ② > ④.**

①만 있어도 현재 막힌 질문("무엇이 할당되는가")을 풀 수 있다.
③은 진단 인프라를 직접 만들어야 하는 비용을 없앤다.

## 참고 — 우리가 만든 우회 도구

이 저장소 `.ai/dogfood/wtm/` 에 있다. taskweaver 가 ①/③을 지원하면 대부분 불필요해진다.

- `dump.js` — minidump 파서(스레드 RIP, 모듈 맵). **함정**: `MINIDUMP_THREAD` 는
  `Teb` 가 오프셋 16이라 스택은 24/32/36, 컨텍스트 RVA 는 44. 이걸 틀리면
  **에러 없이** RIP 가 `0x0` 으로 나온다. 정상 파싱이면 대다수 스레드가
  `ntdll+0x1600e4`(대기)로 모인다.
- `hist.js` — 여러 덤프에서 wedged 렌더러(모듈 22/스레드 25+)를 골라 RIP 히스토그램.
- `symbolize.ps1` — `cdb.exe` 없이 Windows Kits 의 `dbghelp.dll` 을 P/Invoke 해
  심볼 서버(`SRV*C:\symcache*https://msdl.microsoft.com/download/symbols`)로
  `msedge.pdb`(622MB)를 받아 RVA→함수명 해석. **함정**: `SYMBOL_INFO` 는
  `MaxNameLen` 이 오프셋 80, `Name` 이 84. 틀리면 `SymFromAddr` 는 성공하고
  변위도 그럴듯한데 **이름만 빈 문자열**이라 "심볼 없음"으로 오판한다.
- `strings.js` — 덤프 내 문자열 빈도(현재는 힙이 없어 무의미 — 요청 ① 대상).
- `serve.js` — 로컬 HTTP 마커 싱크(요청 ③의 우회).
