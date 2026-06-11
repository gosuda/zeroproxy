const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function createDOMParsing({ childArray }) {
  class DOMParser {
    parseFromString(source, type) {
      return createDocumentFromHostSnapshot(hostParseDocument(source, type), type);
    }
  }
  Object.defineProperty(DOMParser.prototype, Symbol.toStringTag, { value: 'DOMParser', configurable: true });

  class XMLSerializer { serializeToString(node) { return serializeNode(node); } }
  Object.defineProperty(XMLSerializer.prototype, Symbol.toStringTag, { value: 'XMLSerializer', configurable: true });

  function serializeNode(node) {
    if (!node) return '';
    if (node.nodeType === 3) return escapeHTML(node.textContent || '');
    if (node.nodeType === 8) return '<!--' + String(node.textContent || '') + '-->';
    if (node.nodeType !== 1) return serializeChildren(node);
    const attrs = node.attributes ? [...node.attributes].map((attr) => ' ' + attr.name + '="' + escapeHTML(attr.value) + '"').join('') : '';
    const tagName = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? (node.nodeName || node.localName) : node.localName;
    const open = '<' + tagName + attrs + '>';
    return voidElements.has(node.localName) ? open : open + serializeChildren(node) + '</' + tagName + '>';
  }

  function serializeChildren(node) { return childArray(node).map(serializeNode).join(''); }

  function createHTMLDocument(title) {
    const doc = new Document('about:blank');
    const html = doc.createElement('html');
    const head = doc.createElement('head');
    const body = doc.createElement('body');
    doc.appendChild(html);
    html.appendChild(head);
    html.appendChild(body);
    doc.documentElement = html;
    doc.head = head;
    doc.body = body;
    doc.title = String(title || '');
    return doc;
  }

  function replaceChildrenFromHTML(parent, html, transformRecords = null) {
    const records = hostParseFragment(html, parent);
    replaceChildrenFromRecords(parent, typeof transformRecords === 'function' ? transformRecords(records) : records);
  }

  function replaceOuterHTML(node, html) {
    const parent = node.parentNode;
    if (!parent) return;
    const before = node.nextSibling;
    const fragment = parseHTMLFragment(node.ownerDocument, html, parent);
    parent.removeChild(node);
    while (fragment.firstChild) parent.insertBefore(fragment.firstChild, before);
  }

  function appendHTML(parent, html) {
    const fragment = parseHTMLFragment(parent.ownerDocument || parent, html, parent);
    while (fragment.firstChild) parent.appendChild(fragment.firstChild);
  }

  function fragmentFromHTML(contextNode, html) {
    return parseHTMLFragment(contextNode?.ownerDocument || contextNode || globalThis.document, html, contextNode);
  }

  function parseHTMLFragment(doc, html, contextNode) {
    const fragment = doc.createDocumentFragment();
    appendRecords(fragment, doc, hostParseFragment(html, contextNode));
    return fragment;
  }

  function createDocumentFromHostSnapshot(snapshot, type) {
    const doc = createHTMLDocument(snapshot?.title || '');
    doc.contentType = snapshot?.contentType || String(type || 'text/html');
    replaceChildrenFromRecords(doc.head, snapshot?.head || []);
    replaceChildrenFromRecords(doc.body, snapshot?.body || []);
    return doc;
  }

  function replaceChildrenFromRecords(parent, records) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    appendRecords(parent, parent.ownerDocument || parent, records);
  }

  function appendRecords(parent, doc, records) {
    for (const record of records || []) appendRecord(parent, doc, record);
  }

  function appendRecord(parent, doc, record) {
    if (!record || typeof record !== 'object') return;
    if (record.type === 'text') { parent.appendChild(doc.createTextNode(record.text || '')); return; }
    if (record.type === 'comment') { parent.appendChild(doc.createComment(record.text || '')); return; }
    if (record.type !== 'element' || !record.name) return;
    const element = record.namespaceURI ? doc.createElementNS(record.namespaceURI, record.name) : doc.createElement(record.name);
    applyHostAttributes(element, record.attributes);
    parent.appendChild(element);
    appendRecords(element, doc, record.children);
  }

  function applyHostAttributes(element, attributes) {
    for (const attr of attributes || []) {
      if (!attr?.name) continue;
      if (attr.namespaceURI) element.setAttributeNS(attr.namespaceURI, attr.name, attr.value || '');
      else element.setAttribute(attr.name, attr.value || '');
    }
  }

  function hostParseDocument(source, type) {
    return __zpHostParseHTMLDocument(String(source || ''), String(type || 'text/html'));
  }

  function hostParseFragment(html, contextNode) {
    const records = __zpHostParseHTMLFragment(String(html || ''), fragmentContext(contextNode));
    if (!Array.isArray(records)) throw new TypeError('Host DOMParser fragment bridge returned invalid snapshot');
    return records;
  }

  function fragmentContext(node) {
    return node?.nodeType === 1 ? { name: node.localName || 'div', namespaceURI: node.namespaceURI || '' } : null;
  }

  return { DOMParser, XMLSerializer, serializeNode, serializeChildren, createHTMLDocument, replaceChildrenFromHTML, replaceOuterHTML, appendHTML, fragmentFromHTML };
}

function escapeHTML(text) { return String(text || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
