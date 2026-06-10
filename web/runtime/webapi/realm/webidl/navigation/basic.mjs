const navigationToken = {};
const historyEntryToken = {};
const destinationToken = {};
let nextNavigationKey = 1;

export function createNavigationFacades(deps = {}) {
  const EventBase = deps.EventBase || class Event {};
  const EventTargetBase = deps.EventTargetBase || class EventTarget {};
  const cloneState = deps.cloneState || ((value) => value);
  const getRecords = deps.getRecords || (() => []);
  const getIndex = deps.getIndex || (() => 0);
  const pushState = deps.pushState || (() => undefined);
  const replaceState = deps.replaceState || (() => undefined);
  const traverse = deps.traverse || (() => undefined);
  const currentURL = deps.currentURL || (() => 'about:blank');
  const resolveURL = deps.resolveURL || ((value) => String(value ?? currentURL()));

  class NavigationHistoryEntry extends EventTargetBase {
    constructor(token, record = null, index = -1) {
      if (token !== historyEntryToken) throw new TypeError("Failed to construct 'NavigationHistoryEntry': Illegal constructor");
      super();
      defineHidden(this, '__zpRecord', record);
      defineHidden(this, '__zpIndex', index);
    }
    get id() { return navigationRecordKey(this.__zpRecord); }
    get key() { return navigationRecordKey(this.__zpRecord); }
    get index() { return this.__zpIndex; }
    get url() { return this.__zpRecord?.url ?? null; }
    get sameDocument() { return true; }
    getState() { return cloneState(this.__zpRecord?.state ?? null); }
  }
  Object.defineProperty(NavigationHistoryEntry.prototype, Symbol.toStringTag, { value: 'NavigationHistoryEntry', configurable: true });

  class NavigationDestination {
    constructor(token, init = {}) {
      if (token !== destinationToken) throw new TypeError("Failed to construct 'NavigationDestination': Illegal constructor");
      defineHidden(this, '__zpURL', init.url ?? null);
      defineHidden(this, '__zpKey', init.key ?? '');
      defineHidden(this, '__zpIndex', Number.isFinite(init.index) ? init.index : -1);
      defineHidden(this, '__zpState', init.state ?? null);
      defineHidden(this, '__zpSameDocument', init.sameDocument !== false);
    }
    get id() { return this.__zpKey; }
    get key() { return this.__zpKey; }
    get url() { return this.__zpURL; }
    get index() { return this.__zpIndex; }
    get sameDocument() { return this.__zpSameDocument; }
    getState() { return cloneState(this.__zpState); }
  }
  Object.defineProperty(NavigationDestination.prototype, Symbol.toStringTag, { value: 'NavigationDestination', configurable: true });

  class NavigationCurrentEntryChangeEvent extends EventBase {
    constructor(type, init = {}) {
      super(type, init);
      defineHidden(this, '__zpNavigationType', String(init.navigationType || 'push'));
      defineHidden(this, '__zpFrom', init.from ?? null);
    }
    get navigationType() { return this.__zpNavigationType; }
    get from() { return this.__zpFrom; }
  }
  Object.defineProperty(NavigationCurrentEntryChangeEvent.prototype, Symbol.toStringTag, { value: 'NavigationCurrentEntryChangeEvent', configurable: true });

  class NavigateEvent extends EventBase {
    constructor(type, init = {}) {
      super(type, init);
      defineHidden(this, '__zpNavigationType', String(init.navigationType || 'push'));
      defineHidden(this, '__zpDestination', init.destination ?? null);
      defineHidden(this, '__zpCanIntercept', Boolean(init.canIntercept));
      defineHidden(this, '__zpUserInitiated', Boolean(init.userInitiated));
      defineHidden(this, '__zpHashChange', Boolean(init.hashChange));
      defineHidden(this, '__zpSignal', init.signal ?? null);
      defineHidden(this, '__zpFormData', init.formData ?? null);
      defineHidden(this, '__zpDownloadRequest', init.downloadRequest ?? null);
      defineHidden(this, '__zpInfo', init.info);
      defineHidden(this, '__zpHasUAVisualTransition', Boolean(init.hasUAVisualTransition));
      defineHidden(this, '__zpTransitionPromises', []);
    }
    get navigationType() { return this.__zpNavigationType; }
    get destination() { return this.__zpDestination; }
    get canIntercept() { return this.__zpCanIntercept; }
    get userInitiated() { return this.__zpUserInitiated; }
    get hashChange() { return this.__zpHashChange; }
    get signal() { return this.__zpSignal; }
    get formData() { return this.__zpFormData; }
    get downloadRequest() { return this.__zpDownloadRequest; }
    get info() { return this.__zpInfo; }
    get hasUAVisualTransition() { return this.__zpHasUAVisualTransition; }
    intercept(options = {}) {
      if (!this.canIntercept) throw new Error('InvalidStateError');
      if (typeof options.handler === 'function') this.transitionWhile(Promise.resolve().then(() => options.handler()));
    }
    scroll() {}
    transitionWhile(promise) { this.__zpTransitionPromises.push(Promise.resolve(promise)); }
  }
  Object.defineProperty(NavigateEvent.prototype, Symbol.toStringTag, { value: 'NavigateEvent', configurable: true });

  class NavigationTransition {
    constructor() { throw new TypeError("Failed to construct 'NavigationTransition': Illegal constructor"); }
  }
  Object.defineProperty(NavigationTransition.prototype, Symbol.toStringTag, { value: 'NavigationTransition', configurable: true });

  class NavigationActivation {
    constructor() { throw new TypeError("Failed to construct 'NavigationActivation': Illegal constructor"); }
  }
  Object.defineProperty(NavigationActivation.prototype, Symbol.toStringTag, { value: 'NavigationActivation', configurable: true });

  class NavigationPrecommitController {
    constructor() { throw new TypeError("Failed to construct 'NavigationPrecommitController': Illegal constructor"); }
  }
  Object.defineProperty(NavigationPrecommitController.prototype, Symbol.toStringTag, { value: 'NavigationPrecommitController', configurable: true });

  class Navigation extends EventTargetBase {
    constructor(token) {
      if (token !== navigationToken) throw new TypeError("Failed to construct 'Navigation': Illegal constructor");
      super();
      defineHidden(this, '__zpTransition', null);
      defineHidden(this, '__zpActivation', null);
    }
    get currentEntry() { return entryForIndex(getIndex()); }
    get transition() { return this.__zpTransition; }
    get activation() { return this.__zpActivation; }
    get canGoBack() { return getIndex() > 0; }
    get canGoForward() { return getIndex() < getRecords().length - 1; }
    entries() { return getRecords().map((record, index) => new NavigationHistoryEntry(historyEntryToken, record, index)); }
    updateCurrentEntry(options = {}) {
      const entry = this.currentEntry;
      replaceState(options.state ?? null, entry?.url ?? currentURL());
      this.dispatchEvent?.(new NavigationCurrentEntryChangeEvent('currententrychange', { navigationType: 'replace', from: entry }));
    }
    navigate(url, options = {}) {
      const href = resolveURL(url);
      const state = options.state ?? null;
      const navigationType = options.history === 'replace' ? 'replace' : 'push';
      const destination = new NavigationDestination(destinationToken, { url: href, key: nextNavigationKeyValue(), index: navigationType === 'replace' ? getIndex() : getIndex() + 1, state, sameDocument: sameDocumentNavigation(currentURL(), href) });
      const event = new NavigateEvent('navigate', { navigationType, destination, canIntercept: true, userInitiated: false, hashChange: hashOnlyNavigation(currentURL(), href), info: options.info });
      this.dispatchEvent?.(event);
      if (!event.defaultPrevented) {
        if (navigationType === 'replace') replaceState(state, href);
        else pushState(state, href);
      }
      return navigationResult(this.currentEntry);
    }
    reload(options = {}) {
      if (Object.getOwnPropertyDescriptor(Object(options), 'state')) replaceState(options.state, currentURL());
      return navigationResult(this.currentEntry);
    }
    traverseTo(key) {
      const index = getRecords().findIndex((record) => navigationRecordKey(record) === String(key));
      if (index >= 0) traverse(index - getIndex());
      return navigationResult(this.currentEntry);
    }
    back() { if (this.canGoBack) traverse(-1); return navigationResult(this.currentEntry); }
    forward() { if (this.canGoForward) traverse(1); return navigationResult(this.currentEntry); }
  }
  Object.defineProperty(Navigation.prototype, Symbol.toStringTag, { value: 'Navigation', configurable: true });

  function entryForIndex(index) {
    const record = getRecords()[index];
    return record ? new NavigationHistoryEntry(historyEntryToken, record, index) : null;
  }

  function makeNavigation() { return new Navigation(navigationToken); }

  return { Navigation, NavigationActivation, NavigationCurrentEntryChangeEvent, NavigationDestination, NavigationHistoryEntry, NavigationPrecommitController, NavigationTransition, NavigateEvent, makeNavigation };
}

function navigationResult(entry) {
  const committed = Promise.resolve(entry);
  return { committed, finished: committed };
}

function navigationRecordKey(record) {
  if (!record) return '';
  if (!record.__zpNavigationKey) Object.defineProperty(record, '__zpNavigationKey', { value: nextNavigationKeyValue(), configurable: true });
  return record.__zpNavigationKey;
}

function nextNavigationKeyValue() { return `zp-nav-${nextNavigationKey++}`; }

function sameDocumentNavigation(left, right) {
  const a = parseURL(left);
  const b = parseURL(right);
  return Boolean(a && b && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search);
}

function hashOnlyNavigation(left, right) {
  const a = parseURL(left);
  const b = parseURL(right);
  return Boolean(a && b && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash !== b.hash);
}

function parseURL(value) {
  try { return new URL(String(value)); } catch { return null; }
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
