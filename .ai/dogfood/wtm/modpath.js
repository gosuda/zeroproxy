// 덤프가 기록한 msedge.dll 의 **전체 경로 + 이미지 크기 + 타임스탬프** 를 뽑는다.
// symbolize.ps1 이 이 경로로 SymLoadModuleEx 를 부르므로, WebView2 가 자동
// 업데이트되어 그 디렉터리가 사라지면 심볼 로딩이 통째로 실패한다.
//
// 오프셋은 dump.js 의 검증된 것을 그대로 쓴다 — 직접 다시 유도하면 틀린 값을
// **조용히** 내놓는다(이 프로젝트에서 이미 두 번 당했다).
//   헤더: nStreams@8, dirRva@12
//   MINIDUMP_MODULE(108B): Base@0, Size@8, TimeDateStamp@16, NameRva@20
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
if (b.readUInt32LE(0) !== 0x504d444d) throw new Error('not a minidump');

const nStreams = b.readUInt32LE(8);
const dirRva = b.readUInt32LE(12);
let modList = null;
for (let i = 0; i < nStreams; i++) {
  const o = dirRva + i * 12;
  if (b.readUInt32LE(o) === 4) modList = b.readUInt32LE(o + 8);
}
if (!modList) throw new Error('no module list');

const n = b.readUInt32LE(modList);
for (let i = 0; i < n; i++) {
  const o = modList + 4 + i * 108;
  const base = b.readBigUInt64LE(o);
  const size = b.readUInt32LE(o + 8);
  const stamp = b.readUInt32LE(o + 16);
  const nameRva = b.readUInt32LE(o + 20);
  const len = b.readUInt32LE(nameRva);
  const name = b.toString('utf16le', nameRva + 4, nameRva + 4 + len);
  if (/msedge\.dll$/i.test(name)) {
    console.log('path   : ' + name);
    console.log('base   : 0x' + base.toString(16));
    console.log('size   : 0x' + size.toString(16));
    console.log('stamp  : 0x' + stamp.toString(16));
    console.log('exists : ' + fs.existsSync(name));
  }
}
