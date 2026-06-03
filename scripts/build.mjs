#!/usr/bin/env node
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
const serverOut = path.join(
  outRoot,
  process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server',
);
const cargoHome = process.env.CARGO_HOME || path.join(process.env.HOME || '', '.cargo');
const cargoBinPath = path.join(
  cargoHome,
  'bin',
  process.platform === 'win32' ? 'cargo.exe' : 'cargo',
);
const wasmBindgenBinPath = path.join(
  cargoHome,
  'bin',
  process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen',
);
const minify = args.minify === true;

if (args.help) {
  process.stdout.write(
    `Usage: node scripts/build.mjs [options]\n\nOptions:\n  --out <dir>       Output directory (default: dist)\n  --web-only        Build only browser assets\n  --kernel-only     Build only the Go WASM kernel\n  --server-only     Build only the relay server\n  --skip-web        Do not build browser assets\n  --skip-kernel     Do not build the Go WASM kernel\n  --skip-server     Do not build the relay server\n  --minify          Minify bundled JavaScript\n  --no-clean        Keep existing output files not overwritten by this run\n`,
  );
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

  await copyFile(path.join(webSrc, 'index.html'), path.join(webOut, 'index.html'));
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(
    path.join(webSrc, 'manifest.webmanifest'),
    path.join(webOut, 'manifest.webmanifest'),
  );

  await writeClassicAsset('zp-core.js', await readSource('zp-core.js'));
  await writeViteBundle('runtime-prelude.js', {
    inputFileName: 'runtime-prelude-entry.mjs',
    virtualModules: {
      'virtual:zeroproxy-rust-rewriter': rustRewriter,
    },
  });
  await writeClassicAsset('rust-rewriter.js', rustRewriter);
  await writeClassicAsset('http-rewriter.js', await readSource('http-rewriter.js'));
  await writeClassicAsset('wasm_exec.js', goWasmExec);
  await writeViteBundle('worker-prelude.js', { inputFileName: 'worker-prelude-entry.mjs' });
  await writeViteBundle('sw.js', {
    inputFileName: 'sw-entry.mjs',
    virtualModules: {
      'virtual:zeroproxy-rust-rewriter': rustRewriter,
      'virtual:zeroproxy-wasm-exec': goWasmExec,
      'virtual:zeroproxy-sw-body': stripServiceWorkerImports(await readSource('sw.js')),
    },
  });
}

function buildKernel() {
  run('go', ['build', '-trimpath', '-o', kernelOut, './cmd/wasm-kernel'], {
    GOOS: 'js',
    GOARCH: 'wasm',
  });
}

function buildServer() {
  run('go', ['build', '-trimpath', '-o', serverOut, './cmd/zeroproxy-server']);
}

async function readSource(name) {
  return readFile(path.join(webSrc, name), 'utf8');
}

async function writeClassicAsset(fileName, source) {
  await writeFile(path.join(webOut, fileName), `${String(source).trimEnd()}\n`);
}

async function writeViteBundle(entryFileName, options = {}) {
  const { build } = await import('vite');
  const inputFileName = options.inputFileName || entryFileName;
  await build({
    configFile: path.join(repoRoot, 'vite.config.mjs'),
    mode: 'production',
    logLevel: 'warn',
    plugins: [virtualSourcePlugin(options.virtualModules || {})],
    build: {
      outDir: webOut,
      emptyOutDir: false,
      minify,
      rollupOptions: {
        input: path.join(webSrc, inputFileName),
        treeshake: false,
        output: {
          entryFileNames: entryFileName,
          format: 'iife',
        },
      },
    },
  });
}

function virtualSourcePlugin(modules) {
  const prefix = '\0';
  return {
    name: 'zeroproxy-virtual-source',
    resolveId(id) {
      return Object.hasOwn(modules, id) ? prefix + id : null;
    },
    load(id) {
      const name = id.startsWith(prefix) ? id.slice(prefix.length) : id;
      return Object.hasOwn(modules, name) ? modules[name] : null;
    },
  };
}

function stripServiceWorkerImports(source) {
  return source.replace(
    /^importScripts\('\/zp\/assets\/(?:zp-core|rust-rewriter|http-rewriter|wasm_exec|sw-kernel|sw-routes|sw-transport|sw-responses)\.js'\);\n/gm,
    '',
  );
}

async function makeRustRewriterClassic() {
  const crateDir = path.join(repoRoot, 'rewriter-rs');
  const targetDir = path.join(crateDir, 'target');
  run(cargoBinPath, [
    'build',
    '--manifest-path',
    path.join(crateDir, 'Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
    '--release',
  ]);
  const bindgenOut = path.join(targetDir, 'wasm-bindgen');
  await rm(bindgenOut, { recursive: true, force: true });
  await mkdir(bindgenOut, { recursive: true });
  run(wasmBindgenBinPath, [
    '--target',
    'no-modules',
    '--out-dir',
    bindgenOut,
    path.join(targetDir, 'wasm32-unknown-unknown', 'release', 'zp_rewriter.wasm'),
  ]);
  const js = await readFile(path.join(bindgenOut, 'zp_rewriter.js'), 'utf8');
  await writeOptimizedWasm(
    path.join(bindgenOut, 'zp_rewriter_bg.wasm'),
    path.join(webOut, 'rust-rewriter.wasm'),
  );
  return [
    '/* Generated from Rust WASM ZeroProxy rewriter. */',
    '(() => {',
    `const installedRustAPI = Object.getOwnPropertyDescriptor(globalThis, 'ZPRustRewriter');`,
    `const installedPublicAPI = Object.getOwnPropertyDescriptor(globalThis, 'ZPRewriter');`,
    `if (installedRustAPI && installedRustAPI.configurable === false && installedPublicAPI && installedPublicAPI.configurable === false) return;`,
    js,
    "const VERSION = 'phase3-rust-wasm-ast-4-import-map';",
    `const BLOCK_CODE = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";`,
    `const WASM_URL = '/zp/assets/rust-rewriter.wasm';`,
    `let initialized = false;`,
    `let initError = null;`,
    `let initPromise = null;`,
    `function wasmSource() { return WASM_URL; }`,
    `function loadWasmBytesSync() { if (typeof XMLHttpRequest !== 'function') return null; const xhr = new XMLHttpRequest(); xhr.open('GET', WASM_URL, false); if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined'); xhr.send(null); if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0)) throw new Error('RUST_REWRITER_WASM_HTTP_' + xhr.status); const text = String(xhr.responseText || ''); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255; return bytes; }`,
    `function clearWasmTiming() { try { if (globalThis.performance && typeof globalThis.performance.clearResourceTimings === 'function') globalThis.performance.clearResourceTimings(); } catch {} }`,
    `function init() { if (initialized) return Promise.resolve(true); if (!initPromise) initPromise = wasm_bindgen({ module_or_path: wasmSource() }).then(() => { initialized = true; clearWasmTiming(); return true; }).catch(err => { initError = err; initPromise = null; throw err; }); return initPromise; }`,
    `function initSync(bytes) { const source = bytes || loadWasmBytesSync(); if (!source) return false; if (!initialized) { wasm_bindgen.initSync({ module: source }); initialized = true; clearWasmTiming(); } return true; }`,
    `function bootstrapInit() { try { if (initSync()) return; } catch {} init().catch(() => {}); }`,
    `function ensureReady() { if (!initialized) throw initError || new Error('RUST_REWRITER_NOT_READY'); }`,
    `function normalizeKind(kind) { kind = String(kind || 'classic').toLowerCase(); if (kind === 'worker') return 'classic'; if (kind === 'event' || kind === 'event-handler') return 'event-handler'; if (kind === 'function') return 'function'; if (kind === 'module') return 'module'; return 'classic'; }`,
    `function lowLevel(source, kind, targetUrl, controlPrefix) { return lowLevelWithContext(source, kind, targetUrl, controlPrefix, '', ''); }`,
    `function lowLevelWithContext(source, kind, targetUrl, controlPrefix, tabId, runtimeToken) { ensureReady(); const out = wasm_bindgen.rewrite_script_with_context(String(source || ''), normalizeKind(kind), String(targetUrl || ''), String(controlPrefix || '/zp/'), String(tabId || ''), String(runtimeToken || '')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelScriptURL(raw, kind, targetUrl, controlPrefix, tabId, runtimeToken) { ensureReady(); const out = wasm_bindgen.rewrite_script_url(String(raw || ''), normalizeKind(kind), String(targetUrl || ''), String(controlPrefix || '/zp/'), String(tabId || ''), String(runtimeToken || '')); try { return { ok: !!out.ok, url: out.url, target: out.target, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelFetchURL(raw, targetUrl, controlPrefix) { ensureReady(); const out = wasm_bindgen.rewrite_fetch_url(String(raw || ''), String(targetUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, url: out.url, target: out.target, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelSrcset(raw, targetUrl, controlPrefix) { ensureReady(); const out = wasm_bindgen.rewrite_srcset(String(raw || ''), String(targetUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, url: out.url, target: out.target, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelTargetURL(raw, targetUrl, controlPrefix) { ensureReady(); const out = wasm_bindgen.resolve_target_url(String(raw || ''), String(targetUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, url: out.url, target: out.target, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelLinkRel(rel) { ensureReady(); return wasm_bindgen.classify_link_rel(String(rel || '')); }`,
    `function lowLevelBlockedElement(tag) { ensureReady(); return wasm_bindgen.classify_blocked_element(String(tag || '')); }`,
    `function lowLevelMetaPolicy(httpEquiv) { ensureReady(); return wasm_bindgen.classify_meta_policy(String(httpEquiv || '')); }`,
    `function lowLevelAttrPolicy(tag, key) { ensureReady(); return wasm_bindgen.classify_attr_policy(String(tag || ''), String(key || '')); }`,
    `function lowLevelScriptType(scriptType) { ensureReady(); return wasm_bindgen.classify_script_type(String(scriptType || '')); }`,
    `function lowLevelEventHandlerAttr(attrName) { ensureReady(); return wasm_bindgen.classify_event_handler_attr(String(attrName || '')); }`,
    `function lowLevelCSS(source, baseUrl, controlPrefix) { ensureReady(); const out = wasm_bindgen.rewrite_css(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelImportMap(source, baseUrl, tabId, runtimeToken, controlPrefix) { ensureReady(); return wasm_bindgen.rewrite_import_map(String(source || ''), String(baseUrl || ''), String(tabId || ''), String(runtimeToken || ''), String(controlPrefix || '/zp/')); }`,
    `function lowLevelHTMLDocument(source, targetUrl, controlPrefix, servers, runtimePrelude, tabId, runtimeToken) { ensureReady(); const out = wasm_bindgen.rewrite_html_document(String(source || ''), String(targetUrl || ''), String(controlPrefix || '/zp/'), JSON.stringify(Array.isArray(servers) ? servers : []), String(runtimePrelude || ''), String(tabId || ''), String(runtimeToken || '')); try { return { ok: !!out.ok, code: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function lowLevelShareURL(target, servers) { ensureReady(); const out = wasm_bindgen.make_share_url(String(target || ''), JSON.stringify(Array.isArray(servers) ? servers : [])); try { return { ok: !!out.ok, url: out.code, error: out.error || '' }; } finally { out.free && out.free(); } }`,
    `function publicOk(code) { return { ok: true, code, diagnostics: [] }; }`,
    `function publicBlocked(error) { const code = error || 'REWRITE_FAILED'; return { ok: false, errorCode: code, diagnostics: [{ level: 'error', message: code }] }; }`,
    `function rewriteScriptPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { kind: options }; const out = lowLevelWithContext(source, opts.scriptKind || opts.kind, opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/', opts.tabId || opts.tab || '', opts.runtimeToken || opts.rt || ''); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }`,
    `function rewriteScriptURLPublic(raw, options = {}) { const opts = options && typeof options === 'object' ? options : { kind: options }; const out = lowLevelScriptURL(raw, opts.scriptKind || opts.kind, opts.url || opts.targetUrl || opts.baseUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/', opts.tabId || opts.tab || '', opts.runtimeToken || opts.rt || ''); return out.ok ? { ok: true, url: out.url, target: out.target, diagnostics: [] } : { ok: false, url: out.url || '', target: '', errorCode: out.error || 'POLICY_BLOCKED', diagnostics: [{ level: 'error', message: out.error || 'POLICY_BLOCKED' }] }; }`,
    `function rewriteFetchURLPublic(raw, options = {}) { const opts = options && typeof options === 'object' ? options : { targetUrl: options }; const out = lowLevelFetchURL(raw, opts.url || opts.targetUrl || opts.baseUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? { ok: true, url: out.url, target: out.target, diagnostics: [] } : { ok: false, url: out.url || '', target: '', errorCode: out.error || 'POLICY_BLOCKED', diagnostics: [{ level: 'error', message: out.error || 'POLICY_BLOCKED' }] }; }`,
    `function rewriteSrcsetPublic(raw, options = {}) { const opts = options && typeof options === 'object' ? options : { targetUrl: options }; const out = lowLevelSrcset(raw, opts.url || opts.targetUrl || opts.baseUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? { ok: true, url: out.url, target: out.target, diagnostics: [] } : { ok: false, url: out.url || '', target: out.target || String(raw || ''), errorCode: out.error || 'UNCHANGED', diagnostics: [{ level: 'error', message: out.error || 'UNCHANGED' }] }; }`,
    `function rewriteTargetURLPublic(raw, options = {}) { const opts = options && typeof options === 'object' ? options : { targetUrl: options }; const out = lowLevelTargetURL(raw, opts.url || opts.targetUrl || opts.baseUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? { ok: true, url: out.url, target: out.target, diagnostics: [] } : { ok: false, url: out.url || '', target: '', errorCode: out.error || 'POLICY_BLOCKED', diagnostics: [{ level: 'error', message: out.error || 'POLICY_BLOCKED' }] }; }`,
    `function classifyLinkRelPublic(rel) { return lowLevelLinkRel(rel); }`,
    `function classifyBlockedElementPublic(tag) { return lowLevelBlockedElement(tag); }`,
    `function classifyMetaPolicyPublic(httpEquiv) { return lowLevelMetaPolicy(httpEquiv); }`,
    `function classifyAttrPolicyPublic(tag, key) { return lowLevelAttrPolicy(tag, key); }`,
    `function classifyScriptTypePublic(scriptType) { return lowLevelScriptType(scriptType); }`,
    `function classifyEventHandlerAttrPublic(attrName) { return lowLevelEventHandlerAttr(attrName); }`,
    `function rewriteCSSPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { baseUrl: options }; const out = lowLevelCSS(source, opts.baseUrl || opts.url || opts.targetUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/'); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }`,
    `function rewriteImportMapPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { baseUrl: options }; return publicOk(lowLevelImportMap(source, opts.baseUrl || opts.url || opts.targetUrl || '', opts.tabId || opts.tab || '', opts.runtimeToken || opts.rt || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/')); }`,
    `function rewriteHTMLDocumentPublic(source, options = {}) { const opts = options && typeof options === 'object' ? options : { targetUrl: options }; const out = lowLevelHTMLDocument(source, opts.url || opts.targetUrl || opts.baseUrl || '', opts.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/', opts.servers || [], opts.runtimePrelude || opts.prelude || '', opts.tabId || opts.tab || '', opts.runtimeToken || opts.rt || ''); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }`,
    `function makeShareURLPublic(target, options = {}) { const opts = options && typeof options === 'object' ? options : {}; const out = lowLevelShareURL(target, opts.servers || []); return out.ok ? { ok: true, url: out.url, diagnostics: [] } : { ok: false, url: '', errorCode: out.error || 'POLICY_BLOCKED', diagnostics: [{ level: 'error', message: out.error || 'POLICY_BLOCKED' }] }; }`,
    `function generatedFunctionBody(code) { const start = String(code || '').indexOf('{'); const end = String(code || '').lastIndexOf('}'); return start >= 0 && end >= start ? String(code).slice(start + 1, end) : null; }`,
    `function rewriteFunctionBodyRaw(source, params, targetUrl, controlPrefix) { const list = Array.isArray(params) ? params : []; const prefix = 'function __zp_dynamic__(' + list.map(value => String(value)).join(',') + '){\\n'; const suffix = '\\n}'; const out = lowLevel(prefix + String(source || '') + suffix, 'classic', targetUrl, controlPrefix); if (!out.ok) return out; const body = generatedFunctionBody(out.code); if (body == null) return { ok: false, code: '', error: 'REWRITE_FAILED' }; return { ok: true, code: body, error: '' }; }`,
    `function rewriteFunctionBodyPublic(source, params, targetUrl, controlPrefix) { const out = rewriteFunctionBodyRaw(source, params, targetUrl, controlPrefix); return out.ok ? publicOk(out.code) : publicBlocked(out.error); }`,
    `const rustApi = Object.freeze({ init, initSync, get ready() { return initialized; }, rewriteScript(source, kind, targetUrl, controlPrefix, tabId, runtimeToken) { return lowLevelWithContext(source, kind, targetUrl, controlPrefix, tabId, runtimeToken); }, rewriteScriptURL(raw, kind, targetUrl, controlPrefix, tabId, runtimeToken) { return lowLevelScriptURL(raw, kind, targetUrl, controlPrefix, tabId, runtimeToken); }, rewriteFetchURL(raw, targetUrl, controlPrefix) { return lowLevelFetchURL(raw, targetUrl, controlPrefix); }, rewriteSrcset(raw, targetUrl, controlPrefix) { return lowLevelSrcset(raw, targetUrl, controlPrefix); }, rewriteTargetURL(raw, targetUrl, controlPrefix) { return lowLevelTargetURL(raw, targetUrl, controlPrefix); }, classifyLinkRel(rel) { return lowLevelLinkRel(rel); }, classifyBlockedElement(tag) { return lowLevelBlockedElement(tag); }, classifyMetaPolicy(httpEquiv) { return lowLevelMetaPolicy(httpEquiv); }, classifyAttrPolicy(tag, key) { return lowLevelAttrPolicy(tag, key); }, classifyScriptType(scriptType) { return lowLevelScriptType(scriptType); }, classifyEventHandlerAttr(attrName) { return lowLevelEventHandlerAttr(attrName); }, rewriteCSS(source, baseUrl, controlPrefix) { return lowLevelCSS(source, baseUrl, controlPrefix); }, rewriteImportMap(source, baseUrl, tabId, runtimeToken, controlPrefix) { return { ok: true, code: lowLevelImportMap(source, baseUrl, tabId, runtimeToken, controlPrefix), error: '' }; }, rewriteHTMLDocument(source, targetUrl, controlPrefix, servers, runtimePrelude, tabId, runtimeToken) { return lowLevelHTMLDocument(source, targetUrl, controlPrefix, servers, runtimePrelude, tabId, runtimeToken); }, makeShareURL(target, servers) { return lowLevelShareURL(target, servers); }, rewriteFunctionBody: rewriteFunctionBodyRaw });`,
    `const rewriterApi = Object.freeze({ VERSION, get ready() { return initialized; }, init, initSync, rewriteScript: rewriteScriptPublic, rewriteScriptURL: rewriteScriptURLPublic, rewriteFetchURL: rewriteFetchURLPublic, rewriteSrcset: rewriteSrcsetPublic, rewriteTargetURL: rewriteTargetURLPublic, classifyLinkRel: classifyLinkRelPublic, classifyBlockedElement: classifyBlockedElementPublic, classifyMetaPolicy: classifyMetaPolicyPublic, classifyAttrPolicy: classifyAttrPolicyPublic, classifyScriptType: classifyScriptTypePublic, classifyEventHandlerAttr: classifyEventHandlerAttrPublic, rewriteCSS: rewriteCSSPublic, rewriteImportMap: rewriteImportMapPublic, rewriteHTMLDocument: rewriteHTMLDocumentPublic, makeShareURL: makeShareURLPublic, rewriteFunctionBody: rewriteFunctionBodyPublic, blockSource() { return BLOCK_CODE; } });`,
    `function defineHiddenAPI(name, value) { const d = Object.getOwnPropertyDescriptor(globalThis, name); if (d && d.configurable === false) return d.value; Object.defineProperty(globalThis, name, { value, enumerable: false, configurable: false, writable: false }); return value; }`,
    `defineHiddenAPI('ZPRustRewriter', rustApi);`,
    `defineHiddenAPI('ZPRewriter', rewriterApi);`,
    `bootstrapInit();`,
    '})();',
    '',
  ].join('\n');
}

async function writeOptimizedWasm(from, to) {
  if (!hasCommand('wasm-opt')) {
    await copyFile(from, to);
    return;
  }
  run('wasm-opt', ['-Oz', from, '-o', to]);
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
  const result = spawnSync('go', ['env', name], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  if (result.status !== 0)
    throw new Error(`${cmd} ${argv.join(' ')} failed with exit code ${result.status}`);
}

function hasCommand(cmd) {
  const result = spawnSync(cmd, ['--version'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
  });
  return result.status === 0;
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
