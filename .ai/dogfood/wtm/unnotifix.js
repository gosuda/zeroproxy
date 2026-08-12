// dist prelude 에 **자기재귀 게터를 되살린다**(대조군).
// 수정 전후를 같은 조건에서 붙여 비교하기 위한 것이다 — 실행 비율만 보면
// 오늘 오전 수정 전 베이스라인도 8/8 ALIVE 였으므로 수치만으로는 못 가린다.
// 프로브 페이지 로그가 `Notification.permission` 에서 끊기는지가 직접 증거다.
const fs = require('fs');
const p = 'f:/git/zeroproxy/dist/web/runtime-prelude.js';
let s = fs.readFileSync(p, 'utf8');

// 줄바꿈이 CRLF 라 문자열 리터럴 매칭은 조용히 실패한다(이 프로젝트에서 반복된 함정).
const FIXED = /try \{\r?\n\s*const stored = prefixedStorage\(nativeLocalStorage, localPrefix\)\.getItem\(permKey\);\r?\n\s*if \(stored\) return stored;\r?\n\s*\} catch \{\}\r?\n\s*try \{ return nativePerm\(\); \} catch \{ return 'default'; \}/;
if (!FIXED.test(s)) throw new Error('fixed getter body not found');

const BUGGY = `            /*ZP_DEV_UNNOTIFIX*/
            try { return prefixedStorage(nativeLocalStorage, localPrefix).getItem(permKey) || NativeN.permission; }
            catch { return NativeN.permission; }`;

fs.writeFileSync(p, s.replace(FIXED, BUGGY));
console.log('recursive getter restored (dist only)');
