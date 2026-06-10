export function createDOMImplementationSupport(createHTMLDocument) {
  class DocumentType extends Node {
    constructor(name, publicId = '', systemId = '') {
      super(10, String(name || ''), null);
      this.name = String(name || '');
      this.publicId = String(publicId || '');
      this.systemId = String(systemId || '');
    }
  }
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
