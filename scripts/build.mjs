#!/usr/bin/env node
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(repoRoot, args.out || 'dist');
const webSrc = path.join(repoRoot, 'web');
const webOut = path.join(outRoot, 'web');
const kernelOut = path.join(outRoot, 'kernel.wasm');
const serverOut = path.join(outRoot, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
const cargoHome = process.env.CARGO_HOME || path.join(process.env.HOME || '', '.cargo');
const cargoBinPath = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const wasmBindgenBinPath = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');
const minify = args.minify === true;

if (args.help) {
  process.stdout.write(`Usage: node scripts/build.mjs [options]\n\nOptions:\n  --out <dir>       Output directory (default: dist)\n  --web-only        Build only browser assets\n  --kernel-only     Build only the Go WASM kernel\n  --server-only     Build only the relay server\n  --skip-web        Do not build browser assets\n  --skip-kernel     Do not build the Go WASM kernel\n  --skip-server     Do not build the relay server\n  --minify          Minify bundled JavaScript\n  --no-clean        Keep existing output files not overwritten by this run\n`);
  process.exit(0);
}

const selected = selectedTargets(args);

if (!args.noClean) await cleanSelectedOutputs(selected);
await mkdir(outRoot, { recursive: true });

if (selected.web) await buildWeb();
if (selected.kernel) buildKernel();
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
      case '--skip-web':
      case '--skip-kernel':
      case '--skip-server':
      case '--minify':
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
  let kernel = true;
  let server = true;
  if (parsed.webOnly || parsed.kernelOnly || parsed.serverOnly) {
    web = parsed.webOnly === true;
    kernel = parsed.kernelOnly === true;
    server = parsed.serverOnly === true;
  }
  if (parsed.skipWeb) web = false;
  if (parsed.skipKernel) kernel = false;
  if (parsed.skipServer) server = false;
  if (!web && !kernel && !server) throw new Error('no build targets selected');
  return { web, kernel, server };
}

async function cleanSelectedOutputs(selected) {
  if (selected.web && selected.kernel && selected.server) {
    await rm(outRoot, { recursive: true, force: true });
    return;
  }
  const removals = [];
  if (selected.web) removals.push(rm(webOut, { recursive: true, force: true }));
  if (selected.kernel) removals.push(rm(kernelOut, { force: true }));
  if (selected.server) removals.push(rm(serverOut, { force: true }));
  await Promise.all(removals);
}

async function buildWeb() {
  await mkdir(webOut, { recursive: true });

  const goWasmExec = await readGoWasmExec();
  const rustRewriter = await makeRustRewriterClassic();
  const serviceWorker = stripServiceWorkerImports(await readSource('sw.js'));
  const workerPrelude = stripWorkerPreludeImports(await readSource('worker-prelude.js'));

  await copyFile(path.join(webSrc, 'index.html'), path.join(webOut, 'index.html'));
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(path.join(webSrc, 'manifest.webmanifest'), path.join(webOut, 'manifest.webmanifest'));

  await writeBundled('zp-core.js', [await readSource('zp-core.js')]);
  await writeBundled('runtime-prelude.js', [await readSource('runtime-prelude.js')]);
  await writeBundled('rust-rewriter.js', [rustRewriter]);
  await writeBundled('wasm_exec.js', [goWasmExec]);
  await writeBundled('worker-prelude.js', [await readSource('zp-core.js'), workerPrelude]);
  await writeBundled('sw.js', [await readSource('zp-core.js'), rustRewriter, goWasmExec, serviceWorker]);
}

function buildKernel() {
  run('go', ['build', '-trimpath', '-o', kernelOut, './cmd/wasm-kernel'], { GOOS: 'js', GOARCH: 'wasm' });
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
  return source.replace(/^importScripts\('\/zp\/assets\/(?:zp-core|rust-rewriter|wasm_exec)\.js'\);\n/gm, '');
}

function stripWorkerPreludeImports(source) {
  return source.replace(/^\s*importScripts\('\/zp\/assets\/zp-core\.js'\);\n/m, '');
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
  return `/* Generated from Rust WASM ZeroProxy rewriter. */\n${js}\n(() => {\nconst VERSION = 'phase3-rust-wasm-ast-3-css';\nconst BLOCK_CODE = \"throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');\";\nconst __zp_rust_b64 = ${JSON.stringify(wasmBase64)};\nconst __zp_rust_bytes = Uint8Array.from(atob(__zp_rust_b64), ch => ch.charCodeAt(0));\nwasm_bindgen.initSync({ module: __zp_rust_bytes });\nfunction normalizeKind(kind) { kind = String(kind || 'classic').toLowerCase(); if (kind === 'worker') return 'classic'; if (kind === 'event' || kind === 'event-handler') return 'event-handler'; if (kind === 'function') return 'function'; if (kind === 'module') return 'module'; return 'classic'; }\nfunction lowLevel(source, kind, targetUrl, controlPrefix) { const out = wasm_bindgen.rewrite_script(String(source || ''), normalizeKind(kind), String(targetUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }\nfunction lowLevelCSS(source, baseUrl, controlPrefix) { const out = wasm_bindgen.rewrite_css(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }\nfunction publicOk(code) { return { ok: true, code, diagnostics: [] }; }\nfunction publicBlocked(error) { const code = error || 'REWRITE_FAILED'; return { ok: false, errorCode: code, diagnostics: [{ level: 'error', message: code }] }; }\nfunction rewriteScriptPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { kind: options }; const out = lowLevel(source, opts.scriptKind || opts.kind, opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }\nfunction rewriteCSSPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { baseUrl: options }; const out = lowLevelCSS(source, opts.baseUrl || opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }\nfunction rewriteFunctionBodyRaw(source, params, targetUrl, controlPrefix) { const list = Array.isArray(params) ? params : []; const prefix = 'function __zp_dynamic__(' + list.map(value => String(value)).join(',') + '){\\n'; const suffix = '\\n}'; const out = lowLevel(prefix + String(source || '') + suffix, 'classic', targetUrl, controlPrefix); if (!out.ok) return out; const end = out.code.length - suffix.length; if (end < prefix.length) return { ok: false, code: '', error: 'REWRITE_FAILED' }; return { ok: true, code: out.code.slice(prefix.length, end), error: '' }; }\nfunction rewriteFunctionBodyPublic(source, params, targetUrl, controlPrefix) { const out = rewriteFunctionBodyRaw(source, params, targetUrl, controlPrefix); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }\nconst rustApi = Object.freeze({ rewriteScript(source, kind, targetUrl, controlPrefix) { return lowLevel(source, kind, targetUrl, controlPrefix); }, rewriteCSS(source, baseUrl, controlPrefix) { return lowLevelCSS(source, baseUrl, controlPrefix); }, rewriteFunctionBody: rewriteFunctionBodyRaw });\nconst rewriterApi = Object.freeze({ VERSION, ready: true, init() { return Promise.resolve(true); }, initSync() { return true; }, rewriteScript: rewriteScriptPublic, rewriteCSS: rewriteCSSPublic, rewriteFunctionBody: rewriteFunctionBodyPublic, blockSource() { return BLOCK_CODE; } });\nObject.defineProperty(globalThis, 'ZPRustRewriter', { value: rustApi, enumerable: false, configurable: false, writable: false });\nObject.defineProperty(globalThis, 'ZPRewriter', { value: rewriterApi, enumerable: false, configurable: false, writable: false });\n})();\n`;
}
async function readGoWasmExec() {
  const goroot = goEnv('GOROOT');
  const candidates = [
    path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
    path.join(goroot, 'misc', 'wasm', 'wasm_exec.js'),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return readFile(candidate, 'utf8');
  }
  throw new Error(`wasm_exec.js not found under ${goroot}`);
}

function goEnv(name) {
  const result = spawnSync('go', ['env', name], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`go env ${name} failed\n${result.stderr}`);
  return result.stdout.trim();
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
