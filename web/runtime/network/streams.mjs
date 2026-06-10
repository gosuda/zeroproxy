/* ZeroProxy GoNetworkBackend chunked stream helpers. */

import { DEFAULT_MAX_CHUNK_SIZE, makeFetchChunk, makeFetchEnd, makeEnvelope } from './protocol.mjs';

export function toArrayBuffer(value) {
  if (value == null) return new ArrayBuffer(0);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
  return new Uint8Array(value).buffer;
}

export function chunkArrayBuffer(value, chunkSize = DEFAULT_MAX_CHUNK_SIZE) {
  const bytes = new Uint8Array(toArrayBuffer(value));
  const size = safeChunkSize(chunkSize);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.buffer.slice(offset, Math.min(offset + size, bytes.byteLength)));
  }
  if (chunks.length === 0) chunks.push(new ArrayBuffer(0));
  return chunks;
}

export function makeArrayBufferChunkMessages({
  bytes,
  bodyStreamId,
  requestId,
  tabId = 'tab',
  chunkSize = DEFAULT_MAX_CHUNK_SIZE,
  startSeq = 0,
  timing = {},
} = {}) {
  const chunks = chunkArrayBuffer(bytes, chunkSize);
  let offset = 0;
  const messages = chunks.map((chunk, index) => {
    const seq = startSeq + index;
    const message = makeFetchChunk({
      tabId,
      requestId,
      bodyStreamId,
      seq,
      bytes: chunk,
      byteOffset: offset,
      byteLength: chunk.byteLength,
      final: index === chunks.length - 1,
    });
    offset += chunk.byteLength;
    return message;
  });
  messages.push(makeFetchEnd({ tabId, requestId, bodyStreamId, bytesRead: offset, timing }));
  return messages;
}

export class CreditWindow {
  constructor({ initialCredit = 0 } = {}) {
    this.credit = Math.max(0, Number(initialCredit) || 0);
    this.paused = false;
    this.canceled = false;
  }

  apply(message) {
    switch (message?.type) {
      case 'stream.credit':
        this.add(message.credit ?? message.bytes ?? 0);
        break;
      case 'stream.pause':
        this.paused = true;
        break;
      case 'stream.resume':
        this.paused = false;
        break;
      case 'stream.cancel':
      case 'fetch.cancel':
        this.canceled = true;
        break;
      default:
        break;
    }
    return this.snapshot();
  }

  add(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) this.credit += Math.floor(n);
  }

  canSend() {
    return !this.paused && !this.canceled && this.credit > 0;
  }

  consume(units = 1) {
    if (!this.canSend()) return false;
    this.credit = Math.max(0, this.credit - Math.max(1, Number(units) || 1));
    return true;
  }

  snapshot() {
    return { credit: this.credit, paused: this.paused, canceled: this.canceled };
  }
}

export function makeStreamControl(type, record = {}) {
  return makeEnvelope(type, {
    id: record.id,
    tabId: record.tabId || 'tab',
    parentId: record.parentId,
    streamId: String(record.streamId || ''),
    requestId: record.requestId == null ? undefined : String(record.requestId),
    credit: record.credit == null ? undefined : Number(record.credit),
    reason: record.reason == null ? undefined : String(record.reason),
  });
}

function safeChunkSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CHUNK_SIZE;
}
