/* ZeroProxy Phase 2 JavaScript rewrite policy. Classic script for Service Worker and target-runtime use. */
(() => {
  'use strict';
  if (globalThis.ZPRewriter) return;

  const VERSION = 'phase2-oxc-abi-2';
  const BLOCK_CODE = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  const GLOBALS = new Set(['window', 'self', 'globalThis', 'location', 'document', 'history', 'top', 'parent', 'opener', 'frames', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction']);
  const MEMBER_HELPER_PROPS = new Set(['location', 'defaultView', 'contentWindow', 'contentDocument', 'top', 'parent', 'opener', 'frames', 'constructor']);
  const CALL_HELPER_PROPS = new Set(['assign', 'replace', 'open', 'get', 'getOwnPropertyDescriptor', 'defineProperty']);
  let parser = null;
  let ready = false;

  async function init(options = {}) {
    if (ready) return true;
    const p = options.parser || globalThis.OXCParser;
    if (!p || typeof p.parseSync !== 'function') throw new Error('REALM_INJECTION_FAILURE');
    if (typeof p.init === 'function') {
      if (options.wasmURL) {
        const fetchImpl = options.fetch || globalThis.fetch;
        const resp = await fetchImpl(options.wasmURL, { cache: 'no-store' });
        if (!resp || !resp.ok) throw new Error('REALM_INJECTION_FAILURE');
        await p.init(resp);
      } else {
        await p.init();
      }
    }
    parser = p;
    ready = true;
    return true;
  }

  function normalizeKind(kind) {
    kind = String(kind || 'classic').toLowerCase();
    if (kind === 'worker') return 'classic';
    if (kind === 'event-handler' || kind === 'event') return 'event-handler';
    if (kind === 'function') return 'function';
    if (kind === 'module') return 'module';
    return 'classic';
  }

  function blockSource() { return BLOCK_CODE; }
  function blocked(reason, diagnostics) { return { ok: false, errorCode: reason || 'REWRITE_FAILED', diagnostics: diagnostics || [{ level: 'error', message: reason || 'REWRITE_FAILED' }] }; }
  function ok(code, diagnostics) { return { ok: true, code, diagnostics: diagnostics || [] }; }

  function rewriteScript(source, options = {}) {
    source = String(source || '');
    const kind = normalizeKind(options.scriptKind || options.kind);
    if (!ready || !parser) return blocked('REWRITE_FAILED');
    if (kind === 'event-handler') return rewriteEventHandler(source, options);
    if (kind === 'function') return rewriteFunctionBody(source, options);
    const parsed = parse(source, kind === 'module' ? 'module' : 'script', options.url || options.targetUrl || 'target.js');
    if (!parsed.ok) return parsed;
    const rewritten = rewriteProgram(source, parsed.program, { module: kind === 'module' });
    return ok(rewritten.code, parsed.diagnostics.concat(rewritten.diagnostics));
  }

  function rewriteEventHandler(source, options) {
    const prefix = 'function __zp_event__(event){\n';
    const suffix = '\n}';
    const parsed = parse(prefix + source + suffix, 'script', options.url || 'event-handler.js');
    if (!parsed.ok) return parsed;
    const body = parsed.program.body && parsed.program.body[0] && parsed.program.body[0].body;
    if (!body || !Array.isArray(body.body)) return blocked('REWRITE_FAILED');
    const rewritten = rewriteProgram(prefix + source + suffix, { type: 'Program', body: body.body, start: prefix.length, end: prefix.length + source.length }, { baseOffset: prefix.length });
    const inner = rewritten.code.slice(prefix.length, prefix.length + source.length + (rewritten.code.length - (prefix.length + source.length + suffix.length)));
    return ok('return __zp_runEvent(this,event,function(__zp_scope){with(__zp_scope){\n' + inner + '\n}})', parsed.diagnostics.concat(rewritten.diagnostics));
  }

  function rewriteFunctionBody(source, options) {
    const prefix = 'function __zp_dynamic__(){\n';
    const suffix = '\n}';
    const parsed = parse(prefix + source + suffix, 'script', options.url || 'function-body.js');
    if (!parsed.ok) return parsed;
    const body = parsed.program.body && parsed.program.body[0] && parsed.program.body[0].body;
    if (!body || !Array.isArray(body.body)) return blocked('REWRITE_FAILED');
    const rewritten = rewriteProgram(prefix + source + suffix, { type: 'Program', body: body.body, start: prefix.length, end: prefix.length + source.length }, { baseOffset: prefix.length });
    return ok(rewritten.code.slice(prefix.length, rewritten.code.length - suffix.length), parsed.diagnostics.concat(rewritten.diagnostics));
  }

  function parse(source, sourceType, filename) {
    let result;
    try { result = parser.parseSync(source, { sourceType, sourceFilename: filename || 'target.js' }); }
    catch (err) { return blocked('PARSE_FAILED', [{ level: 'error', message: err && err.message || 'PARSE_FAILED' }]); }
    const errors = result.errors || [];
    if (errors.length) return blocked('PARSE_FAILED', errors.map(e => ({ level: e.severity || 'error', message: e.message || 'PARSE_FAILED', start: e.start, end: e.end })));
    return { ok: true, program: result.program, diagnostics: [] };
  }

  function rewriteProgram(source, program) {
    const replacements = [];
    const diagnostics = [];
    const scopeStack = [];
    const globalIds = new WeakSet();
    const renderedCache = new WeakMap();

    function pushScope(names) { scopeStack.push(names || new Set()); }
    function popScope() { scopeStack.pop(); }
    function declare(name) { if (name) scopeStack[scopeStack.length - 1].add(name); }
    function declared(name) { for (let i = scopeStack.length - 1; i >= 0; i--) if (scopeStack[i].has(name)) return true; return false; }
    function addReplacement(node, text, priority) { if (node && Number.isFinite(node.start) && Number.isFinite(node.end) && node.start < node.end) replacements.push({ start: node.start, end: node.end, text, priority: priority || 0 }); }
    function src(node) { return source.slice(node.start, node.end); }
    function propCode(node, computed) {
      if (!computed && node.type === 'Identifier') return JSON.stringify(node.name);
      return render(node);
    }
    function propName(node, computed) {
      if (!computed && node.type === 'Identifier') return node.name;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'StringLiteral') return node.value;
      return '';
    }
    function isGlobalIdentifier(node) { return node && node.type === 'Identifier' && GLOBALS.has(node.name) && !declared(node.name); }
    function isWindowLikeGlobal(node) { return node && node.type === 'Identifier' && !declared(node.name) && (node.name === 'window' || node.name === 'self' || node.name === 'globalThis' || node.name === 'top' || node.name === 'parent' || node.name === 'frames' || node.name === 'document'); }
    function isReferenceIdentifier(node, parent, key) {
      if (!node || node.type !== 'Identifier') return false;
      if (!parent) return true;
      if ((parent.type === 'VariableDeclarator' && key === 'id') || (parent.type === 'FunctionDeclaration' && key === 'id') || (parent.type === 'FunctionExpression' && key === 'id') || (parent.type === 'ClassDeclaration' && key === 'id') || (parent.type === 'ClassExpression' && key === 'id')) return false;
      if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return false;
      if ((parent.type === 'Property' || parent.type === 'ObjectProperty' || parent.type === 'MethodDefinition') && key === 'key' && !parent.computed) return false;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
      if (parent.type && parent.type.startsWith('Import')) return false;
      return true;
    }

    function collectPattern(node, names) {
      if (!node) return;
      if (node.type === 'Identifier') { names.add(node.name); return; }
      if (node.type === 'RestElement') { collectPattern(node.argument, names); return; }
      if (node.type === 'AssignmentPattern') { collectPattern(node.left, names); return; }
      if (node.type === 'ArrayPattern') { for (const e of node.elements || []) collectPattern(e, names); return; }
      if (node.type === 'ObjectPattern') {
        for (const p of node.properties || []) collectPattern(p.value || p.argument || p, names);
      }
    }
    function collectBodyBindings(body, names) {
      for (const stmt of body || []) {
        if (!stmt) continue;
        if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') collectPattern(stmt.id, names);
        if (stmt.type === 'VariableDeclaration') for (const d of stmt.declarations || []) collectPattern(d.id, names);
        if (stmt.type === 'ImportDeclaration') for (const s of stmt.specifiers || []) collectPattern(s.local, names);
      }
      return names;
    }
    function collectParams(node, names) { for (const p of node.params || []) collectPattern(p, names); return names; }

    function render(node) {
      if (!node) return '';
      if (renderedCache.has(node)) return renderedCache.get(node);
      let out = src(node);
      if (node.type === 'Identifier' && (globalIds.has(node) || isGlobalIdentifier(node))) out = '__zp_get(globalThis,' + JSON.stringify(node.name) + ')';
      else if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        const name = propName(node.property, node.computed);
        const helper = MEMBER_HELPER_PROPS.has(name) || (node.computed && isWindowLikeGlobal(node.object));
        if (helper) out = '__zp_get(' + render(node.object) + ',' + propCode(node.property, node.computed) + ')';
        else if (node.computed) out = render(node.object) + '[' + render(node.property) + ']';
        else out = render(node.object) + source.slice(node.object.end, node.property.start) + src(node.property);
      } else if (node.type === 'ChainExpression') out = render(node.expression);
      renderedCache.set(node, out);
      return out;
    }

    function enterNode(node, parent, key) {
      if (!node || typeof node.type !== 'string') return false;
      switch (node.type) {
        case 'Program': {
          pushScope(collectBodyBindings(node.body, new Set()));
          for (const child of node.body || []) walk(child, node, 'body');
          popScope();
          return true;
        }
        case 'BlockStatement': {
          pushScope(collectBodyBindings(node.body, new Set()));
          for (const child of node.body || []) walk(child, node, 'body');
          popScope();
          return true;
        }
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          if (node.type !== 'ArrowFunctionExpression' && node.id) declare(node.id.name);
          pushScope(collectParams(node, new Set()));
          if (node.id && node.type === 'FunctionExpression') declare(node.id.name);
          if (node.body) walk(node.body, node, 'body');
          popScope();
          return true;
        }
        case 'CatchClause': {
          pushScope(new Set());
          collectPattern(node.param, scopeStack[scopeStack.length - 1]);
          if (node.body) walk(node.body, node, 'body');
          popScope();
          return true;
        }
        case 'AssignmentExpression': {
          if (node.operator !== '=' && containsDangerousLHS(node.left)) {
            addReplacement(node, BLOCK_CODE, 100);
            diagnostics.push({ level: 'warning', message: 'blocked compound assignment touching virtualized browser state', start: node.start, end: node.end });
            return true;
          }
          if (node.left && node.left.type === 'Identifier' && isGlobalIdentifier(node.left) && (node.left.name === 'location' || node.left.name === 'window')) {
            addReplacement(node, '__zp_set(globalThis,' + JSON.stringify(node.left.name) + ',' + src(node.right) + ')', 100);
            return true;
          }
          break;
        }
        case 'UpdateExpression': {
          if (containsDangerousLHS(node.argument)) {
            addReplacement(node, BLOCK_CODE, 100);
            diagnostics.push({ level: 'warning', message: 'blocked update touching virtualized browser state', start: node.start, end: node.end });
            return true;
          }
          break;
        }
        case 'CallExpression':
        case 'NewExpression': {
          const callee = node.callee;
          if (callee && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')) {
            const name = propName(callee.property, callee.computed);
            if (CALL_HELPER_PROPS.has(name) || MEMBER_HELPER_PROPS.has(name)) {
              const args = (node.arguments || []).map(a => src(a)).join(',');
              const call = '__zp_call(' + render(callee.object) + ',' + propCode(callee.property, callee.computed) + ',[' + args + '])';
              addReplacement(node, node.type === 'NewExpression' ? BLOCK_CODE : call, 90);
              if (node.type === 'NewExpression') diagnostics.push({ level: 'warning', message: 'blocked construction through virtualized browser state', start: node.start, end: node.end });
              return true;
            }
          }
          break;
        }
        case 'MemberExpression':
        case 'OptionalMemberExpression': {
          const name = propName(node.property, node.computed);
          if (MEMBER_HELPER_PROPS.has(name) || (node.computed && isWindowLikeGlobal(node.object))) {
            addReplacement(node, render(node), 80);
            return true;
          }
          break;
        }
        case 'Identifier': {
          if (isReferenceIdentifier(node, parent, key) && isGlobalIdentifier(node)) {
            globalIds.add(node);
            addReplacement(node, render(node), 10);
          }
          return false;
        }
      }
      return false;
    }

    function containsDangerousLHS(node) {
      if (!node) return false;
      if (node.type === 'Identifier') return isGlobalIdentifier(node) && (node.name === 'location' || node.name === 'window');
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return MEMBER_HELPER_PROPS.has(propName(node.property, node.computed)) || containsDangerousLHS(node.object);
      return false;
    }

    function walk(node, parent, key) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const item of node) walk(item, parent, key); return; }
      if (enterNode(node, parent, key)) return;
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'name' || k === 'raw' || k === 'regex' || k === 'bigint') continue;
        const child = node[k];
        if (child && typeof child === 'object') walk(child, node, k);
      }
    }

    walk(program, null, 'program');
    replacements.sort((a, b) => a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start));
    const chosen = [];
    let coveredEnd = -1;
    for (const r of replacements) {
      if (r.start < coveredEnd) continue;
      chosen.push(r);
      coveredEnd = r.end;
    }
    let code = '';
    let pos = 0;
    for (const r of chosen) {
      code += source.slice(pos, r.start) + r.text;
      pos = r.end;
    }
    code += source.slice(pos);
    return { code, diagnostics };
  }

  const api = { VERSION, init, rewriteScript, blockSource, get ready() { return ready; } };
  Object.defineProperty(globalThis, 'ZPRewriter', { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
})();
