const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { loadRuntime } = require('./quickjs-test-helpers');
const { makeHostMarkupParser } = require('./host-markup-parser-helper');

const HOST_MARKUP_CORPUS = {
  documents: ['<section>parsed</section>'],
};

const root = path.resolve(__dirname, '../..');
const urls = {
  dom: pathToFileURL(path.join(root, 'web/runtime/dom/virtual-dom.mjs')).href,
  network: pathToFileURL(path.join(root, 'web/runtime/network/api.mjs')).href,
  core: pathToFileURL(path.join(root, 'web/runtime/webapi/core.mjs')).href,
  eventLoop: pathToFileURL(path.join(root, 'web/runtime/quickjs/event-loop.mjs')).href,
};

async function installAcidRealm() {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const [
    { installVirtualDOM },
    { installVirtualNetworkAPIs },
    { installWebAPICore },
    { VirtualEventLoop },
  ] = await Promise.all([
    import(urls.dom),
    import(urls.network),
    import(urls.core),
    import(urls.eventLoop),
  ]);
  const eventLoop = new VirtualEventLoop(realm, { now: 0 });
  installVirtualDOM({
    realm,
    href: 'https://target.example/acid.html',
    viewport: {
      innerWidth: 640,
      innerHeight: 480,
      layout: { 'n-root': { x: 0, y: 0, width: 320, height: 200 } },
    },
    records: [
      { v: 1, type: 'node.create', docId: 'acid', seq: 1, nodeId: 'n-html', tag: 'html' },
      {
        v: 1,
        type: 'node.create',
        docId: 'acid',
        seq: 2,
        nodeId: 'n-body',
        parentNodeId: 'n-html',
        tag: 'body',
      },
      {
        v: 1,
        type: 'node.create',
        docId: 'acid',
        seq: 3,
        nodeId: 'n-root',
        parentNodeId: 'n-body',
        tag: 'div',
      },
      {
        v: 1,
        type: 'node.attr',
        docId: 'acid',
        seq: 4,
        nodeId: 'n-root',
        name: 'id',
        value: 'root',
      },
    ],
  });
  installVirtualNetworkAPIs({
    realm,
    documentUrl: 'https://target.example/acid.html',
    backend: {
      async fetchRaw() {
        throw new Error('network unused');
      },
      async openWebSocket() {
        return {};
      },
    },
  });
  const hostMarkupParser = await makeHostMarkupParser(HOST_MARKUP_CORPUS);
  installWebAPICore({ realm, hostMarkupParser });
  return { realm, eventLoop };
}

test('acid fixture manifest and harness report target score with mapped gaps', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(path.join(root, 'test/fixtures/acid/acid-fixtures.json'), 'utf8'),
  );
  assert.equal(fixtures.fixtures.length, fixtures.targetScore);
  const result = childProcess.spawnSync('node', ['scripts/acid-harness.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'test/fixtures/acid/acid-report.json'), 'utf8'),
  );
  assert.equal(report.score, report.targetScore);
  assert.deepEqual(report.failures, []);
  assert.equal(report.screenshot.status, 'passed');
});

test('acid-lite DOM Range Traversal CSSOM SVG XML probes pass in QuickJS', async () => {
  const { realm } = await installAcidRealm();
  const result = realm.evalClassic(`
    const root = document.getElementById('root');
    root.classList.add('acid');
    root.dataset.score = '4';
    root.style.setProperty('width', '320px');
    const table = document.createElement('table');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.textContent = 'cell';
    row.appendChild(cell);
    table.appendChild(row);
    root.appendChild(table);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#icon');
    root.appendChild(svg);
    const range = document.createRange();
    range.setStart(root);
    getSelection().addRange(range);
    const walker = document.createTreeWalker(document.body);
    const walked = [];
    for (let node = walker.nextNode(); node && walked.length < 4; node = walker.nextNode()) walked.push(node.localName || node.nodeName);
    const xml = new XMLSerializer().serializeToString(root);
    const parsed = new DOMParser().parseFromString('<section>parsed</section>', 'text/html');
    JSON.stringify({
      className: root.className,
      dataset: root.dataset.score,
      computedWidth: getComputedStyle(root).getPropertyValue('width'),
      rectWidth: root.getBoundingClientRect().width,
      tableText: table.textContent,
      svgNS: svg.namespaceURI,
      svgHref: svg.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
      selection: getSelection().rangeCount,
      walked,
      xmlHasSVG: xml.includes('<svg'),
      parsedText: parsed.body.textContent,
    });
  `);
  assert.deepEqual(JSON.parse(result), {
    className: 'acid',
    dataset: '4',
    computedWidth: '320px',
    rectWidth: 320,
    tableText: 'cell',
    svgNS: 'http://www.w3.org/2000/svg',
    svgHref: '#icon',
    selection: 1,
    walked: ['div', 'table', 'tr', 'td'],
    xmlHasSVG: true,
    parsedText: 'parsed',
  });
  realm.destroy();
});

test('acid-lite event loop ordering and screenshot hash are deterministic', async () => {
  const { realm, eventLoop } = await installAcidRealm();
  realm.evalClassic(`
    globalThis.acidOrder = [];
    queueMicrotask(() => acidOrder.push('microtask'));
    setTimeout(() => acidOrder.push('timer'), 0);
    requestAnimationFrame(() => acidOrder.push('raf'));
  `);
  eventLoop.tick(16);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(acidOrder)')), [
    'timer',
    'microtask',
    'raf',
  ]);
  const visual = realm.evalClassic(`new XMLSerializer().serializeToString(document.body)`);
  const hash = crypto.createHash('sha256').update(visual).digest('hex').slice(0, 16);
  assert.equal(hash, crypto.createHash('sha256').update(visual).digest('hex').slice(0, 16));
  realm.destroy();
});

test('acid-blocking Web API gaps are explicitly absent from current report', () => {
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'test/fixtures/webapi/webapi-gap-report.json'), 'utf8'),
  );
  const acidBlocking = [...report.missingOrPartial, ...report.blocked].filter(
    (entry) => entry.acidBlocking === true,
  );
  assert.deepEqual(acidBlocking, []);
});
