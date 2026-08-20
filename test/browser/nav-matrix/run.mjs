// 내비게이션 축 드라이버. 케이스마다 프록시로 열고 **브라우저가 어디에 있는지**
// 를 본다. 서브리소스 매트릭스와 달리 "타깃 도착" 은 판정이 아니다 — 프록시가
// 대신 가져와도 도착하기 때문이다. 탈출의 정의는 **문서의 오리진이 바뀌는 것**.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ID = 'zp';
const FIX = 'http://127.0.0.1:18087';
const PROXY = 'http://proxy.localhost:18080';
const tw = (...a) => { try { return execFileSync('taskweaver', a, { encoding: 'utf8', timeout: 120000 }); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => (await fetch(u)).json();
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

const cases = await get(FIX + '/cases');
const tapePath = 'test/browser/nav-matrix/.last-tape.json';

const rows = [];
for (const c of cases) {
  await fetch(FIX + '/reset');
  tw('dump-recording', '-i', ID, '--clear');
  tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', `${FIX}/nav/${c.id}`);
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(8000);

  const url = String(json(tw('get-url', '-i', ID)).url || '');
  const onProxy = url.startsWith(PROXY);

  // 두 번째 신호: 브라우저가 착지 오리진(18086)으로 **직접** 문서 요청을 냈는가.
  // 오리진만 보면 리다이렉트가 되돌아오는 경우를 놓칠 수 있다.
  tw('dump-recording', '-i', ID, '--filter', 'network', '--output', tapePath);
  let events = [];
  try { events = (JSON.parse(fs.readFileSync(tapePath, 'utf8')).network) || []; } catch {}
  const directDoc = events.filter(e =>
    e.kind === 'request' && /127\.0\.0\.1:1808[67]/.test(e.url || '') &&
    (e.resource_type === 'Document' || e.resource_type === 'Other')
  ).length;

  // 착지했는가 — 재현성 축. 프록시를 거쳐서라도 목적지에 갔어야 정상이다.
  const hits = await get(FIX + '/hits');
  const landed = Object.values(hits).flat().some(u => u.includes('/landed/' + c.id));

  rows.push({
    id: c.id,
    where: onProxy ? '프록시' : '밖',
    direct: directDoc,
    landed: landed ? 'O' : '-',
    verdict: !onProxy || directDoc > 0 ? '탈출' : 'ok',
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 24), pad('문서위치', 8), pad('직접', 5), pad('착지', 5), '판정');
for (const r of rows) console.log(pad(r.id, 24), pad(r.where, 8), pad(r.direct, 5), pad(r.landed, 5), r.verdict);

const escapes = rows.filter(r => r.verdict === '탈출');
const stuck = rows.filter(r => r.verdict === 'ok' && r.landed === '-');
console.log('\n[격리] 문서째 프록시 밖으로 나간 것:', escapes.length ? escapes.map(r => r.id).join(', ') : '없음');
console.log('[재현성] 프록시 안에는 있는데 목적지에 못 간 것:', stuck.length ? stuck.map(r => r.id).join(', ') : '없음');
