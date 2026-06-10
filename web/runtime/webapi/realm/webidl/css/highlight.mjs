const registryToken = {};
const validHighlightTypes = new Set(['highlight', 'spelling-error', 'grammar-error']);
const missingPointCoordinate = {};

export function createHighlightSupport(AbstractRange) {
  class Highlight {
    constructor(...ranges) {
      this.__zpRanges = new Set();
      this.__zpPriority = 0;
      this.__zpType = 'highlight';
      for (const range of ranges) this.add(range);
    }
    get priority() { return this.__zpPriority; }
    set priority(value) {
      const number = Number(value);
      this.__zpPriority = Number.isFinite(number) ? Math.trunc(number) : 0;
    }
    get type() { return this.__zpType; }
    set type(value) {
      const text = String(value);
      if (validHighlightTypes.has(text)) this.__zpType = text;
    }
    get size() { return this.__zpRanges.size; }
    add(range) {
      requireAbstractRange(range, 'add');
      this.__zpRanges.add(range);
      return this;
    }
    clear() { this.__zpRanges.clear(); }
    delete(range) { return this.__zpRanges.delete(range); }
    entries() { return this.__zpRanges.entries(); }
    forEach(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'Highlight': parameter 1 is not a function.");
      for (const range of this.__zpRanges) callback.call(thisArg, range, range, this);
    }
    has(range) { return this.__zpRanges.has(range); }
    keys() { return this.__zpRanges.values(); }
    values() { return this.__zpRanges.values(); }
  }

  class HighlightRegistry {
    constructor(token) {
      if (token !== registryToken) throw new TypeError("Failed to construct 'HighlightRegistry': Illegal constructor");
      this.__zpHighlights = new Map();
    }
    get size() { return this.__zpHighlights.size; }
    clear() { this.__zpHighlights.clear(); }
    delete(name) { return this.__zpHighlights.delete(String(name)); }
    entries() { return this.__zpHighlights.entries(); }
    forEach(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError("Failed to execute 'forEach' on 'HighlightRegistry': parameter 1 is not a function.");
      for (const [name, highlight] of this.__zpHighlights) callback.call(thisArg, highlight, name, this);
    }
    get(name) { return this.__zpHighlights.get(String(name)); }
    has(name) { return this.__zpHighlights.has(String(name)); }
    highlightsFromPoint(x = missingPointCoordinate, y = missingPointCoordinate) {
      if (x === missingPointCoordinate || y === missingPointCoordinate) {
        const present = x === missingPointCoordinate ? 0 : 1;
        throw new TypeError(`Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': 2 arguments required, but only ${present} present.`);
      }
      if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new TypeError("Failed to execute 'highlightsFromPoint' on 'HighlightRegistry': The provided float value is non-finite.");
      return [];
    }
    keys() { return this.__zpHighlights.keys(); }
    set(name, highlight) {
      if (!(highlight instanceof Highlight)) throw new TypeError("Failed to execute 'set' on 'HighlightRegistry': parameter 2 is not of type 'Highlight'.");
      this.__zpHighlights.set(String(name), highlight);
      return this;
    }
    values() { return this.__zpHighlights.values(); }
  }

  function requireAbstractRange(range, method) {
    if (!(range instanceof AbstractRange)) throw new TypeError(`Failed to execute '${method}' on 'Highlight': parameter 1 is not of type 'AbstractRange'.`);
  }

  Object.defineProperty(Highlight.prototype, Symbol.iterator, { value: Highlight.prototype.values, writable: true, configurable: true });
  Object.defineProperty(Highlight.prototype, Symbol.toStringTag, { value: 'Highlight', configurable: true });
  Object.defineProperty(HighlightRegistry.prototype, Symbol.iterator, { value: HighlightRegistry.prototype.entries, writable: true, configurable: true });
  Object.defineProperty(HighlightRegistry.prototype, Symbol.toStringTag, { value: 'HighlightRegistry', configurable: true });

  return { Highlight, HighlightRegistry, highlightRegistry: new HighlightRegistry(registryToken) };
}
