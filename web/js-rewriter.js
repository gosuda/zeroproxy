/* ZeroProxy Phase 3 JavaScript rewrite policy. Rust-WASM contract with strict JS fallback for local tests. */
(() => {
  'use strict';
  if (globalThis.ZPRewriter) return;

  const VERSION = 'phase3-rust-wasm-ast-1';
  const BLOCK_CODE = "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";
  const BLOCK_EXPR = "(()=>{" + BLOCK_CODE + "})()";
  const GLOBALS = new Set(['window', 'self', 'globalThis', 'location', 'document', 'history', 'top', 'parent', 'opener', 'frames', 'WebSocket', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction']);
  const MEMBER_HELPER_PROPS = new Set(['location', 'defaultView', 'contentWindow', 'contentDocument', 'top', 'parent', 'opener', 'frames', 'constructor', 'postMessage']);
  const CALL_HELPER_PROPS = new Set(['assign', 'replace', 'open', 'get', 'getOwnPropertyDescriptor', 'defineProperty']);
  const COMPOUND_ASSIGNMENT_OPERATORS = new Set(['+=','-=','*=','/=','%=','**=','<<=','>>=','>>>=','&=','^=','|=','&&=','||=','??=']);
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
  function initSync(options = {}) {
    if (ready) return true;
    const p = options.parser || globalThis.OXCParser;
    if (!p || typeof p.parseSync !== 'function') throw new Error('REALM_INJECTION_FAILURE');
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
    const rust = globalThis.ZPRustRewriter;
    if (rust && typeof rust.rewriteScript === 'function') {
      try {
        const out = rust.rewriteScript(source, kind, options.url || options.targetUrl || '', options.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/');
        if (out && out.ok && typeof out.code === 'string') return ok(out.code, []);
        if (out && out.error === 'PARSE_FAILED') return blocked('PARSE_FAILED');
      } catch {}
    }
    if (!ready || !parser) return blocked('REWRITE_FAILED');
    if (kind === 'event-handler') return rewriteEventHandler(source, options);
    if (kind === 'function') return rewriteFunctionBody(source, options);
    const parsed = parse(source, kind === 'module' ? 'module' : 'script', options.url || options.targetUrl || 'target.js');
    if (!parsed.ok) return parsed;
    const rewritten = rewriteProgram(source, parsed.program, { module: kind === 'module', targetUrl: options.url || options.targetUrl || '' });
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

  function parserFilename(filename) {
    let value = String(filename || 'target.js');
    let end = value.length;
    const query = value.indexOf('?');
    const hash = value.indexOf('#');
    if (query !== -1 && query < end) end = query;
    if (hash !== -1 && hash < end) end = hash;
    if (end !== value.length) value = value.slice(0, end);
    if (!value || value.endsWith('/') || value.endsWith('\\')) return 'target.js';
    return /\.[cm]?js$/i.test(value) ? value : value + '.js';
  }

  function parse(source, sourceType, filename) {
    let result;
    try { result = parser.parseSync(source, { sourceType, sourceFilename: parserFilename(filename) }); }
    catch (err) { return blocked('PARSE_FAILED', [{ level: 'error', message: err && err.message || 'PARSE_FAILED' }]); }
    const errors = result.errors || [];
    if (errors.length) return blocked('PARSE_FAILED', errors.map(e => ({ level: e.severity || 'error', message: e.message || 'PARSE_FAILED', start: e.start, end: e.end })));
    return { ok: true, program: result.program, diagnostics: [] };
  }

  function rewriteProgram(source, program, options = {}) {
    const replacements = [];
    const diagnostics = [];
    const scopeStack = [];
    const globalIds = new WeakSet();
    const renderedCache = new WeakMap();
    const moduleTargetURL = options.module ? String(options.targetUrl || '') : '';
    const controlPrefix = String(options.controlPrefix || globalThis.ZP && globalThis.ZP.CONTROL_PREFIX || '/zp/');

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
    function stringNodeValue(node) {
      if (!node) return '';
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'StringLiteral') return node.value;
      return '';
    }
    function moduleSpecifier(raw) {
      const spec = String(raw);
      if (!moduleTargetURL) return spec;
      if (isBareSpecifier(spec)) return resolveImportMap(spec) || spec;
      if (hasScheme(spec) && !/^https?:/i.test(spec)) return controlPrefix + 'error/POLICY_BLOCKED';
      try {
        const abs = new URL(spec, moduleTargetURL);
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return controlPrefix + 'error/POLICY_BLOCKED';
        return controlPrefix + 'api/script?kind=module&u=' + encodeURIComponent(abs.href);
      } catch {
        return controlPrefix + 'error/POLICY_BLOCKED';
      }
    }
    function isBareSpecifier(spec) { return !spec.startsWith('/') && !spec.startsWith('./') && !spec.startsWith('../') && !hasScheme(spec); }
    function hasScheme(spec) { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec); }
    function resolveImportMap(spec) {
      const map = options.importMap;
      if (!map || typeof map !== 'object') return '';
      const imports = map.imports && typeof map.imports === 'object' ? map.imports : null;
      if (!imports) return '';
      if (typeof imports[spec] === 'string') return moduleSpecifier(imports[spec]);
      let best = '';
      for (const key of Object.keys(imports)) if (key.endsWith('/') && spec.startsWith(key) && key.length > best.length && typeof imports[key] === 'string') best = key;
      return best ? moduleSpecifier(imports[best] + spec.slice(best.length)) : '';
    }
    function isGlobalIdentifier(node) { return node && node.type === 'Identifier' && GLOBALS.has(node.name) && !declared(node.name); }
    function isPattern(node) { return node && (node.type === 'ObjectPattern' || node.type === 'ArrayPattern' || node.type === 'AssignmentPattern' || node.type === 'RestElement'); }
    function isWindowLikeGlobal(node) { return node && node.type === 'Identifier' && !declared(node.name) && (node.name === 'window' || node.name === 'self' || node.name === 'globalThis' || node.name === 'top' || node.name === 'parent' || node.name === 'frames' || node.name === 'document'); }
    function isReferenceIdentifier(node, parent, key) {
      if (!node || node.type !== 'Identifier') return false;
      if (!parent) return true;
      if ((parent.type === 'VariableDeclarator' && key === 'id') || (parent.type === 'FunctionDeclaration' && key === 'id') || (parent.type === 'FunctionExpression' && key === 'id') || (parent.type === 'ClassDeclaration' && key === 'id') || (parent.type === 'ClassExpression' && key === 'id')) return false;
      if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return false;
      if ((parent.type === 'Property' || parent.type === 'ObjectProperty' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && key === 'key' && !parent.computed) return false;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
      if (parent.type && parent.type.startsWith('Import')) return false;
      return true;
    }

    function memberNeedsHelper(node) {
      if (!node) return false;
      if (node.type === 'ChainExpression') return memberNeedsHelper(node.expression);
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
      if (node.object && node.object.type === 'Super') return false;
      const name = propName(node.property, node.computed);
      return MEMBER_HELPER_PROPS.has(name) || (node.computed && isWindowLikeGlobal(node.object));
    }
    function isConstructorEscapeMember(node) {
      if (!node) return false;
      if (node.type === 'ChainExpression') return isConstructorEscapeMember(node.expression);
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
      if (propName(node.property, node.computed) !== 'constructor') return false;
      let base = node.object;
      if (base && base.type === 'ChainExpression') base = base.expression;
      if (!base) return false;
      if (base.type === 'Identifier') return isGlobalIdentifier(base) && (base.name === 'Function' || base.name === 'AsyncFunction' || base.name === 'GeneratorFunction' || base.name === 'AsyncGeneratorFunction');
      return (base.type === 'MemberExpression' || base.type === 'OptionalMemberExpression') && propName(base.property, base.computed) === 'constructor';
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
    function collectBodyBindings(body, names, mode) {
      for (const stmt of body || []) collectStatementBindings(stmt, names, mode || 'block');
      return names;
    }
    function collectStatementBindings(stmt, names, mode) {
      if (!stmt) return;
      if (stmt.type === 'ImportDeclaration') { for (const s of stmt.specifiers || []) collectPattern(s.local, names); return; }
      if (stmt.type === 'FunctionDeclaration') { collectPattern(stmt.id, names); return; }
      if (stmt.type === 'ClassDeclaration') { collectPattern(stmt.id, names); return; }
      if (stmt.type === 'VariableDeclaration') {
        if (mode === 'function' ? stmt.kind === 'var' : (mode === 'function-root' || stmt.kind !== 'var')) for (const d of stmt.declarations || []) collectPattern(d.id, names);
        return;
      }
      if (mode !== 'function' && mode !== 'function-root') return;
      const childMode = mode === 'function-root' ? 'function' : mode;
      if (stmt.type === 'BlockStatement') { for (const child of stmt.body || []) collectStatementBindings(child, names, childMode); return; }
      if (stmt.type === 'IfStatement') { collectStatementBindings(stmt.consequent, names, childMode); collectStatementBindings(stmt.alternate, names, childMode); return; }
      if (stmt.type === 'ForStatement') { collectStatementBindings(stmt.init, names, childMode); collectStatementBindings(stmt.body, names, childMode); return; }
      if (stmt.type === 'ForInStatement' || stmt.type === 'ForOfStatement') { collectStatementBindings(stmt.left, names, childMode); collectStatementBindings(stmt.body, names, childMode); return; }
      if (stmt.type === 'WhileStatement' || stmt.type === 'DoWhileStatement' || stmt.type === 'WithStatement' || stmt.type === 'LabeledStatement') { collectStatementBindings(stmt.body, names, childMode); return; }
      if (stmt.type === 'SwitchStatement') for (const c of stmt.cases || []) for (const child of c.consequent || []) collectStatementBindings(child, names, childMode);
      if (stmt.type === 'TryStatement') { collectStatementBindings(stmt.block, names, childMode); collectStatementBindings(stmt.handler && stmt.handler.body, names, childMode); collectStatementBindings(stmt.finalizer, names, childMode); }
    }
    function collectParams(node, names) { for (const p of node.params || []) collectPattern(p, names); return names; }

    function render(node) {
      if (!node) return '';
      if (renderedCache.has(node)) return renderedCache.get(node);
      let out = src(node);
      if (node.type === 'Identifier' && (globalIds.has(node) || isGlobalIdentifier(node))) out = '__zp_get(globalThis,' + JSON.stringify(node.name) + ')';
      else if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        if (memberNeedsHelper(node)) out = '__zp_get(' + render(node.object) + ',' + propCode(node.property, node.computed) + ')';
        else if (node.computed) out = render(node.object) + '[' + render(node.property) + ']';
        else out = render(node.object) + source.slice(node.object.end, node.property.start) + src(node.property);
      } else if (node.type === 'ChainExpression') out = render(node.expression);
      renderedCache.set(node, out);
      return out;
    }
    function exprCode(node) {
      if (!node) return '';
      if (node.type === 'Identifier' || node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression' || node.type === 'ChainExpression') return render(node);
      if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return exprCode(node.left) + source.slice(node.left.end, node.right.start) + exprCode(node.right);
      if (node.type === 'ConditionalExpression') return exprCode(node.test) + source.slice(node.test.end, node.consequent.start) + exprCode(node.consequent) + source.slice(node.consequent.end, node.alternate.start) + exprCode(node.alternate);
      if (node.type === 'ObjectExpression') {
        const parts = [];
        for (const p of node.properties || []) {
          if (!p) continue;
          if (p.type === 'SpreadElement') { parts.push('...' + exprCode(p.argument)); continue; }
          if ((p.type === 'Property' || p.type === 'ObjectProperty') && p.key && p.value) {
            if (p.method || p.kind === 'get' || p.kind === 'set') { parts.push(src(p)); continue; }
            if (p.shorthand && p.key.type === 'Identifier' && p.value.type === 'Identifier') parts.push(src(p.key) + ': ' + exprCode(p.value));
            else {
              const keyText = p.computed ? source.slice(p.start, p.key.start) + exprCode(p.key) + source.slice(p.key.end, p.value.start) : src(p.key) + source.slice(p.key.end, p.value.start);
              parts.push(keyText + exprCode(p.value));
            }
            continue;
          }
          parts.push(src(p));
        }
        return '{' + parts.join(',') + '}';
      }
      if (node.type === 'ArrayExpression') return '[' + (node.elements || []).map(e => e ? exprCode(e) : '').join(',') + ']';
      if (node.type === 'UnaryExpression' || node.type === 'UpdateExpression') {
        if (node.prefix) return source.slice(node.start, node.argument.start) + exprCode(node.argument);
        return exprCode(node.argument) + source.slice(node.argument.end, node.end);
      }
      return src(node);
    }

    function isVirtualWindowExpr(node) {
      if (!node) return false;
      if (node.type === 'ChainExpression') return isVirtualWindowExpr(node.expression);
      if (node.type === 'Identifier') return isGlobalIdentifier(node) && (node.name === 'window' || node.name === 'self' || node.name === 'globalThis' || node.name === 'top' || node.name === 'parent' || node.name === 'opener' || node.name === 'frames');
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
      const name = propName(node.property, node.computed);
      if ((name === 'defaultView' || name === 'contentWindow') && MEMBER_HELPER_PROPS.has(name)) return true;
      return (name === 'window' || name === 'self' || name === 'globalThis' || name === 'top' || name === 'parent' || name === 'opener' || name === 'frames') && isVirtualWindowExpr(node.object);
    }

    function isVirtualLocationExpr(node) {
      if (!node) return false;
      if (node.type === 'ChainExpression') return isVirtualLocationExpr(node.expression);
      if (node.type === 'Identifier') return isGlobalIdentifier(node) && node.name === 'location';
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return false;
      const name = propName(node.property, node.computed);
      return name === 'location' && isVirtualWindowExpr(node.object) || node.computed && isVirtualWindowExpr(node.object);
    }

    function assignmentSetTarget(node) {
      if (!node) return null;
      if (node.type === 'ChainExpression') return assignmentSetTarget(node.expression);
      if (node.type === 'Identifier' && isGlobalIdentifier(node) && (node.name === 'location' || node.name === 'window')) return { base: 'globalThis', prop: JSON.stringify(node.name) };
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return null;
      const name = propName(node.property, node.computed);
      if (name === 'location' && isVirtualWindowExpr(node.object)) return { base: render(node.object), prop: propCode(node.property, node.computed) };
      if ((name === 'href' || name === 'hash') && isVirtualLocationExpr(node.object)) return { base: render(node.object), prop: propCode(node.property, node.computed) };
      if (node.computed && (isVirtualWindowExpr(node.object) || isVirtualLocationExpr(node.object))) return { base: render(node.object), prop: propCode(node.property, node.computed) };
      return null;
    }
    function argList(args) {
      return (args || []).map(exprCode).join(',');
    }

    function constructTarget(node) {
      if (!node) return '';
      if (node.type === 'ChainExpression') return constructTarget(node.expression);
      if (node.type === 'Identifier' && isGlobalIdentifier(node)) return render(node);
      if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && isVirtualWindowExpr(node.object)) return render(node);
      return '';
    }


    function enterNode(node, parent, key) {
      if (!node || typeof node.type !== 'string') return false;
      switch (node.type) {
        case 'Program': {
          pushScope(collectBodyBindings(node.body, new Set(), 'function-root'));
          for (const child of node.body || []) walk(child, node, 'body');
          popScope();
          return true;
        }
        case 'BlockStatement': {
          pushScope(collectBodyBindings(node.body, new Set(), 'block'));
          for (const child of node.body || []) walk(child, node, 'body');
          popScope();
          return true;
        }
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          if (node.type !== 'ArrowFunctionExpression' && node.id) declare(node.id.name);
          pushScope(collectBodyBindings(node.body && node.body.body || [], collectParams(node, new Set()), 'function-root'));
          if (node.id && node.type === 'FunctionExpression') declare(node.id.name);
          for (const param of node.params || []) walkPattern(param);
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
          const target = assignmentSetTarget(node.left) || helperSetTarget(node.left);
          if (node.operator !== '=') {
            if (target && COMPOUND_ASSIGNMENT_OPERATORS.has(node.operator)) {
              const rhs = node.operator === '&&=' || node.operator === '||=' || node.operator === '??=' ? '()=>(' + exprCode(node.right) + ')' : exprCode(node.right);
              addReplacement(node, '(__zp_assign(' + target.base + ',' + target.prop + ',' + JSON.stringify(node.operator) + ',' + rhs + '))', 100);
              return true;
            }
            if (containsDangerousLHS(node.left)) {
              addReplacement(node, BLOCK_EXPR, 100);
              diagnostics.push({ level: 'warning', message: 'blocked compound assignment touching virtualized browser state', start: node.start, end: node.end });
              return true;
            }
          }
          if (node.operator === '=' && target) {
            addReplacement(node, '(__zp_set(' + target.base + ',' + target.prop + ',' + exprCode(node.right) + '))', 100);
            return true;
          }
          walkAssignmentTarget(node.left);
          if (node.right) walk(node.right, node, 'right');
          return true;
        }
        case 'UpdateExpression': {
          if (containsDangerousLHS(node.argument)) {
            addReplacement(node, BLOCK_EXPR, 100);
            diagnostics.push({ level: 'warning', message: 'blocked update touching virtualized browser state', start: node.start, end: node.end });
            return true;
          }
          walkAssignmentTarget(node.argument);
          return true;
        }
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
        case 'ExportNamedDeclaration': {
          const spec = stringNodeValue(node.source);
          if (spec) addReplacement(node.source, JSON.stringify(moduleSpecifier(spec)), 95);
          break;
        }
        case 'ImportExpression': {
          const spec = stringNodeValue(node.source);
          if (spec) {
            addReplacement(node.source, JSON.stringify(moduleSpecifier(spec)), 95);
            return true;
          }
          addReplacement(node.source, '__zp_module_url(' + exprCode(node.source) + ',' + JSON.stringify(moduleTargetURL) + ')', 95);
          return true;
        }
        case 'MetaProperty': {
          return false;
        }
        case 'CallExpression':
        case 'NewExpression': {
          const callee = node.callee;
          const args = argList(node.arguments);
          if (callee && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')) {
            const name = propName(callee.property, callee.computed);
            if (callee.object && callee.object.type !== 'Super' && (CALL_HELPER_PROPS.has(name) || memberNeedsHelper(callee))) {
              if (node.type === 'NewExpression' && name === 'constructor' && !isConstructorEscapeMember(callee)) break;
              const call = '(__zp_call(' + render(callee.object) + ',' + propCode(callee.property, callee.computed) + ',[' + args + ']))';
              addReplacement(node, node.type === 'NewExpression' ? BLOCK_EXPR : call, 90);
              if (node.type === 'NewExpression') diagnostics.push({ level: 'warning', message: 'blocked construction through virtualized browser state', start: node.start, end: node.end });
              return true;
            }
          }
          if (node.type === 'NewExpression') {
            const ctor = constructTarget(callee);
            if (ctor) {
              addReplacement(node, '(__zp_construct(' + ctor + ',[' + args + ']))', 90);
              return true;
            }
          }
          break;
        }
        case 'VariableDeclaration': {
          for (const declaration of node.declarations || []) collectPattern(declaration.id, scopeStack[scopeStack.length - 1]);
          for (const declaration of node.declarations || []) walk(declaration, node, 'declarations');
          return true;
        }
        case 'ForStatement': {
          const scoped = node.init && node.init.type === 'VariableDeclaration' && node.init.kind !== 'var';
          if (scoped) pushScope(new Set());
          if (node.init) walk(node.init, node, 'init');
          if (node.test) walk(node.test, node, 'test');
          if (node.update) walk(node.update, node, 'update');
          if (node.body) walk(node.body, node, 'body');
          if (scoped) popScope();
          return true;
        }
        case 'ForInStatement':
        case 'ForOfStatement': {
          const scoped = node.left && node.left.type === 'VariableDeclaration' && node.left.kind !== 'var';
          if (scoped) pushScope(new Set());
          if (node.left) {
            if (node.left.type === 'VariableDeclaration') walk(node.left, node, 'left');
            else walkAssignmentTarget(node.left);
          }
          if (node.right) walk(node.right, node, 'right');
          if (node.body) walk(node.body, node, 'body');
          if (scoped) popScope();
          return true;
        }
        case 'VariableDeclarator': {
          walkPattern(node.id);
          if (node.init) walk(node.init, node, 'init');
          return true;
        }
        case 'PropertyDefinition':
        case 'AccessorProperty': {
          if (node.computed && node.key) walk(node.key, node, 'key');
          if (node.value) walk(node.value, node, 'value');
          return true;
        }
        case 'Property': {
          if (parent && parent.type === 'ObjectPattern') {
            walkPattern(node);
            return true;
          }
          if (node.computed && node.key) walk(node.key, node, 'key');
          if (node.shorthand && node.value && node.value.type === 'Identifier' && isGlobalIdentifier(node.value)) {
            globalIds.add(node.value);
            addReplacement(node, src(node.key) + ': ' + render(node.value), 90);
            return true;
          }
          if (node.value) walk(node.value, node, 'value');
          return true;
        }
        case 'MemberExpression':
        case 'OptionalMemberExpression': {
          if (node.object && node.object.type === 'MetaProperty' && src(node.object) === 'import.meta' && propName(node.property, node.computed) === 'url' && moduleTargetURL) {
            addReplacement(node, JSON.stringify(moduleTargetURL), 90);
            return true;
          }
          if (memberNeedsHelper(node)) {
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
      if (node.type === 'ChainExpression') return containsDangerousLHS(node.expression);
      return !!assignmentSetTarget(node);
    }

    function helperSetTarget(node) {
      if (!node) return null;
      if (node.type === 'ParenthesizedExpression' || node.type === 'ChainExpression') return helperSetTarget(node.expression);
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return null;
      if (!memberNeedsHelper(node)) return null;
      return { base: render(node.object), prop: propCode(node.property, node.computed) };
    }

    function walkPattern(node) {
      if (!node) return;
      if (node.type === 'ObjectPattern') {
        for (const prop of node.properties || []) walkPattern(prop);
        return;
      }
      if (node.type === 'ArrayPattern') {
        for (const elem of node.elements || []) walkPattern(elem);
        return;
      }
      if (node.type === 'RestElement') {
        walkPattern(node.argument);
        return;
      }
      if (node.type === 'AssignmentPattern') {
        walkPattern(node.left);
        if (node.right) walk(node.right, node, 'right');
        return;
      }
      if (node.type === 'Property') {
        if (node.computed && node.key) walk(node.key, node, 'key');
        walkPattern(node.value);
        return;
      }
    }

    function walkAssignmentTarget(node) {
      if (!node) return;
      if (isPattern(node)) {
        walkPattern(node);
        return;
      }
      if (node.type === 'ParenthesizedExpression' || node.type === 'ChainExpression') {
        walkAssignmentTarget(node.expression);
        return;
      }
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        if (node.object) walk(node.object, node, 'object');
        if (node.computed && node.property) walk(node.property, node, 'property');
      }
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

  const api = { VERSION, init, initSync, rewriteScript, blockSource, get ready() { return ready; } };
  Object.defineProperty(globalThis, 'ZPRewriter', { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
})();
