import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { writeJSONFile } from './json-output.mjs';
import { manifestSurfaceNames, surfaceShapeSource } from './webapi-surface-shapes.mjs';

const out = process.argv[2] || 'test/fixtures/webapi/host-surface.json';
const manifest = JSON.parse(fs.readFileSync('test/fixtures/webapi/bridge-surface.json', 'utf8'));
const surfaceNames = manifestSurfaceNames(manifest);
const shapeSource = surfaceShapeSource();

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const snapshot = await page.evaluate(
    ({ names, source }) => {
      const keyName = (key) => {
        if (typeof key !== 'symbol') return key;
        const registered = Symbol.keyFor(key);
        if (registered) return `@@${registered}`;
        return `Symbol(${key.description || ''})`;
      };
      const sortedKeyNames = (keys) => keys.map(keyName).sort();
      // biome-ignore lint/security/noGlobalEval: this evaluates trusted in-repo snapshot helper source inside an about:blank probe page.
      const { snapshotSurfaceShapes } = eval(source);

      return {
        version: 2,
        environment: 'host-browser',
        globalThis: {
          ownKeys: sortedKeyNames(Reflect.ownKeys(globalThis)),
          stringNames: Object.getOwnPropertyNames(globalThis).sort(),
          symbolKeys: sortedKeyNames(Object.getOwnPropertySymbols(globalThis)),
        },
        globals: Object.getOwnPropertyNames(globalThis).sort(),
        navigator: Object.getOwnPropertyNames(Navigator.prototype).sort(),
        document: Object.getOwnPropertyNames(Document.prototype).sort(),
        element: Object.getOwnPropertyNames(Element.prototype).sort(),
        entryShapes: snapshotSurfaceShapes(names),
      };
    },
    { names: surfaceNames, source: shapeSource },
  );
  writeJSONFile(out, snapshot);
} finally {
  await browser.close();
}
