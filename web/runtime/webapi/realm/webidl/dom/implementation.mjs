export function createDOMImplementationSupport(createHTMLDocument) {
  class DocumentType extends Node {
    constructor(name, publicId = '', systemId = '') {
      super(10, String(name || ''), null);
      Object.defineProperties(this, {
        __zpDoctypeName: { value: String(name || ''), configurable: true },
        __zpDoctypePublicId: { value: String(publicId || ''), configurable: true },
        __zpDoctypeSystemId: { value: String(systemId || ''), configurable: true },
      });
    }
  }

  function documentTypeNode(value, ownerDocument) {
    if (value && typeof value === 'object' && typeof value.nodeType === 'number') return value;
    return ownerDocument?.createTextNode?.(String(value)) ?? new Text(String(value));
  }

  Object.defineProperties(DocumentType.prototype, {
    name: { get() { return this.__zpDoctypeName ?? ''; }, enumerable: true, configurable: true },
    publicId: { get() { return this.__zpDoctypePublicId ?? ''; }, enumerable: true, configurable: true },
    systemId: { get() { return this.__zpDoctypeSystemId ?? ''; }, enumerable: true, configurable: true },
    before: { value: function before(...values) { if (!this.parentNode) return; for (const value of values) this.parentNode.insertBefore(documentTypeNode(value, this.ownerDocument), this); }, enumerable: true, writable: true, configurable: true },
    after: { value: function after(...values) { if (!this.parentNode) return; const before = this.nextSibling; for (const value of values) this.parentNode.insertBefore(documentTypeNode(value, this.ownerDocument), before); }, enumerable: true, writable: true, configurable: true },
    remove: { value: function remove() { if (this.parentNode) this.parentNode.removeChild(this); }, enumerable: true, writable: true, configurable: true },
    replaceWith: { value: function replaceWith(...values) { if (!this.parentNode) return; const parent = this.parentNode; const before = this.nextSibling; for (const value of values) parent.insertBefore(documentTypeNode(value, this.ownerDocument), before); parent.removeChild(this); }, enumerable: true, writable: true, configurable: true },
    [Symbol.unscopables]: { value: { after: true, before: true, remove: true, replaceWith: true }, configurable: true },
  });
  Object.defineProperty(DocumentType.prototype, Symbol.toStringTag, { value: 'DocumentType', configurable: true });

  class DOMImplementation {
    constructor(ownerDocument = null) { this.__zpOwnerDocument = ownerDocument; }
    createHTMLDocument(title = '') { return createHTMLDocument(String(title || '')); }
    createDocumentType(name, publicId, systemId) { return new DocumentType(name, arguments.length > 1 ? publicId : '', arguments.length > 2 ? systemId : ''); }
    createDocument(namespaceURI, qualifiedName, doctype = null) {
      const doc = new Document('about:blank');
      doc.contentType = 'application/xml';
      if (doctype) doc.appendChild(doctype);
      const tag = String(arguments.length > 1 ? qualifiedName : '');
      if (tag) {
        const ns = namespaceURI === null ? null : String(arguments.length > 0 ? namespaceURI : '');
        const root = doc.createElementNS(ns, tag);
        doc.appendChild(root);
        doc.documentElement = root;
      }
      return doc;
    }
    hasFeature() { return true; }
  }
  Object.defineProperty(DOMImplementation.prototype, Symbol.toStringTag, { value: 'DOMImplementation', configurable: true });

  function installDocumentImplementation(proto) {
    Object.defineProperty(proto, 'implementation', {
      get() {
        if (!this.__zpImplementation) this.__zpImplementation = new DOMImplementation(this);
        return this.__zpImplementation;
      },
      configurable: true,
    });
  }

  return { DOMImplementation, DocumentType, installDocumentImplementation };
}
