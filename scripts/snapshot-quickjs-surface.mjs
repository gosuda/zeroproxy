import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJSONFile } from './json-output.mjs';
import { manifestSurfaceNames, surfaceShapeSource } from './webapi-surface-shapes.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'test/fixtures/webapi/bridge-surface.json');
const hostSurfacePath = path.join(repoRoot, 'test/fixtures/webapi/host-surface.json');
const out = path.resolve(repoRoot, process.argv[2] || 'test/fixtures/webapi/quickjs-surface.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hostSurface = JSON.parse(fs.readFileSync(hostSurfacePath, 'utf8'));
const entries = manifest.entries.filter((entry) => entry.status !== 'out-of-scope');
const surfaceNames = manifestSurfaceNames(manifest);
const runtimeDir = ensureQuickJSRuntimeDir();

const HOST_REFLECTION_EXCLUDED_GLOBALS = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
]);
const hostWebAPIShapes = hostWebAPIReflectionShapes(hostSurface, manifest);

const snapshot = {
  version: 2,
  environment: 'quickjs-virtual',
  globals: entries.map((entry) => entry.name).sort(),
  quickjsGlobalThis: await snapshotPristineQuickJSGlobalThis(runtimeDir),
  installedGlobalThis: await snapshotInstalledQuickJSGlobalThis(runtimeDir),
  entries,
};
writeJSONFile(out, snapshot);

async function snapshotPristineQuickJSGlobalThis(runtimeDir) {
  const { runtime } = await createRuntime(runtimeDir);
  const realm = runtime.createRealm();
  try {
    return { quickjsVersion: runtime.version, ...JSON.parse(snapshotRealmGlobalThis(realm)) };
  } finally {
    realm.destroy();
  }
}

async function snapshotInstalledQuickJSGlobalThis(runtimeDir) {
  const { runtime } = await createRuntime(runtimeDir);
  const realm = runtime.createRealm();
  try {
    const [
      { VirtualEventLoop },
      { installVirtualDOM },
      { installVirtualNetworkAPIs },
      { installWebAPICore },
      { MemoryStorageAdapter, VirtualStorageManager },
    ] = await Promise.all([
      import(pathToFileURL(path.join(repoRoot, 'web/runtime/quickjs/event-loop.mjs'))),
      import(pathToFileURL(path.join(repoRoot, 'web/runtime/dom/virtual-dom.mjs'))),
      import(pathToFileURL(path.join(repoRoot, 'web/runtime/network/api.mjs'))),
      import(pathToFileURL(path.join(repoRoot, 'web/runtime/webapi/core.mjs'))),
      import(pathToFileURL(path.join(repoRoot, 'web/runtime/webapi/storage.mjs'))),
    ]);
    new VirtualEventLoop(realm, { href: 'https://target.example/app/page.html' });
    installVirtualDOM({
      realm,
      href: 'https://target.example/app/page.html',
      records: [
        { v: 1, type: 'node.create', docId: 'doc-surface', seq: 1, nodeId: 'n-html', tag: 'html' },
        {
          v: 1,
          type: 'node.create',
          docId: 'doc-surface',
          seq: 2,
          nodeId: 'n-body',
          parentNodeId: 'n-html',
          tag: 'body',
        },
      ],
    });
    installVirtualNetworkAPIs({
      realm,
      documentUrl: 'https://target.example/app/page.html',
      backend: {
        async fetchRaw(record) {
          return [
            {
              v: 1,
              type: 'fetch.response.start',
              requestId: record.url,
              url: record.url,
              finalUrl: record.url,
              status: 204,
              statusText: 'No Content',
              headers: [],
            },
            { v: 1, type: 'fetch.response.end', requestId: record.url, bytesRead: 0 },
          ];
        },
        async openWebSocket(record) {
          return { wsId: record.wsId, selectedProtocol: '' };
        },
      },
    });
    const storageManager = new VirtualStorageManager({ adapter: new MemoryStorageAdapter() });
    const storagePartition = storageManager.partitionFor('https://target.example/app/page.html', {
      tabId: 'surface',
    });
    const storageSnapshot = await storageManager.loadSnapshot(storagePartition);
    installWebAPICore({
      realm,
      config: {
        userAgent: 'SurfaceSnapshot/1',
        platform: 'QuickJS',
        hostWebAPIShapes,
      },
      storage: {
        manager: storageManager,
        partitionKey: storagePartition,
        snapshot: storageSnapshot,
      },
    });
    return { quickjsVersion: runtime.version, ...JSON.parse(snapshotRealmGlobalThis(realm)) };
  } finally {
    realm.destroy();
  }
}

async function createRuntime(runtimeDir) {
  const engine = await import(pathToFileURL(path.join(repoRoot, 'web/runtime/quickjs/engine.mjs')));
  const factory = (await import(pathToFileURL(path.join(runtimeDir, 'quickjs-runtime.mjs'))))
    .default;
  const runtime = await engine.createQuickJSRuntime({
    moduleFactory: factory,
    wasmURL: path.join(runtimeDir, 'quickjs-runtime.wasm'),
  });
  return { runtime };
}

function snapshotRealmGlobalThis(realm) {
  return realm.evalClassic(
    `JSON.stringify((() => {
      const keyName = (key) => {
        if (typeof key !== 'symbol') return key;
        const registered = Symbol.keyFor(key);
        if (registered) return '@@' + registered;
        return 'Symbol(' + (key.description || '') + ')';
      };
      const sortedKeyNames = (keys) => keys.map(keyName).sort();
      const { snapshotSurfaceShapes } = ${surfaceShapeSource()};
      return {
        ownKeys: sortedKeyNames(Reflect.ownKeys(globalThis)),
        stringNames: Object.getOwnPropertyNames(globalThis).sort(),
        symbolKeys: sortedKeyNames(Object.getOwnPropertySymbols(globalThis)),
        entryShapes: snapshotSurfaceShapes(${JSON.stringify(surfaceNames)}),
      };
    })())`,
    '<quickjs-global-surface>',
  );
}

function hostWebAPIReflectionShapes(surface, manifest) {
  const names = manifestSurfaceNames(manifest);
  const out = {};
  for (const name of names) {
    if (HOST_REFLECTION_EXCLUDED_GLOBALS.has(name)) continue;
    const entryShape = surface.entryShapes?.[name];
    if (entryShape?.type !== 'function') continue;
    const shape = {
      globalDescriptor: reflectionDescriptor(entryShape.globalDescriptor),
      constructorDescriptor: entryShape.constructor,
    };
    const toStringTagDescriptor = entryShape.prototypeDescriptors?.['Symbol(Symbol.toStringTag)'];
    if (toStringTagDescriptor) {
      shape.prototypeToStringTag = reflectionDescriptor(toStringTagDescriptor);
    }
    out[name] = shape;
  }
  return out;
}

function reflectionDescriptor(descriptor) {
  if (!descriptor) return null;
  const out = {
    configurable: Boolean(descriptor.configurable),
    enumerable: Boolean(descriptor.enumerable),
  };
  if (Object.hasOwn(descriptor, 'writable')) out.writable = Boolean(descriptor.writable);
  if (descriptor.value?.type === 'function') {
    out.value = {
      name: String(descriptor.value.name || ''),
      length: Number(descriptor.value.length || 0),
    };
  } else if (descriptor.value && Object.hasOwn(descriptor.value, 'value')) {
    out.value = descriptor.value.value;
  }
  return out;
}

function ensureQuickJSRuntimeDir() {
  const configured = process.env.ZP_QUICKJS_RUNTIME_DIR;
  if (configured) return resolveRuntimeDir(configured);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-quickjs-surface-'));
  const result = spawnSync(process.execPath, ['scripts/build.mjs', '--web-only', '--out', outDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `node scripts/build.mjs --web-only --out ${outDir} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return path.join(outDir, 'web');
}

function resolveRuntimeDir(configured) {
  const absolute = path.resolve(repoRoot, configured);
  if (hasRuntime(absolute)) return absolute;
  const webDir = path.join(absolute, 'web');
  if (hasRuntime(webDir)) return webDir;
  throw new Error(`QuickJS runtime not found in ${configured}`);
}

function hasRuntime(dir) {
  return (
    fs.existsSync(path.join(dir, 'quickjs-runtime.mjs')) &&
    fs.existsSync(path.join(dir, 'quickjs-runtime.wasm'))
  );
}
