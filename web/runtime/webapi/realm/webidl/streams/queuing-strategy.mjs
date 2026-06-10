const byteLengthSize = (chunk) => Number(chunk?.byteLength ?? 0);
const countSize = () => 1;
const highWaterMarks = new WeakMap();


function highWaterMark(name, init, argumentCount) {
  if (argumentCount < 1) throw new TypeError(`Failed to construct '${name}': 1 argument required, but only 0 present.`);
  if (init === null || init === undefined || (typeof init !== 'object' && typeof init !== 'function')) throw new TypeError(`Failed to construct '${name}': The provided value is not of type 'QueuingStrategyInit'.`);
  if (init.highWaterMark === undefined) throw new TypeError(`Failed to construct '${name}': Failed to read the 'highWaterMark' property from 'QueuingStrategyInit': Required member is undefined.`);
  return Number(init.highWaterMark);
}

function setHighWaterMark(strategy, value) { highWaterMarks.set(strategy, value); }
function getHighWaterMark(strategy) { return highWaterMarks.get(strategy); }

export class ByteLengthQueuingStrategy {
  constructor(init) {
    setHighWaterMark(this, highWaterMark('ByteLengthQueuingStrategy', init, arguments.length));
  }
  get highWaterMark() { return getHighWaterMark(this); }
  get size() { return byteLengthSize; }
}
Object.defineProperty(ByteLengthQueuingStrategy.prototype, 'highWaterMark', { get: Object.getOwnPropertyDescriptor(ByteLengthQueuingStrategy.prototype, 'highWaterMark').get, enumerable: true, configurable: true });
Object.defineProperty(ByteLengthQueuingStrategy.prototype, 'size', { get: Object.getOwnPropertyDescriptor(ByteLengthQueuingStrategy.prototype, 'size').get, enumerable: true, configurable: true });
Object.defineProperty(ByteLengthQueuingStrategy.prototype, Symbol.toStringTag, { value: 'ByteLengthQueuingStrategy', configurable: true });

export class CountQueuingStrategy {
  constructor(init) {
    setHighWaterMark(this, highWaterMark('CountQueuingStrategy', init, arguments.length));
  }
  get highWaterMark() { return getHighWaterMark(this); }
  get size() { return countSize; }
}
Object.defineProperty(CountQueuingStrategy.prototype, 'highWaterMark', { get: Object.getOwnPropertyDescriptor(CountQueuingStrategy.prototype, 'highWaterMark').get, enumerable: true, configurable: true });
Object.defineProperty(CountQueuingStrategy.prototype, 'size', { get: Object.getOwnPropertyDescriptor(CountQueuingStrategy.prototype, 'size').get, enumerable: true, configurable: true });
Object.defineProperty(CountQueuingStrategy.prototype, Symbol.toStringTag, { value: 'CountQueuingStrategy', configurable: true });
