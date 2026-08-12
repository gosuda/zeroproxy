// 번들에서 **직접 자기재귀** 함수를 찾는다.
//
// 왜: 프록시에서만 스택이 ~3,000 깊이까지 들어간다(직접 로드는 오버플로 2건).
// 무한 재귀라면 대개 자기 이름을 부르는 함수다. 미니파이돼 있어도
// `function N(...){ ... N(...) ... }` 형태는 이름으로 찾을 수 있다.
// 계측이 간헐성 때문에 비싸므로, 후보를 먼저 좁혀 두면 표적 계측이 가능하다.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/' + (process.argv[2] || 'wtm-new-main.js'), 'utf8');

const ID = '[A-Za-z0-9_$]';
// 미니파이 코드의 주류는 변수에 할당된 익명 함수다. 세 형태를 모두 잡는다.
const re = new RegExp(
  'function\\s+(' + ID + '+)\\s*\\('
  + '|(' + ID + '+)\\s*=\\s*function\\s*\\('
  + '|(' + ID + '+)\\s*=\\s*\\([^)]{0,80}\\)\\s*=>', 'g');

// 대충의 본문 범위: 함수 헤더 이후 중괄호 균형으로 끝을 찾는다.
function bodyEnd(s, from) {
  const open = s.indexOf('{', from);
  if (open < 0) return -1;
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {          // 문자열 건너뛰기(대략)
      const q = c;
      for (i++; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === q) break; }
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

const hits = [];
let candidates = 0;
let m;
while ((m = re.exec(src)) !== null) {
  candidates++;
  const name = m[1] || m[2] || m[3];
  if (!name || name.length > 12) continue;             // 미니파이 이름은 짧다
  const end = bodyEnd(src, m.index);
  if (end < 0) continue;
  const body = src.slice(m.index, end + 1);
  const calls = body.match(new RegExp('(^|[^' + ID + '.])' + name + '\\s*\\(', 'g'));
  // 헤더 자신이 1건 잡히므로 2건 이상이어야 자기재귀다.
  if (calls && calls.length >= 2) {
    hits.push({
      name,
      at: m.index,
      len: body.length,
      selfCalls: calls.length - 1,
      hasTry: /\btry\s*\{/.test(body),
      head: body.slice(0, 110).replace(/\s+/g, ' '),
    });
  }
}

hits.sort((a, b) => b.selfCalls - a.selfCalls);
// 후보 수를 같이 찍는다 — 0건이 "재귀 없음" 인지 "스캐너가 안 물었음" 인지 갈린다.
console.log('candidates scanned:', candidates, ' self-recursive:', hits.length);
hits.slice(0, 15).forEach(h =>
  console.log('  @' + h.at + ' ' + h.name + '  selfCalls=' + h.selfCalls
    + ' len=' + h.len + (h.hasTry ? ' [try]' : '') + '\n      ' + h.head));
