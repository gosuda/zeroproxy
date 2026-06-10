export function createIntlFacade() {
  function callIntl(payload) {
    const response = typeof __zpIntlCall === 'function' ? __zpIntlCall(JSON.stringify(payload || {})) : null;
    if (!response || response.ok !== true) throw intlError(response);
    return response.value;
  }

  function intlError(response) {
    const name = response?.name || 'TypeError';
    const message = response?.message || 'Intl operation failed';
    const Ctor = globalThis[name] || TypeError;
    try { return new Ctor(message); } catch { return new TypeError(message); }
  }

  function localeList(locales) {
    if (locales === undefined) return undefined;
    if (typeof locales === 'string') return locales;
    if (Array.isArray(locales)) return locales.map((locale) => String(locale));
    if (typeof locales?.[Symbol.iterator] === 'function') return Array.from(locales, (locale) => String(locale));
    return String(locales);
  }

  function optionRecord(options) {
    if (options === undefined) return undefined;
    if (options === null || typeof options !== 'object') return {};
    const out = {};
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (value !== undefined && typeof value !== 'function') out[key] = value;
    }
    return out;
  }

  function makeFormatter(constructorName, methods = []) {
    class IntlFormatter {
      constructor(locales = undefined, options = undefined) {
        this.__zpIntlConstructor = constructorName;
        this.__zpIntlLocales = localeList(locales);
        this.__zpIntlOptions = optionRecord(options);
      }
      resolvedOptions() { return callIntl({ op: 'method', constructorName, method: 'resolvedOptions', locales: this.__zpIntlLocales, options: this.__zpIntlOptions, args: [] }); }
    }
    Object.defineProperty(IntlFormatter, 'name', { value: constructorName, configurable: true });
    IntlFormatter.supportedLocalesOf = (locales = undefined, options = undefined) => callIntl({ op: 'supportedLocalesOf', constructorName, locales: localeList(locales), options: optionRecord(options) });
    for (const method of methods) {
      Object.defineProperty(IntlFormatter.prototype, method, {
        value(...args) { return callIntl({ op: 'method', constructorName, method, locales: this.__zpIntlLocales, options: this.__zpIntlOptions, args: intlArgs(constructorName, method, args) }); },
        writable: true,
        configurable: true,
      });
    }
    return IntlFormatter;
  }

  function installBoundMethod(Class, name, method) {
    Object.defineProperty(Class.prototype, name, {
      get() {
        const self = this;
        return (...args) => callIntl({ op: 'method', constructorName: self.__zpIntlConstructor, method, locales: self.__zpIntlLocales, options: self.__zpIntlOptions, args: intlArgs(self.__zpIntlConstructor, method, args) });
      },
      configurable: true,
    });
  }

  function intlArgs(constructorName, method, args) {
    if (constructorName !== 'DateTimeFormat') return args;
    if (method === 'format' || method === 'formatToParts') return args.length ? [dateTimeValue(args[0])] : args;
    if (method === 'formatRange' || method === 'formatRangeToParts') return [dateTimeValue(args[0]), dateTimeValue(args[1])];
    return args;
  }

  function dateTimeValue(value) {
    return value instanceof Date ? Number(value) : value;
  }

  const NumberFormat = makeFormatter('NumberFormat', ['formatToParts']);
  installBoundMethod(NumberFormat, 'format', 'format');
  const DateTimeFormat = makeFormatter('DateTimeFormat', ['formatToParts', 'formatRange', 'formatRangeToParts']);
  installBoundMethod(DateTimeFormat, 'format', 'format');
  const Collator = makeFormatter('Collator');
  installBoundMethod(Collator, 'compare', 'compare');
  const PluralRules = makeFormatter('PluralRules', ['select', 'selectRange']);
  const RelativeTimeFormat = makeFormatter('RelativeTimeFormat', ['format', 'formatToParts']);
  const ListFormat = makeFormatter('ListFormat', ['format', 'formatToParts']);
  const DisplayNames = makeFormatter('DisplayNames', ['of']);
  const Segmenter = makeFormatter('Segmenter');
  Segmenter.prototype.segment = function segment(input = '') {
    const segments = callIntl({ op: 'method', constructorName: 'Segmenter', method: 'segment', locales: this.__zpIntlLocales, options: this.__zpIntlOptions, args: [String(input)] }) || [];
    segments.containing = (index = 0) => segments.find((entry) => Number(entry.index) <= Number(index) && Number(index) < Number(entry.index) + String(entry.segment || '').length);
    return segments;
  };

  class Locale {
    constructor(tag, options = undefined) {
      const record = callIntl({ op: 'locale', tag: String(tag), options: optionRecord(options) });
      this.__zpLocaleRecord = record || { baseName: String(tag), language: String(tag) };
    }
    maximize() { return new Locale(callIntl({ op: 'localeMethod', tag: this.toString(), method: 'maximize' })); }
    minimize() { return new Locale(callIntl({ op: 'localeMethod', tag: this.toString(), method: 'minimize' })); }
    toString() { return String(this.__zpLocaleRecord.id || this.__zpLocaleRecord.baseName || 'und'); }
    get baseName() { return this.__zpLocaleRecord.baseName || this.toString(); }
    get calendar() { return this.__zpLocaleRecord.calendar; }
    get caseFirst() { return this.__zpLocaleRecord.caseFirst; }
    get collation() { return this.__zpLocaleRecord.collation; }
    get hourCycle() { return this.__zpLocaleRecord.hourCycle; }
    get language() { return this.__zpLocaleRecord.language; }
    get numberingSystem() { return this.__zpLocaleRecord.numberingSystem; }
    get numeric() { return this.__zpLocaleRecord.numeric; }
    get region() { return this.__zpLocaleRecord.region; }
    get script() { return this.__zpLocaleRecord.script; }
  }

  return Object.freeze({
    Collator,
    DateTimeFormat,
    DisplayNames,
    ListFormat,
    Locale,
    NumberFormat,
    PluralRules,
    RelativeTimeFormat,
    Segmenter,
    getCanonicalLocales: (locales = undefined) => callIntl({ op: 'getCanonicalLocales', locales: localeList(locales) }),
    supportedValuesOf: (key) => callIntl({ op: 'supportedValuesOf', key: String(key) }),
  });
}
