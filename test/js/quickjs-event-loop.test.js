const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuntime } = require('./quickjs-test-helpers.js');

async function newLoop(href = 'https://target.example/') {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { VirtualEventLoop } = await import('../../web/runtime/quickjs/event-loop.mjs');
  return { realm, loop: new VirtualEventLoop(realm, { href }) };
}

test('virtual event loop runs tasks timers and microtasks in deterministic order', async () => {
  const { realm, loop } = await newLoop();
  try {
    realm.evalClassic(`globalThis.order = [];
      setTimeout(() => order.push('timer'), 5);
      queueMicrotask(() => order.push('microtask'));
    `);
    loop.enqueueTask(realm.evalClassic(`() => order.push('task')`));
    assert.equal(realm.evalClassic('JSON.stringify(order)'), '[]');
    assert.equal(loop.tick(0), 1);
    assert.equal(realm.evalClassic('JSON.stringify(order)'), '["task","microtask"]');
    assert.equal(loop.tick(5), 1);
    assert.equal(realm.evalClassic('JSON.stringify(order)'), '["task","microtask","timer"]');
  } finally {
    realm.destroy();
  }
});

test('virtual event loop exposes requestIdleCallback and IdleDeadline basics', async () => {
  const { realm, loop } = await newLoop();
  try {
    realm.evalClassic(`
      globalThis.idle = [];
      const canceled = requestIdleCallback(() => idle.push(['canceled']));
      cancelIdleCallback(canceled);
      requestIdleCallback((deadline) => idle.push([
        Object.prototype.toString.call(deadline),
        deadline instanceof IdleDeadline,
        Object.getOwnPropertyNames(deadline),
        Object.getOwnPropertyNames(IdleDeadline.prototype),
        [
          Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'didTimeout').enumerable,
          Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'didTimeout').configurable,
          typeof Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'didTimeout').get,
          Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'timeRemaining').enumerable,
          Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'timeRemaining').writable,
          Object.getOwnPropertyDescriptor(IdleDeadline.prototype, 'timeRemaining').value.length,
        ],
        deadline.didTimeout,
        typeof deadline.timeRemaining(),
        deadline.timeRemaining() > 0,
        requestIdleCallback.length,
        cancelIdleCallback.length,
        IdleDeadline.length,
        requestIdleCallback.name,
        cancelIdleCallback.name,
        [
          Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback').writable,
          Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback').writable,
        ],
      ]));
      requestIdleCallback((deadline) => idle.push(['timeout', deadline.didTimeout]), { timeout: 5 });
      try { new IdleDeadline(); } catch (error) { idle.push(['illegal', error.name]); }
      try { requestIdleCallback(); } catch (error) { idle.push(['missing', error.name, error.message]); }
    `);
    assert.equal(loop.tick(0), 1);
    assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(idle)')), [
      ['illegal', 'TypeError'],
      [
        'missing',
        'TypeError',
        "Failed to execute 'requestIdleCallback' on 'Window': 1 argument required, but only 0 present.",
      ],
      [
        '[object IdleDeadline]',
        true,
        [],
        ['didTimeout', 'timeRemaining', 'constructor'],
        [true, true, 'function', true, true, 0],
        false,
        'number',
        true,
        1,
        1,
        0,
        'requestIdleCallback',
        'cancelIdleCallback',
        [true, true, true, true, true, true],
      ],
    ]);
    assert.equal(loop.tick(5), 1);
    assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(idle)')), [
      ['illegal', 'TypeError'],
      [
        'missing',
        'TypeError',
        "Failed to execute 'requestIdleCallback' on 'Window': 1 argument required, but only 0 present.",
      ],
      [
        '[object IdleDeadline]',
        true,
        [],
        ['didTimeout', 'timeRemaining', 'constructor'],
        [true, true, 'function', true, true, 0],
        false,
        'number',
        true,
        1,
        1,
        0,
        'requestIdleCallback',
        'cancelIdleCallback',
        [true, true, true, true, true, true],
      ],
      ['timeout', true],
    ]);
  } finally {
    realm.destroy();
  }
});

test('virtual event loop exposes scheduler.postTask basics', async () => {
  const { realm, loop } = await newLoop();
  try {
    realm.evalClassic(`
      globalThis.schedulerResults = [];
      try { new Scheduler(); } catch (error) { schedulerResults.push(['illegal', error.name]); }
      schedulerResults.push([
        typeof Scheduler,
        Object.prototype.toString.call(scheduler),
        scheduler instanceof Scheduler,
        typeof scheduler.postTask,
        Object.getOwnPropertyNames(Scheduler.prototype),
        Object.getOwnPropertyNames(scheduler),
        [
          Object.getOwnPropertyDescriptor(globalThis, 'Scheduler').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'Scheduler').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'Scheduler').writable,
          Object.getOwnPropertyDescriptor(globalThis, 'scheduler').enumerable,
          Object.getOwnPropertyDescriptor(globalThis, 'scheduler').configurable,
          Object.getOwnPropertyDescriptor(globalThis, 'scheduler').get.name,
          Object.getOwnPropertyDescriptor(globalThis, 'scheduler').set.name,
        ],
      ]);
      scheduler.postTask(() => {
        schedulerResults.push('task');
        return 'value';
      }, { priority: 'background' }).then((value) => schedulerResults.push(['resolved', value]));
      scheduler.postTask(() => schedulerResults.push('aborted-task'), { signal: { aborted: true, reason: 'stopped' } }).catch((error) => schedulerResults.push(['aborted', error]));
      scheduler.postTask(null).catch((error) => schedulerResults.push(['type', error.name]));
      scheduler.postTask(() => schedulerResults.push('bad-priority'), { priority: 'urgent' }).catch((error) => schedulerResults.push(['priority', error.name]));
    `);
    loop.runReady();
    assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(schedulerResults)')), [
      ['illegal', 'TypeError'],
      [
        'function',
        '[object Scheduler]',
        true,
        'function',
        ['constructor', 'postTask', 'yield'],
        [],
        [false, true, true, true, true, 'get scheduler', 'set scheduler'],
      ],
      'task',
      ['aborted', 'stopped'],
      ['type', 'TypeError'],
      ['priority', 'TypeError'],
      ['resolved', 'value'],
    ]);
  } finally {
    realm.destroy();
  }
});

test('virtual event loop exposes TaskController TaskSignal priority basics', async () => {
  const { realm, loop } = await newLoop();
  try {
    realm.evalClassic(`
      globalThis.taskControllerResults = [];
      try { new TaskSignal(); } catch (error) { taskControllerResults.push(['signal-illegal', error.name]); }
      const event = new TaskPriorityChangeEvent('prioritychange', { previousPriority: 'background' });
      taskControllerResults.push([
        typeof TaskController,
        typeof TaskSignal,
        typeof TaskPriorityChangeEvent,
        Object.prototype.toString.call(event),
        event.previousPriority,
      ]);
      const controller = new TaskController({ priority: 'background' });
      controller.signal.onprioritychange = (event) => taskControllerResults.push(['onprioritychange', event.previousPriority, controller.signal.priority]);
      controller.signal.addEventListener('prioritychange', (event) => taskControllerResults.push(['prioritychange', event.previousPriority, controller.signal.priority, event instanceof TaskPriorityChangeEvent]));
      controller.setPriority('user-blocking');
      scheduler.postTask(() => {
        taskControllerResults.push(['task-priority', controller.signal.priority]);
        return controller.signal.priority;
      }, { signal: controller.signal }).then((value) => taskControllerResults.push(['task-resolved', value]));
      const aborting = new TaskController();
      scheduler.postTask(() => taskControllerResults.push('aborted-task'), { signal: aborting.signal }).catch((error) => taskControllerResults.push(['abort-reason', error]));
      aborting.abort('cancelled');
      taskControllerResults.push([
        Object.prototype.toString.call(controller),
        Object.prototype.toString.call(controller.signal),
        controller.signal instanceof TaskSignal,
        controller.signal.aborted,
        controller.signal.priority,
      ]);
    `);
    loop.runReady();
    assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(taskControllerResults)')), [
      ['signal-illegal', 'TypeError'],
      ['function', 'function', 'function', '[object TaskPriorityChangeEvent]', 'background'],
      ['onprioritychange', 'background', 'user-blocking'],
      ['prioritychange', 'background', 'user-blocking', true],
      ['[object TaskController]', '[object TaskSignal]', true, false, 'user-blocking'],
      ['task-priority', 'user-blocking'],
      ['abort-reason', 'cancelled'],
      ['task-resolved', 'user-blocking'],
    ]);
  } finally {
    realm.destroy();
  }
});

test('virtual event loop integrates QuickJS promise jobs and queueMicrotask', async () => {
  const { realm, loop } = await newLoop();
  try {
    realm.evalClassic(`globalThis.done = [];
      Promise.resolve().then(() => done.push('promise'));
      queueMicrotask(() => done.push('queued'));
    `);
    loop.runReady();
    assert.equal(realm.evalClassic('JSON.stringify(done)'), '["queued","promise"]');
  } finally {
    realm.destroy();
  }
});

test('virtual event loop exposes common console methods and captures messages', async () => {
  const { realm, loop } = await newLoop();
  try {
    const result = realm.evalClassic(`
      const names = ['debug','error','info','log','warn','dir','dirxml','table','trace','group','groupCollapsed','groupEnd','clear','count','countReset','assert','profile','profileEnd','time','timeLog','timeEnd','timeStamp','context','createTask'];
      const methods = names.map((name) => [name, typeof console[name]]);
      const logDescriptor = Object.getOwnPropertyDescriptor(console, 'log');
      const memoryDescriptor = Object.getOwnPropertyDescriptor(console, 'memory');
      const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'console');
      console.log('hello', 1);
      console.info('value %d %s', '7', 'ok');
      console.warn('%cstyled %o', 'color:red', { a: 1 });
      console.debug('debug');
      console.assert(true, 'hidden');
      console.assert(false, 'visible %i', 3.8);
      console.error('bad', 7);
      JSON.stringify({ methods, own: Object.getOwnPropertyNames(console), tag: Object.prototype.toString.call(console), frozen: Object.isFrozen(console), logDescriptor: [logDescriptor.enumerable, logDescriptor.configurable, logDescriptor.writable, console.log.length, console.context.length], memoryDescriptor: [typeof memoryDescriptor.get, typeof memoryDescriptor.set, memoryDescriptor.enumerable, memoryDescriptor.configurable, memoryDescriptor.get.name, memoryDescriptor.set.name, memoryDescriptor.get.length, memoryDescriptor.set.length, console.memory === console.memory], globalDescriptor: [globalDescriptor.enumerable, globalDescriptor.configurable, globalDescriptor.writable] });
    `);
    assert.deepEqual(JSON.parse(result), {
      methods: [
        ['debug', 'function'],
        ['error', 'function'],
        ['info', 'function'],
        ['log', 'function'],
        ['warn', 'function'],
        ['dir', 'function'],
        ['dirxml', 'function'],
        ['table', 'function'],
        ['trace', 'function'],
        ['group', 'function'],
        ['groupCollapsed', 'function'],
        ['groupEnd', 'function'],
        ['clear', 'function'],
        ['count', 'function'],
        ['countReset', 'function'],
        ['assert', 'function'],
        ['profile', 'function'],
        ['profileEnd', 'function'],
        ['time', 'function'],
        ['timeLog', 'function'],
        ['timeEnd', 'function'],
        ['timeStamp', 'function'],
        ['context', 'function'],
        ['createTask', 'function'],
      ],
      own: [
        'debug',
        'error',
        'info',
        'log',
        'warn',
        'dir',
        'dirxml',
        'table',
        'trace',
        'group',
        'groupCollapsed',
        'groupEnd',
        'clear',
        'count',
        'countReset',
        'assert',
        'profile',
        'profileEnd',
        'time',
        'timeLog',
        'timeEnd',
        'timeStamp',
        'context',
        'createTask',
        'memory',
      ],
      tag: '[object console]',
      frozen: false,
      logDescriptor: [true, true, true, 0, 1],
      memoryDescriptor: ['function', 'function', true, true, '', '', 0, 0, true],
      globalDescriptor: [false, true, true],
    });
    realm.evalClassic(`
      console.count();
      console.count('cache');
      console.count('cache');
      console.countReset('cache');
      console.count('cache');
      console.time('load');
    `);
    loop.tick(12);
    realm.evalClassic(`
      console.timeLog('load', 'phase %s', 'dom');
      console.timeEnd('load');
      console.timeLog('missing');
    `);
    assert.deepEqual(
      loop.consoleMessages.map((entry) => [entry.level, entry.message]),
      [
        ['log', 'hello 1'],
        ['info', 'value 7 ok'],
        ['warn', 'styled [object Object]'],
        ['debug', 'debug'],
        ['assert', 'visible 3'],
        ['error', 'bad 7'],
        ['count', 'default: 1'],
        ['count', 'cache: 1'],
        ['count', 'cache: 2'],
        ['countReset', "Count for 'cache' was reset."],
        ['count', 'cache: 1'],
        ['timeLog', 'load: 12ms phase dom'],
        ['timeEnd', 'load: 12ms'],
        ['warn', "Timer 'missing' does not exist"],
      ],
    );
    assert.deepEqual(loop.consoleErrors, ['visible 3', 'bad 7']);
  } finally {
    realm.destroy();
  }
});

test('virtual event loop handles navigation reset same-document updates and console errors', async () => {
  const { realm, loop } = await newLoop('https://target.example/page#a');
  try {
    realm.evalClassic(
      `setTimeout(() => { throw new Error('must not run'); }, 1); console.error('bad', 7);`,
    );
    assert.deepEqual(loop.consoleErrors, ['bad 7']);
    const same = loop.sameDocumentNavigate('https://target.example/page#b');
    assert.equal(same.generation, 0);
    assert.equal(same.sameDocument, 1);
    const hard = loop.hardNavigate('https://target.example/next');
    assert.equal(hard.generation, 1);
    assert.equal(hard.sameDocument, 0);
    assert.equal(loop.timers.size, 0);
    assert.equal(loop.tick(10), 0);
  } finally {
    realm.destroy();
  }
});
