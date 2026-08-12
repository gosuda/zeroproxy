// 메인 번들(3e66f2)의 **catch 블록 213개**에 계수기를 심는다.
//
// 왜 catch 인가: 스택 오버플로가 프록시에서 3,216회 난다(직접 로드는 2회).
// 오버플로가 그만큼 반복되려면 누군가 RangeError 를 **삼키고 다시 시도**해야 한다.
// 그 catch 를 찾으면 재시도 루프의 주인이 나온다. 함수 전부를 try/finally 로
// 감싸는 것보다 표적이 훨씬 작고(213곳) 흐름을 바꾸지 않는다.
//
// 회수: 페이지가 굳으면 exec-js 로 못 읽으므로 **힙에서 읽는다**.
// 256회마다 'ZPCATCH#<id>#<count>#<msg>' 문자열을 만들어 배열에 붙잡아 두면
// 풀메모리 덤프 문자열 스캔으로 잡힌다(heapcount.js 와 같은 방식).
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');

const ID = /[A-Za-z0-9_$]/;
const skipString = (s, i) => {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q) return j;
  }
  return s.length;
};
const regexOk = (prev) => !prev || (!ID.test(prev) && !')]}'.includes(prev));
const skipRegex = (s, i) => {
  let cls = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return i;
    if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) { let k = j + 1; while (k < s.length && ID.test(s[k])) k++; return k - 1; }
  }
  return i;
};
const matchParen = (s, pos) => {
  let d = 0, prev = '';
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); prev = c; continue; }
    if (c === '/' && regexOk(prev)) { const e = skipRegex(s, i); if (e > i) { i = e; prev = '/'; continue; } }
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
};

const edits = [];
let id = 0, withBinding = 0, without = 0;
for (let i = 0; i < src.length; i++) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
  if (!ID.test(c)) continue;
  let j = i;
  while (j < src.length && ID.test(src[j])) j++;
  const word = src.slice(i, j);
  const before = i > 0 ? src[i - 1] : '';
  i = j - 1;
  if (word !== 'catch') continue;
  if (ID.test(before) || before === '.') continue;   // `.catch(` 는 Promise 메서드다

  let k = j;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] === '(') {
    const close = matchParen(src, k);
    if (close < 0) continue;
    const binding = src.slice(k + 1, close).trim();
    let b = close + 1;
    while (b < src.length && /\s/.test(src[b])) b++;
    if (src[b] !== '{') continue;
    edits.push({ at: b + 1, text: `__ZPC1(${id},${binding});` });
    withBinding++; id++;
  } else if (src[k] === '{') {
    edits.push({ at: k + 1, text: `__ZPC1(${id},null);` });
    without++; id++;
  }
}

edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);

const prelude = `/*ZP_CATCH_INSTR*/
var __ZC = { n: new Array(${id}).fill(0), marks: [], first: {} };
try { window.__ZPCATCH = __ZC; } catch (e) {}
function __ZPC1(i, e) {
  var c = ++__ZC.n[i];
  if (c === 1 || c % 64 === 0) {
    var m = '';
    try { m = (e && e.message) ? String(e.message).slice(0, 40) : String(e).slice(0, 40); } catch (x) {}
    if (c === 1) __ZC.first[i] = m;
    // 힙 스캔으로 잡을 마커. 배열에 붙잡아 둬야 GC 로 사라지지 않는다.
    __ZC.marks.push('ZPCATCH#' + i + '#' + c + '#' + m);
  }
}
`;

fs.writeFileSync(__dirname + '/main-catch.js', prelude + out);
console.log('catch sites instrumented: ' + id + ' (binding ' + withBinding + ', bare ' + without + ')');
