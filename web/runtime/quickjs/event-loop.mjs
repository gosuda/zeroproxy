export class VirtualEventLoop {
  constructor(realm, options = {}) {
    this.realm = realm;
    this.now = Number(options.now || 0);
    this.nextTimerId = 1;
    this.taskQueue = [];
    this.microtaskQueue = [];
    this.timers = new Map();
    this.consoleErrors = [];
    this.consoleMessages = [];
    this.consoleCounts = new Map();
    this.consoleTimers = new Map();
    this.navigation = { href: options.href || 'about:blank', generation: 0, sameDocument: 0 };
    this.installGlobals();
  }

  installGlobals() {
    this.realm.defineHostFunction('__zpSetTimeout', (callback, delay = 0) => this.setTimer(callback, delay, false));
    this.realm.defineHostFunction('__zpSetInterval', (callback, delay = 0) => this.setTimer(callback, delay, true));
    this.realm.defineHostFunction('__zpClearTimer', (id) => this.clearTimer(id));
    this.realm.defineHostFunction('__zpQueueMicrotask', (callback) => this.queueMicrotask(callback));
    this.realm.defineHostFunction('__zpNow', () => this.now);
    this.realm.defineHostFunction('__zpConsole', (level, ...args) => this.recordConsole(level, args));
    this.realm.defineHostFunction('__zpConsoleError', (...args) => this.recordConsole('error', args));
    this.realm.evalClassic(`
      const __zpDefineWindowFunction = (name, value) => {
        try {
          Object.defineProperty(globalThis, name, { value, writable: true, enumerable: true, configurable: true });
        } catch {
          globalThis[name] = value;
        }
      };
      const __zpBrowserFunction = (name, fn) => {
        const bound = fn.bind(undefined);
        try { Object.defineProperty(bound, 'name', { value: name, configurable: true }); } catch {}
        return bound;
      };
      globalThis.setTimeout = (callback, delay = 0) => __zpSetTimeout(callback, delay);
      globalThis.setInterval = (callback, delay = 0) => __zpSetInterval(callback, delay);
      globalThis.clearTimeout = (id) => __zpClearTimer(id);
      globalThis.clearInterval = (id) => __zpClearTimer(id);
      const __zpQueueMicrotaskFn = __zpBrowserFunction('queueMicrotask', function queueMicrotask(callback) { return __zpQueueMicrotask(callback); });
      __zpDefineWindowFunction('queueMicrotask', __zpQueueMicrotaskFn);
      const __zpIdleDeadlineToken = {};
      const __zpIdleDeadlineState = new WeakMap();
      const IdleDeadline = function IdleDeadline() {
        if (arguments[0] !== __zpIdleDeadlineToken) throw new TypeError("Failed to construct 'IdleDeadline': Illegal constructor");
        __zpIdleDeadlineState.set(this, { didTimeout: Boolean(arguments[1]), deadline: Number(arguments[2]) || 0 });
      };
      const __zpIdleConstructorDescriptor = Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'constructor');
      delete IdleDeadline.prototype.constructor;
      Object.defineProperty(IdleDeadline.prototype, 'didTimeout', { get() {
        const state = __zpIdleDeadlineState.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return state.didTimeout;
      }, enumerable: true, configurable: true });
      Object.defineProperty(IdleDeadline.prototype, 'timeRemaining', { value: function timeRemaining() {
        const state = __zpIdleDeadlineState.get(this);
        if (!state) throw new TypeError('Illegal invocation');
        return Math.max(0, Math.min(50, state.deadline - Number(__zpNow())));
      }, enumerable: true, configurable: true, writable: true });
      Object.defineProperty(IdleDeadline.prototype, 'constructor', __zpIdleConstructorDescriptor);
      Object.defineProperty(IdleDeadline.prototype, Symbol.toStringTag, { value: 'IdleDeadline', configurable: true });
      try {
        Object.defineProperty(globalThis, 'IdleDeadline', { value: IdleDeadline, writable: true, configurable: true });
      } catch {
        globalThis.IdleDeadline = IdleDeadline;
      }
      const __zpRequestIdleCallbackFn = __zpBrowserFunction('requestIdleCallback', function requestIdleCallback(callback, options = {}) {
        if (arguments.length < 1) throw new TypeError("Failed to execute 'requestIdleCallback' on 'Window': 1 argument required, but only 0 present.");
        if (typeof callback !== 'function') throw new TypeError("Failed to execute 'requestIdleCallback' on 'Window': parameter 1 is not of type 'Function'.");
        const timeout = Number(options && options.timeout);
        const delay = Number.isFinite(timeout) && timeout > 0 ? timeout : 0;
        const didTimeout = delay > 0;
        return __zpSetTimeout(() => callback(new IdleDeadline(__zpIdleDeadlineToken, didTimeout, Number(__zpNow()) + 50)), delay);
      });
      const __zpCancelIdleCallbackFn = __zpBrowserFunction('cancelIdleCallback', function cancelIdleCallback(id) { return __zpClearTimer(id); });
      __zpDefineWindowFunction('requestIdleCallback', __zpRequestIdleCallbackFn);
      __zpDefineWindowFunction('cancelIdleCallback', __zpCancelIdleCallbackFn);
      const __zpTaskPriorities = new Set(['user-blocking', 'user-visible', 'background']);
      const Scheduler = function Scheduler() { throw new TypeError("Failed to construct 'Scheduler': Illegal constructor"); };
      Object.defineProperty(Scheduler.prototype, Symbol.toStringTag, { value: 'Scheduler', configurable: true });
      function __zpAbortRejection(signal) {
        if (signal && 'reason' in signal) return signal.reason;
        const error = new Error('AbortError');
        error.name = 'AbortError';
        return error;
      }
      const __zpTaskSignalToken = {};
      const TaskPriorityChangeEvent = function TaskPriorityChangeEvent(type, init = {}) {
        this.type = String(type);
        this.bubbles = false;
        this.cancelable = false;
        this.defaultPrevented = false;
        this.previousPriority = String(init.previousPriority || 'user-visible');
        this.target = null;
        this.currentTarget = null;
      };
      Object.defineProperty(TaskPriorityChangeEvent.prototype, Symbol.toStringTag, { value: 'TaskPriorityChangeEvent', configurable: true });
      const TaskSignal = function TaskSignal(token, priority) {
        if (token !== __zpTaskSignalToken) throw new TypeError("Failed to construct 'TaskSignal': Illegal constructor");
        this.__zpListeners = new Map();
        this.aborted = false;
        this.reason = undefined;
        this.priority = priority;
        this.onabort = null;
        this.onprioritychange = null;
      };
      Object.defineProperty(TaskSignal.prototype, Symbol.toStringTag, { value: 'TaskSignal', configurable: true });
      TaskSignal.prototype.addEventListener = function addEventListener(type, callback) {
        if (typeof callback !== 'function') return;
        const key = String(type);
        const listeners = this.__zpListeners.get(key) || [];
        listeners.push(callback);
        this.__zpListeners.set(key, listeners);
      };
      TaskSignal.prototype.removeEventListener = function removeEventListener(type, callback) {
        const listeners = this.__zpListeners.get(String(type));
        if (!listeners) return;
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
      TaskSignal.prototype.dispatchEvent = function dispatchEvent(event) {
        event.target = this;
        event.currentTarget = this;
        const handler = this['on' + event.type];
        if (typeof handler === 'function') handler.call(this, event);
        const listeners = this.__zpListeners.get(event.type) || [];
        for (const listener of [...listeners]) listener.call(this, event);
        return true;
      };
      TaskSignal.prototype.throwIfAborted = function throwIfAborted() {
        if (this.aborted) throw this.reason;
      };
      const TaskController = function TaskController(options = {}) {
        const priority = __zpNormalizeTaskPriority(options && options.priority !== undefined ? options.priority : 'user-visible');
        this.signal = new TaskSignal(__zpTaskSignalToken, priority);
      };
      Object.defineProperty(TaskController.prototype, Symbol.toStringTag, { value: 'TaskController', configurable: true });
      TaskController.prototype.setPriority = function setPriority(priority) {
        const next = __zpNormalizeTaskPriority(priority);
        if (this.signal.priority === next) return;
        const previousPriority = this.signal.priority;
        this.signal.priority = next;
        this.signal.dispatchEvent(new TaskPriorityChangeEvent('prioritychange', { previousPriority }));
      };
      TaskController.prototype.abort = function abort(reason) {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.reason = reason === undefined ? __zpAbortRejection(this.signal) : reason;
        this.signal.dispatchEvent({ type: 'abort', target: null, currentTarget: null });
      };
      function __zpNormalizeTaskPriority(priority) {
        const normalized = String(priority);
        if (!__zpTaskPriorities.has(normalized)) throw new TypeError('Invalid task priority.');
        return normalized;
      }
      const __zpSchedulerPostTask = function postTask(callback, options = {}) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError("Failed to execute 'postTask' on 'Scheduler': parameter 1 is not a function."));
        const signal = options && options.signal;
        let priority = 'user-visible';
        try {
          priority = __zpNormalizeTaskPriority(options && options.priority !== undefined ? options.priority : (signal?.priority || 'user-visible'));
        } catch (error) {
          return Promise.reject(error);
        }
        if (signal?.aborted) return Promise.reject(__zpAbortRejection(signal));
        return new Promise((resolve, reject) => {
          let settled = false;
          let timer = 0;
          const cleanup = () => signal?.removeEventListener?.('abort', abort);
          const abort = () => {
            if (settled) return;
            settled = true;
            __zpClearTimer(timer);
            cleanup();
            reject(__zpAbortRejection(signal));
          };
          timer = __zpSetTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            try { resolve(callback()); } catch (error) { reject(error); }
          }, 0);
          signal?.addEventListener?.('abort', abort, { once: true });
        });
      };
      const __zpSchedulerYield = { yield(options = {}) { return __zpSchedulerPostTask(() => undefined, options); } }.yield;
      Scheduler.prototype.postTask = __zpSchedulerPostTask;
      Scheduler.prototype.yield = __zpSchedulerYield;
      const __zpSchedulerObject = Object.create(Scheduler.prototype);
      const __zpSchedulerGlobalDescriptor = Object.getOwnPropertyDescriptor({ get scheduler() { return __zpSchedulerObject; }, set scheduler(value) {} }, 'scheduler');
      Object.defineProperty(globalThis, 'Scheduler', { value: Scheduler, writable: true, configurable: true });
      Object.defineProperty(globalThis, 'TaskController', { value: TaskController, writable: true, configurable: true });
      Object.defineProperty(globalThis, 'TaskSignal', { value: TaskSignal, writable: true, configurable: true });
      Object.defineProperty(globalThis, 'TaskPriorityChangeEvent', { value: TaskPriorityChangeEvent, writable: true, configurable: true });
      Object.defineProperty(globalThis, 'scheduler', { get: __zpSchedulerGlobalDescriptor.get, set: __zpSchedulerGlobalDescriptor.set, enumerable: true, configurable: true });
      const __zpConsoleObject = {};
      const __zpConsoleMethod = (level) => ({ [level]: function(...args) { return __zpConsole(level, ...args); } })[level];
      for (const level of ['debug', 'error', 'info', 'log', 'warn', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed', 'groupEnd', 'clear', 'count', 'countReset']) {
        Object.defineProperty(__zpConsoleObject, level, { value: __zpConsoleMethod(level), enumerable: true, writable: true, configurable: true });
      }
      Object.defineProperty(__zpConsoleObject, 'assert', { value: function assert(...args) { const condition = args.shift(); if (!condition) __zpConsole('assert', ...(args.length ? args : ['Assertion failed'])); }, enumerable: true, writable: true, configurable: true });
      for (const level of ['profile', 'profileEnd', 'time', 'timeLog', 'timeEnd', 'timeStamp']) {
        Object.defineProperty(__zpConsoleObject, level, { value: __zpConsoleMethod(level), enumerable: true, writable: true, configurable: true });
      }
      Object.defineProperty(__zpConsoleObject, 'context', { value: function context(_name) { return __zpConsoleObject; }, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(__zpConsoleObject, 'createTask', { value: function createTask() { return { run(callback, ...args) { return callback(...args); } }; }, enumerable: true, writable: true, configurable: true });
      const __zpConsoleMemory = {};
      const __zpConsoleMemoryGet = function() { return __zpConsoleMemory; };
      const __zpConsoleMemorySet = function(...args) { void args; };
      Object.defineProperty(__zpConsoleMemoryGet, 'name', { value: '', configurable: true });
      Object.defineProperty(__zpConsoleMemorySet, 'name', { value: '', configurable: true });
      Object.defineProperty(__zpConsoleObject, 'memory', { get: __zpConsoleMemoryGet, set: __zpConsoleMemorySet, enumerable: true, configurable: true });
      Object.defineProperty(__zpConsoleObject, Symbol.toStringTag, { value: 'console', configurable: true });
      Object.defineProperty(globalThis, 'console', { value: __zpConsoleObject, writable: true, configurable: true });
    `);
  }

  recordConsole(level, args = []) {
    const name = String(level || 'log');
    if (name === 'count') return this.recordConsoleCount(args);
    if (name === 'countReset') return this.resetConsoleCount(args);
    if (name === 'time') return this.startConsoleTimer(args);
    if (name === 'timeLog') return this.logConsoleTimer(args);
    if (name === 'timeEnd') return this.endConsoleTimer(args);
    const formattedArgs = this.formatConsoleArgs(args);
    const entry = { level: name, message: formattedArgs.join(' '), args: args.map((arg) => this.consoleArgToString(arg)) };
    this.consoleMessages.push(entry);
    if (entry.level === 'error' || entry.level === 'assert') this.consoleErrors.push(entry.message);
    return undefined;
  }

  consoleLabel(args = []) {
    return args.length ? this.consoleArgToString(args[0]) : 'default';
  }

  recordConsoleCount(args = []) {
    const label = this.consoleLabel(args);
    const count = (this.consoleCounts.get(label) || 0) + 1;
    this.consoleCounts.set(label, count);
    this.consoleMessages.push({ level: 'count', message: `${label}: ${count}`, args: [label] });
    return undefined;
  }

  resetConsoleCount(args = []) {
    const label = this.consoleLabel(args);
    if (this.consoleCounts.has(label)) this.consoleCounts.delete(label);
    this.consoleMessages.push({ level: 'countReset', message: `Count for '${label}' was reset.`, args: [label] });
    return undefined;
  }

  startConsoleTimer(args = []) {
    this.consoleTimers.set(this.consoleLabel(args), this.now);
    return undefined;
  }

  logConsoleTimer(args = []) {
    const label = this.consoleLabel(args);
    if (!this.consoleTimers.has(label)) return this.recordConsole('warn', [`Timer '${label}' does not exist`]);
    const rest = args.length > 1 ? this.formatConsoleArgs(args.slice(1)) : [];
    this.consoleMessages.push({ level: 'timeLog', message: [`${label}: ${this.consoleElapsed(label)}`, ...rest].join(' '), args: [label, ...rest] });
    return undefined;
  }

  endConsoleTimer(args = []) {
    const label = this.consoleLabel(args);
    if (!this.consoleTimers.has(label)) return this.recordConsole('warn', [`Timer '${label}' does not exist`]);
    this.consoleMessages.push({ level: 'timeEnd', message: `${label}: ${this.consoleElapsed(label)}`, args: [label] });
    this.consoleTimers.delete(label);
    return undefined;
  }

  consoleElapsed(label) {
    const elapsed = Math.max(0, this.now - (this.consoleTimers.get(label) || 0));
    return `${elapsed}ms`;
  }

  formatConsoleArgs(args = []) {
    const values = Array.from(args);
    if (!values.length || typeof values[0] !== 'string') return values.map((arg) => this.consoleArgToString(arg));
    let index = 1;
    const first = values[0].replace(/%([%cdfiosO])/g, (match, type) => {
      if (type === '%') return '%';
      if (index >= values.length) return match;
      const value = values[index++];
      if (type === 'c') return '';
      if (type === 'd' || type === 'i') return String(Number.parseInt(value, 10));
      if (type === 'f') return String(Number(value));
      return this.consoleArgToString(value);
    });
    const out = [first];
    while (index < values.length) out.push(this.consoleArgToString(values[index++]));
    return out;
  }

  consoleArgToString(value) {
    return String(value);

  }

  enqueueTask(callback, args = []) {
    this.taskQueue.push({ callback, args });
    return this.taskQueue.length;
  }

  queueMicrotask(callback) {
    this.microtaskQueue.push(callback);
    return undefined;
  }

  setTimer(callback, delay, interval) {
    const id = this.nextTimerId++;
    const timeout = Math.max(0, Number(delay) || 0);
    this.timers.set(id, { id, callback, timeout, due: this.now + timeout, interval });
    return id;
  }

  clearTimer(id) {
    const timer = this.timers.get(Number(id));
    if (timer?.callback?.release) timer.callback.release();
    this.timers.delete(Number(id));
    return undefined;
  }

  tick(ms = 0) {
    this.now += Math.max(0, Number(ms) || 0);
    return this.runReady();
  }

  runReady(limit = 1024) {
    let count = 0;
    while (count < limit) {
      const item = this.nextReadyItem();
      if (!item) break;
      this.runItem(item);
      this.runMicrotasks(limit - count);
      count++;
    }
    this.runMicrotasks(limit - count);
    this.realm.drainJobs();
    return count;
  }

  hardNavigate(href) {
    this.cancelAllTimers();
    this.taskQueue = [];
    this.microtaskQueue = [];
    this.consoleErrors = [];
    this.consoleMessages = [];
    this.consoleCounts.clear();
    this.consoleTimers.clear();
    this.navigation = { href: String(href || 'about:blank'), generation: this.navigation.generation + 1, sameDocument: 0 };
    this.realm.drainJobs();
    return this.navigation;
  }

  sameDocumentNavigate(href) {
    this.navigation = { ...this.navigation, href: String(href || this.navigation.href), sameDocument: this.navigation.sameDocument + 1 };
    return this.navigation;
  }

  nextReadyItem() {
    if (this.taskQueue.length) return { kind: 'task', ...this.taskQueue.shift() };
    const timer = this.nextDueTimer();
    return timer ? { kind: 'timer', timer } : null;
  }

  nextDueTimer() {
    let selected = null;
    for (const timer of this.timers.values()) {
      if (timer.due <= this.now && (!selected || timer.due < selected.due || timer.id < selected.id)) {
        selected = timer;
      }
    }
    return selected;
  }

  runItem(item) {
    if (item.kind === 'task') {
      this.realm.call(item.callback, item.args);
      return;
    }
    const { timer } = item;
    if (!timer.interval) this.timers.delete(timer.id);
    this.realm.call(timer.callback);
    if (timer.interval && this.timers.has(timer.id)) timer.due = this.now + timer.timeout;
    if (!timer.interval && timer.callback?.release) timer.callback.release();
  }

  runMicrotasks(limit) {
    let count = 0;
    while (this.microtaskQueue.length && count < limit) {
      const callback = this.microtaskQueue.shift();
      this.realm.call(callback);
      if (callback?.release) callback.release();
      this.realm.drainJobs();
      count++;
    }
    this.realm.drainJobs();
    return count;
  }

  cancelAllTimers() {
    for (const timer of this.timers.values()) {
      if (timer.callback?.release) timer.callback.release();
    }
    this.timers.clear();
  }
}
