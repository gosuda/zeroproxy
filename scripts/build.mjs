#!/usr/bin/env node
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Declare all build path constants before top-level await to avoid temporal dead zones.
let buildId = '';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(repoRoot, args.out || 'dist');
const webSrc = path.join(repoRoot, 'web');
const esmSrc = path.join(repoRoot, 'esm');
const membraneDir = path.join(webSrc, 'membrane');
const webOut = path.join(outRoot, 'web');
const esmOut = path.join(outRoot, 'esm');
const esmWbgOut = path.join(esmOut, 'wbg');
const esmWasmOut = path.join(esmOut, 'wasm');
const serverOut = path.join(outRoot, process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server');
const wasmManifestOut = path.join(outRoot, 'wasm-manifest.json');
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
// Remap host-specific workspace and registry paths so WASM binaries are reproducible and compact.
const remapRustFlags = [
  `--remap-path-prefix=${repoRoot}=/src`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
].join(' ');
// Default to a small local footprint; explicit caller limits still win.
const buildEnv = {
  ...process.env,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2',
  BINARYEN_CORES: process.env.BINARYEN_CORES || '2',
  GOFLAGS: process.env.GOFLAGS ?? '-p=2',
  RUSTFLAGS: [process.env.RUSTFLAGS, remapRustFlags].filter(Boolean).join(' '),
};
// Minify by default to match the shipped client artifact; pass --no-minify for readable debug output.
const minify = args.noMinify !== true;
const strictWasmOpt = args.strictWasmOpt === true;
const zpBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_bundle.wasm');
const zpKernelBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_kernel_bundle.wasm');
const zpPageBundleWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_bundle.wasm');
const zpPageRtWasm = path.join(repoRoot, 'target', 'wasm32-unknown-unknown', 'release', 'zp_page_rt.wasm');
// Served at /zp/Asset/<name> (see internal/httphost wasmAssets).
const zpBundleOutDir = path.join(webOut, 'Asset');
const WASM_OPT_FLAGS = [
  '--low-memory-unused',
  '--enable-bulk-memory',
  '--enable-bulk-memory-opt',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
  '--enable-multivalue',
  '--enable-reference-types',
];

if (args.help) {
  process.stdout.write(`Usage: node scripts/build.mjs [options]\n\nOptions:\n  --out <dir>         Output directory (default: dist)\n  --pkg-only          Build Rust WASM, browser assets, and ESM SDK (skip Go server)\n  --esm-only          Build only the ESM SDK from existing compiled WASM\n  --web-only          Build only browser assets\n  --server-only       Build only the relay server\n  --rust-only         Build only the Rust WASM bundle\n  --skip-esm          Do not build the ESM SDK\n  --skip-web          Do not build browser assets\n  --skip-server       Do not build the relay server\n  --skip-rust         Do not build the Rust WASM bundle\n  --strict-wasm-opt   Fail build if wasm-opt is unavailable or fails\n  --minify            Minify bundled JavaScript (default)\n  --no-minify         Emit readable bundled JavaScript (debug)\n  --no-clean          Keep existing output files not overwritten by this run\n`);
  process.exit(0);
}

const selected = selectedTargets(args);
const wasmOptBin = await resolveWasmOpt();

if (!args.noClean) await cleanSelectedOutputs(selected);
await mkdir(outRoot, { recursive: true });

if (selected.rust) await buildRustBundle();
if (selected.web) await buildWeb();
if (selected.esm) await buildEsm();
if (selected.rust || selected.web || selected.esm) await writeWasmManifest();
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
      case '--pkg-only':
      case '--esm-only':
      case '--web-only':
      case '--server-only':
      case '--rust-only':
      case '--skip-esm':
      case '--skip-web':
      case '--skip-server':
      case '--skip-rust':
      case '--strict-wasm-opt':
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
  let esm = true;
  let server = true;
  let rust = true;
  if (parsed.pkgOnly) {
    web = true;
    esm = true;
    rust = true;
    server = false;
  } else if (parsed.webOnly || parsed.esmOnly || parsed.serverOnly || parsed.rustOnly) {
    web = parsed.webOnly === true;
    esm = parsed.esmOnly === true;
    server = parsed.serverOnly === true;
    rust = parsed.rustOnly === true;
  }
  if (parsed.skipWeb) web = false;
  if (parsed.skipEsm) esm = false;
  if (parsed.skipServer) server = false;
  if (parsed.skipRust) rust = false;
  if (!web && !esm && !server && !rust) throw new Error('no build targets selected');
  return { web, esm, server, rust };
}

async function cleanSelectedOutputs(selected) {
  // Preserve dist/web/Asset/ when skipping the Rust build so existing wasm-bindgen outputs remain usable.
  async function rmWebPreserveZp() {
    if (!selected.rust) {
      const entries = await readdir(webOut, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries
        .filter(d => d.name !== 'Asset')
        .map(d => rm(path.join(webOut, d.name), { recursive: true, force: true })));
    } else {
      await rm(webOut, { recursive: true, force: true });
    }
  }
  async function rmEsmPreserveWasm() {
    if (!selected.rust) {
      const entries = await readdir(esmOut, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries
        .filter(d => d.name !== 'wasm' && d.name !== 'wbg')
        .map(d => rm(path.join(esmOut, d.name), { recursive: true, force: true })));
    } else {
      await rm(esmOut, { recursive: true, force: true });
    }
  }
  if (selected.web && selected.esm && selected.server && selected.rust) {
    await rm(outRoot, { recursive: true, force: true });
    return;
  }
  const removals = [];
  if (selected.web) removals.push(rmWebPreserveZp());
  if (selected.esm) removals.push(rmEsmPreserveWasm());
  if (selected.server) removals.push(rm(serverOut, { force: true }));
  await Promise.all(removals);
}

async function resolveWasmOpt() {
  const localName = process.platform === 'win32' ? 'wasm-opt.cmd' : 'wasm-opt';
  const localBin = path.join(repoRoot, 'node_modules', '.bin', localName);
  if (await exists(localBin)) return localBin;
  return 'wasm-opt';
}

function optimizeWasm(wasmPath) {
  const argsList = ['-Oz', ...WASM_OPT_FLAGS, wasmPath, '-o', wasmPath];
  if (strictWasmOpt) {
    run(wasmOptBin, argsList);
    return true;
  }
  return tryRunOptional(wasmOptBin, argsList);
}

async function buildWeb() {
  await mkdir(webOut, { recursive: true });
  // Compute buildId after buildRustBundle() so WASM artifacts in dist/web/Asset/ are included in the hash.
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
  // zp-page-bundle contains only the page-realm JS rewriter (zp-rewriter) and shared URL primitives; HTML, CSS, and source map logic live in zp-bundle.
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-bundle']);
  // zp-page-rt is a raw extern "C" cdylib instantiated directly by web/zp-rt.js without wasm-bindgen glue.
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'zp-page-rt']);
  await mkdir(zpBundleOutDir, { recursive: true });
  // Wrap no-modules wasm-bindgen glue in an IIFE so top-level let wasm_bindgen stays function-scoped.
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp-bundle',
    zpBundleWasm,
  ]);
  const swJsPath = path.join(zpBundleOutDir, 'zp-bundle.js');
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
    '--out-name', 'zp-kernel',
    zpKernelBundleWasm,
  ]);
  const kernelJsPath = path.join(zpBundleOutDir, 'zp-kernel.js');
  const kernelGlue = await readFile(kernelJsPath, 'utf8');
  if (!kernelGlue.startsWith('(function(){')) {
    await writeFile(
      kernelJsPath,
      '(function(){\n' + kernelGlue + '\n;try{ self.ZPKernelWBG = wasm_bindgen; }catch(_e){};\n})();\n',
    );
  }
  // Expose the page bundle factory under self.ZPPageBundleWBG for synchronous page bootstrap.
  run('wasm-bindgen', [
    '--target', 'no-modules',
    '--out-dir', zpBundleOutDir,
    '--out-name', 'zp-page-bundle-wbg',
    zpPageBundleWasm,
  ]);
  const pageBundleJsPath = path.join(zpBundleOutDir, 'zp-page-bundle-wbg.js');
  const pageBundleGlue = await readFile(pageBundleJsPath, 'utf8');
  if (!pageBundleGlue.startsWith('(function(){')) {
    await writeFile(
      pageBundleJsPath,
      '(function(){\n' + pageBundleGlue + '\n;try{ self.ZPPageBundleWBG = wasm_bindgen; }catch(_e){};\n})();\n',
    );
  }
  // wasm-bindgen names the module `<name>_bg.wasm`; the served names drop the suffix. The typings describe that
  // suffixed name and nothing consumes them at runtime.
  for (const name of ['zp-bundle', 'zp-kernel', 'zp-page-bundle-wbg']) {
    await rename(path.join(zpBundleOutDir, `${name}_bg.wasm`), path.join(zpBundleOutDir, `${name}.wasm`));
    await rm(path.join(zpBundleOutDir, `${name}.d.ts`), { force: true });
    await rm(path.join(zpBundleOutDir, `${name}_bg.wasm.d.ts`), { force: true });
  }
  const swWasm = path.join(zpBundleOutDir, 'zp-bundle.wasm');
  const kernelWasm = path.join(zpBundleOutDir, 'zp-kernel.wasm');
  const pageBundleWasm = path.join(zpBundleOutDir, 'zp-page-bundle-wbg.wasm');
  const optimizedSw = optimizeWasm(swWasm);
  if (!optimizedSw) {
    process.stderr.write('wasm-opt not found; skipping size optimization (install binaryen to enable)\n');
  } else {
    optimizeWasm(kernelWasm);
    optimizeWasm(pageBundleWasm);
  }
  const pageRtDst = path.join(zpBundleOutDir, 'zp-rt.wasm');
  await copyFile(zpPageRtWasm, pageRtDst);
  if (optimizedSw) optimizeWasm(pageRtDst);
}

async function buildEsm() {
  await mkdir(esmOut, { recursive: true });
  await mkdir(esmWbgOut, { recursive: true });
  await mkdir(esmWasmOut, { recursive: true });

  if (!buildId) await computeBuildId();

  const needWbgBuild = selected.rust || !(await exists(path.join(esmWasmOut, 'zp-bundle.wasm')));
  if (needWbgBuild) {
    const targets = [
      { outName: 'zp-bundle', srcWasm: zpBundleWasm },
      { outName: 'zp-kernel', srcWasm: zpKernelBundleWasm },
      { outName: 'zp-page-bundle', srcWasm: zpPageBundleWasm },
    ];
    for (const { outName, srcWasm } of targets) {
      if (!(await exists(srcWasm))) {
        throw new Error(`Missing compiled WASM binary ${srcWasm}; run without --esm-only or run npm run wasm:pull first`);
      }
      run('wasm-bindgen', [
        '--target', 'web',
        '--out-dir', esmWbgOut,
        '--out-name', outName,
        srcWasm,
      ]);
      const bgWasm = path.join(esmWbgOut, `${outName}_bg.wasm`);
      const finalWasm = path.join(esmWasmOut, `${outName}.wasm`);
      const preOptWebWasm = path.join(zpBundleOutDir, `${outName}.wasm`);
      // wasm-bindgen --target web and --target no-modules emit byte-identical `.wasm` when --out-name matches.
      if (await exists(preOptWebWasm)) {
        await rm(bgWasm, { force: true });
        await copyFile(preOptWebWasm, finalWasm);
      } else {
        await rename(bgWasm, finalWasm);
        optimizeWasm(finalWasm);
      }
      await rm(path.join(esmWbgOut, `${outName}.d.ts`), { force: true });
      await rm(path.join(esmWbgOut, `${outName}_bg.wasm.d.ts`), { force: true });

      // Point the generated fallback URL at ../wasm/<outName>.wasm and transform through esbuild.
      const wbgJsPath = path.join(esmWbgOut, `${outName}.js`);
      const rawGlue = (await readFile(wbgJsPath, 'utf8'))
        .split(`'${outName}_bg.wasm'`).join(`'../wasm/${outName}.wasm'`)
        .split(`"${outName}_bg.wasm"`).join(`"../wasm/${outName}.wasm"`);
      await writeEsmModule(wbgJsPath, rawGlue);
    }

    const rtDst = path.join(esmWasmOut, 'zp-rt.wasm');
    const preOptRt = path.join(zpBundleOutDir, 'zp-rt.wasm');
    if (await exists(preOptRt)) {
      await copyFile(preOptRt, rtDst);
    } else if (await exists(zpPageRtWasm)) {
      await copyFile(zpPageRtWasm, rtDst);
      optimizeWasm(rtDst);
    } else {
      throw new Error(`Missing zp-rt WASM binary (${zpPageRtWasm})`);
    }
  }

  await writeEsmModule(path.join(esmOut, '_core.js'), makePureCoreEsm(await readSource('zp-core.js'), buildId));
  await writeEsmModule(path.join(esmOut, '_rt.js'), makePureRtEsm(await readSource('zp-rt.js')));

  const esmEntries = (await readdir(esmSrc)).sort();
  for (const name of esmEntries) {
    const srcPath = path.join(esmSrc, name);
    const dstPath = path.join(esmOut, name);
    if (name.endsWith('.d.ts')) {
      await copyFile(srcPath, dstPath);
    } else if (name.endsWith('.js')) {
      await writeEsmModule(dstPath, await readFile(srcPath, 'utf8'));
    }
  }

  await writeEsmModule(path.join(esmOut, 'rewriter-inline.js'), await makeRewriterInlineEsm());
}

function makePureCoreEsm(rawSource, currentBuildId) {
  const normalized = rawSource.split('\r\n').join('\n').split('__ZP_BUILD_ID__').join(currentBuildId);
  const headAnchor = "(() => {\n  'use strict';\n  if (globalThis.ZP) return;\n";
  const tailAnchor = "  Object.defineProperty(globalThis, 'ZP', { value: publicApi, enumerable: false, configurable: true, writable: false });\n  Object.defineProperty(globalThis, '__zp_internal', { value: internal, enumerable: false, configurable: true, writable: false });\n})();";
  const headIdx = normalized.indexOf(headAnchor);
  const tailIdx = normalized.lastIndexOf(tailAnchor);
  if (headIdx < 0 || tailIdx <= headIdx) {
    throw new Error('web/zp-core.js IIFE wrapper anchors changed; update makePureCoreEsm in scripts/build.mjs');
  }
  const body = normalized.slice(headIdx + headAnchor.length, tailIdx);
  return `${body}\nexport { publicApi as ZP, internal };\n`;
}

function makePureRtEsm(rawSource) {
  const normalized = rawSource.split('\r\n').join('\n');
  const headAnchor = "(() => {\n  'use strict';\n  if (globalThis.ZeroProxyRT) return;\n";
  const tailRe = /\s*Object\.defineProperty\(globalThis,\s*'ZeroProxyRT',[\s\S]*?\);\n\}\)\(\);\s*$/;
  const headIdx = normalized.indexOf(headAnchor);
  if (headIdx < 0 || !tailRe.test(normalized)) {
    throw new Error('web/zp-rt.js IIFE wrapper anchors changed; update makePureRtEsm in scripts/build.mjs');
  }
  const body = normalized.slice(headIdx + headAnchor.length).replace(tailRe, '');
  return `${body}\nexport { load, loadSync, UrlClass, api as ZeroProxyRT };\n`;
}

async function makeRewriterInlineEsm() {
  const wasmBytes = await readFile(path.join(esmWasmOut, 'zp-page-bundle.wasm'));
  const b64 = wasmBytes.toString('base64');
  return `import { bindRewriterLoaders, SCRIPT_KINDS } from './rewriter.shared.js';

const INLINE_WASM_B64 = ${JSON.stringify(b64)};
let cachedModule = null;

function decodeInlineModule() {
  if (!cachedModule) {
    let bytes;
    if (typeof Uint8Array.fromBase64 === 'function') {
      bytes = Uint8Array.fromBase64(INLINE_WASM_B64);
    } else if (typeof atob === 'function') {
      const bin = atob(INLINE_WASM_B64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(Buffer.from(INLINE_WASM_B64, 'base64'));
    }
    cachedModule = new WebAssembly.Module(bytes);
  }
  return cachedModule;
}

const { createRewriter, createRewriterSync } = bindRewriterLoaders(
  async () => decodeInlineModule(),
  () => decodeInlineModule(),
);

export { createRewriter, createRewriterSync, SCRIPT_KINDS };
`;
}

async function writeEsmModule(outPath, source) {
  const result = await esbuild.transform(source, {
    charset: 'utf8',
    format: 'esm',
    legalComments: 'none',
    loader: 'js',
    minify,
    target: 'es2022',
  });
  await writeFile(outPath, result.code);
}

async function writeWasmManifest() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const cargoToml = await readFile(path.join(repoRoot, 'Cargo.toml'), 'utf8');
  const wsVerMatch = /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/.exec(cargoToml);
  const transformerVersion = wsVerMatch ? wsVerMatch[1] : pkg.version;
  const wasmBindgenVersion = await readLockedCrateVersion('wasm-bindgen');

  const candidateDirs = [esmWasmOut, zpBundleOutDir];
  const artifacts = [];
  for (const dir of candidateDirs) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter(n => n.endsWith('.wasm')).sort()) {
      const fullPath = path.join(dir, name);
      const buf = await readFile(fullPath);
      const relPath = path.relative(outRoot, fullPath).split(path.sep).join('/');
      const sha256 = createHash('sha256').update(buf).digest('hex');
      artifacts.push({
        path: relPath,
        bytes: buf.byteLength,
        sha256,
      });
    }
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (!buildId) await computeBuildId();
  const manifest = {
    schemaVersion: 1,
    packageVersion: pkg.version,
    transformerVersion,
    wasmBindgenVersion,
    buildId,
    artifacts,
  };
  await writeFile(wasmManifestOut, JSON.stringify(manifest, null, 2) + '\n');
}

async function readLockedCrateVersion(crateName) {
  const lockText = await readFile(path.join(repoRoot, 'Cargo.lock'), 'utf8');
  const re = new RegExp(`\\[\\[package\\]\\]\\s*\\nname\\s*=\\s*"${crateName}"\\s*\\nversion\\s*=\\s*"([^"]+)"`);
  const m = re.exec(lockText);
  return m ? m[1] : 'unknown';
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
  const dir = (await exists(zpBundleOutDir)) ? zpBundleOutDir : esmWasmOut;
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
  return source.replace(/^importScripts\('\/zp\/Asset\/zp-core\.js'\);\r?\n/gm, '');
}

function stripWorkerPreludeImports(source) {
  return source.replace(/^\s*importScripts\('\/zp\/Asset\/zp-core\.js'\);\r?\n/m, '');
}

// Build the classic-script page bundle wrapper from zp-page-bundle (the JS rewriter only).
async function makeZPBundlePageClassic() {
  const glueJs = await readFile(path.join(zpBundleOutDir, 'zp-page-bundle-wbg.js'), 'utf8');
  const wasmBytes = await readFile(path.join(zpBundleOutDir, 'zp-page-bundle-wbg.wasm'));
  const wasmBase64 = wasmBytes.toString('base64');
  return `/* Generated from Rust WASM ZeroProxy page bundle (rewriter + CSS only). */\n${glueJs}\n(() => {\nconst __zp_bundle_b64 = ${JSON.stringify(wasmBase64)};\nconst __zp_bundle_bytes = Uint8Array.from(atob(__zp_bundle_b64), c => c.charCodeAt(0));\nconst wbg = globalThis.ZPPageBundleWBG;\nif (typeof wbg !== 'function') throw new Error('ZP_PAGE_BUNDLE_BOOT_FAILED: ZPPageBundleWBG missing');\nwbg.initSync({ module: __zp_bundle_bytes });\nconst api = Object.freeze({\n  ready: true,\n  bundleVersion: wbg.bundleVersion,\n  rewriteScript: (source, kind, targetUrl, proxyOrigin) => wbg.rewriteScript(String(source || ''), String(kind || 'classic'), String(targetUrl || ''), String(proxyOrigin || '')),\n  rewriteCSS: typeof wbg.rewriteCSS === 'function'\n    ? (source, baseUrl, controlPrefix, proxyOrigin) => wbg.rewriteCSS(String(source || ''), String(baseUrl || ''), String(controlPrefix || '/zp/'), String(proxyOrigin || ''))\n    : null,\n});\nObject.defineProperty(globalThis, 'ZPBundle', { value: api, enumerable: false, configurable: false, writable: false });\n})();\n`;
}

function run(cmd, argv, extraEnv = {}) {
  process.stdout.write(`${cmd} ${argv.join(' ')}\n`);
  const result = spawnSync(cmd, argv, {
    cwd: repoRoot,
    env: { ...buildEnv, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
  });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed with exit code ${result.status}`);
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
