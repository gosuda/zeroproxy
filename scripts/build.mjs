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
const emccBinPath = process.env.EMCC || 'emcc';
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

  run('node', [path.join(repoRoot, 'scripts', 'build-webapi-core.mjs')]);

  const goWasmExec = await readGoWasmExec();
  await makeQuickJSRuntime();
  await copyFile(path.join(webSrc, 'index.html'), path.join(webOut, 'index.html'));
  await copyOptional(path.join(webSrc, 'favicon.ico'), path.join(webOut, 'favicon.ico'));
  await copyOptional(
    path.join(webSrc, 'manifest.webmanifest'),
    path.join(webOut, 'manifest.webmanifest'),
  );

  await writeClassicAsset('zp-core.js', await readSource('zp-core.js'));
  await writeViteBundle('host-shell.js', { inputFileName: 'host-shell-entry.mjs' });
  await writeViteBundle('runtime-prelude.js', { inputFileName: 'runtime-prelude-entry.mjs' });
  await writeClassicAsset('wasm_exec.js', goWasmExec);
  await writeViteBundle('worker-prelude.js', { inputFileName: 'worker-prelude-entry.mjs' });
  await writeClassicAsset('network-worker.js', await readSource('network-worker.js'));
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

async function makeQuickJSRuntime() {
  if (!hasCommand(emccBinPath)) throw new Error('emcc is required to build QuickJS-NG from source');
  const sourceDir = path.join(repoRoot, 'third_party', 'quickjs-ng');
  const bridgeSource = path.join(repoRoot, 'quickjs-runtime', 'bridge.c');
  const buildDir = path.join(outRoot, '.quickjs-runtime');
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  const jsOut = path.join(buildDir, 'quickjs-runtime.mjs');
  run(emccBinPath, [
    '-O2',
    '-std=c11',
    `-I${sourceDir}`,
    '-D_GNU_SOURCE',
    '-DQUICKJS_NG_BUILD',
    bridgeSource,
    path.join(sourceDir, 'quickjs.c'),
    path.join(sourceDir, 'libregexp.c'),
    path.join(sourceDir, 'libunicode.c'),
    path.join(sourceDir, 'dtoa.c'),
    '-o',
    jsOut,
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createZeroProxyQuickJSModule',
    '-sENVIRONMENT=web,worker,node',
    '-sNO_EXIT_RUNTIME=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sSTACK_SIZE=8388608',
    '-sTEXTDECODER=1',
    '-sEXPORTED_FUNCTIONS=_malloc,_free,_zp_qjs_version,_zp_qjs_create_realm,_zp_qjs_destroy_realm,_zp_qjs_eval,_zp_qjs_get_prop,_zp_qjs_call_function,_zp_qjs_define_host_function,_zp_qjs_drain_jobs,_zp_qjs_release_handle,_zp_qjs_handle_refcount',
    '-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToNewUTF8,stringToUTF8,lengthBytesUTF8',
  ]);
  await copyFile(jsOut, path.join(webOut, 'quickjs-runtime.mjs'));
  await copyFile(
    path.join(buildDir, 'quickjs-runtime.wasm'),
    path.join(webOut, 'quickjs-runtime.wasm'),
  );
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
