// 동시에 살아 있는 두 타깃 사이의 채널 격리 (BroadcastChannel).
//
// 스토리지 축(run.mjs)은 A 에 쓰고 B 에서 읽는 **순차** 방식이라 채널을 못 잰다 —
// 채널은 지속되지 않고 양쪽이 **동시에** 살아 있어야 의미가 있다. 그래서 A 문서
// 안에 프레임 둘을 띄운다: 같은 타깃 A 하나, 다른 타깃 B 하나.
//
// 눈이 둘이다:
//   ① 재현성 — 같은 타깃 프레임은 **받아야** 한다 (안 받으면 BC 가 통째로 깨진 것)
//   ② 격리   — 다른 타깃 프레임은 **못 받아야** 한다
// ①이 없으면 ②의 "안 받았다" 는 아무 증거가 아니다. 예전에 그 함정을 밟았다:
// 프레임 인덱스를 확인 안 하고 A 프레임에 수신기를 심어 놓고 "격리됨" 이라
// 읽을 뻔했다. 그래서 지금은 **심기 전에 프레임 신원을 확인**하고, 안 맞으면 멈춘다.
import { execFileSync } from 'node:child_process';

const ID = 'zp';
const PROXY = 'http://proxy.localhost:18080';
// 프레임이 적은 최소 페이지를 쓴다(매트릭스 /page 는 자기 iframe 이 18개다).
const A = 'http://localhost:18099/hdrprobe';
const B = 'http://127.0.0.1:18098/hdrprobe';
const tw = (...a) => {
  try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = s => { try { return JSON.parse(s); } catch { return {}; } };
const run = (script, ...extra) => json(tw('exec-js', '-i', ID, '--await', '--script', script, ...extra)).result;
const frameBase = (i) => {
  const r = run('return document.baseURI;', '--frame', String(i));
  return typeof r === 'string' ? r : '';
};

tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
await sleep(1500);
tw('clear-site-data', '-i', ID, '--types', 'all');
tw('reload', '-i', ID, '--hard');
await sleep(2500);
tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
tw('fill-form', '-i', ID, '--selector', 'input', '--value', A);
tw('click', '-i', ID, '--text', 'Open');
await sleep(9000);

run(`
  for (const [id, src] of [['zpSame', ${JSON.stringify(A)}], ['zpOther', ${JSON.stringify(B)}]]) {
    const f = document.createElement('iframe');
    f.id = id; f.width = 120; f.height = 60; f.src = src;
    document.body.appendChild(f);
  }
  return 'planted';
`);
await sleep(11000);

// 프레임 신원을 **먼저** 확인한다. 인덱스를 믿지 않는다.
const total = Number(json(tw('get-frames', '-i', ID)).total_count || 0);
let sameIdx = -1, otherIdx = -1;
for (let i = 0; i < total; i++) {
  const base = frameBase(i);
  if (base === A && sameIdx < 0) sameIdx = i;
  else if (base === B && otherIdx < 0) otherIdx = i;
}
console.log(`프레임 ${total}개 — 같은타깃(A)=${sameIdx} 다른타깃(B)=${otherIdx}`);
if (sameIdx < 0 || otherIdx < 0) {
  console.log('[!] 프레임을 못 찾았다 — 이 실행은 판정 불가다. (인덱스를 추측해서 진행하면 안 된다.)');
  process.exit(0);
}

const ARM = `
  self.__zp_bc_got = [];
  try {
    const bc = new BroadcastChannel('zp_probe_chan');
    bc.onmessage = (e) => { self.__zp_bc_got.push(String(e.data)); };
    self.__zp_bc_ref = bc;
    return 'armed';
  } catch (e) { return 'arm-err:' + e.name; }
`;
console.log('A 프레임 수신기:', run(ARM, '--frame', String(sameIdx)));
console.log('B 프레임 수신기:', run(ARM, '--frame', String(otherIdx)));

const sent = run(`
  const tx = new BroadcastChannel('zp_probe_chan');
  tx.postMessage('FROM-A');
  await new Promise(r => setTimeout(r, 3000));
  return 'sent';
`);
const gotSame = json(run('return JSON.stringify(self.__zp_bc_got || null);', '--frame', String(sameIdx)) || 'null') || [];
const gotOther = json(run('return JSON.stringify(self.__zp_bc_got || null);', '--frame', String(otherIdx)) || 'null') || [];

console.log('\n── 판정 ──');
console.log('[재현성] 같은 타깃 프레임 수신:', gotSame.length ? gotSame.join(',') : '없음');
console.log('[격리]  다른 타깃 프레임 수신:', gotOther.length ? gotOther.join(',') : '없음');
if (!gotSame.length) {
  console.log('[!] 같은 타깃끼리도 전달이 안 됐다 — BroadcastChannel 이 통째로 깨졌거나 계측이 틀렸다.');
  console.log('    이 실행에서 "격리 없음" 은 증거가 아니다.');
} else if (gotOther.length) {
  console.log('[!!] 다른 타깃이 받았다 — 격리 누출이다.');
} else {
  console.log('[ok] 같은 타깃은 받고 다른 타깃은 못 받았다 — 양성 대조를 가진 격리다.');
}

// ── SharedWorker: 같은 이름이면 인스턴스를 공유한다 ─────────────────────────
//
// 접속 순번을 돌려주는 워커를 두 프레임이 같은 이름으로 붙는다.
//   같은 타깃 두 접속  → 1, 2 (공유돼야 정상 = 재현성)
//   다른 타깃          → 다시 1 (공유되면 격리 누출)
const SW_CONNECT = (origin) => `
  try {
    const w = new SharedWorker(${JSON.stringify('%ORIGIN%/sharedworker.js')}.replace('%ORIGIN%', ${JSON.stringify(origin)}), 'zp_probe_sw');
    const n = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 6000);
      w.port.onmessage = (e) => { clearTimeout(t); res(e.data); };
      w.port.start();
      w.port.postMessage('n');
    });
    return String(n);
  } catch (e) { return 'err:' + (e && e.name ? e.name : String(e)); }
`;
const swSame1 = run(SW_CONNECT(new URL(A).origin), '--frame', String(sameIdx));
const swSame2 = run(SW_CONNECT(new URL(A).origin));
const swOther = run(SW_CONNECT(new URL(B).origin), '--frame', String(otherIdx));
console.log('\n[SharedWorker] 같은타깃 프레임=' + swSame1 + ' / 같은타깃 최상위=' + swSame2 + ' / 다른타깃=' + swOther);
if (String(swSame1).startsWith('err') || String(swSame2).startsWith('err')) {
  console.log('[!] 같은 타깃에서도 SharedWorker 접속이 안 됐다 — 이 실행에서 격리 판정은 불가다.');
} else if (String(swSame2) === String(swSame1)) {
  console.log('[!] 같은 타깃 두 접속이 같은 순번이다 — 인스턴스를 공유하지 않는다(재현성 결함 후보).');
} else if (!String(swOther).startsWith('err') && Number(swOther) > 1) {
  console.log('[!!] 다른 타깃이 같은 인스턴스에 붙었다 — 격리 누출이다.');
} else {
  console.log('[ok] 같은 타깃끼리는 공유하고 다른 타깃은 별도다 — 양성 대조를 가진 격리다.');
}
