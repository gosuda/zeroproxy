const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRuntime } = require('./quickjs-test-helpers');

const domModuleURL = pathToFileURL(path.resolve('web/runtime/dom/virtual-dom.mjs')).href;
const eventLoopModuleURL = pathToFileURL(path.resolve('web/runtime/quickjs/event-loop.mjs')).href;

async function domModule() {
  return import(domModuleURL);
}

async function eventLoopModule() {
  return import(eventLoopModuleURL);
}

function fixtureRecords(docId = 'doc-dom') {
  return [
    { v: 1, type: 'node.create', docId, seq: 1, nodeId: 'n-html', tag: 'html' },
    {
      v: 1,
      type: 'node.create',
      docId,
      seq: 2,
      nodeId: 'n-body',
      parentNodeId: 'n-html',
      tag: 'body',
    },
    {
      v: 1,
      type: 'node.create',
      docId,
      seq: 3,
      nodeId: 'n-app',
      parentNodeId: 'n-body',
      tag: 'main',
    },
    { v: 1, type: 'node.attr', docId, seq: 4, nodeId: 'n-app', name: 'id', value: 'app' },
    { v: 1, type: 'node.attr', docId, seq: 5, nodeId: 'n-app', name: 'class', value: 'root item' },
    { v: 1, type: 'node.text', docId, seq: 6, parentNodeId: 'n-app', text: 'initial' },
    {
      v: 1,
      type: 'node.create',
      docId,
      seq: 7,
      nodeId: 'n-button',
      parentNodeId: 'n-body',
      tag: 'button',
    },
    { v: 1, type: 'node.attr', docId, seq: 8, nodeId: 'n-button', name: 'id', value: 'go' },
    {
      v: 1,
      type: 'event.inlineHandler',
      docId,
      seq: 9,
      nodeId: 'n-button',
      event: 'click',
      source: 'globalThis.inlineClicked = (globalThis.inlineClicked || 0) + 1;',
    },
  ];
}

test('QuickJS virtual DOM reflects resource URL attributes for script lookup', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  const navigations = [];
  try {
    installVirtualDOM({
      realm,
      href: 'https://target.example/page',
      onNavigate: (targetHref, replace) => navigations.push({ targetHref, replace }),
      records: [
        { v: 1, type: 'node.create', docId: 'doc-resource', seq: 1, nodeId: 'n-html', tag: 'html' },
        {
          v: 1,
          type: 'node.create',
          docId: 'doc-resource',
          seq: 2,
          nodeId: 'n-body',
          parentNodeId: 'n-html',
          tag: 'body',
        },
        {
          v: 1,
          type: 'node.create',
          docId: 'doc-resource',
          seq: 3,
          nodeId: 'n-script',
          parentNodeId: 'n-body',
          tag: 'script',
        },
        {
          v: 1,
          type: 'resource.discovered',
          docId: 'doc-resource',
          seq: 4,
          resourceId: 'r-script',
          initiatorNodeId: 'n-script',
          attribute: 'src',
          rawValue: 'https://cdn.example/otSDKStub.js?id=1',
          resolvedTargetUrl: 'https://cdn.example/otSDKStub.js?id=1',
          safeUrl: 'zp-internal://resource/r-script',
        },
      ],
    });
    assert.equal(
      realm.evalClassic(`document.querySelector(\"script[src*='otSDKStub']\").getAttribute('src')`),
      'https://cdn.example/otSDKStub.js?id=1',
    );
    realm.evalClassic(`location.hash = '#same-document'`);
    assert.equal(realm.evalClassic('location.href'), 'https://target.example/page#same-document');
    realm.evalClassic(`location.href = '/next?q=1'`);
    realm.evalClassic(`location.replace('https://other.example/replaced')`);
    assert.deepEqual(navigations, [
      { targetHref: 'https://target.example/next?q=1', replace: false },
      { targetHref: 'https://other.example/replaced', replace: true },
    ]);
    assert.equal(
      realm.evalClassic(`
        const hiddenStyle = document.createElement('style');
        hiddenStyle.textContent = '.x{color:red}';
        const hiddenNoscript = document.createElement('noscript');
        hiddenNoscript.textContent = 'fallback';
        const visible = document.createElement('div');
        visible.textContent = 'visible';
        document.body.append(hiddenStyle, hiddenNoscript, visible);
        document.body.innerText;
      `),
      'visible',
    );
  } finally {
    realm.destroy();
  }
});

test('QuickJS virtual DOM exposes live document element collections', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  installVirtualDOM({
    realm,
    records: fixtureRecords('doc-collections'),
    href: 'https://target.example/page',
  });

  try {
    const result = JSON.parse(
      realm.evalClassic(`
        (() => {
          const form = document.createElement('form');
          form.id = 'checkout';
          form.name = 'checkoutForm';
          const img = document.createElement('img');
          img.id = 'hero';
          const link = document.createElement('a');
          link.id = 'home';
          link.href = '/home';
          const anchor = document.createElement('a');
          anchor.name = 'skip';
          const area = document.createElement('area');
          area.href = '/map';
          const script = document.createElement('script');
          const embed = document.createElement('embed');
          document.body.append(form, img, link, anchor, area, script, embed);
          const images = document.images;
          const forms = document.forms;
          const links = document.links;
          const anchors = document.anchors;
          const scripts = document.scripts;
          const embeds = document.embeds;
          const extraImage = document.createElement('img');
          const control = document.createElement('input');
          control.type = 'checkbox';
          control.checked = true;
          control.required = true;
          document.body.appendChild(control);
          const panel = document.createElement('section');
          panel.className = 'panel visible';
          const nested = document.createElement('span');
          nested.className = 'cta';
          nested.setAttribute('data-kind', 'cta');
          panel.appendChild(nested);
          document.body.appendChild(panel);
          document.body.appendChild(extraImage);
          return JSON.stringify({
            forms: [forms.length, forms[0] === form, forms.checkout === form, forms.checkoutForm === form],
            images: [images.length, images[0] === img, images.hero === img],
            links: [links.length, links[0] === link, links[1] === area, links.namedItem('home') === link],
            anchors: [anchors.length, anchors.skip === anchor, anchors[0] === anchor],
            scripts: [scripts.length, scripts[0] === script],
            embeds: [embeds.length, embeds[0] === embed, document.plugins.length],
            reflection: [form.getAttribute('name'), link.getAttribute('href'), link.href, area.getAttribute('href'), control.getAttribute('type'), control.hasAttribute('checked'), control.checked, control.hasAttribute('required')],
            selectors: [
              document.querySelectorAll('main.root.item, form#checkout[name="checkoutForm"]').length,
              document.querySelector('body section.panel span.cta[data-kind="cta"]') === nested,
              nested.matches('section span.cta'),
              nested.closest('body .panel') === panel,
              nested.matches('span:not([hidden])'),
              nested.matches('span:not(.cta)'),
            ],
          });
        })();
      `),
    );
    assert.deepEqual(result.forms, [1, true, true, true]);
    assert.deepEqual(result.images, [2, true, true]);
    assert.deepEqual(result.links, [2, true, true, true]);
    assert.deepEqual(result.anchors, [1, true, true]);
    assert.deepEqual(result.scripts, [1, true]);
    assert.deepEqual(result.embeds, [1, true, 1]);
    assert.deepEqual(result.reflection, [
      'checkoutForm',
      '/home',
      'https://target.example/home',
      '/map',
      'checkbox',
      true,
      true,
      true,
    ]);
    assert.deepEqual(result.selectors, [2, true, true, true, true, false]);
  } finally {
    realm.destroy();
  }
});

test('QuickJS virtual DOM exposes long-tail PerformanceEntry browser accessors', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  installVirtualDOM({
    realm,
    records: fixtureRecords('doc-performance-accessors'),
    href: 'https://target.example/page',
  });

  try {
    const result = JSON.parse(
      realm.evalClassic(`
        (() => {
          const cases = {
            PerformancePaintTiming: ['paintTime', 'presentationTime'],
            PerformanceEventTiming: ['cancelable', 'interactionId', 'processingEnd', 'processingStart', 'target'],
            PerformanceLongTaskTiming: ['attribution'],
            PerformanceLongAnimationFrameTiming: ['blockingDuration', 'firstUIEventTimestamp', 'paintTime', 'presentationTime', 'renderStart', 'scripts', 'styleAndLayoutStart'],
            PerformanceScriptTiming: ['executionStart', 'forcedStyleAndLayoutDuration', 'invoker', 'invokerType', 'pauseDuration', 'sourceCharPosition', 'sourceFunctionName', 'sourceURL', 'window', 'windowAttribution'],
            PerformanceElementTiming: ['element', 'id', 'identifier', 'intersectionRect', 'loadTime', 'naturalHeight', 'naturalWidth', 'paintTime', 'presentationTime', 'renderTime', 'url'],
            LargestContentfulPaint: ['element', 'id', 'loadTime', 'paintTime', 'presentationTime', 'renderTime', 'size', 'url'],
            LayoutShift: ['hadRecentInput', 'lastInputTime', 'sources', 'value'],
            TaskAttributionTiming: ['containerId', 'containerName', 'containerSrc', 'containerType'],
            LayoutShiftAttribution: ['node', 'previousRect', 'currentRect'],
          };
          return JSON.stringify(Object.fromEntries(Object.entries(cases).map(([name, fields]) => {
            const proto = globalThis[name].prototype;
            const descriptors = fields.map((field) => {
              const descriptor = Object.getOwnPropertyDescriptor(proto, field);
              return [field, descriptor.enumerable, descriptor.configurable, typeof descriptor.get, 'value' in descriptor];
            });
            let fakeToJSON;
            try {
              proto.toJSON.call(Object.create(proto));
              fakeToJSON = ['ok'];
            } catch (error) {
              fakeToJSON = [error.name, error.message];
            }
            return [name, {
              ownNames: Object.getOwnPropertyNames(proto),
              tag: Object.prototype.toString.call(proto),
              descriptors,
              toJSONLength: proto.toJSON.length,
              fakeToJSON,
            }];
          })));
        })();
      `),
    );

    assert.deepEqual(result.PerformancePaintTiming.ownNames, [
      'paintTime',
      'presentationTime',
      'toJSON',
      'constructor',
    ]);
    assert.deepEqual(result.PerformanceLongTaskTiming.ownNames, [
      'attribution',
      'toJSON',
      'constructor',
    ]);
    assert.deepEqual(result.LayoutShiftAttribution.ownNames, [
      'node',
      'previousRect',
      'currentRect',
      'toJSON',
      'constructor',
    ]);
    for (const [name, summary] of Object.entries(result)) {
      assert.equal(summary.tag, `[object ${name}]`);
      assert.equal(summary.toJSONLength, 0);
      assert.deepEqual(summary.fakeToJSON, ['TypeError', 'Illegal invocation']);
      for (const descriptor of summary.descriptors)
        assert.deepEqual(descriptor.slice(1), [true, true, 'function', false]);
    }
  } finally {
    realm.destroy();
  }
});

test('QuickJS virtual DOM supports nodes live collections mutations and events', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  const state = { records: [] };
  installVirtualDOM({
    realm,
    records: fixtureRecords(),
    state,
    href: 'https://target.example/page',
  });

  assert.equal(realm.evalClassic('document.location.href'), 'https://target.example/page');
  assert.deepEqual(
    JSON.parse(
      realm.evalClassic(`
        (() => {
          let newWindow;
          try {
            new Window();
            newWindow = ['ok'];
          } catch (error) {
            newWindow = [error.name, error.message];
          }
          let newHTMLElement;
          try {
            new HTMLElement();
            newHTMLElement = ['ok'];
          } catch (error) {
            newHTMLElement = [error.name, error.message];
          }
          let newSVGElement;
          try {
            new SVGElement();
            newSVGElement = ['ok'];
          } catch (error) {
            newSVGElement = [error.name, error.message];
          }
          let newMathMLElement;
          try {
            new MathMLElement();
            newMathMLElement = ['ok'];
          } catch (error) {
            newMathMLElement = [error.name, error.message];
          }
          let newHTMLDocument;
          try {
            new HTMLDocument();
            newHTMLDocument = ['ok'];
          } catch (error) {
            newHTMLDocument = [error.name, error.message];
          }
          let newXMLDocument;
          try {
            new XMLDocument();
            newXMLDocument = ['ok'];
          } catch (error) {
            newXMLDocument = [error.name, error.message];
          }
          const div = document.createElement('div');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
          const textHost = document.createElement('div');
          const text = new Text('hello');
          text.appendData(' world');
          textHost.appendChild(text);
          const split = text.splitText(5);
          const comment = new Comment('note');
          comment.replaceData(0, 4, 'memo');
          const createdText = document.createTextNode('abc');
          let newCDATASection;
          try { new CDATASection(); newCDATASection = ['ok']; } catch (error) { newCDATASection = [error.name, error.message]; }
          let newProcessingInstruction;
          try { new ProcessingInstruction(); newProcessingInstruction = ['ok']; } catch (error) { newProcessingInstruction = [error.name, error.message]; }
          const cdata = document.createCDATASection('raw <data>');
          cdata.appendData('!');
          const pi = document.createProcessingInstruction('xml-stylesheet', 'href="style.css"');
          pi.replaceData(0, 4, 'type');
          let piError = '';
          try { document.createProcessingInstruction('bad target', 'x'); } catch (error) { piError = error.name; }
          let newFragmentDirective;
          try { new FragmentDirective(); newFragmentDirective = ['ok']; } catch (error) { newFragmentDirective = [error.name, error.message]; }
          let splitError = '';
          try { text.splitText(99); } catch (error) { splitError = error.name; }
          div.setAttribute('role', 'main');
          div.setAttribute('data-x', '1');
          const attrMap = div.attributes;
          let newNamedNodeMap;
          try {
            new NamedNodeMap();
            newNamedNodeMap = ['ok'];
          } catch (error) {
            newNamedNodeMap = [error.name, error.message];
          }
          const descriptorFlags = (owner, key) => {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            return [
              descriptor.enumerable,
              descriptor.configurable,
              'get' in descriptor ? typeof descriptor.get : null,
              'set' in descriptor ? typeof descriptor.set : null,
              'writable' in descriptor ? descriptor.writable : null,
              typeof descriptor.value,
              typeof descriptor.value === 'function' ? descriptor.value.length : null,
            ];
          };
          const namedMapSummary = [
            typeof NamedNodeMap,
            Object.prototype.toString.call(attrMap),
            attrMap instanceof NamedNodeMap,
            attrMap.length,
            attrMap[0].name,
            attrMap.item(1).value,
            attrMap.getNamedItem('role').value,
            attrMap.role.value,
            'role' in attrMap,
            typeof attrMap.keys,
            Array.from(attrMap).map((attr) => attr.name),
          ];
          const namedMapStructure = {
            ctor: [NamedNodeMap.length, NamedNodeMap.name, Object.getOwnPropertyNames(NamedNodeMap), newNamedNodeMap],
            own: Object.getOwnPropertyNames(attrMap),
            proto: Object.getOwnPropertyNames(NamedNodeMap.prototype),
            length: descriptorFlags(NamedNodeMap.prototype, 'length'),
            getNamedItem: descriptorFlags(NamedNodeMap.prototype, 'getNamedItem'),
            getNamedItemNS: descriptorFlags(NamedNodeMap.prototype, 'getNamedItemNS'),
            item: descriptorFlags(NamedNodeMap.prototype, 'item'),
            removeNamedItem: descriptorFlags(NamedNodeMap.prototype, 'removeNamedItem'),
            removeNamedItemNS: descriptorFlags(NamedNodeMap.prototype, 'removeNamedItemNS'),
            setNamedItem: descriptorFlags(NamedNodeMap.prototype, 'setNamedItem'),
            setNamedItemNS: descriptorFlags(NamedNodeMap.prototype, 'setNamedItemNS'),
            constructor: descriptorFlags(NamedNodeMap.prototype, 'constructor'),
          };
          const oldData = attrMap.setNamedItem({ name: 'data-x', value: '2' });
          const removedRole = attrMap.removeNamedItem('role');
          let missingNamedItem = '';
          try { attrMap.removeNamedItem('role'); } catch (error) { missingNamedItem = error.name; }
          const namedMapMutation = [oldData.value, div.getAttribute('data-x'), removedRole.value, div.hasAttribute('role'), missingNamedItem];
          const attrNamesBefore = div.getAttributeNames();
          const toggleAdd = div.toggleAttribute('hidden');
          const toggleKeep = div.toggleAttribute('hidden', true);
          const toggleRemove = div.toggleAttribute('hidden', false);
          div.setAttributeNS('urn:test', 'x:flag', 'yes');
          const elementAttrSummary = [
            div.hasAttributes(),
            attrNamesBefore,
            toggleAdd,
            toggleKeep,
            toggleRemove,
            div.hasAttribute('hidden'),
            div.hasAttributeNS('urn:test', 'x:flag'),
            div.getAttributeNS('urn:test', 'x:flag'),
            div.getAttributeNames(),
          ];
          const cloneHost = document.createElement('div');
          cloneHost.setAttribute('data-v', '1');
          const cloneSpan = document.createElement('span');
          cloneSpan.textContent = 's';
          cloneHost.append(document.createTextNode('a'), cloneSpan, document.createTextNode(''), document.createTextNode('b'));
          document.body.appendChild(cloneHost);
          const shallowClone = cloneHost.cloneNode();
          const deepClone = cloneHost.cloneNode(true);
          const detached = document.createElement('section');
          const nodeMethodSummary = [
            Node.ELEMENT_NODE,
            Node.TEXT_NODE,
            Node.DOCUMENT_POSITION_FOLLOWING,
            cloneHost.hasChildNodes(),
            shallowClone.childNodes.length,
            shallowClone.getAttribute('data-v'),
            deepClone.childNodes.length,
            deepClone.querySelector('span').textContent,
            deepClone.parentNode,
            cloneHost.isSameNode(cloneHost),
            cloneHost.isEqualNode(deepClone),
            cloneHost.isConnected,
            detached.isConnected,
            cloneHost.getRootNode() === document,
            detached.getRootNode() === detached,
            document.body.compareDocumentPosition(cloneHost),
            cloneHost.compareDocumentPosition(document.body),
            cloneHost.compareDocumentPosition(detached),
          ];
          const foreignDoc = new Document('https://foreign.example/');
          const foreign = foreignDoc.createElement('article');
          foreign.setAttribute('data-foreign', '1');
          foreign.appendChild(foreignDoc.createTextNode('foreign'));
          foreignDoc.appendChild(foreign);
          const imported = document.importNode(foreign, true);
          const adopted = document.adoptNode(foreign);
          const documentImportSummary = [
            imported.ownerDocument === document,
            imported.firstChild.ownerDocument === document,
            imported.parentNode,
            imported.textContent,
            foreign.ownerDocument === document,
            foreign.firstChild.ownerDocument === document,
            foreign.parentNode,
            adopted === foreign,
            foreignDoc.firstChild,
          ];
          cloneHost.normalize();
          const nodeNormalizeSummary = [cloneHost.childNodes.length, cloneHost.textContent, cloneHost.childNodes[0].data, cloneHost.childNodes[2].data];
          const domException = new DOMException('missing', 'NotFoundError');
          const domExceptionSummary = [
            typeof DOMException,
            Object.prototype.toString.call(domException),
            domException instanceof DOMException,
            domException instanceof Error,
            domException.name,
            domException.message,
            domException.code,
            DOMException.NOT_FOUND_ERR,
            Object.getOwnPropertyNames(domException),
            Object.getOwnPropertyDescriptor(globalThis, 'DOMException').enumerable,
            (() => {
              const nameDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name');
              const messageDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'message');
              const codeDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'code');
              const constructorDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, 'constructor');
              return [
                [nameDescriptor.enumerable, nameDescriptor.configurable, !!nameDescriptor.get, !!nameDescriptor.set],
                [messageDescriptor.enumerable, messageDescriptor.configurable, !!messageDescriptor.get, !!messageDescriptor.set],
                [codeDescriptor.enumerable, codeDescriptor.configurable, !!codeDescriptor.get, !!codeDescriptor.set],
                [constructorDescriptor.enumerable, constructorDescriptor.writable, constructorDescriptor.configurable, constructorDescriptor.value.name, constructorDescriptor.value.length],
              ];
            })(),
            (() => { try { DOMException('x'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
          ];
          let newCharacterData;
          try { new CharacterData(); newCharacterData = ['ok']; } catch (error) { newCharacterData = [error.name, error.message]; }
          const eventTarget = new EventTarget();
          const eventTargetEvents = [];
          eventTarget.addEventListener('ping', () => eventTargetEvents.push('listener'));
          eventTarget.onping = () => eventTargetEvents.push('handler');
          eventTarget.dispatchEvent(new Event('ping'));
          const eventTargetSummary = [typeof EventTarget, EventTarget.name, Object.prototype.toString.call(eventTarget), eventTarget instanceof EventTarget, eventTargetEvents];
          return JSON.stringify({
            tag: Object.prototype.toString.call(window),
            type: typeof Window,
            instance: window instanceof Window,
            name: Window.name,
            newWindow,
            htmlElementType: typeof HTMLElement,
            htmlElementName: HTMLElement.name,
            divHTMLElement: div instanceof HTMLElement,
            divElement: div instanceof Element,
            svgHTMLElement: svg instanceof HTMLElement,
            svgElement: svg instanceof Element,
            newHTMLElement,
            svgElementType: typeof SVGElement,
            svgElementName: SVGElement.name,
            svgSVGElement: svg instanceof SVGElement,
            newSVGElement,
            mathElementType: typeof MathMLElement,
            mathElementName: MathMLElement.name,
            mathMathMLElement: math instanceof MathMLElement,
            mathElement: math instanceof Element,
            newMathMLElement,
            documentHTMLDocument: document instanceof HTMLDocument,
            documentXMLDocument: document instanceof XMLDocument,
            documentTag: Object.prototype.toString.call(document),
            htmlDocumentType: typeof HTMLDocument,
            xmlDocumentType: typeof XMLDocument,
            newHTMLDocument,
            newXMLDocument,
            textCtor: [typeof Text, text instanceof Text, text instanceof CharacterData, text instanceof Node, Object.prototype.toString.call(text), text.length, text.data, split.data, text.wholeText, split.wholeText, textHost.childNodes.length, textHost.textContent, splitError],
            commentCtor: [typeof Comment, comment instanceof Comment, comment instanceof CharacterData, comment instanceof Node, Object.prototype.toString.call(comment), comment.length, comment.nodeValue, comment.substringData(1, 2)],
            characterDataCtor: [typeof CharacterData, newCharacterData],
            cdataCtor: [typeof CDATASection, cdata instanceof CDATASection, cdata instanceof CharacterData, cdata instanceof Node, Object.prototype.toString.call(cdata), cdata.nodeType, cdata.nodeName, cdata.length, cdata.data, newCDATASection],
            processingInstructionCtor: [typeof ProcessingInstruction, pi instanceof ProcessingInstruction, pi instanceof CharacterData, pi instanceof Node, Object.prototype.toString.call(pi), pi.nodeType, pi.nodeName, pi.target, pi.data, piError, newProcessingInstruction],
            fragmentDirective: [typeof FragmentDirective, Object.prototype.toString.call(document.fragmentDirective), document.fragmentDirective instanceof FragmentDirective, Object.isFrozen(document.fragmentDirective), Object.getOwnPropertyNames(document.fragmentDirective).sort(), newFragmentDirective],
            createdText: [createdText instanceof Text, createdText instanceof CharacterData, createdText.ownerDocument === document, Object.prototype.toString.call(createdText), createdText.data],
            eventTargetSummary,
            newNamedNodeMap,
            namedMapSummary,
            namedMapStructure,
            namedMapMutation,
            elementAttrSummary,
            nodeMethodSummary,
            documentImportSummary,
            nodeNormalizeSummary,
            domExceptionSummary,
          });
        })();
      `),
    ),
    {
      tag: '[object Window]',
      type: 'function',
      instance: true,
      name: 'Window',
      newWindow: ['TypeError', "Failed to construct 'Window': Illegal constructor"],
      htmlElementType: 'function',
      htmlElementName: 'HTMLElement',
      divHTMLElement: true,
      divElement: true,
      svgHTMLElement: false,
      svgElement: true,
      newHTMLElement: ['TypeError', "Failed to construct 'HTMLElement': Illegal constructor"],
      svgElementType: 'function',
      svgElementName: 'SVGElement',
      svgSVGElement: true,
      newSVGElement: ['TypeError', "Failed to construct 'SVGElement': Illegal constructor"],
      mathElementType: 'function',
      mathElementName: 'MathMLElement',
      mathMathMLElement: true,
      mathElement: true,
      newMathMLElement: ['TypeError', "Failed to construct 'MathMLElement': Illegal constructor"],
      documentHTMLDocument: true,
      documentXMLDocument: false,
      documentTag: '[object HTMLDocument]',
      htmlDocumentType: 'function',
      xmlDocumentType: 'function',
      newHTMLDocument: ['TypeError', "Failed to construct 'HTMLDocument': Illegal constructor"],
      newXMLDocument: ['TypeError', "Failed to construct 'XMLDocument': Illegal constructor"],
      textCtor: [
        'function',
        true,
        true,
        true,
        '[object Text]',
        5,
        'hello',
        ' world',
        'hello world',
        'hello world',
        2,
        'hello world',
        'IndexSizeError',
      ],
      newNamedNodeMap: ['TypeError', "Failed to construct 'NamedNodeMap': Illegal constructor"],
      namedMapSummary: [
        'function',
        '[object NamedNodeMap]',
        true,
        2,
        'role',
        '1',
        'main',
        'main',
        true,
        'undefined',
        ['role', 'data-x'],
      ],
      namedMapStructure: {
        ctor: [
          0,
          'NamedNodeMap',
          ['length', 'name', 'prototype'],
          ['TypeError', "Failed to construct 'NamedNodeMap': Illegal constructor"],
        ],
        own: ['0', '1', 'role', 'data-x'],
        proto: [
          'length',
          'getNamedItem',
          'getNamedItemNS',
          'item',
          'removeNamedItem',
          'removeNamedItemNS',
          'setNamedItem',
          'setNamedItemNS',
          'constructor',
        ],
        length: [true, true, 'function', 'undefined', null, 'undefined', null],
        getNamedItem: [true, true, null, null, true, 'function', 1],
        getNamedItemNS: [true, true, null, null, true, 'function', 2],
        item: [true, true, null, null, true, 'function', 1],
        removeNamedItem: [true, true, null, null, true, 'function', 1],
        removeNamedItemNS: [true, true, null, null, true, 'function', 2],
        setNamedItem: [true, true, null, null, true, 'function', 1],
        setNamedItemNS: [true, true, null, null, true, 'function', 1],
        constructor: [false, true, null, null, true, 'function', 0],
      },
      namedMapMutation: ['1', '2', 'main', false, 'NotFoundError'],
      commentCtor: ['function', true, true, true, '[object Comment]', 4, 'memo', 'em'],
      cdataCtor: [
        'function',
        true,
        true,
        true,
        '[object CDATASection]',
        4,
        '#cdata-section',
        11,
        'raw <data>!',
        ['TypeError', "Failed to construct 'CDATASection': Illegal constructor"],
      ],
      processingInstructionCtor: [
        'function',
        true,
        true,
        true,
        '[object ProcessingInstruction]',
        7,
        'xml-stylesheet',
        'xml-stylesheet',
        'type="style.css"',
        'InvalidCharacterError',
        ['TypeError', "Failed to construct 'ProcessingInstruction': Illegal constructor"],
      ],
      characterDataCtor: [
        'function',
        ['TypeError', "Failed to construct 'CharacterData': Illegal constructor"],
      ],
      fragmentDirective: [
        'function',
        '[object FragmentDirective]',
        true,
        false,
        [],
        ['TypeError', "Failed to construct 'FragmentDirective': Illegal constructor"],
      ],
      createdText: [true, true, true, '[object Text]', 'abc'],
      domExceptionSummary: [
        'function',
        '[object DOMException]',
        true,
        true,
        'NotFoundError',
        'missing',
        8,
        8,
        [],
        false,
        [
          [true, true, true, false],
          [true, true, true, false],
          [true, true, true, false],
          [false, true, true, 'DOMException', 0],
        ],
        [
          'TypeError',
          "Failed to construct 'DOMException': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
        ],
      ],
      nodeMethodSummary: [
        1,
        3,
        4,
        true,
        0,
        '1',
        4,
        's',
        null,
        true,
        true,
        true,
        false,
        true,
        true,
        20,
        10,
        33,
      ],
      elementAttrSummary: [
        true,
        ['data-x'],
        true,
        true,
        false,
        false,
        true,
        'yes',
        ['data-x', 'x:flag'],
      ],
      documentImportSummary: [true, true, null, 'foreign', true, true, null, true, null],
      nodeNormalizeSummary: [3, 'asb', 'a', 'b'],
      eventTargetSummary: [
        'function',
        'EventTarget',
        '[object EventTarget]',
        true,
        ['listener', 'handler'],
      ],
    },
  );
  assert.equal(realm.evalClassic('document.getElementById("app").textContent'), 'initial');
  assert.equal(realm.evalClassic('document.getElementsByClassName("item").length'), 1);

  realm.evalClassic(`
    const app = document.getElementById('app');
    const child = document.createElement('section');
    child.id = 'child';
    child.className = 'item dynamic';
    child.textContent = 'added';
    app.appendChild(child);
  `);
  assert.equal(realm.evalClassic('document.getElementsByClassName("item").length'), 2);
  const collections = realm.evalClassic(`
    (() => {
      const app2 = document.getElementById('app');
      const nodes = app2.querySelectorAll('section');
      const children = app2.children;
      const childNodes = app2.childNodes;
      const descriptorFlags = (owner, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        return [
          descriptor.enumerable,
          descriptor.configurable,
          'get' in descriptor ? typeof descriptor.get : null,
          'set' in descriptor ? typeof descriptor.set : null,
          'writable' in descriptor ? descriptor.writable : null,
          typeof descriptor.value,
          typeof descriptor.value === 'function' ? descriptor.value.length : null,
        ];
      };
      const illegal = (Ctor) => {
        try { new Ctor(); return ['ok']; } catch (error) { return [error.name, error.message]; }
      };
      return JSON.stringify({
        childNodesTag: Object.prototype.toString.call(childNodes),
        childNodesInstance: childNodes instanceof NodeList,
        childNodesArray: Array.isArray(childNodes),
        childNodesItem: childNodes.item(1).id,
        childNodesIndex: childNodes[1].id,
        childNodesMap: typeof childNodes.map,
        childNodesOwnItem: Object.prototype.hasOwnProperty.call(childNodes, 'item'),
        childNodesForEach: typeof childNodes.forEach,
        childNodesEntries: childNodes.entries().next().value[1].nodeType,
        nodeListTag: Object.prototype.toString.call(nodes),
        nodeListInstance: nodes instanceof NodeList,
        nodeListItem: nodes.item(0).id,
        nodeListIndex: nodes[0].id,
        nodeListNamedItem: typeof nodes.namedItem,
        nodeListOwnItem: Object.prototype.hasOwnProperty.call(nodes, 'item'),
        nodeListForEach: typeof nodes.forEach,
        nodeListKeys: [...nodes.keys()].join(','),
        htmlCollectionTag: Object.prototype.toString.call(children),
        htmlCollectionInstance: children instanceof HTMLCollection,
        htmlCollectionItem: children.item(0).id,
        htmlCollectionIndex: children[0].id,
        htmlCollectionNamedItem: children.namedItem('child').id,
        htmlCollectionOwnItem: Object.prototype.hasOwnProperty.call(children, 'item'),
        htmlCollectionOwnNamedItem: Object.prototype.hasOwnProperty.call(children, 'namedItem'),
        childNodesOwn: Object.getOwnPropertyNames(childNodes),
        nodeListCtor: [NodeList.length, NodeList.name, Object.getOwnPropertyNames(NodeList), illegal(NodeList)],
        nodeListProto: Object.getOwnPropertyNames(NodeList.prototype),
        nodeListDescriptors: {
          entries: descriptorFlags(NodeList.prototype, 'entries'),
          forEach: descriptorFlags(NodeList.prototype, 'forEach'),
          length: descriptorFlags(NodeList.prototype, 'length'),
          item: descriptorFlags(NodeList.prototype, 'item'),
          constructor: descriptorFlags(NodeList.prototype, 'constructor'),
        },
        htmlCollectionOwn: Object.getOwnPropertyNames(children),
        htmlCollectionCtor: [HTMLCollection.length, HTMLCollection.name, Object.getOwnPropertyNames(HTMLCollection), illegal(HTMLCollection)],
        htmlCollectionProto: Object.getOwnPropertyNames(HTMLCollection.prototype),
        htmlCollectionDescriptors: {
          length: descriptorFlags(HTMLCollection.prototype, 'length'),
          item: descriptorFlags(HTMLCollection.prototype, 'item'),
          namedItem: descriptorFlags(HTMLCollection.prototype, 'namedItem'),
          constructor: descriptorFlags(HTMLCollection.prototype, 'constructor'),
        },
      });
    })();
  `);
  assert.deepEqual(JSON.parse(collections), {
    childNodesTag: '[object NodeList]',
    childNodesInstance: true,
    childNodesArray: false,
    childNodesItem: 'child',
    childNodesIndex: 'child',
    childNodesMap: 'undefined',
    childNodesOwnItem: false,
    childNodesForEach: 'function',
    childNodesEntries: 3,
    nodeListTag: '[object NodeList]',
    nodeListInstance: true,
    nodeListItem: 'child',
    nodeListIndex: 'child',
    nodeListNamedItem: 'undefined',
    nodeListOwnItem: false,
    nodeListForEach: 'function',
    nodeListKeys: '0',
    htmlCollectionTag: '[object HTMLCollection]',
    htmlCollectionInstance: true,
    htmlCollectionItem: 'child',
    htmlCollectionIndex: 'child',
    htmlCollectionNamedItem: 'child',
    htmlCollectionOwnItem: false,
    htmlCollectionOwnNamedItem: false,
    childNodesOwn: ['0', '1'],
    nodeListCtor: [
      0,
      'NodeList',
      ['length', 'name', 'prototype'],
      ['TypeError', "Failed to construct 'NodeList': Illegal constructor"],
    ],
    nodeListProto: ['entries', 'keys', 'values', 'forEach', 'length', 'item', 'constructor'],
    nodeListDescriptors: {
      entries: [true, true, null, null, true, 'function', 0],
      forEach: [true, true, null, null, true, 'function', 1],
      length: [true, true, 'function', 'undefined', null, 'undefined', null],
      item: [true, true, null, null, true, 'function', 1],
      constructor: [false, true, null, null, true, 'function', 0],
    },
    htmlCollectionOwn: ['0', 'child'],
    htmlCollectionCtor: [
      0,
      'HTMLCollection',
      ['length', 'name', 'prototype'],
      ['TypeError', "Failed to construct 'HTMLCollection': Illegal constructor"],
    ],
    htmlCollectionProto: ['length', 'item', 'namedItem', 'constructor'],
    htmlCollectionDescriptors: {
      length: [true, true, 'function', 'undefined', null, 'undefined', null],
      item: [true, true, null, null, true, 'function', 1],
      namedItem: [true, true, null, null, true, 'function', 1],
      constructor: [false, true, null, null, true, 'function', 0],
    },
  });
  assert.equal(realm.evalClassic('document.defaultView === window'), true);
  assert.equal(realm.evalClassic('document.querySelector("#child").closest(".root").id'), 'app');
  assert.deepEqual(
    JSON.parse(
      realm.evalClassic(`
      (() => {
        const script = document.createElement('script');
        script.setAttribute('src', 'https://cdn.example/otSDKStub.js?id=1');
        script.setAttribute('data-domain-script', 'domain-1');
        document.body.appendChild(script);
        return JSON.stringify([
          document.querySelector("script[src*='otSDKStub']").getAttribute('data-domain-script'),
          document.querySelector('script[data-domain-script]').getAttribute('src'),
          document.querySelector('script[src$="1"]').getAttribute('src'),
          document.querySelector('script[src^="https://cdn.example"]').getAttribute('src'),
          document.querySelector('script[data-domain-script="domain-1"]').getAttribute('src'),
          document.querySelector('script[data-domain-script~="domain-1"]').getAttribute('src'),
        ]);
      })();
    `),
    ),
    [
      'domain-1',
      'https://cdn.example/otSDKStub.js?id=1',
      'https://cdn.example/otSDKStub.js?id=1',
      'https://cdn.example/otSDKStub.js?id=1',
      'https://cdn.example/otSDKStub.js?id=1',
      'https://cdn.example/otSDKStub.js?id=1',
    ],
  );
  const manipulations = realm.evalClassic(`
    (() => {
      const host = document.createElement('div');
      const first = document.createElement('p');
      first.id = 'first';
      first.textContent = 'A';
      host.append(first, 'D');
      first.before('B');
      first.after('C');
      const beforeReplace = host.textContent;
      first.prepend('0');
      first.append('1');
      const afterChildText = first.textContent;
      const matches = [first.matches('#first'), first.matches('p'), first.matches('.missing')];
      const span = document.createElement('span');
      span.textContent = 'S';
      host.replaceChildren(first, span);
      span.replaceWith('X', 'Y');
      first.remove();
      host.prepend('P');
      host.append('Q');
      return JSON.stringify({ beforeReplace, afterChildText, matches, final: host.textContent, childCount: host.childNodes.length });
    })();
  `);
  assert.deepEqual(JSON.parse(manipulations), {
    beforeReplace: 'BACD',
    afterChildText: '0A1',
    matches: [true, true, false],
    final: 'PXYQ',
    childCount: 4,
  });
  assert.ok(state.records.some((record) => record.type === 'dom.appendChild'));
  assert.ok(state.records.some((record) => record.type === 'dom.attr' && record.name === 'class'));

  const order = realm.evalClassic(`
    const button = document.getElementById('go');
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const order = [];
    button.addEventListener('click', () => order.push('listener'));
    button.onclick = () => order.push('idl');
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    JSON.stringify({ order, inlineClicked: globalThis.inlineClicked });
  `);
  assert.deepEqual(JSON.parse(order), { order: ['listener', 'idl'], inlineClicked: 1 });
  realm.destroy();
});

test('Virtual DOM dispatches events with propagation options and default prevention', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  installVirtualDOM({ realm, records: fixtureRecords(), href: 'https://target.example/events' });

  const result = realm.evalClassic(`
    const app = document.getElementById('app');
    const child = document.createElement('button');
    child.id = 'child';
    app.appendChild(child);
    const order = [];
    app.addEventListener('click', () => order.push('app-capture'), { capture: true });
    app.addEventListener('click', () => order.push('app-bubble'));
    child.addEventListener('click', () => order.push('target-capture'), true);
    child.addEventListener('click', (event) => { order.push('target-once'); event.preventDefault(); }, { once: true });
    child.addEventListener('click', () => {
      order.push('target-reentrant');
      child.addEventListener('click', () => order.push('late'));
    });
    const first = __zpDispatchNativeEvent(child.__zpNodeId, 'click');
    const second = __zpDispatchNativeEvent(child.__zpNodeId, 'click');
    JSON.stringify({ order, first, second });
  `);
  assert.deepEqual(JSON.parse(result), {
    order: [
      'app-capture',
      'target-capture',
      'target-once',
      'target-reentrant',
      'app-bubble',
      'app-capture',
      'target-capture',
      'target-reentrant',
      'late',
      'app-bubble',
    ],
    first: false,
    second: true,
  });
  const handlerProps = realm.evalClassic(`
    const seen = [];
    const handler = (event) => seen.push([event.type, event.currentTarget === globalThis, event.target === globalThis]);
    globalThis.onbeforeprint = handler;
    globalThis.onpointerdown = handler;
    globalThis.onwebkitanimationend = handler;
    dispatchEvent(new Event('beforeprint'));
    dispatchEvent(new Event('pointerdown'));
    dispatchEvent(new Event('webkitanimationend'));
    globalThis.onbeforeprint = 'ignored';
    const beforePrintDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'onbeforeprint');
    JSON.stringify({
      exposed: [
        'onbeforeprint' in globalThis,
        'onpointerdown' in globalThis,
        'onwebkitanimationend' in globalThis,
      ],
      seen,
      reset: globalThis.onbeforeprint,
      typed: [typeof globalThis.onpointerdown, typeof globalThis.onwebkitanimationend],
      descriptor: [beforePrintDescriptor.enumerable, beforePrintDescriptor.configurable, beforePrintDescriptor.get.name, beforePrintDescriptor.set.name, beforePrintDescriptor.set.length],
    });
  `);
  assert.deepEqual(JSON.parse(handlerProps), {
    exposed: [true, true, true],
    seen: [
      ['beforeprint', false, false],
      ['pointerdown', false, false],
      ['webkitanimationend', false, false],
    ],
    reset: null,
    typed: ['function', 'function'],
    descriptor: [true, true, 'get onbeforeprint', 'set onbeforeprint', 1],
  });
  realm.destroy();
});

test('Virtual DOM event listeners honor AbortSignal option removal', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { installVirtualDOM } = await domModule();
  installVirtualDOM({ realm, records: fixtureRecords(), href: 'https://target.example/events' });

  const result = realm.evalClassic(`
    const button = document.getElementById('go');
    function makeSignal() {
      return {
        aborted: false,
        listeners: [],
        addEventListener(type, callback) { if (type === 'abort') this.listeners.push(callback); },
        removeEventListener(type, callback) {
          if (type !== 'abort') return;
          const index = this.listeners.indexOf(callback);
          if (index >= 0) this.listeners.splice(index, 1);
        },
        abort() {
          if (this.aborted) return;
          this.aborted = true;
          for (const callback of [...this.listeners]) callback({ type: 'abort' });
        },
      };
    }
    const calls = [];
    const first = makeSignal();
    const second = makeSignal();
    button.addEventListener('click', () => calls.push('first'), { signal: first });
    button.addEventListener('click', () => calls.push('second'), { signal: second });
    first.abort();
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    second.abort();
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const already = makeSignal();
    already.abort();
    button.addEventListener('click', () => calls.push('already'), { signal: already });
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const duplicateSignal = makeSignal();
    function duplicate() { calls.push('duplicate'); }
    button.addEventListener('click', duplicate, { signal: duplicateSignal });
    button.addEventListener('click', duplicate, { signal: duplicateSignal });
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    duplicateSignal.abort();
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const descriptorFlags = (owner, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      return [
        descriptor.enumerable,
        descriptor.configurable,
        'get' in descriptor ? typeof descriptor.get : null,
        'set' in descriptor ? typeof descriptor.set : null,
        'writable' in descriptor ? descriptor.writable : null,
        typeof descriptor.value,
        typeof descriptor.value === 'function' ? descriptor.value.length : null,
      ];
    };
    let newAbortSignal;
    try { new AbortSignal(); newAbortSignal = ['ok']; } catch (error) { newAbortSignal = [error.name, error.message]; }
    const controller = new AbortController();
    const signalEvents = [];
    controller.signal.addEventListener('abort', (event) => signalEvents.push(['listener', event.type, event.bubbles, event.cancelable, controller.signal.aborted, controller.signal.reason]));
    controller.signal.onabort = (event) => signalEvents.push(['handler', event.type, event.bubbles, event.cancelable, controller.signal.aborted, controller.signal.reason]);
    button.addEventListener('click', () => calls.push('controller'), { signal: controller.signal });
    controller.abort('stop');
    let throwReason = '';
    try { controller.signal.throwIfAborted(); } catch (error) { throwReason = error; }
    __zpDispatchNativeEvent(button.__zpNodeId, 'click');
    const staticSignal = AbortSignal.abort('static');
    const combined = AbortSignal.any([staticSignal]);
    const defaultController = new AbortController();
    defaultController.abort();
    let timeoutInvalid;
    try { AbortSignal.timeout(-1); timeoutInvalid = ['ok']; } catch (error) { timeoutInvalid = [error.name, error.message]; }
    let anyInvalid;
    try { AbortSignal.any(); anyInvalid = ['ok']; } catch (error) { anyInvalid = [error.name, error.message]; }
    const abortStructure = {
      controllerOwn: Object.getOwnPropertyNames(controller),
      controllerProto: Object.getOwnPropertyNames(AbortController.prototype),
      controllerSignalDescriptor: descriptorFlags(AbortController.prototype, 'signal'),
      controllerAbortDescriptor: descriptorFlags(AbortController.prototype, 'abort'),
      signalCtorProps: Object.getOwnPropertyNames(AbortSignal),
      signalOwn: Object.getOwnPropertyNames(controller.signal),
      signalProto: Object.getOwnPropertyNames(AbortSignal.prototype),
      signalAbortedDescriptor: descriptorFlags(AbortSignal.prototype, 'aborted'),
      signalOnabortDescriptor: descriptorFlags(AbortSignal.prototype, 'onabort'),
      signalThrowDescriptor: descriptorFlags(AbortSignal.prototype, 'throwIfAborted'),
      defaultReason: [defaultController.signal.reason.name, defaultController.signal.reason.message, Object.prototype.toString.call(defaultController.signal.reason), Object.getOwnPropertyNames(defaultController.signal)],
      timeoutInvalid,
      anyInvalid,
    };
    const abortSummary = [
      typeof AbortController,
      typeof AbortSignal,
      Object.prototype.toString.call(controller),
      Object.prototype.toString.call(controller.signal),
      controller.signal instanceof AbortSignal,
      controller.signal.aborted,
      signalEvents,
      throwReason,
      staticSignal.aborted,
      staticSignal.reason,
      combined.aborted,
      combined.reason,
      newAbortSignal,
    ];
    const closeWatcherEvents = [];
    let callCloseWatcher;
    try {
      CloseWatcher();
      callCloseWatcher = ['ok'];
    } catch (error) {
      callCloseWatcher = [error.name, error.message];
    }
    const watcher = new CloseWatcher();
    watcher.addEventListener('cancel', (event) => {
      closeWatcherEvents.push(['cancel', event.cancelable, event.defaultPrevented]);
      event.preventDefault();
    });
    watcher.addEventListener('close', () => closeWatcherEvents.push('close-listener'));
    watcher.onclose = () => closeWatcherEvents.push('close-handler');
    watcher.requestClose();
    watcher.close();
    watcher.requestClose();
    const abortedController = new AbortController();
    const abortedWatcher = new CloseWatcher({ signal: abortedController.signal });
    abortedWatcher.addEventListener('close', () => closeWatcherEvents.push('aborted-close'));
    abortedController.abort('abort-close-watcher');
    abortedWatcher.close();
    const destroyedWatcher = new CloseWatcher();
    destroyedWatcher.addEventListener('close', () => closeWatcherEvents.push('destroyed-close'));
    destroyedWatcher.destroy();
    destroyedWatcher.close();
    const closeWatcherSummary = [
      typeof CloseWatcher,
      Object.prototype.toString.call(watcher),
      watcher instanceof CloseWatcher,
      watcher instanceof EventTarget,
      typeof watcher.requestClose,
      typeof watcher.close,
      typeof watcher.destroy,
      closeWatcherEvents,
      Object.getOwnPropertyNames(watcher),
      Object.getOwnPropertyNames(CloseWatcher.prototype),
      Object.getOwnPropertySymbols(CloseWatcher.prototype).map(String),
      Object.prototype.hasOwnProperty.call(CloseWatcher, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'CloseWatcher').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'CloseWatcher').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'CloseWatcher').writable,
      ],
      callCloseWatcher,
    ];
    JSON.stringify({ calls, remainingAbortListeners: duplicateSignal.listeners.length, abortSummary, abortStructure, closeWatcherSummary });
  `);
  assert.deepEqual(JSON.parse(result), {
    calls: ['second', 'duplicate'],
    remainingAbortListeners: 0,
    abortSummary: [
      'function',
      'function',
      '[object AbortController]',
      '[object AbortSignal]',
      true,
      true,
      [
        ['listener', 'abort', false, false, true, 'stop'],
        ['handler', 'abort', false, false, true, 'stop'],
      ],
      'stop',
      true,
      'static',
      true,
      'static',
      ['TypeError', 'Use `new AbortSignal(...)` instead of `AbortSignal(...)`'],
    ],
    abortStructure: {
      controllerOwn: [],
      controllerProto: ['constructor', 'signal', 'abort'],
      controllerSignalDescriptor: [true, true, 'function', 'undefined', null, 'undefined', null],
      controllerAbortDescriptor: [true, true, null, null, true, 'function', 0],
      signalCtorProps: ['length', 'name', 'prototype', 'abort', 'timeout', 'any'],
      signalOwn: [],
      signalProto: ['constructor', 'aborted', 'reason', 'onabort', 'throwIfAborted'],
      signalAbortedDescriptor: [true, true, 'function', 'undefined', null, 'undefined', null],
      signalOnabortDescriptor: [true, true, 'function', 'function', null, 'undefined', null],
      signalThrowDescriptor: [true, true, null, null, true, 'function', 0],
      defaultReason: ['AbortError', 'The operation was aborted.', '[object DOMException]', []],
      timeoutInvalid: ['TypeError', 'Value -1 is outside the range [0, 9007199254740991]'],
      anyInvalid: ['TypeError', 'signals can not be converted to sequence'],
    },
    closeWatcherSummary: [
      'function',
      '[object CloseWatcher]',
      true,
      true,
      'function',
      'function',
      'function',
      [['cancel', true, false], 'close-listener', 'close-handler'],
      [],
      ['oncancel', 'onclose', 'close', 'destroy', 'requestClose', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      [
        'TypeError',
        "Failed to construct 'CloseWatcher': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
    ],
  });
  realm.destroy();
});

test('Virtual DOM supports namespaces viewport media queries observers layout and raf', async () => {
  const runtime = await loadRuntime();
  const realm = runtime.createRealm();
  const { VirtualEventLoop } = await eventLoopModule();
  const { installVirtualDOM } = await domModule();
  const eventLoop = new VirtualEventLoop(realm, { now: 0 });
  installVirtualDOM({
    realm,
    records: fixtureRecords(),
    href: 'https://target.example/viewport',
    viewport: {
      innerWidth: 500,
      innerHeight: 400,
      devicePixelRatio: 2,
      layout: { 'n-app': { x: 1, y: 2, width: 10, height: 20 } },
    },
  });

  const result = realm.evalClassic(`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#icon');
    const linearGradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    const lowerGradient = document.createElementNS('http://www.w3.org/2000/svg', 'lineargradient');
    svg.append(linearGradient, lowerGradient);
    document.body.appendChild(svg);
    const mql = matchMedia('(min-width: 600px)');
    let newScreen;
    try {
      new Screen();
      newScreen = ['ok'];
    } catch (error) {
      newScreen = [error.name, error.message];
    }
    const screenBefore = [
      typeof Screen,
      Object.prototype.toString.call(screen),
      screen instanceof Screen,
      screen.width,
      screen.availHeight,
      screen.colorDepth,
      screen.pixelDepth,
      screen.availLeft,
      screen.availTop,
      Object.getOwnPropertyNames(screen).sort(),
      [
        Object.getOwnPropertyDescriptor(Screen.prototype, 'width').enumerable,
        Object.getOwnPropertyDescriptor(Screen.prototype, 'width').configurable,
        typeof Object.getOwnPropertyDescriptor(Screen.prototype, 'width').get,
        Object.getOwnPropertyDescriptor(Screen.prototype, 'width').set,
      ],
    ];
    let newScreenOrientation;
    try {
      new ScreenOrientation();
      newScreenOrientation = ['ok'];
    } catch (error) {
      newScreenOrientation = [error.name, error.message];
    }
    let callScreenOrientation;
    try {
      ScreenOrientation();
      callScreenOrientation = ['ok'];
    } catch (error) {
      callScreenOrientation = [error.name, error.message];
    }
    const orientation = screen.orientation;
    const screenOrientationBefore = [
      typeof ScreenOrientation,
      Object.prototype.toString.call(orientation),
      orientation instanceof ScreenOrientation,
      orientation instanceof EventTarget,
      orientation.type,
      orientation.angle,
      typeof orientation.lock,
      typeof orientation.unlock,
      orientation.onchange,
      Object.getOwnPropertyNames(orientation).sort(),
      Object.getOwnPropertyNames(ScreenOrientation.prototype),
      Object.getOwnPropertySymbols(ScreenOrientation.prototype).map(String),
      Object.prototype.hasOwnProperty.call(ScreenOrientation, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'type').enumerable,
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'type').configurable,
        typeof Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'type').get,
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'type').set,
      ],
      [
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'lock').enumerable,
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'lock').configurable,
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'lock').writable,
        typeof Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'lock').value,
        Object.getOwnPropertyDescriptor(ScreenOrientation.prototype, 'lock').value.length,
      ],
      orientation.unlock(),
    ];
    let newBarProp;
    try {
      new BarProp();
      newBarProp = ['ok'];
    } catch (error) {
      newBarProp = [error.name, error.message];
    }
    let callBarProp;
    try {
      BarProp();
      callBarProp = ['ok'];
    } catch (error) {
      callBarProp = [error.name, error.message];
    }
    const barSummary = [
      typeof BarProp,
      Object.prototype.toString.call(locationbar),
      locationbar instanceof BarProp,
      locationbar.visible,
      menubar.visible,
      personalbar.visible,
      scrollbars.visible,
      statusbar.visible,
      toolbar.visible,
      Object.getOwnPropertyNames(locationbar).sort(),
      [
        Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').enumerable,
        Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').configurable,
        typeof Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').get,
        Object.getOwnPropertyDescriptor(BarProp.prototype, 'visible').set,
      ],
      Object.getOwnPropertyNames(BarProp.prototype),
      Object.getOwnPropertySymbols(BarProp.prototype).map(String),
      Object.prototype.hasOwnProperty.call(BarProp, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'BarProp').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'BarProp').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'BarProp').writable,
      ],
      typeof status,
      status,
      callBarProp,
    ];
    status = 'ready';
    let newExternal;
    try {
      new External();
      newExternal = ['ok'];
    } catch (error) {
      newExternal = [error.name, error.message];
    }
    let callExternal;
    try {
      External();
      callExternal = ['ok'];
    } catch (error) {
      callExternal = [error.name, error.message];
    }
    const externalSummary = [
      typeof External,
      Object.prototype.toString.call(external),
      external instanceof External,
      Object.isFrozen(external),
      Object.getOwnPropertyNames(external).sort(),
      [
        Object.getOwnPropertyDescriptor(External.prototype, 'AddSearchProvider').enumerable,
        Object.getOwnPropertyDescriptor(External.prototype, 'AddSearchProvider').configurable,
        Object.getOwnPropertyDescriptor(External.prototype, 'AddSearchProvider').writable,
        typeof Object.getOwnPropertyDescriptor(External.prototype, 'AddSearchProvider').value,
        Object.getOwnPropertyDescriptor(External.prototype, 'AddSearchProvider').value.length,
      ],
      Object.getOwnPropertyNames(External.prototype),
      Object.getOwnPropertySymbols(External.prototype).map(String),
      Object.prototype.hasOwnProperty.call(External, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'External').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'External').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'External').writable,
      ],
      external.AddSearchProvider('x'),
      external.IsSearchProviderInstalled('x'),
      newExternal,
      callExternal,
    ];
    let newVisualViewport;
    try {
      new VisualViewport();
      newVisualViewport = ['ok'];
    } catch (error) {
      newVisualViewport = [error.name, error.message];
    }
    const vv = visualViewport;
    const visualViewportBefore = [
      typeof VisualViewport,
      Object.prototype.toString.call(vv),
      vv instanceof VisualViewport,
      vv.width,
      vv.height,
      vv.scale,
      vv.offsetLeft,
      vv.offsetTop,
      vv.pageLeft,
      vv.pageTop,
      vv.onresize,
      vv.onscroll,
      vv.onscrollend,
      Object.getOwnPropertyNames(vv).sort(),
      [
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'width').enumerable,
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'width').configurable,
        typeof Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'width').get,
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'width').set,
      ],
      [
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'onresize').enumerable,
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'onresize').configurable,
        typeof Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'onresize').get,
        typeof Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'onresize').set,
      ],
    ];
    const visualViewportResizes = [];
    vv.onresize = () => visualViewportResizes.push('handler');
    vv.addEventListener('resize', () => visualViewportResizes.push([vv.width, vv.height, vv.scale]));
    const windowScrollEvents = [];
    const visualViewportScrollEvents = [];
    addEventListener('scroll', () => windowScrollEvents.push([scrollX, scrollY]));
    onscroll = () => windowScrollEvents.push('handler');
    vv.addEventListener('scroll', () => visualViewportScrollEvents.push([vv.pageLeft, vv.pageTop]));
    let newPerformance;
    try {
      new Performance();
      newPerformance = ['ok'];
    } catch (error) {
      newPerformance = [error.name, error.message];
    }
    let newPerformanceEntry;
    try {
      new PerformanceEntry();
      newPerformanceEntry = ['ok'];
    } catch (error) {
      newPerformanceEntry = [error.name, error.message];
    }
    const performanceEntryConstructors = [
      [PerformancePaintTiming, true],
      [VisibilityStateEntry, true],
      [PerformanceEventTiming, true],
      [PerformanceLongTaskTiming, true],
      [PerformanceLongAnimationFrameTiming, true],
      [PerformanceScriptTiming, true],
      [PerformanceElementTiming, true],
      [LargestContentfulPaint, true],
      [LayoutShift, true],
      [TaskAttributionTiming, true],
      [LayoutShiftAttribution, false],
    ];
    const performanceEntrySubclassSummary = performanceEntryConstructors.map(([Ctor, isEntry]) => {
      let constructed;
      try {
        new Ctor();
        constructed = ['ok'];
      } catch (error) {
        constructed = [error.name, error.message];
      }
      return [
        typeof Ctor,
        Object.prototype.toString.call(Ctor.prototype),
        isEntry ? Ctor.prototype instanceof PerformanceEntry : false,
        constructed,
      ];
    });
    let newPerformanceResourceTiming;
    try {
      new PerformanceResourceTiming();
      newPerformanceResourceTiming = ['ok'];
    } catch (error) {
      newPerformanceResourceTiming = [error.name, error.message];
    }
    let newPerformanceNavigationTiming;
    try {
      new PerformanceNavigationTiming();
      newPerformanceNavigationTiming = ['ok'];
    } catch (error) {
      newPerformanceNavigationTiming = [error.name, error.message];
    }
    let newPerformanceServerTiming;
    try {
      new PerformanceServerTiming();
      newPerformanceServerTiming = ['ok'];
    } catch (error) {
      newPerformanceServerTiming = [error.name, error.message];
    }
    let newEventCounts;
    try {
      new EventCounts();
      newEventCounts = ['ok'];
    } catch (error) {
      newEventCounts = [error.name, error.message];
    }
    let callEventCounts;
    try {
      EventCounts();
      callEventCounts = ['ok'];
    } catch (error) {
      callEventCounts = [error.name, error.message];
    }
    let newAnimationTimeline;
    try {
      new AnimationTimeline();
      newAnimationTimeline = ['ok'];
    } catch (error) {
      newAnimationTimeline = [error.name, error.message];
    }
    const offsetTimeline = new DocumentTimeline({ originTime: 5 });
    const timelineSubject = document.getElementById('app');
    const scrollTimeline = new ScrollTimeline({ source: timelineSubject, axis: 'inline' });
    const viewTimeline = new ViewTimeline({ subject: timelineSubject, axis: 'y', inset: '10px' });
    const timelineSummary = [
      typeof AnimationTimeline,
      typeof DocumentTimeline,
      Object.prototype.toString.call(document.timeline),
      document.timeline instanceof DocumentTimeline,
      document.timeline instanceof AnimationTimeline,
      document.timeline.currentTime,
      Object.prototype.toString.call(offsetTimeline),
      offsetTimeline instanceof DocumentTimeline,
      offsetTimeline.currentTime,
      newAnimationTimeline,
      typeof ScrollTimeline,
      typeof ViewTimeline,
      Object.prototype.toString.call(scrollTimeline),
      scrollTimeline instanceof ScrollTimeline,
      scrollTimeline instanceof AnimationTimeline,
      scrollTimeline.source === timelineSubject,
      scrollTimeline.axis,
      scrollTimeline.currentTime,
      Object.prototype.toString.call(viewTimeline),
      viewTimeline instanceof ViewTimeline,
      viewTimeline instanceof ScrollTimeline,
      viewTimeline instanceof AnimationTimeline,
      viewTimeline.subject === timelineSubject,
      viewTimeline.source === timelineSubject,
      viewTimeline.axis,
      viewTimeline.inset,
    ];
    const perf = performance;
    const legacyPerformanceThrows = [PerformanceNavigation, PerformanceTiming, PerformanceTimingConfidence].map((Ctor) => {
      try {
        new Ctor();
        return ['ok'];
      } catch (error) {
        return [error.name, error.message];
      }
    });
    const legacyPerformanceSummary = [
      typeof PerformanceNavigation,
      Object.prototype.toString.call(perf.navigation),
      perf.navigation instanceof PerformanceNavigation,
      perf.navigation.type,
      perf.navigation.redirectCount,
      perf.navigation.TYPE_NAVIGATE,
      JSON.stringify(perf.navigation),
      Object.getOwnPropertyNames(perf.navigation),
      Object.getOwnPropertyNames(PerformanceNavigation.prototype),
      Object.getOwnPropertyNames(PerformanceNavigation),
      [
        Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'type').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'type').configurable,
        typeof Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'type').get,
        Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'TYPE_RESERVED').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'TYPE_RESERVED').configurable,
        Object.getOwnPropertyDescriptor(PerformanceNavigation.prototype, 'TYPE_RESERVED').writable,
      ],
      typeof PerformanceTiming,
      Object.prototype.toString.call(perf.timing),
      perf.timing instanceof PerformanceTiming,
      perf.timing.navigationStart,
      Object.keys(perf.timing.toJSON()).length,
      Object.getOwnPropertyNames(perf.timing),
      Object.getOwnPropertyNames(PerformanceTiming.prototype),
      JSON.stringify(Object.keys(perf.timing.toJSON())),
      typeof PerformanceTimingConfidence,
      Object.prototype.toString.call(PerformanceTimingConfidence.prototype),
      Object.getOwnPropertyNames(PerformanceTimingConfidence.prototype),
      [
        Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'randomizedTriggerRate').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'randomizedTriggerRate').configurable,
        typeof Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'randomizedTriggerRate').get,
        Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'toJSON').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceTimingConfidence.prototype, 'toJSON').writable,
      ],
      legacyPerformanceThrows,
    ];
    const performanceBefore = [
      typeof Performance,
      Object.prototype.toString.call(perf),
      perf instanceof Performance,
      Object.prototype.toString.call(perf.eventCounts),
      perf.eventCounts instanceof EventCounts,
      perf.eventCounts.size,
      Object.getOwnPropertyNames(perf.eventCounts).sort(),
      [
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'size').enumerable,
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'size').configurable,
        typeof Object.getOwnPropertyDescriptor(EventCounts.prototype, 'size').get,
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'size').set,
      ],
      [
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'get').enumerable,
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'get').configurable,
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'get').writable,
        typeof Object.getOwnPropertyDescriptor(EventCounts.prototype, 'get').value,
        Object.getOwnPropertyDescriptor(EventCounts.prototype, 'get').value.length,
      ],
      Object.getOwnPropertyNames(EventCounts.prototype),
      Object.getOwnPropertySymbols(EventCounts.prototype).map(String),
      Object.getOwnPropertyDescriptor(EventCounts.prototype, Symbol.iterator).enumerable,
      Object.getOwnPropertyDescriptor(globalThis, 'EventCounts').enumerable,
      Object.prototype.hasOwnProperty.call(EventCounts, Symbol.hasInstance),
      perf.timeOrigin,
      perf.now(),
    ];
    const navEntry = perf.getEntriesByType('navigation')[0];
    const navigationObserver = new PerformanceObserver(() => {});
    navigationObserver.observe({ type: 'navigation', buffered: true });
    const navigationRecords = navigationObserver.takeRecords();
    navigationObserver.disconnect();
    const fakeServerTiming = Object.create(PerformanceServerTiming.prototype);
    const performanceTimingSummary = [
      typeof PerformanceResourceTiming,
      typeof PerformanceNavigationTiming,
      typeof PerformanceServerTiming,
      Object.prototype.toString.call(navEntry),
      navEntry instanceof PerformanceNavigationTiming,
      navEntry instanceof PerformanceResourceTiming,
      navEntry instanceof PerformanceEntry,
      navEntry.name,
      navEntry.entryType,
      navEntry.initiatorType,
      navEntry.type,
      navEntry.redirectCount,
      navEntry.serverTiming.length,
      navEntry.toJSON().responseEnd,
      navigationRecords.map((entry) => [Object.prototype.toString.call(entry), entry.name, entry.entryType]),
      Object.getOwnPropertyNames(navEntry),
      Object.getOwnPropertyNames(PerformanceResourceTiming.prototype),
      Object.getOwnPropertyNames(PerformanceNavigationTiming.prototype),
      Object.prototype.toString.call(navEntry.confidence),
      navEntry.confidence.value,
      Object.keys(navEntry.toJSON()).slice(-4),
      newPerformanceResourceTiming,
      newPerformanceNavigationTiming,
      Object.getOwnPropertyNames(PerformanceServerTiming.prototype),
      [
        Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'name').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'name').configurable,
        typeof Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'name').get,
        Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'toJSON').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'toJSON').writable,
        Object.getOwnPropertyDescriptor(PerformanceServerTiming.prototype, 'toJSON').value.length,
      ],
      (() => { try { fakeServerTiming.toJSON(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      newPerformanceServerTiming,
    ];
    const mark = perf.mark('start', { startTime: 0, detail: 'mark-detail' });
    let newMediaQueryList;
    try {
      new MediaQueryList();
      newMediaQueryList = ['ok'];
    } catch (error) {
      newMediaQueryList = [error.name, error.message];
    }
    let callMediaQueryList;
    try {
      MediaQueryList();
      callMediaQueryList = ['ok'];
    } catch (error) {
      callMediaQueryList = [error.name, error.message];
    }
    let callMediaQueryListEvent;
    try {
      MediaQueryListEvent('change');
      callMediaQueryListEvent = ['ok'];
    } catch (error) {
      callMediaQueryListEvent = [error.name, error.message];
    }
    let newMediaQueryListEvent;
    try {
      new MediaQueryListEvent();
      newMediaQueryListEvent = ['ok'];
    } catch (error) {
      newMediaQueryListEvent = [error.name, error.message];
    }
    const mediaQueryListBefore = [
      typeof MediaQueryList,
      Object.prototype.toString.call(mql),
      mql instanceof MediaQueryList,
      mql instanceof EventTarget,
      Object.getOwnPropertyNames(mql),
      Object.getOwnPropertyNames(MediaQueryList.prototype),
      Object.getOwnPropertySymbols(MediaQueryList.prototype).map(String),
      Object.prototype.hasOwnProperty.call(MediaQueryList, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryList').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryList').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryList').writable,
      ],
      mql.media,
      mql.matches,
      callMediaQueryList,
      newMediaQueryList,
    ];
    const mediaEvent = new MediaQueryListEvent('change', { matches: true, media: '(min-width: 1px)' });
    const mediaEventSummary = [
      typeof MediaQueryListEvent,
      Object.prototype.toString.call(mediaEvent),
      mediaEvent instanceof MediaQueryListEvent,
      mediaEvent instanceof Event,
      Object.getOwnPropertyNames(mediaEvent),
      Object.getOwnPropertyNames(MediaQueryListEvent.prototype),
      Object.getOwnPropertySymbols(MediaQueryListEvent.prototype).map(String),
      Object.prototype.hasOwnProperty.call(MediaQueryListEvent, Symbol.hasInstance),
      [
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryListEvent').enumerable,
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryListEvent').configurable,
        Object.getOwnPropertyDescriptor(globalThis, 'MediaQueryListEvent').writable,
      ],
      mediaEvent.matches,
      mediaEvent.media,
      callMediaQueryListEvent,
      newMediaQueryListEvent,
    ];
    const mediaEventDetails = [];
    const changes = [];
    mql.addEventListener('change', () => changes.push(mql.matches));
    mql.addListener((event) => mediaEventDetails.push(['legacy', event instanceof MediaQueryListEvent, event.matches, event.media]));
    mql.onchange = (event) => mediaEventDetails.push(['handler', event instanceof MediaQueryListEvent, event.matches, event.media]);
    const observed = [];
    const appElement = document.getElementById('app');
    let newAnimationEffect;
    try {
      new AnimationEffect();
      newAnimationEffect = ['ok'];
    } catch (error) {
      newAnimationEffect = [error.name, error.message];
    }
    const animation = appElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'forwards' });
    const animationEvents = [];
    animation.addEventListener('finish', () => animationEvents.push('finish'));
    animation.addEventListener('cancel', () => animationEvents.push('cancel'));
    animation.finish();
    animation.cancel();
    const effect = animation.effect;
    effect.updateTiming({ duration: 150 });
    const animationSummary = [
      typeof Animation,
      typeof AnimationEffect,
      typeof KeyframeEffect,
      Object.prototype.toString.call(animation),
      animation instanceof Animation,
      animation instanceof EventTarget,
      Object.prototype.toString.call(effect),
      effect instanceof KeyframeEffect,
      effect instanceof AnimationEffect,
      effect.target === appElement,
      animation.timeline === document.timeline,
      animation.playState,
      animation.currentTime,
      effect.getKeyframes().length,
      effect.getTiming().duration,
      effect.getComputedTiming().activeDuration,
      animationEvents,
      newAnimationEffect,
    ];
    let newCSSAnimation;
    try {
      new CSSAnimation();
      newCSSAnimation = ['ok'];
    } catch (error) {
      newCSSAnimation = [error.name, error.message];
    }
    let newCSSTransition;
    try {
      new CSSTransition();
      newCSSTransition = ['ok'];
    } catch (error) {
      newCSSTransition = [error.name, error.message];
    }
    const trackedAnimation = appElement.animate({ transform: ['none', 'scale(1)'] }, 10);
    const animationTrackingSummary = [
      typeof CSSAnimation,
      typeof CSSTransition,
      document.getAnimations().includes(trackedAnimation),
      appElement.getAnimations()[0] === trackedAnimation,
      document.getAnimations().length,
      appElement.getAnimations().length,
      newCSSAnimation,
      newCSSTransition,
    ];
    trackedAnimation.cancel();
    animationTrackingSummary.push(document.getAnimations().includes(trackedAnimation), appElement.getAnimations().length);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry.contentBoxSize[0];
      const deviceBox = entry.devicePixelContentBoxSize[0];
      observed.push([
        entry instanceof ResizeObserverEntry,
        Object.prototype.toString.call(entry),
        entry.target === appElement,
        entry.contentRect instanceof DOMRect,
        entry.contentRect instanceof DOMRectReadOnly,
        Object.prototype.toString.call(entry.contentRect),
        entry.contentRect.width,
        Object.isFrozen(entry.contentBoxSize),
        Object.prototype.toString.call(box),
        box instanceof ResizeObserverSize,
        box.inlineSize,
        box.blockSize,
        deviceBox.inlineSize,
        Object.getOwnPropertyNames(entry),
        Object.getOwnPropertyNames(box),
        (() => { try { new ResizeObserverEntry(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
        (() => { try { new ResizeObserverSize(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    });
    resizeObserver.observe(appElement);
    const intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      observed.push([
        entry instanceof IntersectionObserverEntry,
        Object.prototype.toString.call(entry),
        entry.target === appElement,
        entry.isIntersecting,
        entry.intersectionRatio,
        entry.rootBounds,
        entry.boundingClientRect.width,
        entry.intersectionRect.width,
        entry.isVisible,
        Object.getOwnPropertyNames(entry),
        (() => { try { new IntersectionObserverEntry(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      ]);
    }, { root: appElement, rootMargin: '1px 2px', scrollMargin: '3px', threshold: [0.5, 0], delay: 7, trackVisibility: true });
    intersectionObserver.observe(appElement);
    const observerShape = [
      Object.getOwnPropertyNames(resizeObserver),
      Reflect.ownKeys(ResizeObserver.prototype).map(String),
      Object.prototype.toString.call(ResizeObserver.prototype),
      Object.getOwnPropertyNames(intersectionObserver),
      Reflect.ownKeys(IntersectionObserver.prototype).map(String),
      Object.prototype.toString.call(IntersectionObserver.prototype),
      intersectionObserver.root === appElement,
      intersectionObserver.rootMargin,
      intersectionObserver.scrollMargin,
      Array.from(intersectionObserver.thresholds),
      intersectionObserver.delay,
      intersectionObserver.trackVisibility,
      intersectionObserver.takeRecords().length,
    ];
    const rectBefore = appElement.getBoundingClientRect();
    const rectList = appElement.getClientRects();
    let newDOMRectList;
    try {
      new DOMRectList();
      newDOMRectList = ['ok'];
    } catch (error) {
      newDOMRectList = [error.name, error.message];
    }
    const rectMutable = DOMRect.fromRect({ x: 1, y: 2, width: 3, height: 4 });
    rectMutable.width = 7;
    const rectReadonly = DOMRectReadOnly.fromRect({ x: 5, y: 6, width: -2, height: -3 });
    const rectSummary = [
      typeof DOMRect,
      typeof DOMRectReadOnly,
      Object.prototype.toString.call(rectBefore),
      rectBefore instanceof DOMRect,
      rectBefore instanceof DOMRectReadOnly,
      JSON.stringify(rectBefore),
      typeof DOMRectList,
      Object.prototype.toString.call(rectList),
      rectList instanceof DOMRectList,
      rectList.length,
      rectList.item(0) instanceof DOMRect,
      rectList[0].width,
      [...rectList][0] === rectList.item(0),
      rectList.item(1),
      newDOMRectList,
      [rectMutable.x, rectMutable.y, rectMutable.width, rectMutable.height, rectMutable.right, rectMutable.bottom],
      Object.getOwnPropertyNames(rectMutable).sort(),
      Object.getOwnPropertyNames(rectReadonly).sort(),
      Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, 'x').enumerable,
      Object.getOwnPropertyDescriptor(DOMRectReadOnly, 'fromRect').enumerable,
      Object.prototype.toString.call(rectReadonly),
      rectReadonly instanceof DOMRectReadOnly,
      rectReadonly instanceof DOMRect,
      [rectReadonly.left, rectReadonly.top, rectReadonly.right, rectReadonly.bottom],
    ];
    const pointMutable = DOMPoint.fromPoint({ x: 1, y: 2, z: 3, w: 1 });
    pointMutable.y = 9;
    const pointReadonly = DOMPointReadOnly.fromPoint({ x: 4, y: 5, z: 6, w: 2 });
    const pointTransformed = pointReadonly.matrixTransform({ a: 2, d: 3, e: 10, f: 20, m33: 4, m44: 5 });
    const pointSummary = [
      typeof DOMPoint,
      typeof DOMPointReadOnly,
      Object.prototype.toString.call(pointMutable),
      pointMutable instanceof DOMPoint,
      pointMutable instanceof DOMPointReadOnly,
      JSON.stringify(pointMutable),
      Object.prototype.toString.call(pointReadonly),
      pointReadonly instanceof DOMPointReadOnly,
      pointReadonly instanceof DOMPoint,
      JSON.stringify(pointReadonly),
      [pointTransformed.x, pointTransformed.y, pointTransformed.z, pointTransformed.w],
      Object.getOwnPropertyNames(pointMutable).sort(),
      Object.getOwnPropertyNames(pointReadonly).sort(),
      Object.getOwnPropertyDescriptor(DOMPointReadOnly.prototype, 'matrixTransform').enumerable,
      Object.getOwnPropertyDescriptor(DOMPoint, 'fromPoint').enumerable,
    ];
    const quad = DOMQuad.fromRect({ x: 2, y: 3, width: 4, height: 5 });
    const skewQuad = new DOMQuad({ x: -1, y: 2 }, { x: 3, y: 1 }, { x: 4, y: 8 }, { x: -2, y: 7 });
    const skewBounds = skewQuad.getBounds();
    const quadClone = DOMQuad.fromQuad(quad);
    const quadSummary = [
      typeof DOMQuad,
      Object.prototype.toString.call(quad),
      quad instanceof DOMQuad,
      JSON.stringify(quad),
      [skewBounds.x, skewBounds.y, skewBounds.width, skewBounds.height],
      JSON.stringify(quadClone.p3),
      Object.getOwnPropertyNames(quad).sort(),
      Object.getOwnPropertyDescriptor(DOMQuad.prototype, 'p1').enumerable,
      Object.getOwnPropertyDescriptor(DOMQuad.prototype, 'getBounds').enumerable,
      Object.getOwnPropertyDescriptor(DOMQuad, 'fromRect').enumerable,
    ];
    const matrix = new DOMMatrix([1, 2, 3, 4, 5, 6]);
    matrix.a = 2;
    matrix.translateSelf(10, 20).scaleSelf(2, 3);
    const matrixReadonly = DOMMatrixReadOnly.fromMatrix(matrix);
    const matrixPoint = matrixReadonly.transformPoint({ x: 1, y: 1, z: 0, w: 1 });
    const matrixSummary = [
      typeof DOMMatrix,
      typeof DOMMatrixReadOnly,
      Object.prototype.toString.call(matrix),
      matrix instanceof DOMMatrix,
      matrix instanceof DOMMatrixReadOnly,
      [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, matrix.is2D, matrix.isIdentity],
      Object.getOwnPropertyNames(matrix).sort(),
      Object.getOwnPropertyNames(matrixReadonly).sort(),
      Object.prototype.toString.call(matrixReadonly),
      matrixReadonly instanceof DOMMatrixReadOnly,
      matrixReadonly instanceof DOMMatrix,
      [matrixPoint.x, matrixPoint.y, matrixPoint.z, matrixPoint.w],
      DOMMatrix.fromFloat32Array(new Float32Array([1, 0, 0, 1, 2, 3])).e,
      typeof WebKitCSSMatrix,
      WebKitCSSMatrix === DOMMatrix,
      new WebKitCSSMatrix() instanceof DOMMatrix,
      Object.prototype.toString.call(new WebKitCSSMatrix()),
    ];
    const before = rectBefore.width;
    __zpUpdateViewport({ innerWidth: 700, innerHeight: 401, scale: 1.5, now: 33, layout: { 'n-app': { x: 3, y: 4, width: 42, height: 8 } } });
    name = 'zp-window';
    const frames = [];
    requestAnimationFrame((ts) => frames.push(ts));
    scrollTo(10, 20);
    scrollBy(5, 0);
    dispatchEvent(new Event('zpcount'));
    dispatchEvent(new Event('zpcount'));
    const eventCountForEach = [];
    perf.eventCounts.forEach((value, key, list) => {
      if (key === 'zpcount') eventCountForEach.push([value, list === perf.eventCounts]);
    });
    const eventCountsSummary = [
      typeof EventCounts,
      Object.prototype.toString.call(perf.eventCounts),
      perf.eventCounts instanceof EventCounts,
      perf.eventCounts.get('zpcount'),
      perf.eventCounts.has('zpcount'),
      perf.eventCounts.get('missing'),
      eventCountForEach,
      [...perf.eventCounts.keys()].includes('zpcount'),
      [...perf.eventCounts.values()].includes(2),
      [...perf.eventCounts.entries()].find(([key]) => key === 'zpcount')?.[1],
    ];
    const measure = perf.measure('span', 'start');
    const optionMeasure = perf.measure('option-span', { start: 'start', duration: 5, detail: 'measure-detail' });
    const performanceAfter = [
      performance === perf,
      perf.now(),
      Object.prototype.toString.call(mark),
      mark instanceof PerformanceMark,
      mark instanceof PerformanceEntry,
      mark instanceof PerformanceMeasure,
      mark.startTime,
      JSON.stringify(mark),
      Object.getOwnPropertyNames(mark),
      Object.getOwnPropertyNames(PerformanceEntry.prototype),
      Object.getOwnPropertyNames(PerformanceMark.prototype),
      mark.detail,
      Object.prototype.toString.call(measure),
      measure instanceof PerformanceMeasure,
      measure instanceof PerformanceEntry,
      measure instanceof PerformanceMark,
      measure.duration,
      JSON.stringify(measure),
      Object.getOwnPropertyNames(measure),
      Object.getOwnPropertyNames(PerformanceMeasure.prototype),
      measure.detail,
      optionMeasure.startTime,
      optionMeasure.duration,
      optionMeasure.detail,
      (() => { try { perf.measure('bad', { start: 'start', end: 'observed-mark', duration: 1 }); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      (() => { try { perf.measure('bad', 'missing'); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      perf.getEntriesByType('mark').length,
      perf.getEntriesByName('span', 'measure')[0].duration,
      (() => { try { const manual = new PerformanceMark('manual', { startTime: 9, detail: 'manual-detail' }); return [Object.prototype.toString.call(manual), manual.startTime, manual.detail]; } catch (error) { return [error.name, error.message]; } })(),
    ];
    const observer = new PerformanceObserver(() => {});
    observer.observe({ entryTypes: ['mark', 'measure'] });
    perf.mark('observed-mark');
    perf.measure('observed-measure', 'observed-mark');
    const observedRecords = observer.takeRecords();
    observer.disconnect();
    perf.mark('buffered-mark');
    const bufferedObserver = new PerformanceObserver(() => {});
    bufferedObserver.observe({ type: 'mark', buffered: true });
    const bufferedRecords = bufferedObserver.takeRecords();
    let newPerformanceObserverEntryList;
    try {
      new PerformanceObserverEntryList();
      newPerformanceObserverEntryList = ['ok'];
    } catch (error) {
      newPerformanceObserverEntryList = [error.name, error.message];
    }
    const fakePerformanceObserverEntryList = Object.create(PerformanceObserverEntryList.prototype);
    const perfObserverSummary = [
      typeof PerformanceObserver,
      Array.from(PerformanceObserver.supportedEntryTypes).join(','),
      Object.prototype.toString.call(observer),
      observer instanceof PerformanceObserver,
      observedRecords.map((entry) => [Object.prototype.toString.call(entry), entry.name, entry.entryType]),
      Object.prototype.toString.call(bufferedObserver),
      bufferedRecords.map((entry) => entry.name),
      typeof PerformanceObserverEntryList,
      Object.prototype.toString.call(fakePerformanceObserverEntryList),
      Object.getOwnPropertyNames(PerformanceObserverEntryList.prototype),
      [
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntries').enumerable,
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntries').configurable,
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntries').writable,
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntries').value.length,
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntriesByName').value.length,
        Object.getOwnPropertyDescriptor(PerformanceObserverEntryList.prototype, 'getEntriesByType').value.length,
      ],
      (() => { try { fakePerformanceObserverEntryList.getEntries(); return ['ok']; } catch (error) { return [error.name, error.message]; } })(),
      newPerformanceObserverEntryList,
    ];
    bufferedObserver.disconnect();
    perf.clearMarks();
    perf.clearMeasures();
    const performanceCleared = perf.getEntries().length;
    const windowDescriptorSummary = ['window', 'self', 'document', 'location', 'closed', 'name', 'innerWidth', 'screen', 'visualViewport', 'locationbar', 'status', 'external'].map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      return [key, descriptor.enumerable, descriptor.configurable, typeof descriptor.get, typeof descriptor.set, descriptor.get?.name || '', descriptor.set?.name || ''];
    });
    JSON.stringify({
      ns: svg.namespaceURI,
      href: svg.getAttributeNS('http://www.w3.org/1999/xlink', 'href'),
      svgNames: [
        linearGradient.localName,
        linearGradient.tagName,
        Object.prototype.toString.call(linearGradient),
        lowerGradient.localName,
        document.getElementsByTagName('linearGradient').length,
        document.getElementsByTagName('lineargradient').length,
      ],
      before,
      after: appElement.getBoundingClientRect().width,
      rectSummary,
      pointSummary,
      quadSummary,
      matrixSummary,
      innerWidth,
      dpr: devicePixelRatio,
      windowGlobals: [globalThis.frames === globalThis, globalThis.parent === globalThis, globalThis.top === globalThis, globalThis.opener, globalThis.frameElement, globalThis.length, globalThis.closed, globalThis.name, globalThis.isSecureContext, globalThis.crossOriginIsolated, globalThis.credentialless],
      windowDescriptorSummary,
      windowMethods: [
        typeof alert,
        confirm('question'),
        prompt('question', 'fallback'),
        open('/popup') === null,
        find('missing'),
        scroll === scrollTo,
        typeof webkitRequestAnimationFrame,
        webkitCancelAnimationFrame === cancelAnimationFrame,
        outerWidth,
        outerHeight,
        screenX,
        screenY,
        screenLeft,
        screenTop,
        originAgentCluster,
        offscreenBuffering,
        typeof postMessage,
        postMessage.length,
        Object.hasOwn(postMessage, 'prototype'),
      ],
      matches: mql.matches,
      screenBefore,
      screenAfter: [Object.prototype.toString.call(screen), screen instanceof Screen, screen.width, screen.height, screen.availWidth, screen.availHeight],
      screenOrientationBefore,
      screenOrientationAfter: [screen.orientation === orientation, orientation.type, orientation.angle],
      newScreenOrientation,
      callScreenOrientation,
      newBarProp,
      barSummary,
      statusAfter: status,
      externalSummary,
      newScreen,
      newVisualViewport,
      visualViewportBefore,
      visualViewportAfter: [visualViewport === vv, vv.width, vv.height, vv.scale, visualViewportResizes],
      performanceTimingSummary,
      timelineSummary,
      animationSummary,
      animationTrackingSummary,
      scrollState: [scrollX, scrollY, pageXOffset, pageYOffset, vv.offsetLeft, vv.offsetTop, vv.pageLeft, vv.pageTop, windowScrollEvents, visualViewportScrollEvents],
      changes,
      mediaQueryListBefore,
      mediaEventSummary,
      mediaEventDetails,
      newPerformance,
      newPerformanceEntry,
      performanceEntrySubclassSummary,
      legacyPerformanceSummary,
      newEventCounts,
      callEventCounts,
      performanceBefore,
      performanceAfter,
      performanceCleared,
      eventCountsSummary,
      perfObserverSummary,
      observed,
      observerShape,
      frames,
    });
  `);
  const beforeTick = JSON.parse(result);
  assert.deepEqual(beforeTick, {
    ns: 'http://www.w3.org/2000/svg',
    href: '#icon',
    svgNames: ['linearGradient', 'linearGradient', '[object EventTarget]', 'lineargradient', 1, 1],
    before: 10,
    after: 42,
    innerWidth: 700,
    dpr: 2,
    windowGlobals: [true, true, true, null, null, 0, false, 'zp-window', true, false, false],
    windowDescriptorSummary: [
      ['window', true, false, 'function', 'undefined', 'get window', ''],
      ['self', true, true, 'function', 'function', 'get self', 'set self'],
      ['document', true, false, 'function', 'undefined', 'get document', ''],
      ['location', true, false, 'function', 'function', 'get location', 'set location'],
      ['closed', true, true, 'function', 'undefined', 'get closed', ''],
      ['name', true, true, 'function', 'function', 'get name', 'set name'],
      ['innerWidth', true, true, 'function', 'function', 'get innerWidth', 'set innerWidth'],
      ['screen', true, true, 'function', 'function', 'get screen', 'set screen'],
      [
        'visualViewport',
        true,
        true,
        'function',
        'function',
        'get visualViewport',
        'set visualViewport',
      ],
      ['locationbar', true, true, 'function', 'function', 'get locationbar', 'set locationbar'],
      ['status', true, true, 'function', 'function', 'get status', 'set status'],
      ['external', true, true, 'function', 'function', 'get external', 'set external'],
    ],
    windowMethods: [
      'function',
      false,
      null,
      true,
      false,
      false,
      'function',
      false,
      700,
      401,
      0,
      0,
      0,
      0,
      false,
      false,
      'function',
      1,
      false,
    ],
    matches: true,
    screenBefore: [
      'function',
      '[object Screen]',
      true,
      500,
      400,
      24,
      24,
      0,
      0,
      [],
      [true, true, 'function', null],
    ],
    screenAfter: ['[object Screen]', true, 700, 401, 700, 401],
    newScreen: ['TypeError', "Failed to construct 'Screen': Illegal constructor"],
    screenOrientationBefore: [
      'function',
      '[object ScreenOrientation]',
      true,
      true,
      'landscape-primary',
      0,
      'function',
      'function',
      null,
      [],
      ['angle', 'type', 'onchange', 'lock', 'unlock', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      null,
    ],
    screenOrientationAfter: [true, 'landscape-primary', 0],
    newScreenOrientation: [
      'TypeError',
      "Failed to construct 'ScreenOrientation': Illegal constructor",
    ],
    callScreenOrientation: ['TypeError', 'Illegal constructor'],
    newBarProp: ['TypeError', "Failed to construct 'BarProp': Illegal constructor"],
    barSummary: [
      'function',
      '[object BarProp]',
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      [],
      [true, true, 'function', null],
      ['visible', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      'string',
      '',
      ['TypeError', 'Illegal constructor'],
    ],
    statusAfter: 'ready',
    externalSummary: [
      'function',
      '[object External]',
      true,
      false,
      [],
      [true, true, true, 'function', 0],
      ['AddSearchProvider', 'IsSearchProviderInstalled', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      null,
      null,
      ['TypeError', "Failed to construct 'External': Illegal constructor"],
      ['TypeError', 'Illegal constructor'],
    ],
    newVisualViewport: ['TypeError', "Failed to construct 'VisualViewport': Illegal constructor"],
    visualViewportBefore: [
      'function',
      '[object VisualViewport]',
      true,
      500,
      400,
      1,
      0,
      0,
      0,
      0,
      null,
      null,
      null,
      [],
      [true, true, 'function', null],
      [true, true, 'function', 'function'],
    ],
    visualViewportAfter: [true, 700, 401, 1.5, [[700, 401, 1.5], 'handler']],
    scrollState: [
      15,
      20,
      15,
      20,
      15,
      20,
      15,
      20,
      [[10, 20], 'handler', [15, 20], 'handler'],
      [
        [10, 20],
        [15, 20],
      ],
    ],
    mediaQueryListBefore: [
      'function',
      '[object MediaQueryList]',
      true,
      true,
      [],
      ['media', 'matches', 'onchange', 'addListener', 'removeListener', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      '(min-width: 600px)',
      false,
      ['TypeError', 'Illegal constructor'],
      ['TypeError', "Failed to construct 'MediaQueryList': Illegal constructor"],
    ],
    mediaEventSummary: [
      'function',
      '[object MediaQueryListEvent]',
      true,
      true,
      ['isTrusted'],
      ['media', 'matches', 'constructor'],
      ['Symbol(Symbol.toStringTag)'],
      false,
      [false, true, true],
      true,
      '(min-width: 1px)',
      [
        'TypeError',
        "Failed to construct 'MediaQueryListEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      ],
      [
        'TypeError',
        "Failed to construct 'MediaQueryListEvent': 1 argument required, but only 0 present.",
      ],
    ],
    mediaEventDetails: [
      ['legacy', true, true, '(min-width: 600px)'],
      ['handler', true, true, '(min-width: 600px)'],
    ],
    newPerformance: ['TypeError', "Failed to construct 'Performance': Illegal constructor"],
    performanceBefore: [
      'function',
      '[object Performance]',
      true,
      '[object EventCounts]',
      true,
      0,
      [],
      [true, true, 'function', null],
      [true, true, true, 'function', 1],
      ['size', 'entries', 'forEach', 'get', 'has', 'keys', 'values', 'constructor'],
      ['Symbol(Symbol.toStringTag)', 'Symbol(Symbol.iterator)'],
      false,
      false,
      false,
      0,
      0,
    ],
    newPerformanceEntry: [
      'TypeError',
      "Failed to construct 'PerformanceEntry': Illegal constructor",
    ],
    performanceEntrySubclassSummary: [
      [
        'function',
        '[object PerformancePaintTiming]',
        true,
        ['TypeError', "Failed to construct 'PerformancePaintTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object VisibilityStateEntry]',
        true,
        ['TypeError', "Failed to construct 'VisibilityStateEntry': Illegal constructor"],
      ],
      [
        'function',
        '[object PerformanceEventTiming]',
        true,
        ['TypeError', "Failed to construct 'PerformanceEventTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object PerformanceLongTaskTiming]',
        true,
        ['TypeError', "Failed to construct 'PerformanceLongTaskTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object PerformanceLongAnimationFrameTiming]',
        true,
        [
          'TypeError',
          "Failed to construct 'PerformanceLongAnimationFrameTiming': Illegal constructor",
        ],
      ],
      [
        'function',
        '[object PerformanceScriptTiming]',
        true,
        ['TypeError', "Failed to construct 'PerformanceScriptTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object PerformanceElementTiming]',
        true,
        ['TypeError', "Failed to construct 'PerformanceElementTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object LargestContentfulPaint]',
        true,
        ['TypeError', "Failed to construct 'LargestContentfulPaint': Illegal constructor"],
      ],
      [
        'function',
        '[object LayoutShift]',
        true,
        ['TypeError', "Failed to construct 'LayoutShift': Illegal constructor"],
      ],
      [
        'function',
        '[object TaskAttributionTiming]',
        true,
        ['TypeError', "Failed to construct 'TaskAttributionTiming': Illegal constructor"],
      ],
      [
        'function',
        '[object LayoutShiftAttribution]',
        false,
        ['TypeError', "Failed to construct 'LayoutShiftAttribution': Illegal constructor"],
      ],
    ],
    legacyPerformanceSummary: [
      'function',
      '[object PerformanceNavigation]',
      true,
      0,
      0,
      0,
      '{"type":0,"redirectCount":0}',
      [],
      [
        'type',
        'redirectCount',
        'TYPE_NAVIGATE',
        'TYPE_RELOAD',
        'TYPE_BACK_FORWARD',
        'TYPE_RESERVED',
        'toJSON',
        'constructor',
      ],
      [
        'length',
        'name',
        'prototype',
        'TYPE_NAVIGATE',
        'TYPE_RELOAD',
        'TYPE_BACK_FORWARD',
        'TYPE_RESERVED',
      ],
      [true, true, 'function', true, false, false],
      'function',
      '[object PerformanceTiming]',
      true,
      0,
      21,
      [],
      [
        'navigationStart',
        'unloadEventStart',
        'unloadEventEnd',
        'redirectStart',
        'redirectEnd',
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'connectEnd',
        'secureConnectionStart',
        'requestStart',
        'responseStart',
        'responseEnd',
        'domLoading',
        'domInteractive',
        'domContentLoadedEventStart',
        'domContentLoadedEventEnd',
        'domComplete',
        'loadEventStart',
        'loadEventEnd',
        'toJSON',
        'constructor',
      ],
      '["connectStart","secureConnectionStart","unloadEventEnd","domainLookupStart","domainLookupEnd","responseStart","connectEnd","responseEnd","requestStart","domLoading","redirectStart","loadEventEnd","domComplete","navigationStart","loadEventStart","domContentLoadedEventEnd","unloadEventStart","redirectEnd","domInteractive","fetchStart","domContentLoadedEventStart"]',
      'function',
      '[object PerformanceTimingConfidence]',
      ['randomizedTriggerRate', 'value', 'toJSON', 'constructor'],
      [true, true, 'function', true, true],
      [
        ['TypeError', "Failed to construct 'PerformanceNavigation': Illegal constructor"],
        ['TypeError', "Failed to construct 'PerformanceTiming': Illegal constructor"],
        ['TypeError', "Failed to construct 'PerformanceTimingConfidence': Illegal constructor"],
      ],
    ],
    performanceTimingSummary: [
      'function',
      'function',
      'function',
      '[object PerformanceNavigationTiming]',
      true,
      true,
      true,
      'https://target.example/viewport',
      'navigation',
      'navigation',
      'navigate',
      0,
      0,
      0,
      [['[object PerformanceNavigationTiming]', 'https://target.example/viewport', 'navigation']],
      [],
      [
        'initiatorType',
        'nextHopProtocol',
        'deliveryType',
        'workerStart',
        'redirectStart',
        'redirectEnd',
        'fetchStart',
        'domainLookupStart',
        'domainLookupEnd',
        'connectStart',
        'connectEnd',
        'secureConnectionStart',
        'requestStart',
        'responseStart',
        'responseEnd',
        'transferSize',
        'encodedBodySize',
        'decodedBodySize',
        'serverTiming',
        'responseStatus',
        'finalResponseHeadersStart',
        'firstInterimResponseStart',
        'toJSON',
        'workerRouterEvaluationStart',
        'workerCacheLookupStart',
        'workerMatchedSourceType',
        'workerFinalSourceType',
        'renderBlockingStatus',
        'contentType',
        'contentEncoding',
        'constructor',
      ],
      [
        'unloadEventStart',
        'unloadEventEnd',
        'domInteractive',
        'domContentLoadedEventStart',
        'domContentLoadedEventEnd',
        'domComplete',
        'loadEventStart',
        'loadEventEnd',
        'type',
        'redirectCount',
        'criticalCHRestart',
        'activationStart',
        'toJSON',
        'confidence',
        'constructor',
        'notRestoredReasons',
      ],
      '[object PerformanceTimingConfidence]',
      'low',
      ['activationStart', 'criticalCHRestart', 'notRestoredReasons', 'confidence'],
      ['TypeError', "Failed to construct 'PerformanceResourceTiming': Illegal constructor"],
      ['TypeError', "Failed to construct 'PerformanceNavigationTiming': Illegal constructor"],
      ['name', 'duration', 'description', 'toJSON', 'constructor'],
      [true, true, 'function', true, true, 0],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', "Failed to construct 'PerformanceServerTiming': Illegal constructor"],
    ],
    timelineSummary: [
      'function',
      'function',
      '[object DocumentTimeline]',
      true,
      true,
      0,
      '[object DocumentTimeline]',
      true,
      -5,
      ['TypeError', "Failed to construct 'AnimationTimeline': Illegal constructor"],
      'function',
      'function',
      '[object ScrollTimeline]',
      true,
      true,
      true,
      'inline',
      0,
      '[object ViewTimeline]',
      true,
      true,
      true,
      true,
      true,
      'y',
      '10px',
    ],
    animationSummary: [
      'function',
      'function',
      'function',
      '[object Animation]',
      true,
      true,
      '[object KeyframeEffect]',
      true,
      true,
      true,
      true,
      'idle',
      null,
      2,
      150,
      150,
      ['finish', 'cancel'],
      ['TypeError', "Failed to construct 'AnimationEffect': Illegal constructor"],
    ],
    animationTrackingSummary: [
      'function',
      'function',
      true,
      true,
      1,
      1,
      ['TypeError', "Failed to construct 'CSSAnimation': Illegal constructor"],
      ['TypeError', "Failed to construct 'CSSTransition': Illegal constructor"],
      false,
      0,
    ],
    newEventCounts: ['TypeError', "Failed to construct 'EventCounts': Illegal constructor"],
    callEventCounts: ['TypeError', 'Illegal constructor'],
    performanceAfter: [
      true,
      33,
      '[object PerformanceMark]',
      true,
      true,
      false,
      0,
      '{"name":"start","entryType":"mark","startTime":0,"duration":0}',
      [],
      ['name', 'entryType', 'startTime', 'duration', 'toJSON', 'constructor'],
      ['detail', 'constructor'],
      'mark-detail',
      '[object PerformanceMeasure]',
      true,
      true,
      false,
      33,
      '{"name":"span","entryType":"measure","startTime":0,"duration":33}',
      [],
      ['detail', 'constructor'],
      null,
      0,
      5,
      'measure-detail',
      [
        'TypeError',
        "Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined",
      ],
      [
        'SyntaxError',
        "Failed to execute 'measure' on 'Performance': The mark 'missing' does not exist.",
      ],
      1,
      33,
      ['[object PerformanceMark]', 9, 'manual-detail'],
    ],
    performanceCleared: 1,
    eventCountsSummary: [
      'function',
      '[object EventCounts]',
      true,
      2,
      true,
      0,
      [[2, true]],
      true,
      true,
      2,
    ],
    perfObserverSummary: [
      'function',
      'navigation,mark,measure',
      '[object PerformanceObserver]',
      true,
      [
        ['[object PerformanceMark]', 'observed-mark', 'mark'],
        ['[object PerformanceMeasure]', 'observed-measure', 'measure'],
      ],
      '[object PerformanceObserver]',
      ['start', 'observed-mark', 'buffered-mark'],
      'function',
      '[object PerformanceObserverEntryList]',
      ['getEntries', 'getEntriesByName', 'getEntriesByType', 'constructor'],
      [true, true, true, 0, 1, 1],
      ['TypeError', 'Illegal invocation'],
      ['TypeError', "Failed to construct 'PerformanceObserverEntryList': Illegal constructor"],
    ],
    observerShape: [
      [],
      ['constructor', 'observe', 'unobserve', 'disconnect', 'Symbol(Symbol.toStringTag)'],
      '[object ResizeObserver]',
      [],
      [
        'constructor',
        'root',
        'rootMargin',
        'scrollMargin',
        'thresholds',
        'delay',
        'trackVisibility',
        'observe',
        'unobserve',
        'disconnect',
        'takeRecords',
        'Symbol(Symbol.toStringTag)',
      ],
      '[object IntersectionObserver]',
      true,
      '1px 2px 1px 2px',
      '3px 3px 3px 3px',
      [0, 0.5],
      7,
      true,
      0,
    ],
    changes: [true],
    observed: [
      [
        true,
        '[object ResizeObserverEntry]',
        true,
        true,
        true,
        '[object DOMRect]',
        42,
        true,
        '[object ResizeObserverSize]',
        true,
        42,
        8,
        84,
        [],
        [],
        ['TypeError', "Failed to construct 'ResizeObserverEntry': Illegal constructor"],
        ['TypeError', "Failed to construct 'ResizeObserverSize': Illegal constructor"],
      ],
      [
        true,
        '[object IntersectionObserverEntry]',
        true,
        true,
        1,
        null,
        42,
        42,
        true,
        [],
        ['TypeError', "Failed to construct 'IntersectionObserverEntry': Illegal constructor"],
      ],
    ],
    rectSummary: [
      'function',
      'function',
      '[object DOMRect]',
      true,
      true,
      '{"x":1,"y":2,"width":10,"height":20,"top":2,"right":11,"bottom":22,"left":1}',
      'function',
      '[object DOMRectList]',
      true,
      1,
      true,
      10,
      true,
      null,
      ['TypeError', "Failed to construct 'DOMRectList': Illegal constructor"],
      [1, 2, 7, 4, 8, 6],
      [],
      [],
      true,
      true,
      '[object DOMRectReadOnly]',
      true,
      false,
      [3, 3, 5, 6],
    ],
    pointSummary: [
      'function',
      'function',
      '[object DOMPoint]',
      true,
      true,
      '{"x":1,"y":9,"z":3,"w":1}',
      '[object DOMPointReadOnly]',
      true,
      false,
      '{"x":4,"y":5,"z":6,"w":2}',
      [28, 55, 24, 10],
      [],
      [],
      true,
      true,
    ],
    quadSummary: [
      'function',
      '[object DOMQuad]',
      true,
      '{"p1":{"x":2,"y":3,"z":0,"w":1},"p2":{"x":6,"y":3,"z":0,"w":1},"p3":{"x":6,"y":8,"z":0,"w":1},"p4":{"x":2,"y":8,"z":0,"w":1}}',
      [-2, 1, 6, 7],
      '{"x":6,"y":8,"z":0,"w":1}',
      [],
      true,
      true,
      true,
    ],
    matrixSummary: [
      'function',
      'function',
      '[object DOMMatrix]',
      true,
      true,
      [4, 2, 3, 12, 15, 26, true, false],
      [],
      [],
      '[object DOMMatrixReadOnly]',
      true,
      false,
      [22, 40, 0, 1],
      2,
      'function',
      true,
      true,
      '[object DOMMatrix]',
    ],
    frames: [],
  });
  realm.evalClassic(`
    globalThis.orientationLockResult = '';
    screen.orientation.lock('portrait-primary').catch((error) => { globalThis.orientationLockResult = error.name; });
  `);
  for (let i = 0; i < 4; i++) realm.drainJobs();
  assert.equal(realm.evalClassic('orientationLockResult'), 'NotSupportedError');
  eventLoop.tick(16);
  assert.deepEqual(JSON.parse(realm.evalClassic('JSON.stringify(frames)')), [33]);
  realm.destroy();
});
