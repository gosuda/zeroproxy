# 교차 사이트 감사 (audit)

한 사이트를 프록시로 열고 **같은 잣대 3축**으로 잰다. 특정 사이트에 맞춘
수정이 아니라 "다른 URL 에서도 성립하는가" 를 확인하기 위한 도구다.

```bash
node test/browser/audit.mjs "https://developer.mozilla.org/en-US/docs/Web/API/fetch" 15000
```

## 세 축

| 축 | 무엇을 보는가 | 나쁜 값 |
|---|---|---|
| **격리** | 브라우저 자신의 기록(`dump-recording`)에 프록시 오리진 **밖으로** 나간 요청이 있나 | `outsideOrigins` 가 비어 있지 않음 |
| **재현성** | 미프록시 URL, 깨진 이미지, 죽은 스타일시트 | `unproxiedN` / `broken` / `deadSheets` |
| **소음** | CSP 위반, 403, 스타일 거부, postMessage 불일치, uncaught | `console` 버킷 |

격리축이 0 이 아니면 **감옥이 뚫린 것**이고, 나머지는 충실도 문제다. 둘을
같은 표에서 보는 이유는 구멍 매트릭스 README 와 같다 — 한 축만 보면 오진한다.

## 반드시 대조군을 같이 잴 것

프록시 값만 보면 **사이트 자신의 문제를 프록시 결함으로 오진한다.** 실제로:

- naver 의 피드 토픽은 직접 로드에서도 로드마다 바뀐다(회전 풀).
- naver 의 광고는 직접 로드 쪽이 오히려 비어 있는 경우가 있다.
- naver 의 예외 총량은 프록시 29,135 / 직접 29,775 로 **직접이 더 많다**.

같은 URL 을 `taskweaver navigate` 로 직접 열어 같은 프로브를 돌린 뒤 비교한다.
이 방법으로 wikipedia 포털의 l10n 404 는 프록시 고유(직접 0건)임을,
MDN 의 `Illegal invocation` 77건도 프록시 고유임을 확정했다.

## 프로브를 쓸 때의 함정

- **`exec-js --script` 는 리라이트되지 않은 코드다.** 사이트 스크립트는
  `__zp_get(globalThis,"location")` 으로 가상 location 을 받지만 raw 코드는
  진짜 전역을 읽어 프록시 URL 을 본다. **사이트가 보는 값을 재려면 페이지
  전역의 `__zp_get` 을 직접 부를 것.**
- `.src` / `getAttribute` 는 멤브레인이 타깃 URL 로 마스킹한다. DOM 을 정직하게
  보려면 `--world isolated`.
- 직접 사이트의 광고/위젯 iframe 은 **교차 오리진이라 `contentDocument` 가
  null** 이다. 프레임 내용을 세는 지표는 양쪽 비교에 쓸 수 없다.
- `link[rel=stylesheet]` 중 `href` 가 없는 것(테마 전환용 `data-href`)은 죽은
  시트가 아니다 — GitHub 이 그렇게 쓴다.
