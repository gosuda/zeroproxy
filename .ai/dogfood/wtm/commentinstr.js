// catchinstr.js 와 **같은 삽입 지점**에 런타임 효과가 0인 주석만 넣는다.
//
// 목적: 계측본이 20초에 굳고 동일 본문은 80초 ALIVE 인 이유를 가른다.
//   주석만으로도 굳으면  → SDK 가 자기 소스를 검사한다(toString 무결성).
//                          그러면 소스 레벨 계측은 원리적으로 불가능하다.
//   주석은 괜찮으면      → 문제는 우리가 넣은 **호출**(비용/부작용)이다.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/wtm-new-main.js', 'utf8');
const inst = fs.readFileSync(__dirname + '/main-catch.js', 'utf8');

// main-catch.js 의 삽입 지점을 그대로 재현하는 대신, 같은 스캐너를 재사용한다.
// 여기서는 간단히 `__ZPC1(<id>,<binding>);` 패턴을 같은 길이의 주석으로 바꾼다.
const preludeEnd = inst.indexOf('*/\n') >= 0 ? inst.indexOf('\n', inst.indexOf('__ZPC1(i, e)')) : 0;
let body = inst.slice(inst.indexOf('\n}\n') + 3);   // 프렐류드 제거
const before = (body.match(/__ZPC1\(/g) || []).length;
body = body.replace(/__ZPC1\([^)]*\);/g, (m) => '/*' + 'z'.repeat(Math.max(1, m.length - 4)) + '*/');
const after = (body.match(/__ZPC1\(/g) || []).length;

fs.writeFileSync(__dirname + '/main-comment.js', body);
console.log('replaced ' + before + ' call sites with comments (remaining ' + after + '), bytes=' + body.length
  + ' (original ' + src.length + ')');
