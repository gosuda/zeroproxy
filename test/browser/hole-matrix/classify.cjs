// 매트릭스 격리 판정의 핵심 — 브라우저 네트워크 테이프에서 "직접 요청이 어떻게
// 끝났는가" 를 뽑는다. 러너에서 떼어 낸 이유는 두 가지다:
//   ① 브라우저 없이 합성 테이프로 판정 로직 자체를 테스트할 수 있다.
//   ② 판정이 한 곳에만 있으면 두 곳이 갈라질 수 없다.
//
// 2026-08-20 이전에는 "테이프에 타깃 URL 이 보이면 직접 나갔다" 로 셌다. 그런데
// CSP 가 막은 요청도 `request` 로 남고(뒤에 `failed` 가 따라온다), 도착 축은
// 우리 프록시가 대신 가져와도 켜진다. 두 신호를 곱해 csp-only 를 LEAK 으로
// 올려 부르고 있었다. 이제 **같은 request_id 의 결말**로 판정한다.

const DIRECT_RE = /127\.0\.0\.1:1809[89]/;

/**
 * @param {{network?: Array, dropped?: {network?: number}}} tape
 * @param {(url: string) => string|null} idOf  URL 에서 케이스 id 를 뽑는 함수
 */
function classifyTape(tape, idOf) {
  const network = (tape && tape.network) || [];
  const droppedNetwork = (tape && tape.dropped && tape.dropped.network) || 0;

  // request 이벤트만 url 을 들고 있다. 나머지는 request_id 로 이어 붙인다.
  const idByReq = new Map();
  for (const e of network) {
    if (e.kind !== 'request' || !e.url) continue;
    if (!DIRECT_RE.test(e.url)) continue;
    const id = idOf(e.url);
    if (id) idByReq.set(e.request_id, id);
  }

  // request_id 하나의 결말. `response` 가 최우선이다 — 응답을 받은 뒤에 스트림이
  // 끊겨 `failed` 가 붙는 경우가 있는데, 그건 이미 타깃과 말한 것이다.
  const outcome = new Map();
  for (const e of network) {
    if (!idByReq.has(e.request_id)) continue;
    if (e.kind === 'response') {
      outcome.set(e.request_id, 'answered');
    } else if (e.kind === 'finished' && e.encoded_data_length > 0) {
      if (outcome.get(e.request_id) !== 'answered') outcome.set(e.request_id, 'answered');
    } else if (e.kind === 'failed') {
      if (!outcome.has(e.request_id)) outcome.set(e.request_id, 'blocked');
    }
  }

  const attempted = new Set(), answered = new Set(), blocked = new Set(), unknown = new Set();
  for (const [req, id] of idByReq) {
    attempted.add(id);
    const o = outcome.get(req);
    if (o === 'answered') answered.add(id);
    else if (o === 'blocked') blocked.add(id);
    // 결말 이벤트가 아예 없는 경우 — 링 버퍼에서 밀렸거나 아직 진행 중이다.
    // **csp-only 로 내려앉히지 않는다**: 그러면 진짜 유출이 조용히 통과한다.
    else unknown.add(id);
  }
  // 같은 케이스가 여러 번 요청될 수 있다(재시도/프리로드). 하나라도 응답을
  // 받았으면 그 케이스는 유출이다 — 나머지 결말은 그 사실을 못 지운다.
  for (const id of answered) { blocked.delete(id); unknown.delete(id); }
  for (const id of blocked) unknown.delete(id);

  return { attempted, answered, blocked, unknown, droppedNetwork };
}

module.exports = { classifyTape, DIRECT_RE };
