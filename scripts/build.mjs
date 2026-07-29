#!/usr/bin/env node
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const zpBundlePage = await makeZPBundlePageClassic();
  const serviceWorker = stripServiceWorkerImports(await readSource('sw.js'));
  const workerPrelude = stripWorkerPreludeImports(await readSource('worker-prelude.js'));

  await copyFile(path.join(webSrc, 'index.html'), path.join(webOut, 'index.html'));
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(path.join(webSrc, 'manifest.webmanifest'), path.join(webOut, 'manifest.webmanifest'));

  await writeBundled('zp-core.js', [await readSource('zp-core.js')]);
  await writeBundled('zp-rt.js', [await readSource('zp-rt.js')]);
  // runtime-prelude needs ZeroProxyRT available at IIFE entry — bundle
  // zp-rt.js (the raw-WASM glue) as a prefix so it self-registers on
  // globalThis before runtime-prelude.js runs. The async rt.load() call
  // inside runtime-prelude will fetch /__zp/zp_page_rt.wasm.
  await writeBundled('runtime-prelude.js', [await readSource('zp-rt.js'), await readSource('runtime-prelude.js')]);
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

async function readSource(name) {
  return readFile(path.join(webSrc, name), 'utf8');
}

async function writeBundled(fileName, parts) {
  const source = parts.map(part => String(part).trimEnd()).join('\n;\n') + '\n';
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
  return `/* Generated from Rust WASM ZeroProxy page bundle (rewriter + CSS only). */\n${glueJs}\n(() => {\nconst __zp_bundle_b64 = ${JSON.stringify(wasmBase64)};\nconst __zp_bundle_bytes = Uint8Array.from(atob(__zp_bundle_b64), c => c.charCodeAt(0));\nconst wbg = globalThis.ZPPageBundleWBG;\nif (typeof wbg !== 'function') throw new Error('ZP_PAGE_BUNDLE_BOOT_FAILED: ZPPageBundleWBG missing');\nwbg.initSync({ module: __zp_bundle_bytes });\nconst api = Object.freeze({\n  ready: true,\n  bundleVersion: wbg.bundleVersion,\n  rewriteScript: (source, kind, targetUrl) => wbg.rewriteScript(String(source || ''), String(kind || 'classic'), String(targetUrl || '')),\n  rewriteCSS: typeof wbg.rewriteCSS === 'function'\n    ? (source, baseUrl, controlPrefix, proxyOrigin) => wbg.rewriteCSS(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/'), String(proxyOrigin || ''))\n    : null,\n});\nObject.defineProperty(globalThis, 'ZPBundle', { value: api, enumerable: false, configurable: false, writable: false });\n})();\n`;
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
