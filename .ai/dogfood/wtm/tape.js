// pair.sh 가 남긴 프록시 네트워크 테이프에서 판정에 필요한 것만 뽑는다.
//   - wtm/ncpt 로 나간 **전체 URL** (publicPath 가 깨졌는지 여기서 바로 보인다)
//   - 에스컬레이션 신호: 두 번째 스크립트 / errorLog
const fs = require('fs');
const t = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const urls = (t.network || []).map(e => decodeURIComponent(e.url || '')).filter(Boolean);

const count = (w) => urls.filter(u => u.includes(w)).length;
console.log('events:', (t.network || []).length);
console.log('  main 75b49359 :', count('75b49359'));
console.log('  wasm 8fbcc8a6 :', count('8fbcc8a6'));
console.log('  second a3d739e9:', count('a3d739e9'));
console.log('  errorLog      :', count('errorLog'));

// wasm 요청이 **어느 경로로** 나갔는지가 핵심이다.
// publicPath 가 깨지면 `/zp/api/<hash>.wasm` 처럼 프록시 경로 아래로 나간다.
console.log('\nwasm URLs:');
[...new Set(urls.filter(u => u.includes('.wasm')))].forEach(u => console.log('   ' + u.slice(0, 120)));
console.log('\ndistinct wtm/ncpt URLs:');
[...new Set(urls.filter(u => /wtm\.pstatic|ncpt\.naver/.test(u)))].forEach(u => console.log('   ' + u.slice(0, 120)));
