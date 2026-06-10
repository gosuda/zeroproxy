export class Attr {
  constructor(name, value = '', namespaceURI = '', ownerElement = null) {
    Object.defineProperties(this, {
      __zpName: { value: String(name), writable: true, configurable: true },
      __zpLocalName: { value: localNameForAttr(String(name)), writable: true, configurable: true },
      __zpPrefix: { value: prefixForAttr(String(name)), writable: true, configurable: true },
      __zpNamespaceURI: { value: namespaceURI ? String(namespaceURI) : null, writable: true, configurable: true },
      __zpOwnerElement: { value: ownerElement, writable: true, configurable: true },
      __zpSpecified: { value: true, writable: true, configurable: true },
      __zpNodeType: { value: 2, writable: true, configurable: true },
      __zpValue: { value: String(value), writable: true, configurable: true },
    });
  }

  get namespaceURI() { return this.__zpNamespaceURI; }
  get prefix() { return this.__zpPrefix; }
  get localName() { return this.__zpLocalName; }
  get name() { return this.__zpName; }
  get ownerElement() { return this.__zpOwnerElement; }
  get specified() { return this.__zpSpecified; }

  get value() { return attrValueForNode(this) ?? this.__zpValue; }
  set value(value) {
    this.__zpValue = String(value);
    if (!this.ownerElement) return;
    if (this.namespaceURI) this.ownerElement.setAttributeNS?.(this.namespaceURI, this.name, this.__zpValue);
    else this.ownerElement.setAttribute?.(this.name, this.__zpValue);
  }

}
Object.defineProperty(Attr.prototype, Symbol.toStringTag, { value: 'Attr', configurable: true });

export function installElementAttrNodeReflections(proto) {
  proto.getAttributeNode = function getAttributeNode(name) { return attrNodeForElement(this, '', name); };
  proto.getAttributeNodeNS = function getAttributeNodeNS(namespaceURI, localName) { return attrNodeForElement(this, namespaceURI, localName); };
  proto.setAttributeNode = function setAttributeNode(attr) { return setAttrNodeForElement(this, attr, false); };
  proto.setAttributeNodeNS = function setAttributeNodeNS(attr) { return setAttrNodeForElement(this, attr, true); };
  proto.removeAttributeNode = removeAttributeNode;
  proto.hasAttributeNS = function hasAttributeNS(namespaceURI, localName) { return this.getAttributeNS?.(namespaceURI, localName) !== null; };
  proto.hasAttributes = function hasAttributes() { return this.attributes?.size > 0 || Number(this.attributes?.length || 0) > 0; };
}

function removeAttributeNode(attr) {
  const node = attrNodeForElement(this, attr?.namespaceURI || '', attr?.localName || attr?.name || '');
  if (!node) throw namedError('NotFoundError');
  if (attr?.namespaceURI) this.removeAttributeNS?.(attr.namespaceURI, attr.localName || attr.name);
  else this.removeAttribute?.(attr.name);
  Object.defineProperty(attr, '__zpOwnerElement', { value: null, writable: true, configurable: true });
  return attr;
}

function attrNodeForElement(element, namespaceURI, name) {
  const ns = namespaceURI ? String(namespaceURI) : '';
  const key = String(name);
  const value = ns ? element.getAttributeNS?.(ns, key) : element.getAttribute?.(key);
  return value === null || value === undefined ? null : new Attr(key, value, ns, element);
}

function setAttrNodeForElement(element, attr, useNamespace) {
  if (!(attr instanceof Attr)) throw namedError('TypeError');
  const old = attrNodeForElement(element, useNamespace ? attr.namespaceURI : '', useNamespace ? attr.localName : attr.name);
  if (old) Object.defineProperty(old, '__zpOwnerElement', { value: null, writable: true, configurable: true });
  if (useNamespace && attr.namespaceURI) element.setAttributeNS?.(attr.namespaceURI, attr.name, attr.value);
  else element.setAttribute?.(attr.name, attr.value);
  Object.defineProperty(attr, '__zpOwnerElement', { value: element, writable: true, configurable: true });
  return old;
}

function attrValueForNode(attr) {
  if (!attr.ownerElement) return null;
  return attr.namespaceURI ? attr.ownerElement.getAttributeNS?.(attr.namespaceURI, attr.localName) : attr.ownerElement.getAttribute?.(attr.name);
}

function localNameForAttr(name) {
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}

function prefixForAttr(name) {
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(0, index) : null;
}

function namedError(name) {
  return typeof DOMException === 'function' ? new DOMException(name, name) : Object.assign(new Error(name), { name });
}
