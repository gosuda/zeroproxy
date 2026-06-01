// Browser bench driver — launches headless Chrome via puppeteer, mirrors
// the Node bench. Pulls the shared bench-core.mjs source verbatim and
// injects it into the page along with web/zp-rt.js + wasm bytes.

import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmPath = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_rt.wasm');
const gluePath = path.join(repoRoot, 'web', 'zp-rt.js');
const corePath = path.join(repoRoot, 'test', 'bench', 'bench-core.mjs');

async function ensureWasm() {
  try { await access(wasmPath); }
  catch {
    const r = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt'], { cwd: repoRoot, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('cargo build failed');
  }
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

function report(title, rows, baselineLabel) {
  const baseline = rows.find(r => r.label === baselineLabel) || rows[0];
  console.log('\n=== ' + title + ' ===');
  console.log('label'.padEnd(38) + 'iters'.padStart(10) + 'time(ms)'.padStart(12) + 'ops/sec'.padStart(14) + 'ns/op'.padStart(12) + 'vs base'.padStart(10));
  console.log('-'.repeat(96));
  for (const r of rows) {
    const ratio = (r.opsPerSec / baseline.opsPerSec).toFixed(2) + 'x';
    console.log(
      r.label.padEnd(38) +
      String(r.iters).padStart(10) +
      r.dt.toFixed(2).padStart(12) +
      fmt(r.opsPerSec).padStart(14) +
      r.nsPerOp.toFixed(1).padStart(12) +
      ratio.padStart(10)
    );
  }
}

// Bench body — runs inside the page. Receives the bench-core source as a
// text blob and rebuilds it as a module via blob URL + dynamic import.
async function runInPage(coreSource, glueSource, wasmU8Array) {
  // 1. Bootstrap bench-core via blob URL + dynamic import. This keeps the
  //    Node ESM-style `export` syntax intact without rewriting.
  const coreBlob = new Blob([coreSource], { type: 'text/javascript' });
  const coreUrl = URL.createObjectURL(coreBlob);
  const core = await import(coreUrl);
  URL.revokeObjectURL(coreUrl);
  const {
    UrlClass, classifyJsRegex, classifyJsURL, classifyJsStartsWith,
    makeCorpus, fmt: _fmt, timed, PARITY_SAMPLES,
    encodeManual, encodeAsciiFast,
  } = core;

  // 2. Bootstrap zp-rt glue (an IIFE registering globalThis.ZeroProxyRT).
  new Function(glueSource)();
  const ZeroProxyRT = window.ZeroProxyRT;
  if (!ZeroProxyRT) throw new Error('glue did not register ZeroProxyRT');

  const wasm = new Uint8Array(wasmU8Array);
  const rt = await ZeroProxyRT.load(wasm.buffer);

  const now = () => performance.now();
  const t = (label, iters, fn) => timed(now, label, iters, fn);

  // Parity check.
  let parityFails = 0;
  for (const s of PARITY_SAMPLES) {
    const expected = classifyJsRegex(s);
    const w = rt.classOf(s);
    if (expected !== w) parityFails++;
  }

  const corpus = makeCorpus(1000);
  const ITERS = 100_000;

  rt.reset();
  for (const s of corpus) rt.classOf(s);
  const ex = rt.raw;
  const SCRATCH = ex.scratch_ptr();
  const SCRATCH_CAP = ex.scratch_cap();
  const enc = new TextEncoder();
  const memU8 = () => new Uint8Array(ex.memory.buffer);
  const cachedScratch = new Uint8Array(ex.memory.buffer).subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
  const probeBuf = new Uint8Array(4096);

  // ===== Main =====
  const main = [];
  main.push(t('js-regex', ITERS, (i) => classifyJsRegex(corpus[i % corpus.length])));
  main.push(t('js-URL (new URL parse)', ITERS, (i) => classifyJsURL(corpus[i % corpus.length])));
  main.push(t('js-startsWith chain', ITERS, (i) => classifyJsStartsWith(corpus[i % corpus.length])));
  main.push(t('encodeInto only (no wasm call)', ITERS, (i) => {
    const view = memU8().subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
    return enc.encodeInto(corpus[i % corpus.length], view).written;
  }));
  main.push(t('wasm classOf (warm, wrapper)', ITERS, (i) => rt.classOf(corpus[i % corpus.length])));
  main.push(t('wasm raw (warm, no wrapper)', ITERS, (i) => {
    const { written } = enc.encodeInto(corpus[i % corpus.length], memU8().subarray(SCRATCH, SCRATCH + SCRATCH_CAP));
    const packed = ex.url_intern_and_classify(SCRATCH, written);
    return Number(packed & 0xffffffffn);
  }));
  main.push(t('wasm raw (warm, cached view)', ITERS, (i) => {
    const { written } = enc.encodeInto(corpus[i % corpus.length], cachedScratch);
    const packed = ex.url_intern_and_classify(SCRATCH, written);
    return Number(packed & 0xffffffffn);
  }));
  const lastEncoded = enc.encodeInto(corpus[corpus.length - 1], cachedScratch).written;
  main.push(t('wasm pre-encoded (no encode)', ITERS, (i) => {
    return Number(ex.url_intern_and_classify(SCRATCH, lastEncoded) & 0xffffffffn);
  }));
  main.push(t('wasm classifySchemeOnly (D)', ITERS, (i) => rt.classifySchemeOnly(corpus[i % corpus.length])));
  const handles = corpus.map(s => rt.internURL(s));
  main.push(t('wasm classifyURL (handle-only)', ITERS, (i) => ex.url_classify(handles[i % handles.length])));

  // ===== Encoder isolation =====
  const enc_rows = [];
  enc_rows.push(t('encodeInto into Uint8Array', ITERS, (i) => enc.encodeInto(corpus[i % corpus.length], probeBuf).written));
  enc_rows.push(t('encodeInto into scratch view', ITERS, (i) => enc.encodeInto(corpus[i % corpus.length], cachedScratch).written));
  enc_rows.push(t('encodeManual (charCodeAt loop)', ITERS, (i) => encodeManual(corpus[i % corpus.length], probeBuf)));
  enc_rows.push(t('encodeAsciiFast (ASCII only)', ITERS, (i) => encodeAsciiFast(corpus[i % corpus.length], probeBuf)));

  // ===== Wasm with alternate encoders =====
  const wasm_enc = [];
  wasm_enc.push(main.find(r => r.label === 'wasm raw (warm, cached view)'));
  wasm_enc.push(t('wasm raw + encodeManual', ITERS, (i) => {
    const n = encodeManual(corpus[i % corpus.length], cachedScratch);
    const packed = ex.url_intern_and_classify(SCRATCH, n);
    return Number(packed & 0xffffffffn);
  }));
  wasm_enc.push(t('wasm raw + encodeAsciiFast', ITERS, (i) => {
    const n = encodeAsciiFast(corpus[i % corpus.length], cachedScratch);
    if (n < 0) return 0;
    const packed = ex.url_intern_and_classify(SCRATCH, n);
    return Number(packed & 0xffffffffn);
  }));

  // ===== schemeOnly with alternate encoders =====
  const SCHEME_PROBE = 16;
  const schemeRows = [];
  schemeRows.push(main.find(r => r.label === 'wasm classifySchemeOnly (D)'));
  schemeRows.push(t('schemeOnly + encodeManual', ITERS, (i) => {
    const n = encodeManual(corpus[i % corpus.length], cachedScratch.subarray(0, SCHEME_PROBE));
    return ex.url_classify_scheme_only(SCRATCH, n);
  }));
  schemeRows.push(t('schemeOnly + encodeAsciiFast', ITERS, (i) => {
    const s = corpus[i % corpus.length];
    const n = encodeAsciiFast(s.slice(0, SCHEME_PROBE), cachedScratch.subarray(0, SCHEME_PROBE));
    if (n < 0) return 0;
    return ex.url_classify_scheme_only(SCRATCH, n);
  }));

  // ===== Batch =====
  const batch = [];
  batch.push(main.find(r => r.label === 'wasm raw (warm, cached view)'));
  // Production rt.classifyBatch path — ASCII fast path + single-pass encoding.
  for (const N of [16, 64, 256]) {
    for (const s of corpus) rt.classOf(s);
    const batchSlice = corpus.slice(0, N);
    const ITERS_BATCH = Math.max(1000, ITERS / N | 0);
    const totalItems = ITERS_BATCH * N;
    for (let i = 0; i < 100; i++) rt.classifyBatch(batchSlice);
    const t0 = performance.now();
    for (let i = 0; i < ITERS_BATCH; i++) rt.classifyBatch(batchSlice);
    const dt = performance.now() - t0;
    batch.push({
      label: `rt.classifyBatch N=${N} (production)`,
      iters: totalItems, dt,
      opsPerSec: (totalItems / dt) * 1000,
      nsPerOp: (dt * 1e6) / totalItems,
    });
  }
  for (const N of [16, 64, 256]) {
    for (const s of corpus) rt.classOf(s);
    const lensU32 = new Uint32Array(N);
    let bytesTotal = 0;
    const encoded = [];
    for (let k = 0; k < N; k++) {
      const tmp = new Uint8Array(2048);
      const { written } = enc.encodeInto(corpus[k % corpus.length], tmp);
      encoded.push(tmp.subarray(0, written));
      lensU32[k] = written;
      bytesTotal += written;
    }
    const lensPtr = SCRATCH;
    const bytesPtr = SCRATCH + 4 * N;
    const outPtr = bytesPtr + bytesTotal;
    if (outPtr + 4 * N > SCRATCH + SCRATCH_CAP) continue;
    const v = new Uint8Array(ex.memory.buffer);
    v.set(new Uint8Array(lensU32.buffer), lensPtr);
    let cur = bytesPtr;
    for (const b of encoded) { v.set(b, cur); cur += b.length; }
    const ITERS_BATCH = Math.max(1000, ITERS / N | 0);
    const totalItems = ITERS_BATCH * N;
    for (let i = 0; i < 100; i++) ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
    const t0 = performance.now();
    for (let i = 0; i < ITERS_BATCH; i++) ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
    const dt = performance.now() - t0;
    batch.push({
      label: `wasm bulk N=${N} (per-item)`,
      iters: totalItems, dt,
      opsPerSec: (totalItems / dt) * 1000,
      nsPerOp: (dt * 1e6) / totalItems,
    });
  }

  // ===== Cold =====
  const cold = [];
  cold.push(t('js-regex (cold unique)', ITERS, (i) => classifyJsRegex(`https://cold.example/${i}/asset.js`)));
  rt.reset();
  cold.push(t('wasm classOf (cold unique)', ITERS, (i) => rt.classOf(`https://cold.example/${i}/asset.js`)));

  // ===== Length sensitivity =====
  const length = [];
  for (const mode of ['short', 'medium', 'long']) {
    const c = makeCorpus(1000, mode);
    rt.reset();
    for (const s of c) rt.classOf(s);
    const avgLen = (c.reduce((a, s) => a + s.length, 0) / c.length) | 0;
    length.push(t(`js-regex (${mode}, ~${avgLen}B)`, ITERS, (i) => classifyJsRegex(c[i % c.length])));
    length.push(t(`wasm classOf (${mode}, ~${avgLen}B)`, ITERS, (i) => rt.classOf(c[i % c.length])));
    length.push(t(`wasm schemeOnly (${mode}, ~${avgLen}B)`, ITERS, (i) => rt.classifySchemeOnly(c[i % c.length])));
  }

  // ===== Pool =====
  const pool = [];
  for (const SIZE of [100, 1000, 10000]) {
    rt.reset();
    const big = makeCorpus(SIZE);
    for (const s of big) rt.classOf(s);
    pool.push(t(`wasm classOf @ pool=${SIZE}`, ITERS, (i) => rt.classOf(big[i % big.length])));
  }

  return {
    main, encoder: enc_rows, wasmEnc: wasm_enc, schemeOnly: schemeRows,
    batch, cold, length, pool,
    parityFails, poolStats: rt.stats(),
    wasmSize: wasm.byteLength, userAgent: navigator.userAgent,
  };
}

async function main() {
  await ensureWasm();
  const wasm = await readFile(wasmPath);
  const glueSource = await readFile(gluePath, 'utf8');
  const coreSource = await readFile(corePath, 'utf8');

  process.stderr.write('Launching headless Chrome…\n');
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('PAGE ERROR:', e.message));
    page.on('console', m => {
      const ty = m.type();
      if (ty === 'error' || ty === 'warning') console.error(`[${ty}]`, m.text());
    });
    await page.goto('about:blank');
    const wasmArr = Array.from(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
    const result = await page.evaluate(runInPage, coreSource, glueSource, wasmArr);

    if (result.parityFails > 0) console.error(`⚠  ${result.parityFails} parity divergences`);
    else console.log('✓ parity (browser): js-regex ≡ wasm');
    console.log(`UA: ${result.userAgent}`);

    report('Main comparison (warm) — BROWSER', result.main, 'js-regex');
    report('Encoder alternatives (isolation) — BROWSER', result.encoder, 'encodeInto into Uint8Array');
    report('WASM with alternate encoders (warm) — BROWSER', result.wasmEnc, 'wasm raw (warm, cached view)');
    report('Scheme-only with alternate encoders (warm) — BROWSER', result.schemeOnly, 'wasm classifySchemeOnly (D)');
    report('Batch ABI — BROWSER', result.batch, 'wasm raw (warm, cached view)');
    report('Cold path — BROWSER', result.cold, 'js-regex (cold unique)');
    report('URL length sensitivity — BROWSER', result.length, result.length[0].label);
    report('Pool size sensitivity — BROWSER', result.pool, result.pool[0].label);

    console.log(`\nwasm size: ${result.wasmSize} bytes`);
    console.log(`pool final: ${result.poolStats.entries} entries, ${result.poolStats.bytes} bytes`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
