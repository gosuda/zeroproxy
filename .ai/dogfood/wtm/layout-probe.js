// 레이아웃/CSS 무결성 축. 프록시와 대조군에서 **같은 눈으로** 찍어 비교한다.
//
// 2026-08-26 에 이게 없어서 CSS 버그가 오래 살았다: 인라인 `<style>` 을 HTML
// 이스케이프해 `>` 671건이 `&gt;` 가 되고 규칙 98개가 파싱 실패로 버려졌는데,
// 그때 돌던 축(요소 수 / raw URL / CSP / 콘솔 에러)은 **전부 통과**했다.
// 페이지 높이가 3배(7,760 → 22,590px)인데 아무 경보도 안 울렸다.
//
// `exec-js --file` 은 함수 본문으로 실행하므로 최상위 `return` 을 쓴다.
const out = {};
out.height = document.body ? document.body.scrollHeight : -1;
out.width = document.documentElement ? document.documentElement.scrollWidth : -1;
out.els = document.querySelectorAll('*').length;

// ★엔티티 축 — 이번 버그의 직접 신호다. `<style>` 은 raw text 라 엔티티가
// 풀리지 않으므로, 스타일 텍스트 안의 `&gt;`/`&lt;` 는 **무조건** 우리가
// 깨뜨린 것이다(원본에 있었다면 원본 브라우저에서도 죽어 있었을 것이다).
let gt = 0, lt = 0, styleChars = 0;
for (const s of document.querySelectorAll('style')) {
  const t = s.textContent || '';
  styleChars += t.length;
  gt += (t.match(/&gt;/g) || []).length;
  lt += (t.match(/&lt;/g) || []).length;
}
out.styleEntities = gt + lt;
out.styleChars = styleChars;

// 파싱된 규칙 수. 오리진마다 읽기 권한이 다르므로(프록시는 전부 same-origin
// 이라 cross-origin 시트까지 읽힌다) **총합 비교는 오라클이 못 된다** —
// 정보로만 싣는다. 실제로 이번 버그에서 프록시 총합이 더 컸다(6,415 vs 5,608).
let rules = 0, unreadable = 0;
for (const sh of document.styleSheets) {
  try { rules += sh.cssRules ? sh.cssRules.length : 0; } catch (e) { unreadable++; }
}
out.rules = rules;
out.unreadableSheets = unreadable;

// 첫 화면에 실제로 보이는 것이 있는가. 높이만 보면 "전부 화면 밖으로 밀렸다"
// 를 놓친다 — 이번에 라이브 플레이어가 y=5073 으로 밀려 재생이 안 됐다.
let above = 0;
const vh = window.innerHeight || 800;
for (const el of document.querySelectorAll('img,video,h1,h2,h3,a,button')) {
  const r = el.getBoundingClientRect();
  if (r.height > 0 && r.top < vh && r.bottom > 0) above++;
}
out.aboveFold = above;
return out;
