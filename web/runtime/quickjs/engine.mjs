const DEFAULT_FACTORY_URL = '/zp/assets/quickjs-runtime.mjs';
const DEFAULT_WASM_URL = '/zp/assets/quickjs-runtime.wasm';
const DEFAULT_MEMORY_LIMIT = 128 * 1024 * 1024;
const DEFAULT_STACK_SIZE = 8 * 1024 * 1024;

let nextHostCallId = 1;

export async function createQuickJSRuntime(options = {}) {
  const factory = options.moduleFactory || (await import(options.factoryURL || DEFAULT_FACTORY_URL)).default;
  const module = await factory({
    locateFile(file) {
      return file.endsWith('.wasm') ? options.wasmURL || DEFAULT_WASM_URL : file;
    },
  });
  return new QuickJSRuntime(module, options);
}

export class QuickJSRuntime {
  constructor(module, options = {}) {
    this.module = module;
    this.hostCalls = new Map();
    this.realms = new Map();
    this.version = module.UTF8ToString(module._zp_qjs_version());
    this.memoryLimit = options.memoryLimit || DEFAULT_MEMORY_LIMIT;
    this.stackSize = options.stackSize || DEFAULT_STACK_SIZE;
    module.zpHostCall = (realmId, callId, argsJson) => this.dispatchHostCall(realmId, callId, argsJson);
  }

  createRealm(options = {}) {
    const id = this.module._zp_qjs_create_realm(
      options.memoryLimit || this.memoryLimit,
      options.stackSize || this.stackSize,
    );
    if (!id) throw new Error('QUICKJS_REALM_CREATE_FAILED');
    const realm = new QuickJSRealm(this, id);
    this.realms.set(id, realm);
    return realm;
  }

  registerHostFunction(fn) {
    const id = nextHostCallId++;
    this.hostCalls.set(id, fn);
    return id;
  }

  dispatchHostCall(realmId, callId, argsJson) {
    const fn = this.hostCalls.get(callId);
    if (!fn) return JSON.stringify({ __zpHostError: 'HOST_CALL_NOT_FOUND' });
    try {
      const realm = this.realms.get(realmId);
      const args = JSON.parse(argsJson || '[]').map((arg) => realm.decodeEnvelope(arg));
      const value = fn(...args);
      return JSON.stringify(value === undefined ? null : value);
    } catch (error) {
      return JSON.stringify({ __zpHostError: error?.message || String(error) });
    }
  }
}

export class QuickJSRealm {
  constructor(runtime, id) {
    this.runtime = runtime;
    this.id = id;
    this.destroyed = false;
    this.wrappers = new Map();
  }

  evalClassic(source, filename = '<classic>') {
    return this.wrapEnvelope(
      this.callString('zp_qjs_eval', ['number', 'string', 'string', 'number'], [
        this.id,
        String(source || ''),
        filename,
        0,
      ]),
    );
  }

  evalModule(source, filename = '<module>') {
    return this.wrapEnvelope(
      this.callString('zp_qjs_eval', ['number', 'string', 'string', 'number'], [
        this.id,
        String(source || ''),
        filename,
        1,
      ]),
    );
  }

  getGlobal(name) {
    return this.getProp(0, name);
  }

  getProp(value, name) {
    const handle = typeof value === 'number' ? value : value?.handle || 0;
    return this.wrapEnvelope(
      this.callString('zp_qjs_get_prop', ['number', 'number', 'string'], [
        this.id,
        handle,
        String(name || ''),
      ]),
    );
  }

  defineHostFunction(name, fn) {
    const callId = this.runtime.registerHostFunction(fn);
    const ok = this.runtime.module.ccall('zp_qjs_define_host_function', 'number', ['number', 'string', 'number'], [this.id, String(name || ''), callId]);
    if (!ok) throw new Error('QUICKJS_HOST_FUNCTION_DEFINE_FAILED');
    return callId;
  }

  call(fn, args = [], thisValue = 0) {
    return this.wrapEnvelope(
      this.callString('zp_qjs_call_function', ['number', 'number', 'number', 'string'], [
        this.id,
        fn?.handle || fn || 0,
        thisValue?.handle || thisValue || 0,
        JSON.stringify(args),
      ]),
    );
  }

  drainJobs() {
    return this.runtime.module._zp_qjs_drain_jobs(this.id);
  }

  release(value) {
    const handle = typeof value === 'number' ? value : value?.handle || 0;
    if (!handle) return false;
    this.wrappers.delete(handle);
    return this.runtime.module._zp_qjs_release_handle(this.id, handle) === 1;
  }

  refcount(value) {
    const handle = typeof value === 'number' ? value : value?.handle || 0;
    return handle ? this.runtime.module._zp_qjs_handle_refcount(this.id, handle) : 0;
  }

  destroy() {
    if (this.destroyed) return;
    this.runtime.module._zp_qjs_destroy_realm(this.id);
    this.runtime.realms.delete(this.id);
    this.wrappers.clear();
    this.destroyed = true;
  }

  callString(name, argTypes, args) {
    if (this.destroyed) throw new Error('QUICKJS_REALM_DESTROYED');
    const ptr = this.runtime.module.ccall(name, 'number', argTypes, args);
    const text = this.runtime.module.UTF8ToString(ptr);
    this.runtime.module._free(ptr);
    const envelope = JSON.parse(text);
    if (!envelope.ok) throw Object.assign(new Error(quickJSErrorMessage(envelope)), { envelope });
    return envelope;
  }

  decodeEnvelope(envelope) {
    if (!envelope.ok) throw Object.assign(new Error(quickJSErrorMessage(envelope)), { envelope });
    return this.wrapEnvelope(envelope);
  }

  wrapEnvelope(envelope) {
    if (!envelope.handle) return envelope.json;
    const existing = this.wrappers.get(envelope.handle);
    if (existing) return existing;
    const wrapper = Object.freeze({
      realm: this,
      handle: envelope.handle,
      type: envelope.type,
      json: envelope.json,
      get: (name) => this.getProp(envelope.handle, name),
      release: () => this.release(envelope.handle),
    });
    this.wrappers.set(envelope.handle, wrapper);
    return wrapper;
  }
}

function quickJSErrorMessage(envelope) {
  const code = envelope?.error || 'QUICKJS_ERROR';
  const name = envelopeString(envelope?.name);
  const message = envelopeString(envelope?.message);
  if (name && message) return `${code}: ${name}: ${message}`;
  if (message) return `${code}: ${message}`;
  return code;
}

function envelopeString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}
