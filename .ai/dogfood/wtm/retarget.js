// catchinstr.js 를 파라미터화한다 — 대상 번들을 인자로 받게.
// NAVER 가 빌드를 갈면 옛 파일(wtm-raw.js)은 스테일이 되므로 하드코딩은 위험하다.
const fs = require('fs');
const p = __dirname + '/catchinstr.js';
let s = fs.readFileSync(p, 'utf8');

const A = "const src = fs.readFileSync(__dirname + '/wtm-raw.js', 'utf8');";
if (s.indexOf(A) >= 0) {
  s = s.replace(A,
    'const SRC = process.argv[2] || "wtm-new-main.js";\n'
    + 'const OUT = process.argv[3] || "main-catch.js";\n'
    + 'const src = fs.readFileSync(__dirname + "/" + SRC, "utf8");');
}

const B = "fs.writeFileSync(__dirname + '/main-catch.js', prelude + out);";
if (s.indexOf(B) >= 0) s = s.replace(B, 'fs.writeFileSync(__dirname + "/" + OUT, prelude + out);');

const C = "console.log('catch sites instrumented: ' + id + ' (binding ' + withBinding + ', bare ' + without + ')');";
if (s.indexOf(C) >= 0) {
  s = s.replace(C, 'console.log(SRC + " -> " + OUT + ": catch " + id + " (binding " + withBinding + ", bare " + without + ")");');
}

fs.writeFileSync(p, s);
console.log('catchinstr.js parameterised');
