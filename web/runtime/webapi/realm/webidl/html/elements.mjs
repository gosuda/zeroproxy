const HTML_NS = 'http://www.w3.org/1999/xhtml';

const htmlTagInterfaceEntries = Object.freeze([
  ['a', 'HTMLAnchorElement'],
  ['area', 'HTMLAreaElement'],
  ['audio', 'HTMLAudioElement'],
  ['base', 'HTMLBaseElement'],
  ['body', 'HTMLBodyElement'],
  ['blockquote', 'HTMLQuoteElement'],
  ['br', 'HTMLBRElement'],
  ['button', 'HTMLButtonElement'],
  ['canvas', 'HTMLCanvasElement'],
  ['caption', 'HTMLTableCaptionElement'],
  ['col', 'HTMLTableColElement'],
  ['colgroup', 'HTMLTableColElement'],
  ['data', 'HTMLDataElement'],
  ['datalist', 'HTMLDataListElement'],
  ['del', 'HTMLModElement'],
  ['details', 'HTMLDetailsElement'],
  ['dialog', 'HTMLDialogElement'],
  ['dir', 'HTMLDirectoryElement'],
  ['div', 'HTMLDivElement'],
  ['dl', 'HTMLDListElement'],
  ['embed', 'HTMLEmbedElement'],
  ['fencedframe', 'HTMLFencedFrameElement'],
  ['fieldset', 'HTMLFieldSetElement'],
  ['font', 'HTMLFontElement'],
  ['form', 'HTMLFormElement'],
  ['frame', 'HTMLFrameElement'],
  ['frameset', 'HTMLFrameSetElement'],
  ['geolocation', 'HTMLGeolocationElement'],
  ['h1', 'HTMLHeadingElement'],
  ['h2', 'HTMLHeadingElement'],
  ['h3', 'HTMLHeadingElement'],
  ['h4', 'HTMLHeadingElement'],
  ['h5', 'HTMLHeadingElement'],
  ['h6', 'HTMLHeadingElement'],
  ['head', 'HTMLHeadElement'],
  ['hr', 'HTMLHRElement'],
  ['html', 'HTMLHtmlElement'],
  ['iframe', 'HTMLIFrameElement'],
  ['legend', 'HTMLLegendElement'],
  ['img', 'HTMLImageElement'],
  ['input', 'HTMLInputElement'],
  ['ins', 'HTMLModElement'],
  ['label', 'HTMLLabelElement'],
  ['li', 'HTMLLIElement'],
  ['link', 'HTMLLinkElement'],
  ['map', 'HTMLMapElement'],
  ['marquee', 'HTMLMarqueeElement'],
  ['menu', 'HTMLMenuElement'],
  ['meta', 'HTMLMetaElement'],
  ['meter', 'HTMLMeterElement'],
  ['object', 'HTMLObjectElement'],
  ['ol', 'HTMLOListElement'],
  ['optgroup', 'HTMLOptGroupElement'],
  ['option', 'HTMLOptionElement'],
  ['output', 'HTMLOutputElement'],
  ['p', 'HTMLParagraphElement'],
  ['param', 'HTMLParamElement'],
  ['picture', 'HTMLPictureElement'],
  ['pre', 'HTMLPreElement'],
  ['progress', 'HTMLProgressElement'],
  ['q', 'HTMLQuoteElement'],
  ['script', 'HTMLScriptElement'],
  ['select', 'HTMLSelectElement'],
  ['selectedcontent', 'HTMLSelectedContentElement'],
  ['slot', 'HTMLSlotElement'],
  ['source', 'HTMLSourceElement'],
  ['span', 'HTMLSpanElement'],
  ['style', 'HTMLStyleElement'],
  ['table', 'HTMLTableElement'],
  ['tbody', 'HTMLTableSectionElement'],
  ['td', 'HTMLTableCellElement'],
  ['template', 'HTMLTemplateElement'],
  ['textarea', 'HTMLTextAreaElement'],
  ['tfoot', 'HTMLTableSectionElement'],
  ['th', 'HTMLTableCellElement'],
  ['thead', 'HTMLTableSectionElement'],
  ['time', 'HTMLTimeElement'],
  ['title', 'HTMLTitleElement'],
  ['tr', 'HTMLTableRowElement'],
  ['track', 'HTMLTrackElement'],
  ['ul', 'HTMLUListElement'],
  ['video', 'HTMLVideoElement'],
]);

const htmlElementInterfaceTags = new Set(htmlTagInterfaceEntries.map(([tag]) => tag));

const genericHTMLElementTags = new Set([
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'dd',
  'dfn',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'header',
  'hgroup',
  'i',
  'kbd',
  'main',
  'mark',
  'nav',
  'noscript',
  'rb',
  'rp',
  'rt',
  'rtc',
  'ruby',
  's',
  'samp',
  'search',
  'section',
  'small',
  'strong',
  'sub',
  'summary',
  'sup',
  'u',
  'var',
  'wbr',
]);

const htmlElementConstructorLocalNames = Object.freeze({
  HTMLMediaElement: ['audio', 'video'],
  HTMLAnchorElement: 'a',
  HTMLAreaElement: 'area',
  HTMLAudioElement: 'audio',
  HTMLBaseElement: 'base',
  HTMLBodyElement: 'body',
  HTMLBRElement: 'br',
  HTMLButtonElement: 'button',
  HTMLCanvasElement: 'canvas',
  HTMLDataElement: 'data',
  HTMLDataListElement: 'datalist',
  HTMLDetailsElement: 'details',
  HTMLDialogElement: 'dialog',
  HTMLDirectoryElement: 'dir',
  HTMLDivElement: 'div',
  HTMLDListElement: 'dl',
  HTMLEmbedElement: 'embed',
  HTMLFencedFrameElement: 'fencedframe',
  HTMLFieldSetElement: 'fieldset',
  HTMLFontElement: 'font',
  HTMLFormElement: 'form',
  HTMLFrameElement: 'frame',
  HTMLFrameSetElement: 'frameset',
  HTMLGeolocationElement: 'geolocation',
  HTMLHeadElement: 'head',
  HTMLHeadingElement: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  HTMLHRElement: 'hr',
  HTMLHtmlElement: 'html',
  HTMLIFrameElement: 'iframe',
  HTMLImageElement: 'img',
  HTMLInputElement: 'input',
  HTMLLabelElement: 'label',
  HTMLLIElement: 'li',
  HTMLLinkElement: 'link',
  HTMLLegendElement: 'legend',
  HTMLMapElement: 'map',
  HTMLMarqueeElement: 'marquee',
  HTMLMenuElement: 'menu',
  HTMLMetaElement: 'meta',
  HTMLMeterElement: 'meter',
  HTMLModElement: ['del', 'ins'],
  HTMLObjectElement: 'object',
  HTMLOListElement: 'ol',
  HTMLOptGroupElement: 'optgroup',
  HTMLOptionElement: 'option',
  HTMLOutputElement: 'output',
  HTMLParagraphElement: 'p',
  HTMLParamElement: 'param',
  HTMLPictureElement: 'picture',
  HTMLPreElement: 'pre',
  HTMLProgressElement: 'progress',
  HTMLQuoteElement: ['blockquote', 'q'],
  HTMLScriptElement: 'script',
  HTMLSelectElement: 'select',
  HTMLSelectedContentElement: 'selectedcontent',
  HTMLSlotElement: 'slot',
  HTMLSourceElement: 'source',
  HTMLSpanElement: 'span',
  HTMLStyleElement: 'style',
  HTMLTableCaptionElement: 'caption',
  HTMLTableCellElement: ['td', 'th'],
  HTMLTableColElement: ['col', 'colgroup'],
  HTMLTableElement: 'table',
  HTMLTableRowElement: 'tr',
  HTMLTableSectionElement: ['thead', 'tbody', 'tfoot'],
  HTMLTemplateElement: 'template',
  HTMLTextAreaElement: 'textarea',
  HTMLTimeElement: 'time',
  HTMLTitleElement: 'title',
  HTMLTrackElement: 'track',
  HTMLUListElement: 'ul',
  HTMLUnknownElement: isUnknownHTMLElement,
  HTMLVideoElement: 'video',
});

export function createHTMLWebIDL(options = {}) {
  const htmlInterfaceByTag = Object.freeze(Object.fromEntries(htmlTagInterfaceEntries));
  const svgElementToStringTag = typeof options.svgElementToStringTag === 'function' ? options.svgElementToStringTag : null;
  const htmlElementConstructors = Object.freeze(Object.fromEntries(
    Object.entries(htmlElementConstructorLocalNames).map(([interfaceName, localNames]) => [
      interfaceName,
      makeHTMLConstructor(interfaceName, localNames),
    ]),
  ));
  const HTMLFormControlsCollection = makeIllegalHTMLCollectionConstructor('HTMLFormControlsCollection');
  const HTMLOptionsCollection = makeIllegalHTMLCollectionConstructor('HTMLOptionsCollection');
  const RadioNodeList = makeIllegalHTMLCollectionConstructor('RadioNodeList');

  return {
    htmlElementConstructors,
    HTMLFormControlsCollection,
    HTMLOptionsCollection,
    RadioNodeList,
    elementToStringTag(element) {
      if (element?.nodeType !== 1) return 'Element';
      if (!isHTMLNamespace(element)) return svgElementToStringTag?.(element) || 'Element';
      const local = String(element.localName || '');
      if (!local) return 'HTMLElement';
      if (htmlInterfaceByTag[local]) return htmlInterfaceByTag[local];
      return isGenericHTMLElementLocalName(local) ? 'HTMLElement' : 'HTMLUnknownElement';
    },
    interfaceNameForTag(localName) {
      const local = String(localName || '').toLowerCase();
      return htmlInterfaceByTag[local] || (isGenericHTMLElementLocalName(local) ? 'HTMLElement' : 'HTMLUnknownElement');
    },
    parentInterfaceForName(name) {
      return htmlParentInterfaces[name] || 'HTMLElement';
    },
    isElement(value, localName) { return matchesHTMLLocalName(value, localName); },
  };
}


function makeIllegalHTMLCollectionConstructor(interfaceName) {
  const ctor = function HTMLCollectionConstructor() { throw new TypeError("Failed to construct '" + interfaceName + "': Illegal constructor"); };
  Object.defineProperty(ctor, 'name', { value: interfaceName, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: interfaceName, configurable: true });
  return ctor;
}

function makeHTMLConstructor(interfaceName, localNames) {
  const ctor = function HTMLConstructor() { throw new TypeError("Failed to construct '" + interfaceName + "': Illegal constructor"); };
  Object.defineProperty(ctor, 'name', { value: interfaceName, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: interfaceName, configurable: true });
  Object.defineProperty(ctor, Symbol.hasInstance, { value: (value) => matchesHTMLLocalName(value, localNames), configurable: true });
  if (globalThis.HTMLElement?.prototype) Object.setPrototypeOf(ctor.prototype, globalThis.HTMLElement.prototype);
  return ctor;
}

function matchesHTMLLocalName(value, localNames) {
  if (value?.nodeType !== 1 || !isHTMLNamespace(value)) return false;
  if (typeof localNames === 'function') return localNames(value);
  if (Array.isArray(localNames)) return localNames.includes(value.localName);
  return value.localName === localNames;
}

function isHTMLNamespace(value) {
  return value?.namespaceURI === HTML_NS;
}

function isUnknownHTMLElement(value) {
  const local = String(value?.localName || '');
  return Boolean(local) && !htmlElementInterfaceTags.has(local) && !isGenericHTMLElementLocalName(local);
}

function isGenericHTMLElementLocalName(localName) {
  return genericHTMLElementTags.has(localName) || localName.includes('-');
}
