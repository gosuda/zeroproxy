// URL classification bench (Node) — pulls all shared logic from
// ./bench-core.mjs so the Browser variant can stay in parity.
//
// Run with: node test/bench/url-classify.bench.mjs

import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UrlClass, classifyJsRegex, classifyJsURL, classifyJsStartsWith,
  makeCorpus, fmt, timed, PARITY_SAMPLES,
  encodeManual, encodeAsciiFast,
} from './bench-core.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmPath = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_rt.wasm');
const gluePath = path.join(repoRoot, 'web', 'zp-rt.js');

async function ensureWasm() {
  try { await access(wasmPath); }
  catch {
    process.stderr.write('zp_page_rt.wasm not found, building...\n');
    const r = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt'], { cwd: repoRoot, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('cargo build failed');
  }
}

async function loadGlue() {
  const source = await readFile(gluePath, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(source)();
  if (!globalThis.ZeroProxyRT) throw new Error('zp-rt.js did not register ZeroProxyRT');
  return globalThis.ZeroProxyRT;
}

function now() { return performance.now(); }
function t(label, iters, fn) { return timed(now, label, iters, fn); }

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

async function main() {
  await ensureWasm();
  const ZeroProxyRT = await loadGlue();
  const wasm = await readFile(wasmPath);
  const rt = await ZeroProxyRT.load(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

  // Parity check.
  let parityFails = 0;
  for (const s of PARITY_SAMPLES) {
    const expected = classifyJsRegex(s);
    const w = rt.classOf(s);
    const wso = rt.classifySchemeOnly(s);
    const sw = classifyJsStartsWith(s);
    if (expected !== w) { console.log(`PARITY wasm: ${JSON.stringify(s)}: js=${expected} wasm=${w}`); parityFails++; }
    if (expected !== sw && !(expected === UrlClass.OTHER && sw === UrlClass.RELATIVE)) {
      console.log(`PARITY startsWith: ${JSON.stringify(s)}: js=${expected} sw=${sw}`); parityFails++;
    }
    if (expected !== wso) {
      const ok = (expected === UrlClass.ABOUT_OTHER && wso === UrlClass.ABOUT_OTHER)
        || (expected === UrlClass.ABOUT_BLANK && wso === UrlClass.ABOUT_BLANK);
      if (!ok) { console.log(`PARITY schemeOnly: ${JSON.stringify(s)}: js=${expected} wso=${wso}`); parityFails++; }
    }
  }
  if (parityFails > 0) console.log(`⚠  ${parityFails} parity divergences`);
  else console.log('✓ parity: js-regex ≡ wasm ≡ startsWith ≡ schemeOnly on sample set');

  const corpus = makeCorpus(1000);
  const ITERS = 100_000;

  // Pre-warm rt pool for warm-path measurements.
  rt.reset();
  for (const s of corpus) rt.classOf(s);

  const ex = rt.raw;
  const SCRATCH = ex.scratch_ptr();
  const SCRATCH_CAP = ex.scratch_cap();
  const enc = new TextEncoder();
  const memU8 = () => new Uint8Array(ex.memory.buffer);

  // ===== Main comparison (warm cache) =====
  const mainRows = [];
  mainRows.push(t('js-regex', ITERS, (i) => classifyJsRegex(corpus[i % corpus.length])));
  mainRows.push(t('js-URL (new URL parse)', ITERS, (i) => classifyJsURL(corpus[i % corpus.length])));
  mainRows.push(t('js-startsWith chain', ITERS, (i) => classifyJsStartsWith(corpus[i % corpus.length])));
  mainRows.push(t('encodeInto only (no wasm call)', ITERS, (i) => {
    const view = memU8().subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
    return enc.encodeInto(corpus[i % corpus.length], view).written;
  }));
  mainRows.push(t('wasm classOf (warm, wrapper)', ITERS, (i) => rt.classOf(corpus[i % corpus.length])));
  mainRows.push(t('wasm raw (warm, no wrapper)', ITERS, (i) => {
    const { written } = enc.encodeInto(corpus[i % corpus.length], memU8().subarray(SCRATCH, SCRATCH + SCRATCH_CAP));
    const packed = ex.url_intern_and_classify(SCRATCH, written);
    return Number(packed & 0xffffffffn);
  }));
  const cachedView = new Uint8Array(ex.memory.buffer);
  const cachedScratch = cachedView.subarray(SCRATCH, SCRATCH + SCRATCH_CAP);
  mainRows.push(t('wasm raw (warm, cached view)', ITERS, (i) => {
    const { written } = enc.encodeInto(corpus[i % corpus.length], cachedScratch);
    const packed = ex.url_intern_and_classify(SCRATCH, written);
    return Number(packed & 0xffffffffn);
  }));
  const lastEncoded = enc.encodeInto(corpus[corpus.length - 1], cachedScratch).written;
  mainRows.push(t('wasm pre-encoded (no encode)', ITERS, (i) => {
    return Number(ex.url_intern_and_classify(SCRATCH, lastEncoded) & 0xffffffffn);
  }));
  mainRows.push(t('wasm classifySchemeOnly (D)', ITERS, (i) => rt.classifySchemeOnly(corpus[i % corpus.length])));
  const handles = corpus.map(s => rt.internURL(s));
  mainRows.push(t('wasm classifyURL (handle-only)', ITERS, (i) => ex.url_classify(handles[i % handles.length])));
  report('Main comparison (warm)', mainRows, 'js-regex');

  // ===== Encoder isolation =====
  // TextEncoder vs manual UTF-8 loop vs ASCII-only fast path. Establishes
  // whether the Chrome encodeInto cost (840ns) is the encoder itself or
  // the cross-realm bridge. If encodeManual beats TextEncoder, the Chrome
  // path can switch to manual for ASCII URL inputs.
  const probeBuf = new Uint8Array(4096);
  const encRows = [];
  encRows.push(t('encodeInto into Uint8Array', ITERS, (i) => enc.encodeInto(corpus[i % corpus.length], probeBuf).written));
  encRows.push(t('encodeInto into scratch view', ITERS, (i) => enc.encodeInto(corpus[i % corpus.length], cachedScratch).written));
  encRows.push(t('encodeManual (charCodeAt loop)', ITERS, (i) => encodeManual(corpus[i % corpus.length], probeBuf)));
  encRows.push(t('encodeAsciiFast (ASCII only)', ITERS, (i) => encodeAsciiFast(corpus[i % corpus.length], probeBuf)));
  // Buffer.from (Node-only). Allocates a Uint8Array internally, so this
  // measures both encode and alloc — apples-to-oranges with the above but
  // useful for Node-only callers.
  encRows.push(t('Buffer.from utf8 (Node, alloc)', ITERS, (i) => Buffer.from(corpus[i % corpus.length], 'utf8').length));
  report('Encoder alternatives (isolation)', encRows, 'encodeInto into Uint8Array');

  // ===== Wasm with alternate encoders =====
  // Replace encodeInto with the alternatives, keep the wasm call. Shows
  // whether changing the encoder closes the gap between
  // "wasm raw (warm, cached view)" and "js-regex".
  const wasmEncRows = [];
  wasmEncRows.push(mainRows.find(r => r.label === 'wasm raw (warm, cached view)'));
  wasmEncRows.push(t('wasm raw + encodeManual', ITERS, (i) => {
    const n = encodeManual(corpus[i % corpus.length], cachedScratch);
    const packed = ex.url_intern_and_classify(SCRATCH, n);
    return Number(packed & 0xffffffffn);
  }));
  wasmEncRows.push(t('wasm raw + encodeAsciiFast', ITERS, (i) => {
    const n = encodeAsciiFast(corpus[i % corpus.length], cachedScratch);
    if (n < 0) return 0; // fallback would be needed; corpus is ASCII so this never triggers
    const packed = ex.url_intern_and_classify(SCRATCH, n);
    return Number(packed & 0xffffffffn);
  }));
  report('WASM with alternate encoders (warm)', wasmEncRows, 'wasm raw (warm, cached view)');

  // ===== Scheme-only with alternate encoders =====
  // Most impactful — schemeOnly is the path we recommend for long URLs.
  // If encodeManual closes the Chrome encodeInto gap, schemeOnly benefits
  // most.
  const SCHEME_PROBE = 16;
  const schemeRows = [];
  schemeRows.push(mainRows.find(r => r.label === 'wasm classifySchemeOnly (D)'));
  schemeRows.push(t('schemeOnly + encodeManual', ITERS, (i) => {
    const s = corpus[i % corpus.length];
    const n = encodeManual(s, cachedScratch.subarray(0, SCHEME_PROBE));
    return ex.url_classify_scheme_only(SCRATCH, n);
  }));
  schemeRows.push(t('schemeOnly + encodeAsciiFast', ITERS, (i) => {
    const s = corpus[i % corpus.length];
    const n = encodeAsciiFast(s.slice(0, SCHEME_PROBE), cachedScratch.subarray(0, SCHEME_PROBE));
    if (n < 0) return 0;
    return ex.url_classify_scheme_only(SCRATCH, n);
  }));
  report('Scheme-only with alternate encoders (warm)', schemeRows, 'wasm classifySchemeOnly (D)');

  // ===== Batch ABI =====
  const BATCH_SIZES = [16, 64, 256];
  const batchRows = [];
  batchRows.push(mainRows.find(r => r.label === 'wasm raw (warm, cached view)'));
  // Production rt.classifyBatch path — ASCII fast path inside.
  // Different from the raw-export batch row (which pre-encodes outside the
  // measured loop). This row measures the end-to-end cost the MO callback
  // actually pays.
  for (const N of BATCH_SIZES) {
    for (const s of corpus) rt.classOf(s);
    const batchSlice = corpus.slice(0, N);
    const ITERS_BATCH = Math.max(1000, ITERS / N | 0);
    const totalItems = ITERS_BATCH * N;
    // warmup
    for (let i = 0; i < 100; i++) rt.classifyBatch(batchSlice);
    const t0 = now();
    for (let i = 0; i < ITERS_BATCH; i++) rt.classifyBatch(batchSlice);
    const dt = now() - t0;
    batchRows.push({
      label: `rt.classifyBatch N=${N} (production)`,
      iters: totalItems, dt,
      opsPerSec: (totalItems / dt) * 1000,
      nsPerOp: (dt * 1e6) / totalItems,
    });
  }
  for (const N of BATCH_SIZES) {
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
    const t0 = now();
    for (let i = 0; i < ITERS_BATCH; i++) ex.bulk_intern_and_classify(lensPtr, N, bytesPtr, outPtr);
    const dt = now() - t0;
    batchRows.push({
      label: `wasm bulk N=${N} (per-item)`,
      iters: totalItems, dt,
      opsPerSec: (totalItems / dt) * 1000,
      nsPerOp: (dt * 1e6) / totalItems,
    });
  }
  report('Batch ABI (per-item ns includes encode amortised)', batchRows, 'wasm raw (warm, cached view)');

  // ===== Cold path =====
  rt.reset();
  const coldRows = [];
  coldRows.push(t('js-regex (cold unique)', ITERS, (i) => classifyJsRegex(`https://cold.example/${i}/asset.js`)));
  rt.reset();
  coldRows.push(t('wasm classOf (cold unique)', ITERS, (i) => rt.classOf(`https://cold.example/${i}/asset.js`)));
  report('Cold path (no cache hits — HashMap behaviour)', coldRows, 'js-regex (cold unique)');

  // ===== URL length sensitivity =====
  const lengthRows = [];
  for (const mode of ['short', 'medium', 'long']) {
    const c = makeCorpus(1000, mode);
    rt.reset();
    for (const s of c) rt.classOf(s);
    const avgLen = (c.reduce((a, s) => a + s.length, 0) / c.length) | 0;
    lengthRows.push(t(`js-regex (${mode}, ~${avgLen}B)`, ITERS, (i) => classifyJsRegex(c[i % c.length])));
    lengthRows.push(t(`wasm classOf (${mode}, ~${avgLen}B)`, ITERS, (i) => rt.classOf(c[i % c.length])));
    lengthRows.push(t(`wasm schemeOnly (${mode}, ~${avgLen}B)`, ITERS, (i) => rt.classifySchemeOnly(c[i % c.length])));
  }
  report('URL length sensitivity (warm)', lengthRows, lengthRows[0].label);

  // ===== Pool size sensitivity =====
  const poolRows = [];
  for (const SIZE of [100, 1000, 10000]) {
    rt.reset();
    const big = makeCorpus(SIZE);
    for (const s of big) rt.classOf(s);
    poolRows.push(t(`wasm classOf @ pool=${SIZE}`, ITERS, (i) => rt.classOf(big[i % big.length])));
  }
  report('Pool size sensitivity (classOf on pre-warmed URL)', poolRows, poolRows[0].label);

  console.log('\nwasm size: ' + wasm.length + ' bytes');
  const st = rt.stats();
  console.log(`pool final: ${st.entries} entries, ${st.bytes} bytes`);
}

main().catch(e => { console.error(e); process.exit(1); });
