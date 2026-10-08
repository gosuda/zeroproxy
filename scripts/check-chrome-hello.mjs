// Does the ClientHello we send still look like the installed Chrome's?   npm run check:chrome-hello
//
// A TCP listener on 127.0.0.1 records the first flight of each connection while a real Chrome (a throw-away profile, no
// automation flags) opens https://localhost:PORT/. The hello's extensions and the `trust_anchors` body are compared with what
// the SW's captured spec and the rustls fork send. Exit 0: same. Exit 1: drift (the report says what). Exit 2: no Chrome.
//
// Why bytes and not a fingerprint service: tls.peet.ws compared our hello with WebView2's and called them equal, while a real
// Chrome sends one more extension (0xca34, ERRATA 66). Compare with the browser the persona claims to be.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

function chromeVersion(exe) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8' });
    return String(r.stdout || '').trim() || '?';
  }
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  return String(r.stdout || '').trim() || '?';
}

const isGrease = t => (t & 0x0f0f) === 0x0a0a && (t >> 8) === (t & 0xff);

/** A ClientHello record → { exts: [{ type, body }] }, or null while the record is still incomplete. */
function parseHello(buf) {
  if (buf.length < 5 || buf[0] !== 0x16) return null;
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen || buf[5] !== 0x01) return null;
  let p = 5 + 4 + 2 + 32;
  p += 1 + buf[p];
  p += 2 + buf.readUInt16BE(p);
  p += 1 + buf[p];
  const end = p + 2 + buf.readUInt16BE(p);
  p += 2;
  const exts = [];
  while (p + 4 <= end) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    exts.push({ type, body: buf.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return { exts };
}

/** What the repo sends: the SW's spec extensions and the fork's trust_anchors body. */
function repoHello() {
  const sw = fs.readFileSync(path.join(root, 'web/sw.js'), 'utf8');
  const b64 = /const CAPTURED_FINGERPRINT_B64 = '([^']+)'/.exec(sw)?.[1];
  if (!b64) throw new Error('web/sw.js no longer carries CAPTURED_FINGERPRINT_B64');
  const spec = JSON.parse(Buffer.from(b64, 'base64').toString());
  const rs = fs.readFileSync(path.join(root, 'third_party-rustls-fork/src/ja3.rs'), 'utf8');
  const block = /CHROME_TRUST_ANCHORS: \[u8; \d+\] = \[([^\]]*)\]/.exec(rs)?.[1];
  if (!block) throw new Error('ja3.rs no longer carries CHROME_TRUST_ANCHORS');
  const anchors = Buffer.from([...block.matchAll(/0x([0-9a-fA-F]{2})/g)].map(m => parseInt(m[1], 16)));
  return { exts: [...spec.extensions].sort((a, b) => a - b), anchors };
}

async function captureChromeHello(exe) {
  const flights = [];
  const server = net.createServer(sock => {
    const chunks = [];
    sock.on('data', d => { chunks.push(d); flights.push(Buffer.concat(chunks)); });
    sock.on('error', () => {});
    setTimeout(() => sock.destroy(), 600);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-hello-'));
  const child = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `https://localhost:${server.address().port}/`], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 9000));
  child.kill();
  server.close();
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return flights.map(parseHello).filter(Boolean);
}

const exe = findChrome();
if (!exe) { console.error('check-chrome-hello: no Chrome found (set CHROME_PATH)'); process.exit(2); }
const hellos = await captureChromeHello(exe);
if (!hellos.length) { console.error('check-chrome-hello: Chrome sent no ClientHello to the listener'); process.exit(2); }

const version = chromeVersion(exe);
const real = [...new Set(hellos[0].exts.map(e => e.type).filter(t => !isGrease(t)))].sort((a, b) => a - b);
const mine = repoHello();
const hex = n => '0x' + n.toString(16).padStart(4, '0');
const problems = [];

const missing = real.filter(t => !mine.exts.includes(t));
const extra = mine.exts.filter(t => !real.includes(t));
if (missing.length) problems.push(`Chrome sends, we do not: ${missing.map(hex).join(' ')}`);
if (extra.length) problems.push(`we send, Chrome does not: ${extra.map(hex).join(' ')}`);

const anchors = hellos.map(h => h.exts.find(e => e.type === 0xca34)?.body).filter(Boolean);
if (!anchors.length) {
  if (mine.exts.includes(0xca34)) problems.push('Chrome sent no trust_anchors (0xca34) this time; we still do');
} else if (!anchors.every(a => a.equals(anchors[0]))) {
  problems.push('Chrome\'s trust_anchors body differs between connections — it is not a constant');
} else if (!anchors[0].equals(mine.anchors)) {
  problems.push(`trust_anchors body drifted: Chrome ${anchors[0].toString('hex')}\n                              repo   ${mine.anchors.toString('hex')}`);
}

console.log(`Chrome ${version}: ${hellos.length} hello(s), ${real.length} non-GREASE extensions; trust_anchors ${anchors.length ? anchors[0].length + ' bytes' : 'absent'}`);
if (problems.length) {
  console.log('DRIFT:\n  ' + problems.join('\n  '));
  console.log('Update web/sw.js (CAPTURED_FINGERPRINT_B64.extensions), third_party-rustls-fork/src/ja3.rs (CHROME_TRUST_ANCHORS) and the persona version in web/zp-core.js + web/worker-prelude.js together.');
  process.exit(1);
}
console.log('OK: the SW spec and the fork send what this Chrome sends.');
