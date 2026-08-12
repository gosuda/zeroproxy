// 메인 번들 페이로드 주입 + **분기 설치**. 둘 다 해야 계측본이 실제로 실행된다.
const { execFileSync } = require('child_process');
const fs = require('fs');
const run = (f, args) => execFileSync(process.execPath, [__dirname + '/' + f].concat(args || []), { stdio: 'inherit' });
run('inject-payload.js', ['main-catch.js', '3e66f2']);
run('installdev.js');
const sw = fs.readFileSync('f:/git/zeroproxy/dist/web/sw.js', 'utf8');
for (const need of ['__zpDevSink', 'ZP_DEV_BVSD_B64', 'ZP_DEV_TARGET']) {
  if (sw.indexOf(need) < 0) throw new Error('dev wiring incomplete: missing ' + need);
}
console.log('dev wiring verified');
