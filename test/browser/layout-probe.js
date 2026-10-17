// Layout and CSS integrity probe executed via `taskweaver exec-js --file`
// (wrapped as a function body, so top-level `return` is required).
const out = {};
out.height = document.body ? document.body.scrollHeight : -1;
out.width = document.documentElement ? document.documentElement.scrollWidth : -1;
out.els = document.querySelectorAll('*').length;

// `<style>` elements contain raw text where HTML entities are not decoded;
// any `&gt;` or `&lt;` in `textContent` indicates broken HTML escaping during rewrite.
let gt = 0, lt = 0, styleChars = 0;
for (const s of document.querySelectorAll('style')) {
  const t = s.textContent || '';
  styleChars += t.length;
  gt += (t.match(/&gt;/g) || []).length;
  lt += (t.match(/&lt;/g) || []).length;
}
out.styleEntities = gt + lt;
out.styleChars = styleChars;

// Count parsed CSS rules and unreadable cross-origin stylesheets.
let rules = 0, unreadable = 0;
for (const sh of document.styleSheets) {
  try { rules += sh.cssRules ? sh.cssRules.length : 0; } catch (e) { unreadable++; }
}
out.rules = rules;
out.unreadableSheets = unreadable;

// Count visible elements in the initial viewport.
let above = 0;
const vh = window.innerHeight || 800;
for (const el of document.querySelectorAll('img,video,h1,h2,h3,a,button')) {
  const r = el.getBoundingClientRect();
  if (r.height > 0 && r.top < vh && r.bottom > 0) above++;
}
out.aboveFold = above;
return out;
