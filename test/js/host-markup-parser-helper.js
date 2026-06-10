const puppeteer = require('puppeteer');

const parserSnapshots = new Map();

async function makeHostMarkupParser(corpus) {
  const snapshot = await snapshotHostMarkup(corpus);
  return {
    parseDocument(source, type) {
      const key = documentKey(source, type);
      const record = snapshot.documents[key];
      if (!record) throw new Error(`Host DOMParser document snapshot missing for ${key}`);
      return clone(record);
    },
    parseFragment(source, context) {
      const key = fragmentKey(source, context);
      const record = snapshot.fragments[key];
      if (!record) throw new Error(`Host parser fragment snapshot missing for ${key}`);
      return clone(record);
    },
    parseStyleDeclarations(cssText) {
      const key = String(cssText ?? '');
      const record = snapshot.styles[key];
      if (!record) throw new Error(`Host CSS parser snapshot missing for ${key}`);
      return clone(record);
    },
  };
}

async function snapshotHostMarkup(corpus) {
  const normalized = normalizeCorpus(corpus);
  const cacheKey = JSON.stringify(normalized);
  let promise = parserSnapshots.get(cacheKey);
  if (!promise) {
    promise = readHostParserSnapshot(normalized);
    parserSnapshots.set(cacheKey, promise);
  }
  return promise;
}

function normalizeCorpus(corpus) {
  const documents = [
    ...new Map(
      (corpus.documents || []).map((entry) => {
        const source = typeof entry === 'string' ? entry : entry.source;
        const type = typeof entry === 'string' ? 'text/html' : entry.type || 'text/html';
        return [
          documentKey(source, type),
          { source: String(source ?? ''), type: String(type || 'text/html') },
        ];
      }),
    ).values(),
  ];
  const fragments = [
    ...new Map(
      (corpus.fragments || []).map((entry) => {
        const source = typeof entry === 'string' ? entry : entry.source;
        const context = normalizeFragmentContext(
          typeof entry === 'string' ? undefined : entry.context,
        );
        return [fragmentKey(source, context), { source: String(source ?? ''), context }];
      }),
    ).values(),
  ];
  const styles = [...new Set((corpus.styles || []).map((cssText) => String(cssText ?? '')))];
  return { documents, fragments, styles };
}

async function readHostParserSnapshot(corpus) {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    return await page.evaluate((input) => {
      const parserTypes = new Set([
        'text/html',
        'text/xml',
        'application/xml',
        'application/xhtml+xml',
        'image/svg+xml',
      ]);
      const normalizeType = (type) => {
        const text = String(type || 'text/html').toLowerCase();
        return parserTypes.has(text) ? text : 'text/html';
      };
      const key = (source, type) => `${normalizeType(type)}\u0000${String(source ?? '')}`;
      const fragmentKey = (source, context) => {
        const normalized = normalizeFragmentContext(context);
        return `${normalized.namespaceURI}\u0000${normalized.name}\u0000${String(source ?? '')}`;
      };
      const normalizeFragmentContext = (context) => ({
        name: String(context?.name || 'div').toLowerCase(),
        namespaceURI: String(context?.namespaceURI || 'http://www.w3.org/1999/xhtml'),
      });
      const childSnapshots = (parent) =>
        Array.from(parent?.childNodes || [], nodeSnapshot).filter(Boolean);
      const attributeSnapshots = (element) =>
        Array.from(element.attributes || [], (attr) => ({
          name: attr.name,
          namespaceURI: attr.namespaceURI || '',
          value: attr.value || '',
        }));
      const documentBodySnapshot = (doc) => {
        if (!doc) return [];
        if (doc.body) return childSnapshots(doc.body);
        return doc.documentElement ? [nodeSnapshot(doc.documentElement)] : childSnapshots(doc);
      };
      const documentSnapshot = (doc, contentType) => ({
        contentType: doc?.contentType || contentType,
        title: doc?.title || '',
        head: childSnapshots(doc?.head),
        body: documentBodySnapshot(doc),
      });
      function nodeSnapshot(node) {
        if (!node) return null;
        if (node.nodeType === 3) return { type: 'text', text: node.nodeValue || '' };
        if (node.nodeType === 8) return { type: 'comment', text: node.nodeValue || '' };
        if (node.nodeType !== 1) return null;
        return {
          type: 'element',
          name: node.localName || String(node.nodeName || '').toLowerCase(),
          namespaceURI: node.namespaceURI || '',
          attributes: attributeSnapshots(node),
          children: childSnapshots(node),
        };
      }

      const documents = {};
      for (const { source, type } of input.documents) {
        const parseType = normalizeType(type);
        const doc = new DOMParser().parseFromString(String(source ?? ''), parseType);
        documents[key(source, parseType)] = documentSnapshot(doc, parseType);
      }

      const fragments = {};
      for (const { source, context } of input.fragments) {
        const doc = new DOMParser().parseFromString(
          '<!doctype html><html><body></body></html>',
          'text/html',
        );
        const normalized = normalizeFragmentContext(context);
        const element =
          normalized.namespaceURI && normalized.namespaceURI !== 'http://www.w3.org/1999/xhtml'
            ? doc.createElementNS(normalized.namespaceURI, normalized.name)
            : doc.createElement(normalized.name);
        (doc.body || doc.documentElement || doc).appendChild(element);
        element.innerHTML = String(source ?? '');
        fragments[fragmentKey(source, normalized)] = childSnapshots(element);
      }
      const styles = {};
      for (const cssText of input.styles) {
        const doc = new DOMParser().parseFromString(
          '<!doctype html><html><body></body></html>',
          'text/html',
        );
        const element = doc.createElement('div');
        (doc.body || doc.documentElement || doc).appendChild(element);
        element.style.cssText = String(cssText ?? '');
        const declarations = [];
        for (let i = 0; i < element.style.length; i += 1) {
          const name = element.style.item(i);
          declarations.push({
            name,
            value: element.style.getPropertyValue(name),
            priority: element.style.getPropertyPriority(name),
          });
        }
        styles[String(cssText ?? '')] = declarations;
      }
      return { documents, fragments, styles };
    }, corpus);
  } finally {
    await browser.close();
  }
}

function documentKey(source, type) {
  return `${normalizeType(type)}\u0000${String(source ?? '')}`;
}

function fragmentKey(source, context) {
  const normalized = normalizeFragmentContext(context);
  return `${normalized.namespaceURI}\u0000${normalized.name}\u0000${String(source ?? '')}`;
}

function normalizeFragmentContext(context) {
  return {
    name: String(context?.name || 'div').toLowerCase(),
    namespaceURI: String(context?.namespaceURI || 'http://www.w3.org/1999/xhtml'),
  };
}

function normalizeType(type) {
  const text = String(type || 'text/html').toLowerCase();
  return [
    'text/html',
    'text/xml',
    'application/xml',
    'application/xhtml+xml',
    'image/svg+xml',
  ].includes(text)
    ? text
    : 'text/html';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { makeHostMarkupParser };
