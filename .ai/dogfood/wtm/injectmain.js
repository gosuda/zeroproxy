// 메인 번들 페이로드 주입 + 분기 설치 + **배선 검증**.
// 대상 해시는 새 빌드(1baa7f7)의 메인 번들. 빌드가 바뀌면 여기를 갱신해야 한다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const run = (f, a) => execFileSync(process.execPath, [__dirname + '/' + f].concat(a || []), { stdio: 'inherit' });
run('inject-payload.js', ['main-catch.js', '75b49359']);
run('installdev.js');
const sw = fs.readFileSync('f:/git/zeroproxy/dist/web/sw.js', 'utf8');
for (const need of ['__zpDevSink', 'ZP_DEV_BVSD_B64', 'ZP_DEV_TARGET']) {
  if (sw.indexOf(need) < 0) throw new Error('dev wiring incomplete: missing ' + need);
}
console.log('dev wiring verified (target 75b49359)');
