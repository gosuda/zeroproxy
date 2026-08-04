// 최소 minidump 파서.
// 목표는 심볼 해석이 아니라 **한 가지 판별**이다: 스핀 중인 스레드의 RIP 가
// 로드된 모듈(msedge.dll 등) 안인가, 아니면 어느 모듈에도 속하지 않는
// **익명 실행 메모리(= JIT: WASM 또는 최적화된 JS)** 인가.
// WASM 코드는 어떤 모듈에도 매핑되지 않으므로 이 구분만으로 답이 갈린다.
const fs = require('fs');

const STREAM = { THREAD_LIST: 3, MODULE_LIST: 4, MEMORY_LIST: 5, SYSTEM_INFO: 7, MEMORY64_LIST: 9, MISC_INFO: 15 };

function parse(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32LE(0) !== 0x504d444d) throw new Error('not a minidump: ' + path);
  const nStreams = b.readUInt32LE(8);
  const dirRva = b.readUInt32LE(12);

  const streams = {};
  for (let i = 0; i < nStreams; i++) {
    const o = dirRva + i * 12;
    streams[b.readUInt32LE(o)] = { size: b.readUInt32LE(o + 4), rva: b.readUInt32LE(o + 8) };
  }

  // MINIDUMP_MODULE = 108 bytes
  const modules = [];
  if (streams[STREAM.MODULE_LIST]) {
    const base = streams[STREAM.MODULE_LIST].rva;
    const n = b.readUInt32LE(base);
    for (let i = 0; i < n; i++) {
      const o = base + 4 + i * 108;
      const imgBase = b.readBigUInt64LE(o);
      const imgSize = BigInt(b.readUInt32LE(o + 8));
      const nameRva = b.readUInt32LE(o + 20);
      const len = b.readUInt32LE(nameRva);
      const name = b.toString('utf16le', nameRva + 4, nameRva + 4 + len);
      modules.push({ base: imgBase, end: imgBase + imgSize, name: name.split('\\').pop() });
    }
  }

  // MINIDUMP_THREAD = 48 bytes; CONTEXT_AMD64: Rsp @0x98, Rip @0xF8
  const threads = [];
  if (streams[STREAM.THREAD_LIST]) {
    const base = streams[STREAM.THREAD_LIST].rva;
    const n = b.readUInt32LE(base);
    for (let i = 0; i < n; i++) {
      const o = base + 4 + i * 48;
      const id = b.readUInt32LE(o);
      // ThreadId 0, SuspendCount 4, PriorityClass 8, Priority 12, Teb 16,
      // Stack{StartOfMemoryRange 24, Memory{DataSize 32, Rva 36}},
      // ThreadContext{DataSize 40, Rva 44}
      const stackStart = b.readBigUInt64LE(o + 24);
      const stackSize = b.readUInt32LE(o + 32);
      const stackRva = b.readUInt32LE(o + 36);
      const ctxRva = b.readUInt32LE(o + 44);
      const rip = b.readBigUInt64LE(ctxRva + 0xf8);
      const rsp = b.readBigUInt64LE(ctxRva + 0x98);
      threads.push({ idx: i, id, rip, rsp, stackStart, stackSize, stackRva });
    }
  }
  return { buf: b, modules, threads };
}

function locate(modules, addr) {
  for (const m of modules) if (addr >= m.base && addr < m.end) return m.name + '+0x' + (addr - m.base).toString(16);
  return null;
}

// 언와인드 정보 없이 스택 메모리에서 모듈 .text 범위에 드는 값을 훑어
// 그럴듯한 리턴 주소 사슬을 복원한다. 정확하지 않지만 어느 서브시스템에
// 있는지 보기에는 충분하다.
function scanStack(d, t, max) {
  const out = [];
  if (!t.stackSize) return out;
  const seen = new Set();
  for (let off = 0; off + 8 <= t.stackSize; off += 8) {
    const v = d.buf.readBigUInt64LE(t.stackRva + off);
    const loc = locate(d.modules, v);
    if (!loc) continue;
    const mod = loc.split('+')[0];
    if (seen.has(loc)) continue;
    seen.add(loc);
    out.push(loc);
    if (out.length >= max) break;
  }
  return out;
}

const target = process.argv[2];
const d = parse(target);
console.log('modules:', d.modules.length, ' threads:', d.threads.length);

const jit = [];
for (const t of d.threads) {
  const loc = locate(d.modules, t.rip);
  if (!loc) jit.push(t);
}
console.log('\n=== threads whose RIP is NOT in any module (JIT / anonymous exec memory):', jit.length);
for (const t of jit) console.log('  tid=' + t.id + ' idx=' + t.idx + ' rip=0x' + t.rip.toString(16) + ' stackSize=' + t.stackSize);

console.log('\n=== all threads (rip location):');
for (const t of d.threads) {
  console.log('  tid=' + String(t.id).padStart(6) + '  ' + (locate(d.modules, t.rip) || '<JIT 0x' + t.rip.toString(16) + '>'));
}

const which = process.argv[3] ? d.threads.find(t => String(t.id) === process.argv[3]) : (jit[0] || d.threads[0]);
if (which) {
  console.log('\n=== stack scan for tid=' + which.id + ' (heuristic, no unwind info):');
  for (const f of scanStack(d, which, 40)) console.log('   ' + f);
}
