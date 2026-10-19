#!/usr/bin/env node
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Declare buildId before top-level buildWeb() executes to avoid the temporal dead zone.
let buildId = '';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(repoRoot, args.out || 'dist');
const webSrc = path.join(repoRoot, 'web');
const membraneDir = path.join(webSrc, 'membrane');
const webOut = path.join(outRoot, 'web');
const serverOut = path.join(outRoot, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
// Default to a small local footprint; explicit caller limits still win.
const buildEnv = {
  ...process.env,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2',
  BINARYEN_CORES: process.env.BINARYEN_CORES || '2',
  GOFLAGS: process.env.GOFLAGS ?? '-p=2',
};
// Minify by default to match the shipped client artifact; pass --no-minify for readable debug output.
const minify = args.noMinify !== true;
const zpBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_bundle.wasm');
const zpKernelBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_kernel_bundle.wasm');
const zpPageRtWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_rt.wasm');
const zpBundleOutDir = path.join(webOut, '__zp');

if (args.help) {
  process.stdout.write(`Usage: node scripts/build.mjs [options]\n\nOptions:\n  --out <dir>       Output directory (default: dist)\n  --web-only        Build only browser assets\n  --server-only     Build only the relay server\n  --rust-only       Build only the Rust WASM bundle\n  --skip-web        Do not build browser assets\n  --skip-server     Do not build the relay server\n  --skip-rust       Do not build the Rust WASM bundle\n  --minify          Minify bundled JavaScript (default)
  --no-minify       Emit readable bundled JavaScript (debug)\n  --no-clean        Keep existing output files not overwritten by this run\n`);
  process.exit(0);
}

const selected = selectedTargets(args);

if (!args.noClean) await cleanSelectedOutputs(selected);
await mkdir(outRoot, { recursive: true });

if (selected.rust) await buildRustBundle();
if (selected.web) await buildWeb();
if (selected.server) buildServer();

process.stdout.write(`Built ZeroProxy artifacts in ${path.relative(repoRoot, outRoot) || '.'}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
        if (!argv[i + 1]) throw new Error('--out requires a directory');
        parsed.out = argv[++i];
        break;
      case '--web-only':
      case '--kernel-only':
      case '--server-only':
      case '--rust-only':
      case '--skip-web':
      case '--skip-kernel':
      case '--skip-server':
      case '--skip-rust':
      case '--minify':
      case '--no-minify':
      case '--no-clean':
      case '--help':
        parsed[toKey(arg)] = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function toKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function selectedTargets(parsed) {
  let web = true;
  let server = true;
  let rust = true;
  if (parsed.webOnly || parsed.serverOnly || parsed.rustOnly) {
    web = parsed.webOnly === true;
    server = parsed.serverOnly === true;
    rust = parsed.rustOnly === true;
  }
  if (parsed.skipWeb) web = false;
  if (parsed.skipServer) server = false;
  if (parsed.skipRust) rust = false;
  if (!web && !server && !rust) throw new Error('no build targets selected');
  return { web, server, rust };
}

async function cleanSelectedOutputs(selected) {
  // Preserve dist/web/__zp/ when skipping the Rust build so existing wasm-bindgen outputs remain usable.
  async function rmWebPreserveZp() {
    if (!selected.rust) {
      const entries = await readdir(webOut, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries
        .filter(d => d.name !== '__zp')
        .map(d => rm(path.join(webOut, d.name), { recursive: true, force: true })));
    } else {
      await rm(webOut, { recursive: true, force: true });
    }
  }
  if (selected.web && selected.server) {
    if (!selected.rust) {
      await Promise.all([rmWebPreserveZp(), rm(serverOut, { force: true })]);
    } else {
      await rm(outRoot, { recursive: true, force: true });
    }
    return;
  }
  const removals = [];
  if (selected.web) removals.push(rmWebPreserveZp());
  if (selected.server) removals.push(rm(serverOut, { force: true }));
  await Promise.all(removals);
}

async function buildWeb() {
  await mkdir(webOut, { recursive: true });
  // Compute buildId after buildRustBundle() so WASM artifacts in dist/web/__zp/ are included in the hash.
  await computeBuildId();

  const zpBundlePage = await makeZPBundlePageClassic();
  const hdrPolicy = await responseHeaderPolicy();
  const serviceWorker = stripServiceWorkerImports(await readSource('sw.js'))
    .split('__ZP_REPORTING_HEADERS__').join(JSON.stringify(hdrPolicy.reporting))
    .split('__ZP_TARGET_POLICY_HEADERS__').join(JSON.stringify(hdrPolicy.directive))
    .split('__ZP_HOP_BY_HOP_HEADERS__').join(JSON.stringify(hdrPolicy.hop_by_hop));
  const workerPrelude = stripWorkerPreludeImports(await readSource('worker-prelude.js'));

  // Substitute __ZP_BUILD_ID__ in index.html so the zp-core.js script URL is versioned and immutable.
  await writeFile(
    path.join(webOut, 'index.html'),
    (await readFile(path.join(webSrc, 'index.html'), 'utf8'))
      .split('__ZP_BUILD_ID__').join(buildId),
  );
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(path.join(webSrc, 'manifest.webmanifest'), path.join(webOut, 'manifest.webmanifest'));

  await writeBundled('zp-core.js', [await readSource('zp-core.js')]);
  await writeBundled('zp-rt.js', [await readSource('zp-rt.js')]);
  // Prepend zp-rt.js so ZeroProxyRT is registered on globalThis before the runtime-prelude IIFE runs.
  const surfaceTable = JSON.stringify(await urlSurfacePairs());
  await writeBundled('runtime-prelude.js', [
    await readSource('zp-rt.js'),
    (await readMembraneSource()).split('__ZP_URL_SURFACES__').join(surfaceTable),
  ]);
  // Inline the ZPBundle wasm-bindgen glue and WASM bytes with synchronous initSync()
  // so globalThis.ZPBundle is ready before runtime-prelude runs.
  await writeBundled('zp-page-bundle.js', [zpBundlePage]);
  await writeBundled('worker-prelude.js', [await readSource('zp-core.js'), workerPrelude]);
  await writeBundled('sw.js', [await readSource('zp-core.js'), serviceWorker]);
}

async function buildRustBundle() {
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-bundle']);
  // zp-kernel-bundle holds the SW transport and kernel stack, instantiated lazily on first transportFetch.
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-kernel-bundle']);
  // zp-page-bundle contains only the page-realm rewriter, sourcemap, CSS, and HTML transform logic.
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-bundle']);
  // zp-page-rt is a raw extern "C" cdylib instantiated directly by web/zp-rt.js without wasm-bindgen glue.
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt']);
  await mkdir(zpBundleOutDir, { recursive: true });
  // Wrap no-modules wasm-bindgen glue in an IIFE so top-level let wasm_bindgen stays function-scoped.
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp_bundle_sw',
    zpBundleWasm,
  ]);
  const swJsPath = path.join(zpBundleOutDir, 'zp_bundle_sw.js');
  const swGlue = await readFile(swJsPath, 'utf8');
  if (!swGlue.startsWith('(function(){')) {
    await writeFile(
      swJsPath,
      '(function(){\n' + swGlue + '\n;try{ self.ZPBundleWBG = wasm_bindgen; }catch(_e){};\n})();\n',
    );
  }
  // Expose the SW kernel factory under self.ZPKernelWBG for lazy initialization.
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp_kernel_sw',
    zpKernelBundleWasm,
  ]);
  const kernelJsPath = path.join(zpBundleOutDir, 'zp_kernel_sw.js');
  const kernelGlue = await readFile(kernelJsPath, 'utf8');
  if (!kernelGlue.startsWith('(function(){')) {
    await writeFile(
      kernelJsPath,
      '(function(){\n' + kernelGlue + '\n;try{ self.ZPKernelWBG = wasm_bindgen; }catch(_e){};\n})();\n',
    );
  }
  // Expose the page bundle factory under self.ZPPageBundleWBG for synchronous page bootstrap.
  const zpPageBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_bundle.wasm');
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp_page_bundle',
    zpPageBundleWasm,
  ]);
  const pageBundleJsPath = path.join(zpBundleOutDir, 'zp_page_bundle.js');
  const pageBundleGlue = await readFile(pageBundleJsPath, 'utf8');
  if (!pageBundleGlue.startsWith('(function(){')) {
    await writeFile(
      pageBundleJsPath,
      '(function(){\n' + pageBundleGlue + '\n;try{ self.ZPPageBundleWBG = wasm_bindgen; }catch(_e){};\n})();\n',
    );
  }
  // Enable the WebAssembly features that rustc emits by default for wasm32.
  const WASM_OPT_FLAGS = [
    '--enable-bulk-memory',
    '--enable-bulk-memory-opt',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '--enable-multivalue',
    '--enable-reference-types',
  ];
  const swWasm = path.join(zpBundleOutDir, 'zp_bundle_sw_bg.wasm');
  const kernelWasm = path.join(zpBundleOutDir, 'zp_kernel_sw_bg.wasm');
  const pageBundleWasm = path.join(zpBundleOutDir, 'zp_page_bundle_bg.wasm');
  const optimizedSw = tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, swWasm, '-o', swWasm]);
  if (!optimizedSw) {
    process.stderr.write('wasm-opt not found; skipping size optimization (install binaryen to enable)\n');
  } else {
    tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, kernelWasm, '-o', kernelWasm]);
    tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, pageBundleWasm, '-o', pageBundleWasm]);
  }
  const pageRtDst = path.join(zpBundleOutDir, 'zp_page_rt.wasm');
  await copyFile(zpPageRtWasm, pageRtDst);
  tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, pageRtDst, '-o', pageRtDst]);
}

function tryRunOptional(cmd, argv) {
  try {
    // Use shell: true on Windows so spawnSync resolves .cmd shims installed by npm.
    const result = spawnSync(cmd, argv, { cwd: repoRoot, env: buildEnv, stdio: 'inherit', shell: process.platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function buildServer() {
  run('go', ['build', '-trimpath', '-o', serverOut, './cmd/zeroproxy-server']);
}

// Derive URL surface pairs from crates/zp-shared/testdata/url_surfaces.json.
// Exclude 'deliberate' entries (never rewritten) and strip namespace prefixes
// (such as xlink:href) to match attrLocalName lookup in the prelude.
async function urlSurfacePairs() {
  const raw = await readFile(
    path.join(repoRoot, 'crates', 'zp-shared', 'testdata', 'url_surfaces.json'),
    'utf8',
  );
  const pairs = new Set();
  for (const e of JSON.parse(raw)) {
    if (!e || !e.pair || e.kind === 'deliberate') continue;
    const bits = e.pair.split(':');
    const tag = bits[0];
    const attr = bits[bits.length - 1];
    pairs.add(tag + ':' + attr);
  }
  if (pairs.size < 20) throw new Error('Too few URL surfaces extracted from url_surfaces.json: ' + pairs.size);
  return [...pairs].sort();
}

// Embed the target response header policy from the shared fixture into the service worker.
async function responseHeaderPolicy() {
  const raw = await readFile(
    path.join(repoRoot, 'crates', 'zp-shared', 'testdata', 'response_header_policy.json'),
    'utf8',
  );
  const doc = JSON.parse(raw);
  for (const key of ['reporting', 'directive', 'hop_by_hop']) {
    if (!Array.isArray(doc[key]) || doc[key].length === 0) {
      throw new Error('response_header_policy.json key "' + key + '" is empty');
    }
  }
  return doc;
}

async function readSource(name) {
  return readFile(path.join(webSrc, name), 'utf8');
}

// Join membrane fragments in lexicographical filename order (matching test/js/_prelude.cjs).
async function membraneFragmentNames() {
  return (await readdir(membraneDir)).filter(n => n.endsWith('.js')).sort();
}
async function readMembraneSource() {
  const parts = [];
  for (const n of await membraneFragmentNames()) {
    parts.push(await readFile(path.join(membraneDir, n), 'utf8'));
  }
  return parts.join('\n');
}

// Hash source and WASM inputs to produce a content-addressed buildId for immutable ?v= asset URLs.
async function computeBuildId() {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  const names = (await readdir(webSrc)).filter(n => n.endsWith('.js') || n.endsWith('.html')).sort();
  for (const n of names) {
    h.update(n);
    h.update(await readFile(path.join(webSrc, n)));
  }
  for (const n of await membraneFragmentNames()) {
    h.update('membrane/' + n);
    h.update(await readFile(path.join(membraneDir, n)));
  }
  for (const p of await listWasmArtifacts()) {
    h.update(path.basename(p));
    try { h.update(await readFile(p)); } catch {}
  }
  buildId = h.digest('hex').slice(0, 12);
  return buildId;
}
async function listWasmArtifacts() {
  const dir = path.join(webOut, '__zp');
  try {
    return (await readdir(dir)).filter(n => n.endsWith('.wasm')).sort().map(n => path.join(dir, n));
  } catch { return []; }
}

async function writeBundled(fileName, parts) {
  const source = (parts.map(part => String(part).trimEnd()).join('\n;\n') + '\n')
    .split('__ZP_BUILD_ID__').join(buildId);
  const result = await esbuild.transform(source, {
    charset: 'utf8',
    legalComments: 'none',
    loader: 'js',
    minify,
    target: 'es2022',
  });
  await writeFile(path.join(webOut, fileName), result.code);
}

function stripServiceWorkerImports(source) {
  // Match both LF and CRLF line endings so git autocrlf checkouts do not leave duplicate importScripts in the bundle.
  return source.replace(/^importScripts\('\/zp\/assets\/zp-core\.js'\);\r?\n/gm, '');
}

function stripWorkerPreludeImports(source) {
  return source.replace(/^\s*importScripts\('\/zp\/assets\/zp-core\.js'\);\r?\n/m, '');
}

// Build the classic-script page bundle wrapper from zp-page-bundle (rewriter and CSS only).
async function makeZPBundlePageClassic() {
  const glueJs = await readFile(path.join(zpBundleOutDir, 'zp_page_bundle.js'), 'utf8');
  const wasmBytes = await readFile(path.join(zpBundleOutDir, 'zp_page_bundle_bg.wasm'));
  const wasmBase64 = wasmBytes.toString('base64');
  return `/* Generated from Rust WASM ZeroProxy page bundle (rewriter + CSS only). */\n${glueJs}\n(() => {\nconst __zp_bundle_b64 = ${JSON.stringify(wasmBase64)};\nconst __zp_bundle_bytes = Uint8Array.from(atob(__zp_bundle_b64), c => c.charCodeAt(0));\nconst wbg = globalThis.ZPPageBundleWBG;\nif (typeof wbg !== 'function') throw new Error('ZP_PAGE_BUNDLE_BOOT_FAILED: ZPPageBundleWBG missing');\nwbg.initSync({ module: __zp_bundle_bytes });\nconst api = Object.freeze({\n  ready: true,\n  bundleVersion: wbg.bundleVersion,\n  rewriteScript: (source, kind, targetUrl, proxyOrigin) => wbg.rewriteScript(String(source || ''), String(kind || 'classic'), String(targetUrl || ''), String(proxyOrigin || '')),\n  rewriteCSS: typeof wbg.rewriteCSS === 'function'\n    ? (source, baseUrl, controlPrefix, proxyOrigin) => wbg.rewriteCSS(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/'), String(proxyOrigin || ''))\n    : null,\n});\nObject.defineProperty(globalThis, 'ZPBundle', { value: api, enumerable: false, configurable: false, writable: false });\n})();\n`;
}

function run(cmd, argv, extraEnv = {}) {
  process.stdout.write(`${cmd} ${argv.join(' ')}\n`);
  const result = spawnSync(cmd, argv, {
    cwd: repoRoot,
    env: { ...buildEnv, ...extraEnv },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed with exit code ${result.status}`);
}

function resolveNodeModule(specifier) {
  return path.join(repoRoot, 'node_modules', ...specifier.split('/'));
}

async function copyOptional(from, to) {
  if (await exists(from)) await copyFile(from, to);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
