const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// The worker's top-level functions, loaded the way request-policy.test.js loads them.
function loadWorker() {
  const context = {
    crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    Headers, Request, Response, ArrayBuffer, Uint8Array, Blob,
    ReadableStream, TransformStream, performance, console, btoa, atob,
    location: new URL('https://proxy.example/zp/sw.js'),
    navigator: { languages: ['en-US'] },
    fetch: () => new Promise(() => {}),
    importScripts() {}, addEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    ZPKernel: { ready: true }, kernelFetch: async () => new Response(null, { status: 500 }),
    __ZP_REPORTING_HEADERS__: [], __ZP_TARGET_POLICY_HEADERS__: [],
    __ZP_HOP_BY_HOP_HEADERS__: ['location', 'set-cookie', 'x-zp-set-cookie'],
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('web/zp-core.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('web/sw.js', 'utf8'), context);
  return context;
}

const worker = loadWorker();
const tab = { tabId: 'tab1' };
const route = url => 'https://proxy.example/zp/api/fetch?url=' + encodeURIComponent(url) + '&tab=tab1';

test('playlist URIs — relative, absolute and attributes — become proxy routes for their absolute targets', () => {
  const base = 'https://cdn.example/video/hls/master.m3u8?token=abc';
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k?id=1&x=2",IV=0x01',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="../audio/a.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'v0/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1600000',
    '/abs/root.m3u8',
    '',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
    '',
  ].join('\n');
  const out = worker.rewritePlaylistText(text, base, tab).split('\n');
  assert.equal(out[0], '#EXTM3U');
  assert.equal(out[1], '#EXT-X-VERSION:7');
  assert.equal(out[2], `#EXT-X-MAP:URI="${route('https://cdn.example/video/hls/init.mp4')}",BYTERANGE="720@0"`);
  assert.equal(out[3], `#EXT-X-KEY:METHOD=AES-128,URI="${route('https://keys.example/k?id=1&x=2')}",IV=0x01`);
  assert.equal(out[4], `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="${route('https://cdn.example/video/audio/a.m3u8')}"`);
  assert.equal(out[6], route('https://cdn.example/video/hls/v0/index.m3u8'));
  assert.equal(out[8], route('https://cdn.example/abs/root.m3u8'));
  assert.equal(out[9], '');
  assert.equal(out[10], `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="${route('https://cdn.example/video/hls/iframe.m3u8')}"`);
});

test('playlist rewriting keeps line endings, leaves non-http URIs and comments, and drops a BOM', () => {
  const base = 'https://cdn.example/a/b.m3u8';
  const text = '﻿#EXTM3U\r\n# a comment with seg.ts in it\r\ndata:text/plain,x\r\nseg.ts\r\n';
  const out = worker.rewritePlaylistText(text, base, null);
  assert.equal(out, `#EXTM3U\r\n# a comment with seg.ts in it\r\ndata:text/plain,x\r\n${'https://proxy.example/zp/api/fetch?url=' + encodeURIComponent('https://cdn.example/a/seg.ts')}\r\n`);
});

test('a playlist is recognised by its type, or by its path when the type says nothing', () => {
  const resp = (status, type) => new Response('x', { status, headers: type ? { 'Content-Type': type } : {} });
  assert.equal(worker.isPlaylistResponse(resp(200, 'application/vnd.apple.mpegurl'), 'https://c.example/x'), true);
  assert.equal(worker.isPlaylistResponse(resp(200, 'application/x-mpegURL; charset=utf-8'), 'https://c.example/x'), true);
  assert.equal(worker.isPlaylistResponse(resp(206, 'audio/mpegurl'), 'https://c.example/x'), true);
  assert.equal(worker.isPlaylistResponse(resp(200, 'application/octet-stream'), 'https://c.example/v/index.m3u8'), true);
  assert.equal(worker.isPlaylistResponse(resp(200, ''), 'https://c.example/v/index.m3u8?t=1'), true);
  assert.equal(worker.isPlaylistResponse(resp(200, 'application/octet-stream'), 'https://c.example/v/seg.ts'), false);
  assert.equal(worker.isPlaylistResponse(resp(200, 'video/mp4'), 'https://c.example/v/movie.m3u8'), false);
  assert.equal(worker.isPlaylistResponse(resp(404, 'application/vnd.apple.mpegurl'), 'https://c.example/x.m3u8'), false);
});

test('a ranged request for a playlist is answered from the rewritten bytes', async () => {
  const body = '#EXTM3U\nseg.ts\n';
  const target = 'https://cdn.example/a/p.m3u8';
  const upstream = () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(body.length), ETag: '"x"' } });
  const rewritten = worker.rewritePlaylistText(body, target, tab);
  const total = new TextEncoder().encode(rewritten).length;
  const ask = range => new Request('https://proxy.example/zp/api/fetch?url=x', range ? { headers: { Range: range } } : {});

  const whole = await worker.rewritePlaylistResponse(ask(), upstream(), { targetUrl: target, tab });
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), rewritten);
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(whole.headers.get('Content-Type'), 'application/vnd.apple.mpegurl');
  assert.equal(whole.headers.get('ETag'), null);

  const head = await worker.rewritePlaylistResponse(ask('bytes=0-6'), upstream(), { targetUrl: target, tab });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('Content-Range'), `bytes 0-6/${total}`);
  assert.equal(await head.text(), '#EXTM3U');

  const tail = await worker.rewritePlaylistResponse(ask(`bytes=${total - 4}-`), upstream(), { targetUrl: target, tab });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), rewritten.slice(-4));

  const suffix = await worker.rewritePlaylistResponse(ask('bytes=-4'), upstream(), { targetUrl: target, tab });
  assert.equal(await suffix.text(), rewritten.slice(-4));

  const past = await worker.rewritePlaylistResponse(ask(`bytes=${total + 10}-`), upstream(), { targetUrl: target, tab });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('Content-Range'), `bytes */${total}`);
});

test('an upstream partial playlist is fetched again whole before it is rewritten', async () => {
  const body = '#EXTM3U\nseg.ts\n';
  const target = 'https://cdn.example/a/p.m3u8';
  const partial = new Response('#EXTM', { status: 206, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Range': 'bytes 0-4/15' } });
  let refetched = 0;
  const out = await worker.rewritePlaylistResponse(new Request('https://proxy.example/zp/api/fetch?url=x'), partial, {
    targetUrl: target, tab,
    refetch: async () => { refetched++; return new Response(body, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }); },
  });
  assert.equal(refetched, 1);
  assert.equal(out.status, 200);
  assert.equal(await out.text(), worker.rewritePlaylistText(body, target, tab));
});

test('a body that is not a playlist passes through unchanged', async () => {
  const resp = new Response('<html>not a playlist</html>', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  const out = await worker.rewritePlaylistResponse(new Request('https://proxy.example/zp/api/fetch?url=x'), resp, { targetUrl: 'https://cdn.example/x.m3u8', tab });
  assert.equal(await out.text(), '<html>not a playlist</html>');
});

// The transport copies the browser's own request headers — `Range: bytes=0-` among them, which is how a media element
// starts — and a CDN answers that with a 206 of the ORIGINAL bytes. A playlist is rewritten whole, so it is asked for whole.
test('the transport leaves Range off a request that asked for it not to travel, and keeps it otherwise', async () => {
  const seen = [];
  const w = loadWorker();
  w.kernelFetch = async request => { seen.push(new Headers(request.headerEntries).get('range')); return new Response('x', { status: 200 }); };
  const entry = { entryId: 'entry', targetUrl: 'https://site.example/page', baseUrl: 'https://site.example/page' };
  const t = {
    tabId: 'tab', activeEntryId: entry.entryId, entries: new Map([[entry.entryId, entry]]), servers: [],
    cookieJar: { cookieHeader: () => '', setCookieLine: () => {} },
  };
  const req = () => new Request('https://proxy.example/zp/api/fetch?url=x', { headers: { Range: 'bytes=0-', 'If-Range': '"e"' } });
  await w.transportFetch('https://cdn.example/a/index.m3u8', { tab: t, request: req(), noRange: true });
  await w.transportFetch('https://cdn.example/a/movie.mp4', { tab: t, request: req() });
  assert.deepEqual(seen, [null, 'bytes=0-']);
});
