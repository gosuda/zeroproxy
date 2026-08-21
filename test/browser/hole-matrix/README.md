# 구멍 매트릭스 (hole matrix)

페이지가 URL 을 바깥으로 내보낼 수 있는 경로를 전수로 놓고, **재현성** 과
**격리** 를 동시에 재는 브라우저 하니스. `npm test` 에는 들어 있지 않다 —
실브라우저(taskweaver)와 로컬 픽스처 서버 두 개가 필요하다.

## 왜 두 축을 같이 재는가

한 축만 보면 반드시 오진한다. 실제로 그랬다:

- **재현성만 본다** = 바이트가 픽스처 서버에 도착했는가. 그런데 프록시가
  대신 가져와도 **같은 서버에 같은 URL 로** 도착한다(`-socks internal` 이면
  출발 IP 까지 같다). "도착했으니 샜다" 는 성립하지 않는다.
- **격리만 본다** = 브라우저가 외부 오리진으로 직접 갔는가
  (`dump-recording --filter network`, 브라우저 자신의 기록). 그런데 CSP 가
  막은 *시도* 와 성공한 유출이 구분되지 않는다.

그래서 판정은 두 신호의 조합이다:

| 직접 시도 | 도착 | 판정 |
|---|---|---|
| O | O | **진짜 유출** — 바이트가 우리를 거치지 않고 나갔다 |
| O | X | `csp-only` — 리라이트는 놓쳤고 2선 방어(CSP)만 남았던 것 |
| X | — | `ok` — 리라이트가 잡았다 |

## 재현성 X 가 곧 버그는 아니다

의도적으로 막는 것들이 있다. 이걸 버그로 세면 목록이 부풀고 진짜 구멍이
묻힌다 (2026-08-14 에 실제로 `<object>`/`<embed>` 를 그렇게 오해했다):

- `b8-preload-link` — `preload`/`prefetch`/`preconnect`/`dns-prefetch`/
  `prerender`/`manifest` 는 차단 목록. `preconnect` 는 타깃 호스트명을 DNS 로
  그대로 넘긴다.
- `b9-object-data` / `b10-embed-src` / `a23-static-object-cross` —
  `object-src 'none'`. plugin 표면은 금지.

  **2026-08-21 정정**: 예전에는 이 자리를 "리라이트하지 않는다" 로도 이해하고
  있었는데, 그건 두 질문을 섞은 것이었다:

  | 질문 | 답 | 누가 지키나 |
  |---|---|---|
  | 로드를 허용하는가 | **아니오** | CSP `object-src 'none'` |
  | 원본 URL 이 DOM 에 남아도 되는가 | **아니오** | 리라이트 |

  둘째를 놓치면 정적 cross-origin `<object data>` 가 `csp-only` 로 남는다.
  실제로 그랬다 — 정적 칸이 없어서 안 보이다가 `a23` 을 넣자마자 드러났다.
  리라이트해도 CSP 는 URL 과 무관하게 로드를 거부하므로 표면은 되살아나지 않는다.
  (페이지 realm 의 `isURLBearing` 은 처음부터 이렇게 하고 있었고 htmltx 만
  갈라져 있었다.)
- `c7-worker` / `c8-worker-cross` — JS blob 을 Worker 로 돌리는 것은 차단.
- `c11-ping-attr` — 클릭 추적 비콘. 값이 공백 구분 URL **목록**이라 단일 URL
  훅으로 다룰 수 없고, 통과시키는 것 자체가 목적에 반한다.
- **FedCM** (`navigator.credentials.get({identity})`, `accounts.google.com/gsi/
  fedcm.json`) — 매트릭스 케이스는 없지만 같은 부류다. 브라우저가 IdP 와
  **직접** 말하는 것이 프로토콜의 전제라, 지원하려면 그 통신을 우리 밖으로
  내보내야 한다. 즉 "출구는 하나" 를 정면으로 깨야 지원되는 기능이다.
  `connect-src` 가 막는 것이 맞고, 그래서 Google 로그인 위젯은 프록시에서
  뜨지 않는다 (2026-08-18 stackoverflow 에서 관측).
`e1-adframe-img` / `e4-blank-iframe-img` 는 오래 이 목록에 있었지만
**2026-08-14 에 해결됐다**. `document.write` / `about:blank` iframe 은 SW
클라이언트가 아니라서 리라이트된 `/zp/api/fetch` 요청이 SW 를 지나쳐 Go 서버로
직행해 403 이 됐다. 이제 부모 realm 이 대신 받아 blob URL 을 물려준다 — 나가는
요청은 여전히 부모의 SW 한 곳만 지나므로 출구는 하나 그대로다. 실사이트에서
naver 메인의 광고 크리에이티브가 정확히 이 경로로 안 뜨고 있었다.

## 실행

```bash
# 1) 프록시 서버 (항상 dist/web — 소스 디렉토리로 띄우면 503 폭주)
./dist/zeroproxy-server.exe -web "$(realpath dist/web)" -addr 127.0.0.1:18080 -socks internal

# 2) 픽스처 서버 (18099 = same-origin, 18098 = cross-origin)
node test/browser/hole-matrix/server.mjs

# 3) 브라우저. CSP 를 **실제로 적용**해야 의미가 있다 —
#    taskweaver 는 기본으로 CSP 를 꺼서 아무것도 안 막힌다.
taskweaver start --id zp --width 1200 --height 800 --record --enforce-csp

# 4) 측정 (대조군 직접 로드 → 프록시 로드 → 표)
node test/browser/hole-matrix/run.mjs
```

`--enforce-csp` 없이 돌리면 `csp_bypassed: true` 라 **모든 칸이 통과한 것처럼
보인다**. `taskweaver list` 로 먼저 확인할 것.

## 쓰는 법

새 케이스가 O 로 바뀐 것만 보고 끝내지 말 것. **표 전체**를 보고 무관한 칸이
바뀌지 않았는지 확인하고, 바뀌었으면 `git stash` 로 되돌려 증상이 돌아오는지
확인한다. 2026-08-14 에 CSS 리라이터를 넣다가 TDZ 예외로 자식 프레임 멤브레인
설치를 통째로 날려먹은 것을 이 방법으로 잡았다 — 새로 고친 칸은 정상이었고,
전혀 무관한 iframe 칸 두 개가 조용히 회귀했다.

## 정적(파싱 시점) 그룹 — 2026-08-20 에 열 칸 추가

`a10-static-iframe` 을 잡고 나서 매트릭스를 다시 보니, 정적 그룹은 열 칸뿐이고
나머지 표면은 **전부 런타임 경로로만** 있었다. 그래서 htmltx 의 `(tag, attr)`
서브리소스 목록과 한 줄씩 대조해 **목록에 없는 조합**을 칸으로 만들었다:
`a11`~`a20`. 여섯 자리가 그때까지 원본 URL 을 그대로 내보내고 있었다 —
`<input type=image src>`, `<video poster>`, SVG `<image href>` / `xlink:href`,
레거시 `<image src>`, 레거시 `background` 속성.

전부 `cross` 로 둔 이유: 원본 오리진으로 직접 나가는지가 유일한 판정이고,
same-origin 상대 URL 은 리라이트를 안 해도 어차피 SW 를 지나므로 아무것도
증명하지 못한다.

**`a20-static-use` 는 대조군에서 안 온다** — 브라우저가 cross-origin `<use href>`
를 원래 막기 때문이다. 프록시에서는 같은 오리진이 되므로 요청이 나간다.
격리 문제는 아니지만(바이트는 우리를 지난다) "프록시가 브라우저보다 허용적인"
방향의 차이라 여기 적어 둔다. 모든 cross-origin 서브리소스를 same-origin 으로
만드는 구조의 일반적 귀결이다.
