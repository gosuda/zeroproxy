#!/usr/bin/env node
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 함수 선언은 호이스팅되지만 `let` 은 TDZ 다. buildWeb() 이 이 파일의 최상위
// 호출에서 먼저 실행되므로, 선언이 아래에 있으면 "Cannot access before
// initialization" 으로 죽는다(실제로 밟았다). 최상위에서 선언한다.
let buildId = '';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(repoRoot, args.out || 'dist');
const webSrc = path.join(repoRoot, 'web');
const webOut = path.join(outRoot, 'web');
const serverOut = path.join(outRoot, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
const cargoHome = process.env.CARGO_HOME || path.join(process.env.HOME || '', '.cargo');
const cargoBinPath = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const wasmBindgenBinPath = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');
// Minify by default — produces the artifact shipped to clients. Opt out
// with `--no-minify` for readable dist output when chasing a bug.
// Explicit `--minify` still works (no-op when default is already true)
// so existing invocations keep parsing.
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
  // When the Rust step is skipped, the `dist/web/__zp/` subdir holds the
  // wasm-bindgen output from a previous build — wiping it would force the
  // dev to re-run the (slow) Rust build before SW can register. Preserve
  // __zp when rust is not being rebuilt.
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
  // wasm 이 이미 dist/web/__zp 에 있어야 id 에 반영된다 — buildWeb 은 Rust
  // 단계 뒤에 돈다.
  await computeBuildId();

  const zpBundlePage = await makeZPBundlePageClassic();
  const hdrPolicy = await responseHeaderPolicy();
  const serviceWorker = stripServiceWorkerImports(await readSource('sw.js'))
    .split('__ZP_REPORTING_HEADERS__').join(JSON.stringify(hdrPolicy.reporting))
    .split('__ZP_TARGET_POLICY_HEADERS__').join(JSON.stringify(hdrPolicy.directive))
    .split('__ZP_HOP_BY_HOP_HEADERS__').join(JSON.stringify(hdrPolicy.hop_by_hop));
  const workerPrelude = stripWorkerPreludeImports(await readSource('worker-prelude.js'));

  // index.html 도 build id 치환 대상이다. 그냥 복사하면 런처의
  // `<script src="/zp/assets/zp-core.js">` 가 버전 없는 URL 로 남아 로드마다
  // 재검증 왕복이 하나 남는다(측정: 웜 로드에서 유일하게 남던 요청).
  await writeFile(
    path.join(webOut, 'index.html'),
    (await readFile(path.join(webSrc, 'index.html'), 'utf8'))
      .split('__ZP_BUILD_ID__').join(buildId),
  );
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(path.join(webSrc, 'manifest.webmanifest'), path.join(webOut, 'manifest.webmanifest'));

  await writeBundled('zp-core.js', [await readSource('zp-core.js')]);
  await writeBundled('zp-rt.js', [await readSource('zp-rt.js')]);
  // runtime-prelude needs ZeroProxyRT available at IIFE entry — bundle
  // zp-rt.js (the raw-WASM glue) as a prefix so it self-registers on
  // globalThis before runtime-prelude.js runs. The async rt.load() call
  // inside runtime-prelude will fetch /__zp/zp_page_rt.wasm.
  const surfaceTable = JSON.stringify(await urlSurfacePairs());
  await writeBundled('runtime-prelude.js', [
    await readSource('zp-rt.js'),
    (await readSource('runtime-prelude.js')).split('__ZP_URL_SURFACES__').join(surfaceTable),
  ]);
  // 2026-06-08 split-bundle (c.1) Step 4: classic-script wrapper that
  // inlines the SW-flavored ZPBundle wasm-bindgen glue + wasm bytes and
  // does an `initSync()` so the page realm has `globalThis.ZPBundle`
  // ready synchronously by the time runtime-prelude's IIFE runs. Both
  // JS and CSS rewrite live here now (legacy crate deleted in Step 4).
  await writeBundled('zp-page-bundle.js', [zpBundlePage]);
  await writeBundled('worker-prelude.js', [await readSource('zp-core.js'), workerPrelude]);
  // 2026-06-08 split-bundle (c.1) Step 4: legacy rust-rewriter.js dropped
  // from the SW bundle. The SW realm loads the modern ZPBundle via the
  // top-level `importScripts('/__zp/zp_bundle_sw.js')` (see sw.js).
  await writeBundled('sw.js', [await readSource('zp-core.js'), serviceWorker]);
}

async function buildRustBundle() {
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-bundle']);
  // 2026-06-08 split-bundle (c.3): zp-kernel-bundle holds the SW
  // transport/kernel half (rustls + h2 + yamux + mlkem + tokio +
  // flate2/brotli/ruzstd + membrane/rtcgw/wtproxy). Its wasm is fetched +
  // instantiated lazily — only on first `transportFetch` — instead of
  // blocking SW `activate`.
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-kernel-bundle']);
  // 2026-06-08 split-bundle (c.2): zp-page-bundle is the page-realm wasm —
  // strict subset (rewriter + sourcemap + CSS + html-tx) without the SW
  // kernel/transport stack.
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-bundle']);
  // zp-page-rt: raw extern "C" cdylib loaded by web/zp-rt.js. No wasm-bindgen
  // glue; the .wasm is copied as-is and JS instantiates it directly.
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt']);
  await mkdir(zpBundleOutDir, { recursive: true });
  // SW bundle (zp-bundle, full transport stack). No-modules glue loadable
  // via importScripts(); wrapped in an IIFE so top-level `let wasm_bindgen`
  // stays function-scoped.
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
  // 2026-06-08 split-bundle (c.3): SW kernel bundle (zp-kernel-bundle —
  // rustls + h2 + yamux + mlkem + tokio + decoders + membrane/rtcgw/
  // wtproxy). Same no-modules + IIFE wrap shape as the rewriter bundle,
  // but its factory is exposed under `self.ZPKernelWBG` so the SW's
  // `initKernel()` shim can find it independently. The wasm itself
  // stays unfetched until first `transportFetch`.
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
  // Page bundle (zp-page-bundle, rewriter + CSS only). Same no-modules
  // flavor + same IIFE wrap; exposes its factory under a distinct global
  // so the page boot wrapper can find it.
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
  // wasm-opt feature flags: rustc since 1.82 emits bulk-memory / sign-ext /
  // multivalue etc. by default for wasm32, but wasm-opt rejects them unless
  // explicitly enabled. Mirror the runtime feature set rustc assumes (which
  // browsers have shipped for years). `npm i -D binaryen` provides wasm-opt.
  const WASM_OPT_FLAGS = [
    '--enable-bulk-memory',
    '--enable-bulk-memory-opt',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '--enable-multivalue',
    '--enable-reference-types',
  ];
  // Optimize the wasm-bindgen outputs — SW bundle (zp_bundle_sw_bg.wasm)
  // + page bundle (zp_page_bundle_bg.wasm). The legacy `--target web`
  // ES-module page output is no longer built (zp-page-bundle is loaded
  // as a classic script via importScripts-like `<script>` tags).
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
  // zp-page-rt: copy raw wasm into __zp/, optionally optimize. No glue file.
  const pageRtDst = path.join(zpBundleOutDir, 'zp_page_rt.wasm');
  await copyFile(zpPageRtWasm, pageRtDst);
  tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, pageRtDst, '-o', pageRtDst]);
}

function tryRunOptional(cmd, argv) {
  try {
    // On Windows, `npm i -g binaryen` installs `wasm-opt.cmd` not
    // `wasm-opt.exe`. Plain `spawnSync('wasm-opt', ...)` returns ENOENT
    // for `.cmd` shims because Node won't auto-resolve PATHEXT unless
    // `shell:true` is set. That's why the page-bundle wasm-opt step
    // silently no-op'd — Linux/macOS hit the binary, Windows fell through.
    const result = spawnSync(cmd, argv, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function buildServer() {
  run('go', ['build', '-trimpath', '-o', serverOut, './cmd/zeroproxy-server']);
}

// URL 표면 테이블은 `crates/zp-shared/testdata/url_surfaces.json` 이 단일 소스다.
// 프렐류드가 손목록을 들고 있으면 Rust 목록과 갈라진다 — 2026-08-20~21 에 그
// 이유로 `background` / `feImage` / `image-set` 이 csp-only 로 남아 있었다.
// 빌드 시점에 박아 넣어 목록이 한 곳에만 존재하게 한다.
//
// `deliberate` 은 제외한다 — 정책상 어느 realm 에서도 리라이트하지 않는 자리다.
// 나머지(rewrite/srcset/navigation/special/known-gap)는 페이지 realm 이 다뤄야
// 한다. `known-gap` 은 htmltx 에만 없는 것이지 페이지 realm 은 이미 다룬다.
//
// `xlink:href` 같은 접두 속성은 프렐류드가 `attrLocalName` 으로 접두를 떼고
// 보므로 로컬 이름으로 눕힌다.
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
  if (pairs.size < 20) throw new Error('url_surfaces.json 에서 뽑은 표면이 너무 적다: ' + pairs.size);
  return [...pairs].sort();
}

// 타깃 응답 헤더 정책도 픽스처가 단일 소스다. Go 사본이 있었지만 호출자가
// 없는 죽은 코드였고(2026-08-21 확인), "Go 가 막고 있다" 는 믿음이 실제
// 탈출을 낳았다. 이제 목록은 여기 하나이고 빌드가 SW 에 박아 넣는다.
async function responseHeaderPolicy() {
  const raw = await readFile(
    path.join(repoRoot, 'crates', 'zp-shared', 'testdata', 'response_header_policy.json'),
    'utf8',
  );
  const doc = JSON.parse(raw);
  for (const key of ['reporting', 'directive', 'hop_by_hop']) {
    if (!Array.isArray(doc[key]) || doc[key].length === 0) {
      throw new Error('response_header_policy.json 의 ' + key + ' 가 비었다');
    }
  }
  return doc;
}

async function readSource(name) {
  return readFile(path.join(webSrc, name), 'utf8');
}

// 2026-08-14 — 콘텐츠 기반 build id.
//
// 에셋을 `no-cache` 로 바꿔 재검증 캐시는 살렸지만(1042KB → 0KB), 여전히 매
// 로드마다 조건부 요청 왕복이 남는다. URL 에 build id 를 실으면 그 왕복도
// 사라진다 — 빌드가 바뀌면 URL 이 바뀌므로 `immutable` 로 줘도 낡은 사본이
// 남을 수 없다. 파일명을 해싱하는 대신 `?v=` 를 쓰는 이유는 참조 지점이
// 여러 곳(sw.js 의 importScripts 리터럴, 프렐류드의 wasm 경로,
// ZP.assetPath)이라 파일명 재작성이 그 전부를 건드려야 하기 때문이다.
//
// **소스 바이트**로 해싱한다. 산출물로 해싱하면 치환이 산출물을 바꿔
// 순환이 된다.
async function computeBuildId() {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  const names = (await readdir(webSrc)).filter(n => n.endsWith('.js') || n.endsWith('.html')).sort();
  for (const n of names) {
    h.update(n);
    h.update(await readFile(path.join(webSrc, n)));
  }
  // wasm 도 포함해야 한다 — Rust 만 바뀐 빌드에서 id 가 그대로면 낡은 wasm 이
  // immutable 로 굳는다.
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
  // CRLF-tolerant: web/sw.js can be checked out with either LF or CRLF
  // line endings depending on git autocrlf. Without \r? the regex misses
  // CRLF lines, leaving importScripts in the bundle. The bundled sw.js
  // would then have two top-level `let wasm_bindgen` declarations (one
  // from inlined rust-rewriter, one from importScripts'd rust-rewriter),
  // causing a SyntaxError during SW evaluation.
  return source.replace(/^importScripts\('\/zp\/assets\/zp-core\.js'\);\r?\n/gm, '');
}

function stripWorkerPreludeImports(source) {
  return source.replace(/^\s*importScripts\('\/zp\/assets\/zp-core\.js'\);\r?\n/m, '');
}

// 2026-06-08 split-bundle (c.2): page-realm ZPBundle uses the dedicated
// `zp-page-bundle` crate's WASM (~1 MB after wasm-opt) instead of the
// full SW bundle's (~3.8 MB). The page bundle exposes only the rewriter
// + CSS rewriter — no kernel/transport stack (rustls / h2 / mlkem /
// yamux / tokio / flate2 / brotli / ruzstd / membrane / rtcgw / wtproxy
// all left in the SW bundle).
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
    env: { ...process.env, ...extraEnv },
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
