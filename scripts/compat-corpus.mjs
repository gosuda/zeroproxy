import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(ROOT, 'test/e2e/representative-sites.json');
const FIXTURE_ROOT = path.join(ROOT, 'test/fixtures/representative-sites');
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>)}]+/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const DEFAULT_TIMEOUT_MS = 45000;

const PROFILES = {
  desktop: {
    viewport: { width: 1365, height: 900, deviceScaleFactor: 1, isMobile: false },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  },
  mobile: {
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
};

export function loadCorpus(file = DEFAULT_CORPUS) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id))
      throw new Error(`duplicate or missing corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.url && !entry.fixture) throw new Error(`${entry.id} needs url or fixture`);
    if (!PROFILES[entry.profile])
      throw new Error(`${entry.id} has unknown profile ${entry.profile}`);
  }
  return entries;
}

export function redactText(value, site = {}) {
  return String(value || '')
    .replace(
      URL_RE,
      (raw) => `<url:${classifyURL(raw, site).scheme}:${classifyURL(raw, site).hostClass}>`,
    )
    .replace(IPV4_RE, '<ipv4>')
    .replace(TOKEN_RE, '<token>');
}

export function fingerprintText(value, site = {}) {
  const redacted = redactText(value, site).slice(0, 2048);
  return crypto.createHash('sha256').update(redacted).digest('hex').slice(0, 20);
}

export function classifyURL(raw, site = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { scheme: 'invalid', hostClass: 'invalid', pathClass: 'invalid' };
  }
  const protocol = parsed.protocol.replace(/:$/, '') || 'unknown';
  const hostname = parsed.hostname.toLowerCase();
  return {
    scheme: protocol,
    hostClass: classifyHost(hostname, site),
    pathClass: classifyPath(parsed),
  };
}

export function summarizeRecord(record) {
  return {
    ok: record.ok,
    urlClass: record.urlClass,
    lifecycle: record.lifecycle,
    console: countBy(record.console, (item) => item.level),
    pageErrors: record.pageErrors.length,
    requestFailures: countBy(record.requestFailures, failureKey),
    responses: countBy(record.responses, responseKey),
    selectors: record.selectors,
    rendering: record.rendering,
    iframes: record.iframes,
    resources: record.resources,
    transportTimings: summarizeTransportTimings(record.transportTimings),
    syntheticTimingGaps: record.syntheticTimingGaps,
    rootSurface: record.rootSurface,
  };
}

export function compareSiteRecords(nativeRecord, zeroProxyRecord, spec) {
  const nativeSummary = summarizeRecord(nativeRecord);
  const zeroProxySummary = summarizeRecord(zeroProxyRecord);
  const delta = {
    console: subtractCounts(zeroProxySummary.console, nativeSummary.console),
    pageErrors: zeroProxySummary.pageErrors - nativeSummary.pageErrors,
    requestFailures: subtractCounts(
      zeroProxySummary.requestFailures,
      nativeSummary.requestFailures,
    ),
    responses: subtractCounts(zeroProxySummary.responses, nativeSummary.responses),
    rendering: renderingDelta(nativeRecord, zeroProxyRecord),
    iframes: iframeDelta(nativeRecord, zeroProxyRecord),
    timing: timingDelta(nativeRecord, zeroProxyRecord),
    rootSurface: rootSurfaceDelta(nativeRecord.rootSurface, zeroProxyRecord.rootSurface),
    transport: transportDelta(nativeRecord, zeroProxyRecord),
  };
  const firstFailingSurface = classifyFirstFailure(nativeRecord, zeroProxyRecord, delta, spec);
  const expectedDelta = expectedCorpusDelta(spec, firstFailingSurface);
  const status =
    firstFailingSurface === 'none' ? 'pass' : expectedDelta ? 'expected-delta' : 'triage';
  const failureTelemetry = buildFailureTelemetry(
    nativeRecord,
    zeroProxyRecord,
    delta,
    spec,
    firstFailingSurface,
    expectedDelta,
  );
  return {
    site: spec.id,
    profile: spec.profile,
    primaryFlow: spec.primaryFlow,
    firstFailingSurface,
    ownerModule: ownerForSurface(firstFailingSurface),
    status,
    expectedDelta,
    failureTelemetry,
    native: nativeSummary,
    zeroProxy: zeroProxySummary,
    delta,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = defaultArgs();
  const handlers = argHandlers(args);
  for (let i = 0; i < argv.length; i++) {
    const handler = handlers.get(argv[i]);
    if (!handler) throw new Error(`unknown argument: ${argv[i]}`);
    i = handler(argv, i);
  }
  validateArgs(args);
  return args;
}

function defaultArgs() {
  return {
    mode: 'both',
    corpus: DEFAULT_CORPUS,
    out: '',
    releaseOut: '',
    failOnReleaseGate: false,
    sites: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    proxyUrl: '',
    dist: '',
    headless: true,
  };
}

function argHandlers(args) {
  return new Map([
    [
      '--mode',
      (argv, i) => {
        args.mode = argv[i + 1];
        return i + 1;
      },
    ],
    [
      '--corpus',
      (argv, i) => {
        args.corpus = path.resolve(argv[i + 1]);
        return i + 1;
      },
    ],
    [
      '--out',
      (argv, i) => {
        args.out = path.resolve(argv[i + 1]);
        return i + 1;
      },
    ],
    [
      '--release-out',
      (argv, i) => {
        args.releaseOut = path.resolve(argv[i + 1]);
        return i + 1;
      },
    ],
    [
      '--fail-on-release-gate',
      (_argv, i) => {
        args.failOnReleaseGate = true;
        return i;
      },
    ],
    [
      '--sites',
      (argv, i) => {
        args.sites = argv[i + 1].split(',').filter(Boolean);
        return i + 1;
      },
    ],
    [
      '--timeout-ms',
      (argv, i) => {
        args.timeoutMs = Number(argv[i + 1]);
        return i + 1;
      },
    ],
    [
      '--proxy-url',
      (argv, i) => {
        args.proxyUrl = argv[i + 1];
        return i + 1;
      },
    ],
    [
      '--dist',
      (argv, i) => {
        args.dist = path.resolve(argv[i + 1]);
        return i + 1;
      },
    ],
    [
      '--headed',
      (_argv, i) => {
        args.headless = false;
        return i;
      },
    ],
    [
      '--help',
      (_argv, i) => {
        args.help = true;
        return i;
      },
    ],
  ]);
}

function validateArgs(args) {
  if (!['native', 'zeroproxy', 'both'].includes(args.mode)) {
    throw new Error('--mode must be native, zeroproxy, or both');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
}

export async function runCorpus(options) {
  const corpus = selectSites(loadCorpus(options.corpus), options.sites);
  const fixtureServer = await startFixtureServer(corpus);
  const proxy = await maybeStartProxy(options);
  const browser = await puppeteer.launch({
    headless: options.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP proxy.localhost 127.0.0.1',
    ],
  });
  try {
    const records = await collectCorpusRecords(browser, corpus, fixtureServer, proxy, options);
    const report = buildCorpusReport(corpus, records, options);
    writeCorpusReport(report, options.out);
    writeCorpusReport(report.releaseGate, options.releaseOut);
    if (options.failOnReleaseGate && report.releaseGate.status !== 'pass') {
      const metrics = report.releaseGate.metrics;
      throw new Error(
        `release corpus gate failed: triage=${metrics.triageSites} missing=${metrics.missingComparisons} script=${metrics.scriptRewriteInducedFailures} syntax=${metrics.generatedJavaScriptSyntaxErrors} failClosed=${metrics.unexpectedScriptFailCloseFallbacks}`,
      );
    }
    return report;
  } finally {
    await browser.close();
    await closeFixtureServer(fixtureServer);
    await closeProxy(proxy);
  }
}

async function collectCorpusRecords(browser, corpus, fixtureServer, proxy, options) {
  const records = [];
  for (const spec of corpus) {
    records.push(await collectSiteRecord(browser, spec, fixtureServer, proxy, options));
  }
  return records;
}

async function collectSiteRecord(browser, spec, fixtureServer, proxy, options) {
  const url = siteURL(spec, fixtureServer?.origin);
  const siteSpec = { ...spec, url };
  const native = await maybeRunMode(browser, siteSpec, url, 'native', options, proxy);
  const zeroProxy = await maybeRunMode(browser, siteSpec, url, 'zeroproxy', options, proxy);
  return {
    site: spec.id,
    profile: spec.profile,
    primaryFlow: spec.primaryFlow,
    native: native ? summarizeRecord(native) : null,
    zeroProxy: zeroProxy ? summarizeRecord(zeroProxy) : null,
    comparison: native && zeroProxy ? compareSiteRecords(native, zeroProxy, siteSpec) : null,
  };
}

async function maybeRunMode(browser, siteSpec, url, mode, options, proxy) {
  if (!shouldRunMode(options.mode, mode)) return null;
  const modeOptions = mode === 'zeroproxy' ? { ...options, proxyUrl: proxy.url } : options;
  return runOne(browser, siteSpec, url, mode, modeOptions);
}

function shouldRunMode(selectedMode, candidateMode) {
  return selectedMode === candidateMode || selectedMode === 'both';
}

function buildCorpusReport(corpus, records, options) {
  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    corpusVersion: corpusHash(corpus),
    redaction: {
      rawUrls: false,
      rawConsoleText: false,
      rawIpDnsValues: false,
      fingerprints: 'sha256-20-of-redacted-text',
    },
    releaseGate: buildReleaseGateReport(corpus, records),
    records,
  };
}

function writeCorpusReport(report, out) {
  if (!out) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

export function buildReleaseGateReport(corpus, records) {
  const siteRecords = Array.isArray(records) ? records : [];
  const compared = siteRecords.filter((record) => record.comparison);
  const metrics = compared.reduce(
    (acc, record) => {
      const comparison = record.comparison;
      const script = comparison.failureTelemetry?.evidence?.script || {};
      acc.passSites += comparison.status === 'pass' ? 1 : 0;
      acc.expectedDeltaSites += comparison.status === 'expected-delta' ? 1 : 0;
      acc.triageSites += comparison.status === 'triage' ? 1 : 0;
      if (comparison.status !== 'expected-delta') {
        acc.scriptRewriteInducedFailures += Number(script.rewriteInducedFailureCount) || 0;
        acc.generatedJavaScriptSyntaxErrors +=
          Number(script.generatedJavaScriptSyntaxErrorCount) || 0;
        acc.unexpectedScriptFailCloseFallbacks += Number(script.unexpectedFailCloseCount) || 0;
      }
      return acc;
    },
    {
      siteCount: Array.isArray(corpus) ? corpus.length : 0,
      comparedSites: compared.length,
      missingComparisons: siteRecords.filter((record) => !record.comparison).length,
      passSites: 0,
      expectedDeltaSites: 0,
      triageSites: 0,
      scriptRewriteInducedFailures: 0,
      generatedJavaScriptSyntaxErrors: 0,
      unexpectedScriptFailCloseFallbacks: 0,
    },
  );
  const gates = {
    allSitesCompared:
      metrics.comparedSites === metrics.siteCount && metrics.missingComparisons === 0,
    noTriageSites: metrics.triageSites === 0,
    noRewriteInducedScriptFailures: metrics.scriptRewriteInducedFailures === 0,
    noGeneratedJavaScriptSyntaxErrors: metrics.generatedJavaScriptSyntaxErrors === 0,
    noUnexpectedScriptFailCloseFallbacks: metrics.unexpectedScriptFailCloseFallbacks === 0,
  };
  return {
    schema: 'zp.compat.release-gate.v1',
    corpusVersion: corpusHash(corpus || []),
    status: Object.values(gates).every(Boolean) ? 'pass' : 'triage',
    metrics,
    gates,
    seedCorpus: releaseGateSeedSemantics(corpus),
    triageSites: compared
      .filter((record) => record.comparison.status === 'triage')
      .map((record) => ({
        site: record.site,
        firstFailingSurface: record.comparison.firstFailingSurface,
        ownerModule: record.comparison.ownerModule,
      })),
    expectedDeltaSites: compared
      .filter((record) => record.comparison.status === 'expected-delta')
      .map((record) => ({
        site: record.site,
        firstFailingSurface: record.comparison.firstFailingSurface,
        ownerModule: record.comparison.ownerModule,
        reason: record.comparison.expectedDelta?.reason || '',
        classification: record.comparison.expectedDelta?.classification || 'expected-delta',
      })),
    redaction: {
      rawUrls: false,
      rawConsoleText: false,
      rawIpDnsValues: false,
      rawSourceBodies: false,
    },
  };
}

export function releaseGateSeedSemantics(corpus) {
  return (Array.isArray(corpus) ? corpus : []).map((site) => ({
    id: site.id,
    site: site.site,
    profile: site.profile,
    primaryFlow: site.primaryFlow,
    source: site.fixture ? 'checked-in-html-fixture' : 'sanitized-seed-fixture',
    expectations: {
      iframeAdCandidates: site.iframeExpectations?.adCandidates === true,
      iframeNonBlank: site.iframeExpectations?.nonBlank === true,
      googleMapsFrame: site.iframeExpectations?.googleMaps === true,
      nonBlankMap: site.renderExpectations?.nonBlankMap === true,
      coarseIpDnsClassesOnly: site.redaction?.coarseIpDnsClassesOnly === true,
      unsupportedSurfaces: [...(site.unsupportedSurfaces || [])].sort(),
      expectedDeltas: (Array.isArray(site.expectedDeltas) ? site.expectedDeltas : []).map(
        (row) => ({
          surface: row.surface,
          classification: row.classification || 'expected-delta',
        }),
      ),
    },
  }));
}

function expectedCorpusDelta(spec, surface) {
  if (!spec || surface === 'none') return null;
  const rows = Array.isArray(spec.expectedDeltas) ? spec.expectedDeltas : [];
  return rows.find((row) => row.surface === surface) || null;
}
async function runOne(browser, spec, url, mode, options) {
  const page = await browser.newPage();
  const events = makeEventCollector(spec);
  attachEventCollector(page, events);
  await applyProfile(page, spec.profile);
  const startedAt = Date.now();
  let navigationError = null;
  try {
    if (mode === 'zeroproxy')
      await openThroughProxy(page, options.proxyUrl, url, options.timeoutMs);
    else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await waitForReadiness(page, spec.readiness || [], options.timeoutMs);
  } catch (err) {
    navigationError = err;
  }
  const observed = await observePage(page, spec, events, startedAt, navigationError);
  await page.close();
  return observed;
}

function makeEventCollector(spec) {
  return {
    spec,
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
  };
}

function attachEventCollector(page, events) {
  page.on('console', (msg) => {
    events.console.push({
      level: msg.type(),
      fingerprint: fingerprintText(msg.text(), events.spec),
    });
  });
  page.on('pageerror', (err) => {
    events.pageErrors.push({
      name: err?.name || 'Error',
      fingerprint: fingerprintText(err?.message || err, events.spec),
    });
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    events.requestFailures.push({
      urlClass: classifyURL(req.url(), events.spec),
      resourceType: req.resourceType(),
      failureClass: redactText(failure?.errorText || 'unknown', events.spec),
    });
  });
  page.on('response', (res) => {
    const headers = res.headers();
    events.responses.push({
      urlClass: classifyURL(res.url(), events.spec),
      resourceType: res.request().resourceType(),
      statusBucket: statusBucket(res.status()),
      contentTypeBucket: contentTypeBucket(headers['content-type'] || ''),
    });
  });
}

async function applyProfile(page, profileName) {
  const profile = PROFILES[profileName];
  await page.setViewport(profile.viewport);
  await page.setUserAgent(profile.userAgent);
}

async function openThroughProxy(page, proxyUrl, targetUrl, timeoutMs) {
  await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await waitForFunction(
    page,
    () => document.querySelector('#status')?.textContent === 'Ready.',
    timeoutMs,
  );
  await page.type('#url', targetUrl);
  await Promise.all([
    page.click('button'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null),
  ]);
}

async function waitForReadiness(page, selectors, timeoutMs) {
  if (!selectors.length) return;
  await waitForFunction(
    page,
    (required) => required.every((selector) => document.querySelector(selector)),
    Math.min(timeoutMs, 20000),
    selectors,
  );
}

async function waitForFunction(page, predicate, timeoutMs, ...args) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(predicate, ...args)) return;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last || new Error('timed out waiting for page predicate');
}

async function observePage(page, spec, events, startedAt, navigationError) {
  const pageURL = page.url();
  const screenshot = await screenshotDigest(page);
  const dom = await safeEvaluate(
    page,
    (selectors) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      };
      const selectorRows = selectors.map((selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        return { selector, count: nodes.length, visible: nodes.some(visible) };
      });
      const iframeRows = Array.from(document.querySelectorAll('iframe')).map((frame) => {
        const rect = frame.getBoundingClientRect();
        let accessible = false;
        let textLength = 0;
        try {
          accessible = !!frame.contentDocument;
          textLength = frame.contentDocument?.body?.innerText?.length || 0;
        } catch {}
        const marker = `${frame.id || ''} ${frame.name || ''} ${frame.title || ''} ${frame.className || ''} ${frame.getAttribute('src') || ''}`;
        return {
          src: frame.getAttribute('src') || frame.src || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: visible(frame),
          accessible,
          nonBlank: rect.width > 8 && rect.height > 8 && (!accessible || textLength > 0),
          adCandidate: /\bad\b|ads|doubleclick|googlesyndication|adservice/i.test(marker),
          googleMapsCandidate: /google.*maps|maps.*google/i.test(marker),
        };
      });
      const bodyRect = document.body?.getBoundingClientRect();
      const rootSurfaceOracle = () => {
        const keys = Reflect.ownKeys(globalThis);
        const selected = [
          'window',
          'self',
          'globalThis',
          'location',
          'document',
          'history',
          'frames',
          'top',
          'parent',
          'opener',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
          'Worker',
          'PerformanceObserver',
          'Function',
        ];
        const constructorName = (value) => value?.constructor?.name || '';
        const valueToStringTag = (value) => value?.[Symbol.toStringTag] || '';
        const functionSourceLength = (value) =>
          typeof value === 'function' ? Function.prototype.toString.call(value).length : 0;
        const errorName = (err) => err?.name || 'Error';
        const valueMetadata = (value) => ({
          valueType: typeof value,
          constructorName: constructorName(value),
          toStringTag: valueToStringTag(value),
          functionSourceLength: functionSourceLength(value),
        });
        const descriptorMetadata = (d) => ({
          configurable: d.configurable,
          enumerable: d.enumerable,
          writable: Object.hasOwn(d, 'writable') ? d.writable : null,
          hasGet: typeof d.get === 'function',
          hasSet: typeof d.set === 'function',
          ...valueMetadata(d.value),
        });
        const descriptor = (key) => {
          try {
            const d = Object.getOwnPropertyDescriptor(globalThis, key);
            return d ? descriptorMetadata(d) : null;
          } catch (err) {
            return { errorName: errorName(err) };
          }
        };
        const inspectObjectGraph = (key) => {
          try {
            const d = Object.getOwnPropertyDescriptor(globalThis, key);
            if (!d || !Object.hasOwn(d, 'value')) return null;
            const value = d.value;
            if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
            const names = Object.getOwnPropertyNames(value);
            const proto = Object.getPrototypeOf(value);
            return {
              ownNameCount: names.length,
              ownSymbolCount: Object.getOwnPropertySymbols(value).length,
              firstNames: names.slice(0, 64).sort(),
              toStringTag: valueToStringTag(value),
              constructorName: constructorName(value),
              prototypeConstructorName: constructorName(proto),
            };
          } catch (err) {
            return { errorName: errorName(err) };
          }
        };
        return {
          ownKeyCount: keys.length,
          ownNameCount: Object.getOwnPropertyNames(globalThis).length,
          ownSymbolCount: Object.getOwnPropertySymbols(globalThis).length,
          firstNames: Object.getOwnPropertyNames(globalThis).slice(0, 200).sort(),
          selectedDescriptors: Object.fromEntries(selected.map((key) => [key, descriptor(key)])),
          selectedGraph: Object.fromEntries(selected.map((key) => [key, inspectObjectGraph(key)])),
          toStringTag: globalThis[Symbol.toStringTag] || '',
        };
      };
      const resources = performance.getEntriesByType('resource').map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType || 'other',
        duration: Number.isFinite(entry.duration) ? Math.round(entry.duration) : 0,
        transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : 0,
      }));
      return {
        titleLength: document.title.length,
        readyState: document.readyState,
        visibleTextLength: document.body?.innerText?.length || 0,
        body: bodyRect
          ? { width: Math.round(bodyRect.width), height: Math.round(bodyRect.height) }
          : { width: 0, height: 0 },
        selectors: selectorRows,
        iframes: iframeRows,
        resources,
        navigationTiming:
          performance.getEntriesByType('navigation').map((entry) => ({
            duration: Math.round(entry.duration),
            domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
            loadEventEnd: Math.round(entry.loadEventEnd),
          }))[0] || null,
        syntheticTimingGaps: globalThis.__zpSyntheticTimingGaps || { script: 0, resource: 0 },
        rootSurface: rootSurfaceOracle(),
      };
    },
    spec.primarySelectors || [],
  );
  const transportTimings = await readTransportTimings(page);
  return {
    ok: !navigationError,
    navigationError: navigationError && {
      name: navigationError.name || 'Error',
      fingerprint: fingerprintText(navigationError.message || navigationError, spec),
    },
    urlClass: classifyURL(pageURL, spec),
    lifecycle: {
      readyState: dom.readyState || 'unknown',
      elapsedMs: Date.now() - startedAt,
      navigation: dom.navigationTiming || null,
    },
    console: events.console,
    pageErrors: events.pageErrors,
    requestFailures: normalizeRequestFailures(
      events.requestFailures,
      events.responses,
      !navigationError,
    ),
    responses: events.responses,
    selectors: dom.selectors || [],
    rendering: {
      titleLength: dom.titleLength || 0,
      visibleTextLength: dom.visibleTextLength || 0,
      body: dom.body || { width: 0, height: 0 },
      screenshot,
    },
    iframes: summarizeIframes(dom.iframes || [], spec),
    resources: summarizeResources(dom.resources || [], spec),
    transportTimings,
    syntheticTimingGaps: dom.syntheticTimingGaps || { script: 0, resource: 0 },
    rootSurface: dom.rootSurface || {},
  };
}

async function readTransportTimings(page) {
  return safeEvaluate(
    page,
    () =>
      new Promise((resolve) => {
        const controller = navigator.serviceWorker?.controller;
        if (!controller) {
          resolve([]);
          return;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
          try {
            channel.port1.close();
          } catch {}
          resolve([]);
        }, 1000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          try {
            channel.port1.close();
          } catch {}
          resolve(event.data?.ok && Array.isArray(event.data.timings) ? event.data.timings : []);
        };
        controller.postMessage({ type: 'ZP_TRANSPORT_TIMINGS', limit: 128 }, [channel.port2]);
      }),
  );
}
async function safeEvaluate(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return {};
  }
}

async function screenshotDigest(page) {
  try {
    const bytes = await page.screenshot({ encoding: 'binary', captureBeyondViewport: false });
    return {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20),
      byteBucket: sizeBucket(bytes.length),
    };
  } catch {
    return { sha256: '', byteBucket: 'unavailable' };
  }
}

function summarizeIframes(iframes, spec) {
  return {
    count: iframes.length,
    visibleCount: iframes.filter((frame) => frame.visible).length,
    nonBlankCount: iframes.filter((frame) => frame.nonBlank).length,
    adCandidateCount: iframes.filter((frame) => frame.adCandidate).length,
    googleMapsCandidateCount: iframes.filter((frame) => frame.googleMapsCandidate).length,
    entries: iframes.slice(0, 20).map((frame) => ({
      srcClass: frame.src
        ? classifyURL(frame.src, spec)
        : { scheme: 'missing', hostClass: 'missing', pathClass: 'missing' },
      visible: frame.visible,
      nonBlank: frame.nonBlank,
      adCandidate: frame.adCandidate,
      googleMapsCandidate: frame.googleMapsCandidate,
      size: { width: frame.width, height: frame.height },
    })),
  };
}

function summarizeResources(resources, spec) {
  const rows = resources.map((entry) => ({
    urlClass: classifyURL(entry.name, spec),
    initiatorType: entry.initiatorType || 'other',
    durationBucket: durationBucket(entry.duration),
    sizeBucket: sizeBucket(entry.transferSize),
  }));
  return {
    count: rows.length,
    byInitiator: countBy(rows, (row) => row.initiatorType),
    byHostClass: countBy(rows, (row) => row.urlClass.hostClass),
    byDuration: countBy(rows, (row) => row.durationBucket),
    bySize: countBy(rows, (row) => row.sizeBucket),
  };
}

async function startFixtureServer(corpus) {
  if (!corpus.some((entry) => entry.fixture)) return null;
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url, 'http://fixture.local').pathname;
    const filePath = path.resolve(FIXTURE_ROOT, `.${requestPath}`);
    if (!filePath.startsWith(`${FIXTURE_ROOT}${path.sep}`)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function maybeStartProxy(options) {
  if (options.mode === 'native') return { url: options.proxyUrl, process: null, temp: '' };
  if (options.proxyUrl) return { url: options.proxyUrl, process: null, temp: '' };
  const temp = options.dist ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'zeroproxy-corpus-'));
  const buildOut = options.dist || path.join(temp, 'dist');
  run('node', ['scripts/build.mjs', '--out', buildOut]);
  const port = await freePort();
  const serverPath = path.join(
    buildOut,
    process.platform === 'win32' ? 'zeroproxy-server.exe' : 'zeroproxy-server',
  );
  const child = childProcess.spawn(
    serverPath,
    [
      '-addr',
      `127.0.0.1:${port}`,
      '-web',
      path.join(buildOut, 'web'),
      '-kernel',
      path.join(buildOut, 'kernel.wasm'),
      '-socks',
      'internal',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  await waitForHTTP(`http://127.0.0.1:${port}/`).catch((err) => {
    throw new Error(`${err.message}\nproxy output:\n${log}`);
  });
  return { url: `http://proxy.localhost:${port}/zp/`, process: child, temp };
}

async function closeProxy(proxy) {
  if (!proxy) return;
  if (proxy.process) {
    proxy.process.kill('SIGTERM');
    await new Promise((resolve) => proxy.process.once('exit', resolve));
  }
  if (proxy.temp) fs.rmSync(proxy.temp, { recursive: true, force: true });
}

async function closeFixtureServer(fixtureServer) {
  if (!fixtureServer) return;
  await new Promise((resolve) => fixtureServer.server.close(resolve));
}

function siteURL(spec, fixtureOrigin) {
  if (spec.fixture) return `${fixtureOrigin}/${encodeURIComponent(spec.fixture)}`;
  return spec.url;
}

function selectSites(corpus, ids) {
  if (!ids.length) return corpus;
  const wanted = new Set(ids);
  const selected = corpus.filter((entry) => wanted.has(entry.id));
  const missing = ids.filter((id) => !selected.some((entry) => entry.id === id));
  if (missing.length) throw new Error(`unknown corpus site(s): ${missing.join(', ')}`);
  return selected;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForHTTP(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.setTimeout(1000, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (Date.now() >= deadline) reject(err);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function run(cmd, args) {
  const result = childProcess.spawnSync(cmd, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function classifyHost(hostname, site) {
  if (!hostname) return 'none';
  if (isProxyHost(hostname)) return 'zeroproxy';
  if (isLoopbackHost(hostname)) return 'loopback';
  if (isPrimaryHost(hostname, site)) return 'primary';
  if (isAdNetworkHost(hostname)) return 'ad-network';
  if (isGoogleHost(hostname)) return googleHostClass(site);
  return 'third-party';
}

function isProxyHost(hostname) {
  return hostname === 'proxy.localhost';
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isPrimaryHost(hostname, site) {
  const siteHost = site.url ? new URL(site.url).hostname.toLowerCase() : '';
  const bareSite = String(site.site || '')
    .replace(/^www\./, '')
    .toLowerCase();
  return hostMatches(hostname, siteHost) || hostMatches(hostname, bareSite);
}

function hostMatches(hostname, suffix) {
  return !!suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isAdNetworkHost(hostname) {
  return /doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain/.test(hostname);
}

function isGoogleHost(hostname) {
  return /google|gstatic|googleapis|googleusercontent/.test(hostname);
}

function googleHostClass(site) {
  return site.site === 'google-maps' ||
    site.site === 'embedded-google-maps' ||
    site.site === 'google-search'
    ? 'primary'
    : 'third-party-google';
}

function classifyPath(parsed) {
  if (parsed.protocol === 'data:') return 'data';
  if (parsed.protocol === 'blob:') return 'blob';
  if (parsed.pathname.startsWith('/zp/assets/')) return 'zeroproxy-asset';
  if (parsed.pathname.startsWith('/zp/api/')) return 'zeroproxy-api';
  if (parsed.pathname.startsWith('/zp/p/')) return 'zeroproxy-route';
  if (parsed.pathname === '/' || parsed.pathname === '') return 'root';
  const ext = path.extname(parsed.pathname).toLowerCase();
  if (ext) return ext.slice(1);
  return 'path';
}

function statusBucket(status) {
  if (status < 200) return '1xx';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

function contentTypeBucket(contentType) {
  const value = contentType.toLowerCase();
  if (value.includes('html')) return 'html';
  if (value.includes('javascript') || value.includes('ecmascript')) return 'script';
  if (value.includes('css')) return 'style';
  if (value.includes('json')) return 'json';
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('font/')) return 'font';
  if (value.startsWith('text/')) return 'text';
  if (!value) return 'missing';
  return 'other';
}

function durationBucket(ms) {
  if (ms <= 0) return '0ms';
  if (ms <= 50) return '1-50ms';
  if (ms <= 250) return '51-250ms';
  if (ms <= 1000) return '251-1000ms';
  if (ms <= 5000) return '1001-5000ms';
  return '>5000ms';
}

function sizeBucket(bytes) {
  if (!bytes) return '0B';
  if (bytes < 1024) return '<1KiB';
  if (bytes < 64 * 1024) return '<64KiB';
  if (bytes < 1024 * 1024) return '<1MiB';
  return '>=1MiB';
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function subtractCounts(left, right) {
  const out = {};
  for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
    const delta = (left[key] || 0) - (right[key] || 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

function failureKey(item) {
  return `${item.resourceType}:${item.urlClass.scheme}:${item.urlClass.hostClass}:${item.failureClass}`;
}

function normalizeRequestFailures(failures, responses, pageOK) {
  const rows = Array.isArray(failures) ? failures : [];
  if (!pageOK) return rows;
  const responseRows = Array.isArray(responses) ? responses : [];
  const hasDocumentResponse = responseRows.some(
    (row) => row.resourceType === 'document' && row.statusBucket !== '5xx',
  );
  if (!hasDocumentResponse) return rows;
  return rows.filter(
    (row) =>
      !(row.resourceType === 'document' && /ERR_ABORTED/i.test(String(row.failureClass || ''))),
  );
}
function responseKey(item) {
  return `${item.resourceType}:${item.urlClass.hostClass}:${item.statusBucket}:${item.contentTypeBucket}`;
}

function renderingDelta(nativeRecord, zeroProxyRecord) {
  return {
    visibleTextLength:
      zeroProxyRecord.rendering.visibleTextLength - nativeRecord.rendering.visibleTextLength,
    bodyHeight: zeroProxyRecord.rendering.body.height - nativeRecord.rendering.body.height,
    screenshotChanged:
      nativeRecord.rendering.screenshot.sha256 !== zeroProxyRecord.rendering.screenshot.sha256,
    missingNativeVisibleSelectors: nativeRecord.selectors
      .filter((nativeSelector) => nativeSelector.visible)
      .filter(
        (nativeSelector) =>
          !zeroProxyRecord.selectors.find(
            (row) => row.selector === nativeSelector.selector && row.visible,
          ),
      )
      .map((row) => row.selector),
  };
}

function iframeDelta(nativeRecord, zeroProxyRecord) {
  return {
    count: zeroProxyRecord.iframes.count - nativeRecord.iframes.count,
    nonBlankCount: zeroProxyRecord.iframes.nonBlankCount - nativeRecord.iframes.nonBlankCount,
    adCandidateCount:
      zeroProxyRecord.iframes.adCandidateCount - nativeRecord.iframes.adCandidateCount,
    googleMapsCandidateCount:
      zeroProxyRecord.iframes.googleMapsCandidateCount -
      nativeRecord.iframes.googleMapsCandidateCount,
  };
}

function rootSurfaceDelta(nativeRoot, zeroRoot) {
  const nativeSurface = nativeRoot || {};
  const zeroSurface = zeroRoot || {};
  const mismatches = [];
  pushRootSurfaceMismatch(
    mismatches,
    'ownKeyCount',
    nativeSurface.ownKeyCount,
    zeroSurface.ownKeyCount,
  );
  pushRootSurfaceMismatch(
    mismatches,
    'ownNameCount',
    nativeSurface.ownNameCount,
    zeroSurface.ownNameCount,
  );
  pushRootSurfaceMismatch(
    mismatches,
    'ownSymbolCount',
    nativeSurface.ownSymbolCount,
    zeroSurface.ownSymbolCount,
  );
  pushRootSurfaceMismatch(
    mismatches,
    'toStringTag',
    nativeSurface.toStringTag,
    zeroSurface.toStringTag,
  );
  compareRootSurfaceMap(
    mismatches,
    'selectedDescriptors',
    nativeSurface.selectedDescriptors,
    zeroSurface.selectedDescriptors,
  );
  compareRootSurfaceMap(
    mismatches,
    'selectedGraph',
    nativeSurface.selectedGraph,
    zeroSurface.selectedGraph,
  );
  return {
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 64),
    classes: countBy(mismatches, (row) => row.classification),
  };
}

function compareRootSurfaceMap(out, prefix, nativeMap, zeroMap) {
  const left = nativeMap || {};
  const right = zeroMap || {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const nativeValue = stableJSONString(left[key]);
    const zeroValue = stableJSONString(right[key]);
    if (nativeValue === zeroValue) continue;
    out.push({
      path: `${prefix}.${key}`,
      classification: classifyRootSurfacePath(`${prefix}.${key}`),
    });
  }
}

function pushRootSurfaceMismatch(out, pathKey, nativeValue, zeroValue) {
  if (stableJSONString(nativeValue) === stableJSONString(zeroValue)) return;
  out.push({
    path: pathKey,
    classification: classifyRootSurfacePath(pathKey),
  });
}

function stableJSONString(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJSONString(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSONString(value[key])}`)
    .join(',')}}`;
}

function classifyRootSurfacePath(pathKey) {
  if (/(window|self|globalThis|location|document|history|frames|top|parent|opener)/.test(pathKey)) {
    return 'security-delta';
  }
  if (/(navigator|screen|timezone|locale|language|platform)/.test(pathKey)) {
    return 'privacy-persona-delta';
  }
  if (/(fetch|XMLHttpRequest|WebSocket|Worker|PerformanceObserver|Function)/.test(pathKey)) {
    return 'compatibility-gap';
  }
  return 'native-browser-version-delta';
}

function summarizeTransportTimings(timings) {
  const rows = Array.isArray(timings) ? timings : [];
  return {
    count: rows.length,
    reused: rows.filter((row) => row.connectionReused === true).length,
    byProtocol: countBy(rows, (row) => row.negotiatedProtocol || 'unknown'),
    byFailure: countBy(
      rows.filter((row) => row.failureClass),
      (row) => row.failureClass,
    ),
    queueWait: countBy(rows, (row) => durationBucket(Number(row.queueWaitMs) || 0)),
    firstByte: countBy(rows, (row) => durationBucket(Number(row.timeToFirstByteMs) || 0)),
    body: countBy(rows, (row) => durationBucket(Number(row.bodyDurationMs) || 0)),
    retries: countBy(rows, (row) => String(Number(row.retryCount) || 0)),
    staticResourceTimingMerged: rows.filter(
      (row) => row.resourceType && row.resourceType !== 'document',
    ).length,
  };
}
function timingDelta(nativeRecord, zeroProxyRecord) {
  return {
    elapsedMs: zeroProxyRecord.lifecycle.elapsedMs - nativeRecord.lifecycle.elapsedMs,
    navigationDurationMs:
      (zeroProxyRecord.lifecycle.navigation?.duration || 0) -
      (nativeRecord.lifecycle.navigation?.duration || 0),
  };
}

function transportDelta(nativeRecord, zeroProxyRecord) {
  return {
    requestFailureDelta: subtractCounts(
      countBy(zeroProxyRecord.requestFailures, failureKey),
      countBy(nativeRecord.requestFailures, failureKey),
    ),
    responseBucketDelta: subtractCounts(
      countBy(zeroProxyRecord.responses, responseKey),
      countBy(nativeRecord.responses, responseKey),
    ),
    goTimingAvailable: zeroProxyRecord.transportTimings.length > 0,
    goTimingCountDelta:
      zeroProxyRecord.transportTimings.length - nativeRecord.transportTimings.length,
    syntheticTimingGapCount:
      (zeroProxyRecord.syntheticTimingGaps?.script || 0) +
      (zeroProxyRecord.syntheticTimingGaps?.resource || 0),
  };
}

function buildFailureTelemetry(nativeRecord, zeroProxyRecord, delta, spec, surface, expectedDelta) {
  return {
    schema: 'zp.failure.telemetry.v1',
    site: spec.id,
    profile: spec.profile,
    surface,
    ownerModule: ownerForSurface(surface),
    severity: surface === 'none' ? 'none' : expectedDelta ? 'expected-delta' : 'triage',
    evidence: {
      consoleDelta: delta.console,
      pageErrorDelta: delta.pageErrors,
      requestFailureDeltaKeys: Object.keys(delta.requestFailures).sort().slice(0, 32),
      responseDeltaKeys: Object.keys(delta.responses).sort().slice(0, 32),
      rootSurface: {
        mismatchCount: delta.rootSurface.mismatchCount,
        classes: delta.rootSurface.classes,
        samplePaths: delta.rootSurface.mismatches.map((row) => row.path).slice(0, 16),
      },
      apiFailureClass: classifyAPIFailure(surface, delta),
      syntheticTimingGaps: delta.transport.syntheticTimingGapCount,
      missingVisibleSelectors: delta.rendering.missingNativeVisibleSelectors.slice(0, 32),
      iframe: delta.iframes,
      script: scriptFailureTelemetry(nativeRecord, zeroProxyRecord, delta, surface),
      timing: {
        elapsedMsDelta: durationBucket(Math.abs(delta.timing.elapsedMs)),
        navigationDurationMsDelta: durationBucket(Math.abs(delta.timing.navigationDurationMs)),
        goTimingAvailable: zeroProxyRecord.transportTimings.length > 0,
        goTimingCount: zeroProxyRecord.transportTimings.length,
      },
      nativeOK: nativeRecord.ok,
      zeroProxyOK: zeroProxyRecord.ok,
      expectedDelta: expectedDelta
        ? {
            classification: expectedDelta.classification || 'expected-delta',
            reason: expectedDelta.reason || '',
          }
        : null,
    },
    redaction: {
      rawURL: false,
      rawConsoleText: false,
      rawIPAddress: false,
      rawSelectorText: true,
      fingerprintsOnly: true,
    },
  };
}

function classifyAPIFailure(surface, delta) {
  if (surface === 'none') return 'none';
  if (surface === 'script-runtime') return 'script-runtime';
  if (surface === 'network') return 'network-request';
  if (surface === 'navigation') return 'navigation';
  if (surface === 'frame') return 'frame-boundary';
  if (surface === 'rendering') {
    if (delta.rootSurface?.mismatchCount) return 'root-surface';
    return 'rendering';
  }
  return 'other';
}

function scriptFailureTelemetry(nativeRecord, zeroProxyRecord, delta, surface) {
  const nativeErrors = countBy(nativeRecord.pageErrors, (item) => item.name || 'Error');
  const zeroProxyErrors = countBy(zeroProxyRecord.pageErrors, (item) => item.name || 'Error');
  const generatedJavaScriptSyntaxErrorCount = Math.max(
    0,
    (zeroProxyErrors.SyntaxError || 0) - (nativeErrors.SyntaxError || 0),
  );
  const failCloseDeltaKeys = Object.keys(delta.requestFailures)
    .filter((key) => /^script:/.test(key) || /POLICY|BLOCK|rewrite|script/i.test(key))
    .sort()
    .slice(0, 32);
  return {
    rewriteInducedFailureCount:
      surface === 'script-runtime' ? Math.max(0, Number(delta.pageErrors) || 0) : 0,
    generatedJavaScriptSyntaxErrorCount,
    unexpectedFailCloseCount: failCloseDeltaKeys.length,
    pageErrorNames: subtractCounts(zeroProxyErrors, nativeErrors),
    failCloseDeltaKeys,
  };
}

function classifyFirstFailure(nativeRecord, zeroProxyRecord, delta, spec) {
  if (!nativeRecord.ok) return 'native-site';
  if (!zeroProxyRecord.ok) return 'navigation';
  if (delta.rendering.missingNativeVisibleSelectors.length) return 'rendering';
  if (
    spec.iframeExpectations?.adCandidates &&
    nativeRecord.iframes.adCandidateCount > zeroProxyRecord.iframes.adCandidateCount
  )
    return 'frame';
  if (
    spec.iframeExpectations?.nonBlank &&
    nativeRecord.iframes.nonBlankCount > zeroProxyRecord.iframes.nonBlankCount
  )
    return 'frame';
  if (delta.pageErrors > 0) return 'script-runtime';
  if (Object.keys(delta.requestFailures).length) return 'network';
  if (
    zeroProxyRecord.rendering.visibleTextLength <
    Math.max(64, nativeRecord.rendering.visibleTextLength * 0.25)
  )
    return 'rendering';
  return 'none';
}

function ownerForSurface(surface) {
  return (
    {
      none: 'none',
      'native-site': 'external',
      navigation: 'service-worker/runtime-routing',
      rendering: 'runtime/html-rewriter',
      frame: 'runtime-frames/html-rewriter',
      'script-runtime': 'runtime/js-rewriter',
      network: 'service-worker/go-transport',
    }[surface] || 'triage'
  );
}

function corpusHash(corpus) {
  return crypto.createHash('sha256').update(JSON.stringify(corpus)).digest('hex').slice(0, 20);
}

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/compat-corpus.mjs [options]\n\nOptions:\n  --mode native|zeroproxy|both   Run native host browser, ZeroProxy, or both (default: both)\n  --sites id,id                  Limit to selected representative-site ids\n  --out path                     Write redacted report JSON\n  --release-out path             Write stable release-gate summary JSON\n  --fail-on-release-gate         Exit non-zero unless the release-gate summary passes\n  --timeout-ms n                 Per-page navigation/readiness timeout\n  --proxy-url url                Reuse an already running ZeroProxy origin\n  --dist path                    Reuse an existing build output for auto-started ZeroProxy\n  --headed                       Run a visible browser\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs();
  if (options.help) {
    printHelp();
  } else {
    runCorpus(options)
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      })
      .catch((err) => {
        process.stderr.write(`${err?.stack || err}\n`);
        process.exitCode = 1;
      });
  }
}
