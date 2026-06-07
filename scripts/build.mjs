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

  const rustRewriter = await makeRustRewriterClassic();
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
  await writeBundled('rust-rewriter.js', [rustRewriter]);
  await writeBundled('worker-prelude.js', [await readSource('zp-core.js'), workerPrelude]);
  await writeBundled('sw.js', [await readSource('zp-core.js'), rustRewriter, serviceWorker]);
}

async function buildRustBundle() {
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-bundle']);
  // zp-page-rt: raw extern "C" cdylib loaded by web/zp-rt.js. No wasm-bindgen
  // glue; the .wasm is copied as-is and JS instantiates it directly.
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt']);
  await mkdir(zpBundleOutDir, { recursive: true });
  // Foreground / page use: ES-module flavored glue.
  run('wasm-bindgen', [
    '--target', 'web',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp_bundle',
    zpBundleWasm,
  ]);
  // Service Worker use: classic script flavored glue loadable via
  // importScripts(). wasm-bindgen `no-modules` emits `let wasm_bindgen = ...`
  // at top level — `let` creates a lexical binding NOT on globalThis. SWs
  // see it from other importScripts'd scripts via the shared script realm,
  // but `self.wasm_bindgen` is undefined. We need both forms because the
  // SW caller code probes via `typeof self.wasm_bindgen === 'function'`.
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp_bundle_sw',
    zpBundleWasm,
  ]);
  // Two wasm-bindgen no-modules outputs live in the SW realm: this one
  // (zp-bundle) AND the legacy rewriter-rs glue. Both declare top-level
  // `let wasm_bindgen` which collides → SyntaxError on importScripts.
  // Wrap our output in an IIFE so `let wasm_bindgen` is function-scoped,
  // then expose under a distinct global so initBundle can find it.
  const swJsPath = path.join(zpBundleOutDir, 'zp_bundle_sw.js');
  const swGlue = await readFile(swJsPath, 'utf8');
  if (!swGlue.startsWith('(function(){')) {
    await writeFile(
      swJsPath,
      '(function(){\n' + swGlue + '\n;try{ self.ZPBundleWBG = wasm_bindgen; }catch(_e){};\n})();\n',
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
  // Optimize BOTH wasm-bindgen outputs — page bundle (`zp_bundle_bg.wasm`)
  // and the SW bundle (`zp_bundle_sw_bg.wasm`). Prior versions only ran
  // wasm-opt on the page bundle, leaving the SW worker shipping an
  // unoptimised ~3.5 MB blob even when binaryen was present.
  const pageWasm = path.join(zpBundleOutDir, 'zp_bundle_bg.wasm');
  const swWasm = path.join(zpBundleOutDir, 'zp_bundle_sw_bg.wasm');
  const optimizedPage = tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, pageWasm, '-o', pageWasm]);
  if (!optimizedPage) {
    process.stderr.write('wasm-opt not found; skipping size optimization (install binaryen to enable)\n');
  } else {
    tryRunOptional('wasm-opt', ['-Oz', ...WASM_OPT_FLAGS, swWasm, '-o', swWasm]);
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
  return source.replace(/^importScripts\('\/zp\/assets\/(?:zp-core|rust-rewriter)\.js'\);\r?\n/gm, '');
}

function stripWorkerPreludeImports(source) {
  return source.replace(/^\s*importScripts\('\/zp\/assets\/zp-core\.js'\);\r?\n/m, '');
}

async function makeRustRewriterClassic() {
  const crateDir = path.join(repoRoot, 'rewriter-rs');
  const targetDir = path.join(crateDir, 'target');
  run(cargoBinPath, ['build', '--manifest-path', path.join(crateDir, 'Cargo.toml'), '--target', 'wasm32-unknown-unknown', '--release']);
  const bindgenOut = path.join(targetDir, 'wasm-bindgen');
  await rm(bindgenOut, { recursive: true, force: true });
  await mkdir(bindgenOut, { recursive: true });
  run(wasmBindgenBinPath, ['--target', 'no-modules', '--out-dir', bindgenOut, path.join(targetDir, 'wasm32-unknown-unknown', 'release', 'zp_rewriter.wasm')]);
  const js = await readFile(path.join(bindgenOut, 'zp_rewriter.js'), 'utf8');
  const wasmBase64 = (await readFile(path.join(bindgenOut, 'zp_rewriter_bg.wasm'))).toString('base64');
  // 2026-06-07 split-bundle (c.1) Step 1: dropped the JS-side
  // `rewriteFunctionBody` wrap+strip (now inlined in runtime-prelude's
  // `rewriteDynamicFunctionBody`) and `blockSource()` (now inlined in
  // sw.js as a literal string). Neither needed Rust; both were JS
  // wrappers exposed on `ZPRewriter` for historical reasons.
  return `/* Generated from Rust WASM ZeroProxy rewriter. */\n${js}\n(() => {\nconst VERSION = 'phase3-rust-wasm-ast-3-css';\nconst __zp_rust_b64 = ${JSON.stringify(wasmBase64)};\nconst __zp_rust_bytes = Uint8Array.from(atob(__zp_rust_b64), ch => ch.charCodeAt(0));\nwasm_bindgen.initSync({ module: __zp_rust_bytes });\nfunction normalizeKind(kind) { kind = String(kind || 'classic').toLowerCase(); if (kind === 'worker') return 'classic'; if (kind === 'event' || kind === 'event-handler') return 'event-handler'; if (kind === 'module') return 'module'; return 'classic'; }\nfunction lowLevel(source, kind, targetUrl, controlPrefix) { const out = wasm_bindgen.rewrite_script(String(source || ''), normalizeKind(kind), String(targetUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }\nfunction lowLevelCSS(source, baseUrl, controlPrefix) { const out = wasm_bindgen.rewrite_css(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }\nfunction publicOk(code) { return { ok: true, code, diagnostics: [] }; }\nfunction publicBlocked(error) { const code = error || 'REWRITE_FAILED'; return { ok: false, errorCode: code, diagnostics: [{ level: 'error', message: code }] }; }\nfunction rewriteScriptPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { kind: options }; const out = lowLevel(source, opts.scriptKind || opts.kind, opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }\nfunction rewriteCSSPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { baseUrl: options }; const out = lowLevelCSS(source, opts.baseUrl || opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }\nconst rustApi = Object.freeze({ rewriteScript(source, kind, targetUrl, controlPrefix) { return lowLevel(source, kind, targetUrl, controlPrefix); }, rewriteCSS(source, baseUrl, controlPrefix) { return lowLevelCSS(source, baseUrl, controlPrefix); } });\nconst rewriterApi = Object.freeze({ VERSION, ready: true, init() { return Promise.resolve(true); }, initSync() { return true; }, rewriteScript: rewriteScriptPublic, rewriteCSS: rewriteCSSPublic });\nObject.defineProperty(globalThis, 'ZPRustRewriter', { value: rustApi, enumerable: false, configurable: false, writable: false });\nObject.defineProperty(globalThis, 'ZPRewriter', { value: rewriterApi, enumerable: false, configurable: false, writable: false });\n})();\n`;
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
