// 스토리지/쿠키 격리 축.
//
// 프록시는 서로 다른 타깃을 **같은 브라우저 오리진**(프록시 오리진)에 담는다.
// 그래서 진짜 웹이라면 오리진이 갈라 주던 것을 우리가 직접 갈라야 한다:
// 타깃 A 가 쓴 것을 타깃 B 가 읽으면 그건 실제 웹에는 없는 누출이다.
//
// 축 셋을 동시에 본다:
//   ① 격리   — A 가 쓴 것을 B 가 읽는가                 (읽히면 누출)
//   ② 지속성 — A 로 돌아왔을 때 A 의 것이 그대로인가      (사라지면 격리가 과했다)
//   ③ 위생   — 페이지가 우리 내부 키를 볼 수 있는가       (보이면 프록시 정체 노출)
//
// 실행 전제: 프록시(18080)와 픽스처 서버(18099/18098)가 떠 있을 것.
import { execFileSync } from 'node:child_process';

const ID = 'zp';
const PROXY = 'http://proxy.localhost:18080';
// ★A/B 는 **호스트명이 달라야** 한다. 처음엔 127.0.0.1 의 두 포트로 잡았는데,
// 쿠키는 원래 포트를 구분하지 않아서 `document.cookie` 가 LEAK 으로 찍혔다 —
// 대조군(프록시 없이 직접 로드)에서도 똑같이 공유되는 것을 확인했다. 즉 프록시가
// 브라우저와 **같게** 동작한 것이지 결함이 아니었다. 픽스처가 틀린 것이다.
// localhost vs 127.0.0.1 은 호스트 문자열이 달라 쿠키가 안 섞인다(대조군 확인).
const A = 'http://localhost:18099/page';
const B = 'http://127.0.0.1:18098/page';
const tw = (...a) => {
  try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return String((e.stdout || '') + (e.stderr || '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = s => { try { return JSON.parse(s); } catch { return {}; } };
const evalJS = (script, world) => {
  const args = ['exec-js', '-i', ID, '--await', '--script', script];
  if (world) args.push('--world', world);
  const out = json(tw(...args));
  return out.result;
};

async function open(target) {
  tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', target);
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(9000);
}

// A 가 남기는 흔적. 이름 기반 접근(`localStorage.x = …`)도 섞는다 — 아주 흔한
// 관용구이고, 예전에 그 경로가 조용히 삼켜진 적이 있다(주석에 기록됨).
const WRITE = `
  localStorage.setItem('zp_probe_local', 'A-local');
  localStorage.zp_probe_named = 'A-named';
  sessionStorage.setItem('zp_probe_session', 'A-session');
  document.cookie = 'zp_probe_cookie=A-cookie; path=/';
  const done = [];
  try {
    const c = await caches.open('zp_probe_cache');
    await c.put(new Request('/zp-probe'), new Response('A-cache'));
    done.push('cache');
  } catch (e) { done.push('cache-err:' + e.name); }
  try {
    await new Promise((res, rej) => {
      const rq = indexedDB.open('zp_probe_db', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('s');
      rq.onsuccess = () => {
        const tx = rq.result.transaction('s', 'readwrite');
        tx.objectStore('s').put('A-idb', 'k');
        tx.oncomplete = () => { rq.result.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      rq.onerror = () => rej(rq.error);
    });
    done.push('idb');
  } catch (e) { done.push('idb-err:' + e.name); }
  return JSON.stringify(done);
`;

const READ = `
  const out = {};
  out.local = localStorage.getItem('zp_probe_local');
  out.named = localStorage.zp_probe_named === undefined ? null : localStorage.zp_probe_named;
  out.session = sessionStorage.getItem('zp_probe_session');
  out.cookie = /zp_probe_cookie=([^;]*)/.test(document.cookie) ? RegExp.$1 : null;
  try {
    const c = await caches.open('zp_probe_cache');
    const hit = await c.match(new Request('/zp-probe'));
    out.cache = hit ? await hit.text() : null;
  } catch (e) { out.cache = 'err:' + e.name; }
  try {
    out.idb = await new Promise((res) => {
      const rq = indexedDB.open('zp_probe_db', 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('s'); } catch {} };
      rq.onsuccess = () => {
        let v = null;
        try {
          const g = rq.result.transaction('s', 'readonly').objectStore('s').get('k');
          g.onsuccess = () => { v = g.result === undefined ? null : g.result; rq.result.close(); res(v); };
          g.onerror = () => { rq.result.close(); res(null); };
        } catch (e) { rq.result.close(); res(null); }
      };
      rq.onerror = () => res(null);
    });
  } catch (e) { out.idb = 'err:' + e.name; }
  // 위생: 페이지가 보는 키 목록에 우리 내부 이름이 섞이면 안 된다.
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  out.visibleKeys = keys;
  out.internalVisible = keys.filter(k => k && /^_*zp[:_]/i.test(k) && !k.startsWith('zp_probe'));
  return JSON.stringify(out);
`;

const FIELDS = ['local', 'named', 'session', 'cookie', 'cache', 'idb'];
const EXPECT_A = { local: 'A-local', named: 'A-named', session: 'A-session', cookie: 'A-cookie', cache: 'A-cache', idb: 'A-idb' };

// ★깨끗한 상태에서 시작한다. 이게 없으면 **앞 실행의 잔재**를 이번 실행의
// 누출로 오독한다 — 실제로 처음에 그랬다: 픽스처를 고치기 전 실행이 남긴
// 쿠키(도메인 127.0.0.1)가 SW 저장소에 남아 다음 실행의 B 로 흘러들어갔고,
// 그걸 새 누출로 읽을 뻔했다. 상태를 안 지우는 측정은 자기 과거를 잰다.
tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
await sleep(1500);
tw('clear-site-data', '-i', ID, '--types', 'all');
tw('reload', '-i', ID, '--hard');
await sleep(2500);

await open(A);
const wrote = evalJS(WRITE);
console.log('A 기록:', wrote);
const readA1 = json(evalJS(READ));

await open(B);
const readB = json(evalJS(READ));

await open(A);
const readA2 = json(evalJS(READ));

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('항목', 10), pad('A 쓴 직후', 12), pad('B 에서', 12), pad('A 재방문', 12), '판정');
const leaks = [], lost = [];
for (const f of FIELDS) {
  const a1 = readA1[f], b = readB[f], a2 = readA2[f];
  const leaked = b != null && String(b) === EXPECT_A[f];
  const persisted = a2 != null && String(a2) === EXPECT_A[f];
  // sessionStorage 는 탭 세션 스코프라 재방문(같은 탭 내 내비게이션)에도 남는 것이 정상.
  let verdict = 'ok';
  if (leaked) { verdict = 'LEAK'; leaks.push(f); }
  else if (!persisted) { verdict = '유실'; lost.push(f); }
  console.log(pad(f, 10), pad(a1 === null ? '-' : a1, 12), pad(b === null ? '-' : b, 12), pad(a2 === null ? '-' : a2, 12), verdict);
}
console.log('\n[격리] 타깃 A 의 값을 타깃 B 가 읽은 것:', leaks.length ? leaks.join(', ') : '없음');
console.log('[지속성] A 로 돌아왔을 때 사라진 것:', lost.length ? lost.join(', ') : '없음');
const internal = readA2.internalVisible || [];
console.log('[위생] 페이지에 보이는 우리 내부 키:', internal.length ? internal.join(', ') : '없음');
console.log('       (페이지가 보는 전체 키:', (readA2.visibleKeys || []).join(', ') || '없음', ')');
// 계측이 자기 상태를 말하게 한다: A 가 애초에 못 썼으면 격리 0 은 증거가 아니다.
const wroteNothing = FIELDS.filter(f => readA1[f] == null);
if (wroteNothing.length) {
  console.log(`\n[!] A 에서 애초에 안 써진 항목이 있다: ${wroteNothing.join(', ')} — 그 항목의 "누출 없음" 은 증거가 아니다.`);
}
