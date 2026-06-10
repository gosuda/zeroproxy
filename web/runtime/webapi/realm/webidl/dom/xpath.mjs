const xpathExpressionToken = {};
const xpathResultToken = {};

const XPathResultConstants = Object.freeze({
  ANY_TYPE: 0,
  NUMBER_TYPE: 1,
  STRING_TYPE: 2,
  BOOLEAN_TYPE: 3,
  UNORDERED_NODE_ITERATOR_TYPE: 4,
  ORDERED_NODE_ITERATOR_TYPE: 5,
  UNORDERED_NODE_SNAPSHOT_TYPE: 6,
  ORDERED_NODE_SNAPSHOT_TYPE: 7,
  ANY_UNORDERED_NODE_TYPE: 8,
  FIRST_ORDERED_NODE_TYPE: 9,
});

export function createXPathFacades() {
  class XPathExpression {
    constructor(token, expression, resolver) {
      if (token !== xpathExpressionToken) throw new TypeError("Failed to construct 'XPathExpression': Illegal constructor");
      defineHidden(this, '__zpExpression', String(expression));
      defineHidden(this, '__zpResolver', resolver ?? null);
    }

    evaluate(contextNode, type = XPathResultConstants.ANY_TYPE, result = null) {
      return evaluateXPath(this.__zpExpression, contextNode, this.__zpResolver, type, result);
    }
  }
  Object.defineProperty(XPathExpression.prototype, Symbol.toStringTag, { value: 'XPathExpression', configurable: true });

  class XPathResult {
    constructor(token, record = {}) {
      if (token !== xpathResultToken) throw new TypeError("Failed to construct 'XPathResult': Illegal constructor");
      setXPathResult(this, record);
    }

    get resultType() { return this.__zpResultType; }
    get numberValue() { requireResultKind(this, 'number'); return this.__zpNumberValue; }
    get stringValue() { requireResultKind(this, 'string'); return this.__zpStringValue; }
    get booleanValue() { requireResultKind(this, 'boolean'); return this.__zpBooleanValue; }
    get singleNodeValue() { requireResultKind(this, 'single'); return this.__zpNodes[0] || null; }
    get invalidIteratorState() { requireResultKind(this, 'iterator'); return false; }
    get snapshotLength() { requireResultKind(this, 'snapshot'); return this.__zpNodes.length; }

    iterateNext() {
      requireResultKind(this, 'iterator');
      const node = this.__zpNodes[this.__zpIteratorIndex] || null;
      defineHidden(this, '__zpIteratorIndex', this.__zpIteratorIndex + 1);
      return node;
    }

    snapshotItem(index) {
      requireResultKind(this, 'snapshot');
      return this.__zpNodes[Number(index)] || null;
    }
  }
  Object.defineProperty(XPathResult.prototype, Symbol.toStringTag, { value: 'XPathResult', configurable: true });
  installResultConstants(XPathResult);

  class XPathEvaluator {
    createExpression(expression, resolver = null) {
      return new XPathExpression(xpathExpressionToken, expression, resolver);
    }

    createNSResolver(nodeResolver) {
      return nodeResolver ?? null;
    }

    evaluate(expression, contextNode, resolver = null, type = XPathResultConstants.ANY_TYPE, result = null) {
      return evaluateXPath(String(expression), contextNode, resolver, type, result);
    }
  }
  Object.defineProperty(XPathEvaluator.prototype, Symbol.toStringTag, { value: 'XPathEvaluator', configurable: true });

  function evaluateXPath(expression, contextNode, resolver, requestedType, result) {
    const evaluated = evaluateExpression(expression, contextNode, resolver);
    const record = resultRecord(evaluated, requestedType);
    if (result instanceof XPathResult) {
      setXPathResult(result, record);
      return result;
    }
    return new XPathResult(xpathResultToken, record);
  }

  return { XPathEvaluator, XPathExpression, XPathResult };
}

function installResultConstants(XPathResult) {
  for (const [name, value] of Object.entries(XPathResultConstants)) {
    Object.defineProperty(XPathResult, name, { value, enumerable: true, configurable: false });
    Object.defineProperty(XPathResult.prototype, name, { value, enumerable: true, configurable: false });
  }
}

function evaluateExpression(expression, contextNode, resolver) {
  const text = String(expression || '').trim();
  const scalar = scalarExpression(text, contextNode, resolver);
  if (scalar) return scalar;
  return { kind: 'nodes', nodes: selectXPathNodes(text, contextNode, resolver) };
}

function scalarExpression(text, contextNode, resolver) {
  const call = /^([a-z]+)\((.*)\)$/u.exec(text);
  if (!call) return null;
  const nodes = selectXPathNodes(call[2], contextNode, resolver);
  if (call[1] === 'string') return { kind: 'string', value: String(nodes[0]?.textContent || '') };
  if (call[1] === 'count') return { kind: 'number', value: nodes.length };
  if (call[1] === 'boolean') return { kind: 'boolean', value: nodes.length > 0 };
  return null;
}

function resultRecord(evaluated, requestedType) {
  const type = normalizeResultType(evaluated, requestedType);
  const nodes = evaluated.kind === 'nodes' ? evaluated.nodes : [];
  return {
    type,
    nodes,
    numberValue: evaluated.kind === 'number' ? evaluated.value : nodes.length,
    stringValue: evaluated.kind === 'string' ? evaluated.value : String(nodes[0]?.textContent || ''),
    booleanValue: evaluated.kind === 'boolean' ? evaluated.value : nodes.length > 0,
  };
}

function normalizeResultType(evaluated, requestedType) {
  const type = Number(requestedType) || XPathResultConstants.ANY_TYPE;
  if (type !== XPathResultConstants.ANY_TYPE) return type;
  if (evaluated.kind === 'number') return XPathResultConstants.NUMBER_TYPE;
  if (evaluated.kind === 'string') return XPathResultConstants.STRING_TYPE;
  if (evaluated.kind === 'boolean') return XPathResultConstants.BOOLEAN_TYPE;
  return XPathResultConstants.UNORDERED_NODE_ITERATOR_TYPE;
}

function selectXPathNodes(expression, contextNode, resolver) {
  const text = String(expression || '').trim();
  if (!contextNode) return [];
  if (text === '.') return [contextNode];
  const idMatch = /^id\(["']([^"']+)["']\)$/u.exec(text);
  if (idMatch) return nodeById(contextNode, idMatch[1]);
  const descendant = /^(?:\.?)\/\/([*]|[A-Za-z_][\w:-]*)(?:\[@([\w:-]+)=["']([^"']*)["']\])?$/u.exec(text);
  if (descendant) return matchingDescendants(contextNode, descendant[1], descendant[2], descendant[3]);
  const absolute = /^\/([A-Za-z_][\w:-]*(?:\/[A-Za-z_][\w:-]*)*)$/u.exec(text);
  if (absolute) return absolutePath(contextNode, absolute[1].split('/'));
  void resolver;
  return [];
}

function nodeById(contextNode, id) {
  const doc = contextNode.nodeType === 9 ? contextNode : contextNode.ownerDocument;
  const found = doc?.getElementById?.(id) || null;
  return found ? [found] : [];
}

function matchingDescendants(contextNode, tagName, attrName, attrValue) {
  const out = [];
  visitDescendants(contextNode, (node) => {
    if (matchesStep(node, tagName, attrName, attrValue)) out.push(node);
  });
  return out;
}

function absolutePath(contextNode, parts) {
  const doc = contextNode.nodeType === 9 ? contextNode : contextNode.ownerDocument;
  let node = doc?.documentElement || null;
  const start = parts[0] && matchesStep(node, parts[0]) ? 1 : 0;
  for (let index = start; node && index < parts.length; index += 1) {
    node = childElements(node).find((child) => matchesStep(child, parts[index])) || null;
  }
  return node ? [node] : [];
}

function visitDescendants(node, callback) {
  for (const child of Array.from(node?.childNodes || [])) {
    callback(child);
    visitDescendants(child, callback);
  }
}

function childElements(node) {
  return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
}

function matchesStep(node, tagName, attrName = undefined, attrValue = undefined) {
  if (!node || node.nodeType !== 1) return false;
  if (tagName !== '*' && String(node.localName || node.nodeName || '').toLowerCase() !== String(tagName).toLowerCase()) return false;
  if (!attrName) return true;
  return String(node.getAttribute?.(attrName) ?? '') === String(attrValue);
}

function requireResultKind(result, kind) {
  const type = result.__zpResultType;
  if (kind === 'number' && type === XPathResultConstants.NUMBER_TYPE) return;
  if (kind === 'string' && type === XPathResultConstants.STRING_TYPE) return;
  if (kind === 'boolean' && type === XPathResultConstants.BOOLEAN_TYPE) return;
  if (kind === 'single' && (type === XPathResultConstants.ANY_UNORDERED_NODE_TYPE || type === XPathResultConstants.FIRST_ORDERED_NODE_TYPE)) return;
  if (kind === 'iterator' && (type === XPathResultConstants.UNORDERED_NODE_ITERATOR_TYPE || type === XPathResultConstants.ORDERED_NODE_ITERATOR_TYPE)) return;
  if (kind === 'snapshot' && (type === XPathResultConstants.UNORDERED_NODE_SNAPSHOT_TYPE || type === XPathResultConstants.ORDERED_NODE_SNAPSHOT_TYPE)) return;
  throw new TypeError("Failed to read the XPathResult value: The result type does not match the requested property.");
}

function setXPathResult(target, record) {
  defineHidden(target, '__zpResultType', record.type ?? XPathResultConstants.ANY_TYPE);
  defineHidden(target, '__zpNodes', Array.from(record.nodes || []));
  defineHidden(target, '__zpNumberValue', Number(record.numberValue ?? 0));
  defineHidden(target, '__zpStringValue', String(record.stringValue ?? ''));
  defineHidden(target, '__zpBooleanValue', Boolean(record.booleanValue));
  defineHidden(target, '__zpIteratorIndex', 0);
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
