// Classify direct network requests in a taskweaver network tape by correlating
// each `request` event with its terminal event (`response`, `finished`, or `failed`)
// via `request_id`.

const DIRECT_RE = /127\.0\.0\.1:1809[89]/;

/**
 * @param {{network?: Array, dropped?: {network?: number}}} tape
 * @param {(url: string) => string|null} idOf
 */
function classifyTape(tape, idOf) {
  const network = (tape && tape.network) || [];
  const droppedNetwork = (tape && tape.dropped && tape.dropped.network) || 0;

  // Only `request` events carry the URL; subsequent events reference `request_id`.
  const idByReq = new Map();
  for (const e of network) {
    if (e.kind !== 'request' || !e.url) continue;
    if (!DIRECT_RE.test(e.url)) continue;
    const id = idOf(e.url);
    if (id) idByReq.set(e.request_id, id);
  }

  // `response` takes precedence over a later `failed` event on the same request_id
  // because the request already reached the target server.
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
    // Keep requests without a terminal event in `unknown` rather than `blocked`
    // so ring-buffer drops or in-flight leaks are not misclassified as CSP blocks.
    else unknown.add(id);
  }
  // If any request for a case id received a response, classify the case as answered.
  for (const id of answered) { blocked.delete(id); unknown.delete(id); }
  for (const id of blocked) unknown.delete(id);

  return { attempted, answered, blocked, unknown, droppedNetwork };
}

module.exports = { classifyTape, DIRECT_RE };
