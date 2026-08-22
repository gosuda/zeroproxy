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
  // ── 대조군: 프록시 없이 같은 픽스처를 그대로 연다 ──────────────────────
  // 이게 없으면 "착지 실패" 가 우리 탓인지 브라우저 탓인지 구분이 안 된다.
  // 실제로 `target=_blank` / `window.open` 은 사용자 제스처 없는 스크립트
  // 호출이라 크롬이 팝업을 막는다 — 대조군에서도 똑같이 안 뜬다.
  // (구멍 매트릭스가 같은 이유로 대조군을 먼저 돌린다. 2026-08-14 교훈.)
  //
  // ★먼저 about:blank 로 **비운다**. 이게 없으면 앞 케이스의 프록시 단계에서
  // 아직 진행 중이던 내비게이션이 `/reset` 직후에 착지해, 대조군 히트 로그에
  // **앞 케이스의 id** 가 찍힌다. 그러면 지금 케이스 id 를 찾는 검사는 항상
  // 빗나가고 대조군 열이 전부 `-` 가 된다 — 그 상태에서는 `stuck`(대조군은
  // 되는데 프록시는 안 되는 것)이 **구조적으로 빌 수밖에 없어** 재현성 축이
  // 통째로 무의미해진다. 2026-08-21 에 23칸 전부 `-` 인 것을 보고 손으로
  // 재현해서 확인했다: 같은 케이스도 비우고 열면 정상 착지한다.
  tw('navigate', '-i', ID, '--url', 'about:blank');
  await sleep(700);
  await fetch(FIX + '/reset');
  tw('navigate', '-i', ID, '--url', FIX + (c.path || '/nav/' + c.id));
  await sleep(5000);
  const controlHits = await get(FIX + '/hits');
  const controlLanded = Object.values(controlHits).flat().some(u => u.includes('/landed/' + c.id));

  // ★대조군을 **멈춰 놓고** 테이프를 비운다. 이게 없으면 대조군이 진행 중이던
  // 리다이렉트 체인의 나머지 홉이 `--clear` **이후**에 도착해, 프록시 단계의
  // "직접 문서 요청" 으로 잡힌다. 60홉짜리 n13 에서 정확히 그러서
  // **없는 탈출이 한 번 찍혔다**(손으로 재현하면 직접 요청 0). 구멍/내비게이션
  // 매트릭스에서 반복된 계측 결함과 같은 부류다 — **측정은 앞 단계가 끝난
  // 다음에 시작해야 한다.**
  tw('navigate', '-i', ID, '--url', 'about:blank');
  await sleep(1500);
  await fetch(FIX + '/reset');
  tw('dump-recording', '-i', ID, '--clear');
  tw('navigate', '-i', ID, '--url', PROXY + '/zp/');
  tw('fill-form', '-i', ID, '--selector', 'input', '--value', FIX + (c.path || '/nav/' + c.id));
  tw('click', '-i', ID, '--text', 'Open');
  await sleep(8000);

  const url = String(json(tw('get-url', '-i', ID)).url || '');
  const onProxy = url.startsWith(PROXY);

  // 프레임 축: 자식 프레임이 프록시 밖으로 나갔는가. 최상위 URL 만 보면
  // 프레임은 페이지가 안 떠나므로 **영영 안 잡힌다** — 축을 나눈 이유가 이것이다.
  let framesOutside = 0;
  if (c.axis === 'frame') {
    const total = Number(json(tw('get-frames', '-i', ID)).total_count || 0);
    for (let i = 0; i < total; i++) {
      const r = json(tw('exec-js', '-i', ID, '--frame', String(i), '--world', 'isolated',
        '--script', 'return String(location.href||"")'));
      const href = String(r.result || '');
      // about:blank / 부모 URL 상속은 프록시 안이다. 착지 오리진이면 밖이다.
      if (/127.0.0.1:1808[67]/.test(href)) framesOutside++;
    }
  }

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
    axis: c.axis === 'frame' ? '프레임' : '최상위',
    where: onProxy ? '프록시' : '밖',
    direct: directDoc,
    frames: framesOutside,
    control: controlLanded ? 'O' : '-',
    landed: landed ? 'O' : '-',
    verdict: !onProxy || directDoc > 0 || framesOutside > 0 ? '탈출' : 'ok',
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 24), pad('축', 7), pad('대조군', 7), pad('문서위치', 8), pad('직접', 5), pad('밖프레임', 8), pad('착지', 5), '판정');
for (const r of rows) console.log(pad(r.id, 24), pad(r.axis, 7), pad(r.control, 7), pad(r.where, 8), pad(r.direct, 5), pad(r.frames, 8), pad(r.landed, 5), r.verdict);

const escapes = rows.filter(r => r.verdict === '탈출');
// 대조군에서도 안 되는 것은 우리 결함이 아니다(팝업 차단 등).
const stuck = rows.filter(r => r.verdict === 'ok' && r.landed === '-' && r.control === 'O');
const blockedByBrowser = rows.filter(r => r.control === '-');
console.log('\n[격리] 문서째 프록시 밖으로 나간 것:', escapes.length ? escapes.map(r => r.id).join(', ') : '없음');
console.log('[재현성] 대조군에서 되는데 프록시에서 안 되는 것:', stuck.length ? stuck.map(r => r.id).join(', ') : '없음');
if (blockedByBrowser.length) console.log('(대조군에서도 안 됨 — 브라우저가 막는 것이지 우리 결함이 아니다):', blockedByBrowser.map(r => r.id).join(', '));
