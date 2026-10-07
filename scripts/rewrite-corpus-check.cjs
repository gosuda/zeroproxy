#!/usr/bin/env node
// Rewrites every script a page load fetched and checks that the rewritten OUTPUT parses in V8.
//
// A rewriter bug that emits invalid syntax kills the whole script file, and tests built from hand-written snippets miss the
// shapes real sites use (`for(;;e++)` shipped broken through every unit test and was found on NYT's video player). This runs
// the rewriter over what real pages actually load.
//
//   node --experimental-vm-modules scripts/rewrite-corpus-check.cjs <tape.json | urls.txt>...
//
// Inputs: a taskweaver network tape (`taskweaver start --record`, load the site through the proxy, then
// `taskweaver dump-recording --filter network --output tape.json`) — the script URLs are the `u=` of its
// `/zp/api/script?` requests — or a text file with one script URL per line (`kind=classic`; `module <url>` for a module).
// Needs a built `dist/web/zp-page-bundle.js` (`node scripts/build.mjs`). Downloads are cached by URL under the OS temp dir.
// Exit status 1 if any rewritten script does not parse.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('usage: node --experimental-vm-modules scripts/rewrite-corpus-check.cjs <tape.json | urls.txt>...');
  process.exit(2);
}
if (typeof vm.SourceTextModule !== 'function') {
  console.error('run with --experimental-vm-modules (module scripts are parsed with vm.SourceTextModule)');
  process.exit(2);
}

const urls = new Map();
for (const input of inputs) {
  const text = fs.readFileSync(input, 'utf8');
  if (/^\s*[{[]/.test(text)) {
    for (const e of JSON.parse(text).network || []) {
      if (e.kind !== 'request' || !/\/zp\/api\/script\?/.test(e.url)) continue;
      try {
        const u = new URL(e.url);
        const target = u.searchParams.get('u');
        if (target) urls.set(target, u.searchParams.get('kind') || 'classic');
      } catch {}
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const m = /^(?:(module)\s+)?(https?:\/\/\S+)$/.exec(line.trim());
      if (m) urls.set(m[2], m[1] || 'classic');
    }
  }
}
console.log('script urls', urls.size);

const bundlePath = path.join(root, 'dist/web/zp-page-bundle.js');
if (!fs.existsSync(bundlePath)) {
  console.error('dist/web/zp-page-bundle.js is missing — run `node scripts/build.mjs` first');
  process.exit(2);
}
const ctx = { console, atob, btoa, TextEncoder, TextDecoder, Uint8Array, WebAssembly, FinalizationRegistry, URL };
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), ctx, { filename: 'zp-page-bundle.js' });
const bundle = ctx.ZPBundle;

const cache = path.join(os.tmpdir(), 'zp-rewrite-corpus');
fs.mkdirSync(cache, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const counts = { ok: 0, bad: 0, skipped: 0 };
let bytes = 0;
const failures = [];

for (const [target, kind] of urls) {
  const file = path.join(cache, crypto.createHash('sha1').update(target).digest('hex').slice(0, 16) + '.js');
  if (!fs.existsSync(file)) {
    try { execFileSync('curl', ['-sL', '-m', '25', '-A', UA, '-o', file, target], { stdio: 'ignore' }); } catch { counts.skipped++; continue; }
  }
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { counts.skipped++; continue; }
  if (source.length < 200 || /^\s*</.test(source)) { counts.skipped++; continue; }   // not a script (an error page, a redirect)
  bytes += source.length;
  let out;
  try { out = bundle.rewriteScript(source, kind, target, 'https://proxy.example'); }
  catch { counts.skipped++; continue; }                                               // refused by the rewriter: blocked, not broken
  let valid = false;
  let why = '';
  if (kind !== 'module') {
    try { new vm.Script(out, { filename: 'rewritten' }); valid = true; } catch (e) { why = String(e.message); }
  }
  if (!valid) {
    try { new vm.SourceTextModule(out, { context: ctx }); valid = true; } catch (e) { why = why || String(e.message); }
  }
  if (valid) counts.ok++;
  else { counts.bad++; failures.push({ kind, target: target.slice(0, 120), why: why.slice(0, 160), file }); }
}

console.log({ ...counts, megabytes: (bytes / 1e6).toFixed(1) });
for (const f of failures.slice(0, 20)) console.log(' FAIL', f.kind, f.target, '|', f.why, '|', f.file);
process.exit(counts.bad ? 1 : 0);
