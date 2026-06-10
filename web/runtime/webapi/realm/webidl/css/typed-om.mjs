const styleValueToken = {};
const numericValueToken = {};
const mathValueToken = {};
const numericArrayToken = {};
const transformComponentToken = {};
const cssUnitNames = new Set([
  'number',
  'percent',
  '%',
  'em',
  'ex',
  'ch',
  'ic',
  'rem',
  'lh',
  'rlh',
  'cap',
  'rcap',
  'rch',
  'rex',
  'ric',
  'vw',
  'vh',
  'vi',
  'vb',
  'vmin',
  'vmax',
  'svw',
  'svh',
  'svi',
  'svb',
  'svmin',
  'svmax',
  'lvw',
  'lvh',
  'lvi',
  'lvb',
  'lvmin',
  'lvmax',
  'dvw',
  'dvh',
  'dvi',
  'dvb',
  'dvmin',
  'dvmax',
  'cqw',
  'cqh',
  'cqi',
  'dpcm',
  'dpi',
  'dppx',
  'cqb',
  'cqmin',
  'cqmax',
  'cm',
  'mm',
  'q',
  'in',
  'pt',
  'pc',
  'px',
  'deg',
  'grad',
  'rad',
  'turn',
  's',
  'ms',
  'hz',
  'khz',
  'fr',
  'x',
]);


export function createCSSTypedOMFacades() {
  class CSSStyleValue {
    constructor(token) {
      if (token !== styleValueToken) throw new TypeError("Failed to construct 'CSSStyleValue': Illegal constructor");
    }
    static parse(property, cssText) { void property; return new CSSUnparsedValue([String(cssText ?? '')]); }
    static parseAll(property, cssText) { return [CSSStyleValue.parse(property, cssText)]; }
    toString() { return cssStyleValueToString(this); }
  }
  Object.defineProperty(CSSStyleValue.prototype, Symbol.toStringTag, { value: 'CSSStyleValue', configurable: true });
  function cssStyleValueToString(value) {
    if (cssKeywordValueState.has(value)) return cssKeywordValueSlots(value).value;
    if (cssUnitValueState.has(value)) return cssUnitValueToString(value);
    if (cssPositionValueState.has(value)) return cssPositionValueToString(value);
    if (value.__zpValues && value.__zpOperator) return cssMathValueToString(value);
    return value.__zpText ?? '';
  }
  function cssUnitValueToString(value) {
    const { value: numericValue, unit } = cssUnitValueSlots(value);
    if (unit === 'number') return String(numericValue);
    if (unit === 'percent') return String(numericValue) + '%';
    return String(numericValue) + unit;
  }
  function cssPositionValueToString(value) {
    const { x, y } = cssPositionValueSlots(value);
    return `${x} ${y}`;
  }
  function cssMathValueToString(value) {
    return `${value.__zpOperator}(${Array.from(value.__zpValues).join(', ')})`;
  }

  const cssKeywordValueState = new WeakMap();
  function CSSKeywordValue(value) {
    if (!new.target) throw new TypeError("Failed to construct 'CSSKeywordValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'CSSKeywordValue': 1 argument required, but only 0 present.");
    const object = Reflect.construct(CSSStyleValue, [styleValueToken], new.target);
    cssKeywordValueState.set(object, { value: cssString('CSSKeywordValue', 'construct', 'value', value) });
    return object;
  }
  Object.setPrototypeOf(CSSKeywordValue, CSSStyleValue);
  CSSKeywordValue.prototype = Object.create(CSSStyleValue.prototype);
  Object.defineProperties(CSSKeywordValue.prototype, {
    value: { get() { return cssKeywordValueSlots(this).value; }, set(value) { cssKeywordValueSlots(this).value = cssString('CSSKeywordValue', 'set', 'value', value); }, enumerable: true, configurable: true },
    constructor: { value: CSSKeywordValue, writable: true, configurable: true },
  });
  Object.defineProperty(CSSKeywordValue.prototype, Symbol.toStringTag, { value: 'CSSKeywordValue', configurable: true });
  Object.defineProperty(CSSKeywordValue, 'prototype', { writable: false });

  class CSSNumericValue extends CSSStyleValue {
    constructor(token) {
      if (token !== numericValueToken) throw new TypeError("Failed to construct 'CSSNumericValue': Illegal constructor");
      super(styleValueToken);
    }
    static parse(cssText) { return parseNumericValue(cssText); }
    add(...values) { return new CSSMathSum(this, ...values); }
    sub(...values) { return new CSSMathSum(this, ...values.map((value) => new CSSMathNegate(value))); }
    mul(...values) { return new CSSMathProduct(this, ...values); }
    div(...values) { return new CSSMathProduct(this, ...values.map((value) => new CSSMathInvert(value))); }
    min(...values) { return new CSSMathMin(this, ...values); }
    max(...values) { return new CSSMathMax(this, ...values); }
    equals(...values) { return values.every((value) => String(value) === String(this)); }
    to(unit) { return new CSSUnitValue(this.value ?? 0, unit); }
    toSum(...units) { return new CSSMathSum(this.to(units[0] || this.unit || 'number')); }
    type() { return {}; }
  }
  Object.defineProperty(CSSNumericValue.prototype, Symbol.toStringTag, { value: 'CSSNumericValue', configurable: true });

  const cssUnitValueState = new WeakMap();
  function CSSUnitValue(value, unit) {
    if (!new.target) throw new TypeError("Failed to construct 'CSSUnitValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'CSSUnitValue': 2 arguments required, but only ${arguments.length} present.`);
    const cssUnit = cssUnitName(unit);
    const object = Reflect.construct(CSSNumericValue, [numericValueToken], new.target);
    cssUnitValueState.set(object, { value: cssFiniteNumber('CSSUnitValue', 'construct', 'value', value), unit: cssUnit });
    return object;
  }
  Object.setPrototypeOf(CSSUnitValue, CSSNumericValue);
  CSSUnitValue.prototype = Object.create(CSSNumericValue.prototype);
  Object.defineProperties(CSSUnitValue.prototype, {
    value: { get() { return cssUnitValueSlots(this).value; }, set(value) { cssUnitValueSlots(this).value = cssFiniteNumber('CSSUnitValue', 'set', 'value', value); }, enumerable: true, configurable: true },
    unit: { get() { return cssUnitValueSlots(this).unit; }, enumerable: true, configurable: true },
    constructor: { value: CSSUnitValue, writable: true, configurable: true },
  });
  Object.defineProperty(CSSUnitValue.prototype, Symbol.toStringTag, { value: 'CSSUnitValue', configurable: true });
  Object.defineProperty(CSSUnitValue, 'prototype', { writable: false });

  class CSSNumericArray {
    constructor(token, values) {
      if (token !== numericArrayToken) throw new TypeError("Failed to construct 'CSSNumericArray': Illegal constructor");
      defineHidden(this, '__zpValues', values);
      refreshIndexes(this);
    }
    get length() { return this.__zpValues.length; }
    item(index) { return this.__zpValues[Number(index)] ?? null; }
    [Symbol.iterator]() { return this.__zpValues[Symbol.iterator](); }
  }
  Object.defineProperty(CSSNumericArray.prototype, Symbol.toStringTag, { value: 'CSSNumericArray', configurable: true });

  class CSSMathValue extends CSSNumericValue {
    constructor(token, operator, values) {
      if (token !== mathValueToken) throw new TypeError("Failed to construct 'CSSMathValue': Illegal constructor");
      super(numericValueToken);
      defineHidden(this, '__zpOperator', operator);
      defineHidden(this, '__zpValues', new CSSNumericArray(numericArrayToken, values.map(toNumericValue)));
    }
    get operator() { return this.__zpOperator; }

  }
  Object.defineProperty(CSSMathValue.prototype, Symbol.toStringTag, { value: 'CSSMathValue', configurable: true });
  function cssMathValues(value) {
    return value.__zpValues;
  }
  function cssMathValueAt(value, index) {
    return cssMathValues(value).item(index);
  }

  class CSSMathSum extends CSSMathValue { constructor(...values) { super(mathValueToken, 'sum', values); } }
  class CSSMathProduct extends CSSMathValue { constructor(...values) { super(mathValueToken, 'product', values); } }
  class CSSMathMin extends CSSMathValue { constructor(...values) { super(mathValueToken, 'min', values); } }
  class CSSMathMax extends CSSMathValue { constructor(...values) { super(mathValueToken, 'max', values); } }
  class CSSMathClamp extends CSSMathValue { constructor(lower, value, upper) { super(mathValueToken, 'clamp', [lower, value, upper]); } }
  class CSSMathNegate extends CSSMathValue { constructor(value) { super(mathValueToken, 'negate', [value]); } }
  class CSSMathInvert extends CSSMathValue { constructor(value) { super(mathValueToken, 'invert', [value]); } }
  Object.defineProperty(CSSMathValue, 'length', { value: 0, configurable: true });
  for (const ctor of [CSSMathSum, CSSMathProduct, CSSMathMin, CSSMathMax]) {
    Object.defineProperty(ctor.prototype, 'values', { get() { return cssMathValues(this); }, enumerable: true, configurable: true });
  }
  Object.defineProperties(CSSMathClamp.prototype, {
    lower: { get() { return cssMathValueAt(this, 0); }, enumerable: true, configurable: true },
    value: { get() { return cssMathValueAt(this, 1); }, enumerable: true, configurable: true },
    upper: { get() { return cssMathValueAt(this, 2); }, enumerable: true, configurable: true },
  });
  for (const ctor of [CSSMathNegate, CSSMathInvert]) {
    Object.defineProperty(ctor.prototype, 'value', { get() { return cssMathValueAt(this, 0); }, enumerable: true, configurable: true });
  }
  for (const ctor of [CSSMathSum, CSSMathProduct, CSSMathMin, CSSMathMax, CSSMathClamp, CSSMathNegate, CSSMathInvert]) {
    Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: ctor.name, configurable: true });
  }

  class CSSUnparsedValue extends CSSStyleValue {
    constructor(members = []) {
      super(styleValueToken);
      defineHidden(this, '__zpMembers', Array.from(members));
      refreshIndexes(this);
    }
    get length() { return this.__zpMembers.length; }
    entries() { return this.__zpMembers.entries(); }
    keys() { return this.__zpMembers.keys(); }
    values() { return this.__zpMembers.values(); }
    forEach(callback, thisArg = undefined) { this.__zpMembers.forEach((value, index) => callback.call(thisArg, value, index, this)); }
    [Symbol.iterator]() { return this.values(); }
    toString() { return this.__zpMembers.map(String).join(''); }
  }
  Object.defineProperty(CSSUnparsedValue.prototype, Symbol.toStringTag, { value: 'CSSUnparsedValue', configurable: true });

  const cssVariableReferenceValueState = new WeakMap();
  function CSSVariableReferenceValue(variable, fallback = null) {
    if (!new.target) throw new TypeError("Failed to construct 'CSSVariableReferenceValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'CSSVariableReferenceValue': 1 argument required, but only 0 present.");
    const object = Object.create(new.target.prototype);
    cssVariableReferenceValueState.set(object, {
      variable: cssCustomPropertyName('CSSVariableReferenceValue', 'construct', 'variable', variable),
      fallback: cssUnparsedFallback(fallback),
    });
    return object;
  }
  delete CSSVariableReferenceValue.prototype.constructor;
  Object.defineProperties(CSSVariableReferenceValue.prototype, {
    variable: { get() { return cssVariableReferenceValueSlots(this).variable; }, set(value) { cssVariableReferenceValueSlots(this).variable = cssCustomPropertyName('CSSVariableReferenceValue', 'set', 'variable', value); }, enumerable: true, configurable: true },
    fallback: { get() { return cssVariableReferenceValueSlots(this).fallback; }, enumerable: true, configurable: true },
    constructor: { value: CSSVariableReferenceValue, writable: true, configurable: true },
  });
  Object.defineProperty(CSSVariableReferenceValue.prototype, Symbol.toStringTag, { value: 'CSSVariableReferenceValue', configurable: true });
  Object.defineProperty(CSSVariableReferenceValue, 'prototype', { writable: false });

  class CSSImageValue extends CSSStyleValue {
    constructor(token) {
      if (token !== styleValueToken) throw new TypeError("Failed to construct 'CSSImageValue': Illegal constructor");
      super(styleValueToken);
    }
  }
  Object.defineProperty(CSSImageValue.prototype, Symbol.toStringTag, { value: 'CSSImageValue', configurable: true });

  const cssPositionValueState = new WeakMap();
  function CSSPositionValue(x, y) {
    if (!new.target) throw new TypeError("Failed to construct 'CSSPositionValue': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) throw new TypeError(`Failed to construct 'CSSPositionValue': 2 arguments required, but only ${arguments.length} present.`);
    const object = Reflect.construct(CSSStyleValue, [styleValueToken], new.target);
    cssPositionValueState.set(object, {
      x: cssNumericArgument('CSSPositionValue', 'construct', 'x', 1, x),
      y: cssNumericArgument('CSSPositionValue', 'construct', 'y', 2, y),
    });
    return object;
  }
  Object.setPrototypeOf(CSSPositionValue, CSSStyleValue);
  CSSPositionValue.prototype = Object.create(CSSStyleValue.prototype);
  Object.defineProperties(CSSPositionValue.prototype, {
    x: { get() { return cssPositionValueSlots(this).x; }, set(value) { cssPositionValueSlots(this).x = cssNumericArgument('CSSPositionValue', 'set', 'x', 1, value); }, enumerable: true, configurable: true },
    y: { get() { return cssPositionValueSlots(this).y; }, set(value) { cssPositionValueSlots(this).y = cssNumericArgument('CSSPositionValue', 'set', 'y', 2, value); }, enumerable: true, configurable: true },
    constructor: { value: CSSPositionValue, writable: true, configurable: true },
  });
  Object.defineProperty(CSSPositionValue.prototype, Symbol.toStringTag, { value: 'CSSPositionValue', configurable: true });
  Object.defineProperty(CSSPositionValue, 'prototype', { writable: false });

  class CSSTransformComponent extends CSSStyleValue {
    constructor(token) {
      if (token !== transformComponentToken) throw new TypeError("Failed to construct 'CSSTransformComponent': Illegal constructor");
      super(styleValueToken);
    }
  }
  Object.defineProperty(CSSTransformComponent.prototype, Symbol.toStringTag, { value: 'CSSTransformComponent', configurable: true });

  class CSSTransformValue extends CSSStyleValue {
    constructor(transforms = []) {
      super(styleValueToken);
      defineHidden(this, '__zpTransforms', Array.from(transforms));
      refreshTransformIndexes(this);
    }
    get length() { return this.__zpTransforms.length; }
    get is2D() { return this.__zpTransforms.every((value) => value?.is2D !== false); }
    entries() { return this.__zpTransforms.entries(); }
    keys() { return this.__zpTransforms.keys(); }
    values() { return this.__zpTransforms.values(); }
    forEach(callback, thisArg = undefined) { this.__zpTransforms.forEach((value, index) => callback.call(thisArg, value, index, this)); }
    [Symbol.iterator]() { return this.values(); }
    toString() { return this.__zpTransforms.map(String).join(' '); }
  }
  Object.defineProperty(CSSTransformValue.prototype, Symbol.toStringTag, { value: 'CSSTransformValue', configurable: true });

  class CSSTranslate extends CSSTransformComponent {
    constructor(x, y, z = new CSSUnitValue(0, 'px')) {
      super(transformComponentToken);
      defineHidden(this, '__zpX', toNumericValue(x));
      defineHidden(this, '__zpY', toNumericValue(y));
      defineHidden(this, '__zpZ', toNumericValue(z));
    }
    get x() { return this.__zpX; }
    get y() { return this.__zpY; }
    get z() { return this.__zpZ; }
    get is2D() { return this.z.value === 0; }
    toString() { return this.is2D ? `translate(${this.x}, ${this.y})` : `translate3d(${this.x}, ${this.y}, ${this.z})`; }
  }
  Object.defineProperty(CSSTranslate.prototype, Symbol.toStringTag, { value: 'CSSTranslate', configurable: true });

  class CSSRotate extends CSSTransformComponent {
    constructor(angle, x = new CSSUnitValue(0, 'number'), y = new CSSUnitValue(0, 'number'), z = new CSSUnitValue(1, 'number')) {
      super(transformComponentToken);
      defineHidden(this, '__zpAngle', toNumericValue(angle));
      defineHidden(this, '__zpX', toNumericValue(x));
      defineHidden(this, '__zpY', toNumericValue(y));
      defineHidden(this, '__zpZ', toNumericValue(z));
    }
    get angle() { return this.__zpAngle; }
    get x() { return this.__zpX; }
    get y() { return this.__zpY; }
    get z() { return this.__zpZ; }
    get is2D() { return this.x.value === 0 && this.y.value === 0 && this.z.value === 1; }
    toString() { return this.is2D ? `rotate(${this.angle})` : `rotate3d(${this.x}, ${this.y}, ${this.z}, ${this.angle})`; }
  }
  Object.defineProperty(CSSRotate.prototype, Symbol.toStringTag, { value: 'CSSRotate', configurable: true });

  class CSSScale extends CSSTransformComponent {
    constructor(x, y = x, z = new CSSUnitValue(1, 'number')) {
      super(transformComponentToken);
      defineHidden(this, '__zpX', toNumericValue(x));
      defineHidden(this, '__zpY', toNumericValue(y));
      defineHidden(this, '__zpZ', toNumericValue(z));
    }
    get x() { return this.__zpX; }
    get y() { return this.__zpY; }
    get z() { return this.__zpZ; }
    get is2D() { return this.z.value === 1; }
    toString() { return this.is2D ? `scale(${this.x}, ${this.y})` : `scale3d(${this.x}, ${this.y}, ${this.z})`; }
  }
  Object.defineProperty(CSSScale.prototype, Symbol.toStringTag, { value: 'CSSScale', configurable: true });

  class CSSSkew extends CSSTransformComponent {
    constructor(ax, ay = new CSSUnitValue(0, 'deg')) {
      super(transformComponentToken);
      defineHidden(this, '__zpAx', toNumericValue(ax));
      defineHidden(this, '__zpAy', toNumericValue(ay));
    }
    get ax() { return this.__zpAx; }
    get ay() { return this.__zpAy; }
    get is2D() { return true; }
    toString() { return `skew(${this.ax}, ${this.ay})`; }
  }
  Object.defineProperty(CSSSkew.prototype, Symbol.toStringTag, { value: 'CSSSkew', configurable: true });

  class CSSSkewX extends CSSTransformComponent {
    constructor(ax) { super(transformComponentToken); defineHidden(this, '__zpAx', toNumericValue(ax)); }
    get ax() { return this.__zpAx; }
    get is2D() { return true; }
    toString() { return `skewX(${this.ax})`; }
  }
  Object.defineProperty(CSSSkewX.prototype, Symbol.toStringTag, { value: 'CSSSkewX', configurable: true });

  class CSSSkewY extends CSSTransformComponent {
    constructor(ay) { super(transformComponentToken); defineHidden(this, '__zpAy', toNumericValue(ay)); }
    get ay() { return this.__zpAy; }
    get is2D() { return true; }
    toString() { return `skewY(${this.ay})`; }
  }
  Object.defineProperty(CSSSkewY.prototype, Symbol.toStringTag, { value: 'CSSSkewY', configurable: true });

  class CSSPerspective extends CSSTransformComponent {
    constructor(length) { super(transformComponentToken); defineHidden(this, '__zpLength', toNumericValue(length)); }
    get length() { return this.__zpLength; }
    get is2D() { return false; }
    toString() { return `perspective(${this.length})`; }
  }
  Object.defineProperty(CSSPerspective.prototype, Symbol.toStringTag, { value: 'CSSPerspective', configurable: true });

  class CSSMatrixComponent extends CSSTransformComponent {
    constructor(matrix, options = {}) {
      super(transformComponentToken);
      defineHidden(this, '__zpMatrix', matrix);
      defineHidden(this, '__zpIs2D', options.is2D ?? matrix?.is2D !== false);
    }
    get matrix() { return this.__zpMatrix; }
    get is2D() { return Boolean(this.__zpIs2D); }
    toString() { return String(this.matrix ?? 'matrix()'); }
  }
  function cssPositionValueSlots(value) {
    const state = cssPositionValueState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function cssNumericArgument(className, operation, property, parameterIndex, value) {
    if (value instanceof CSSNumericValue) return value;
    if (operation === 'set') throw new TypeError(`Failed to set the '${property}' property on '${className}': Failed to convert value to 'CSSNumericValue'.`);
    throw new TypeError(`Failed to construct '${className}': parameter ${parameterIndex} is not of type 'CSSNumericValue'.`);
  }
  function cssVariableReferenceValueSlots(value) {
    const state = cssVariableReferenceValueState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function cssCustomPropertyName(className, operation, property, value) {
    const name = cssString(className, operation, property, value);
    if (!name.startsWith('--') || name.length <= 2) throw new TypeError(cssConversionMessage(className, operation, property, 'Invalid custom property name'));
    return name;
  }

  function cssUnparsedFallback(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof CSSUnparsedValue) return value;
    throw new TypeError("Failed to construct 'CSSVariableReferenceValue': parameter 2 is not of type 'CSSUnparsedValue'.");
  }


  Object.defineProperty(CSSMatrixComponent.prototype, Symbol.toStringTag, { value: 'CSSMatrixComponent', configurable: true });

  function cssKeywordValueSlots(value) {
    const state = cssKeywordValueState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function cssUnitValueSlots(value) {
    const state = cssUnitValueState.get(value);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function cssString(className, operation, property, value) {
    if (typeof value === 'symbol') throw new TypeError(cssConversionMessage(className, operation, property, 'Cannot convert a Symbol value to a string'));
    return String(value);
  }

  function cssFiniteNumber(className, operation, property, value) {
    if (typeof value === 'symbol') throw new TypeError(cssConversionMessage(className, operation, property, 'Cannot convert a Symbol value to a number'));
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(cssConversionMessage(className, operation, property, 'The provided double value is non-finite.'));
    return number;
  }

  function cssConversionMessage(className, operation, property, detail) {
    if (operation === 'set') return `Failed to set the '${property}' property on '${className}': ${detail}`;
    return `Failed to construct '${className}': ${detail}`;
  }

  function cssUnitName(value) {
    const unit = cssString('CSSUnitValue', 'construct', 'unit', value);
    const normalized = unit === '%' ? 'percent' : unit.toLowerCase();
    if (!cssUnitNames.has(normalized)) throw new TypeError(`Failed to construct 'CSSUnitValue': Invalid unit: ${unit}`);
    return normalized;
  }

  return { CSSStyleValue, CSSKeywordValue, CSSImageValue, CSSNumericValue, CSSUnitValue, CSSNumericArray, CSSMathValue, CSSMathSum, CSSMathProduct, CSSMathNegate, CSSMathInvert, CSSMathMin, CSSMathMax, CSSMathClamp, CSSPositionValue, CSSUnparsedValue, CSSVariableReferenceValue, CSSTransformComponent, CSSTransformValue, CSSTranslate, CSSRotate, CSSScale, CSSSkew, CSSSkewX, CSSSkewY, CSSPerspective, CSSMatrixComponent };
}

function parseNumericValue(cssText) {
  const text = String(cssText ?? '').trim();
  const match = text.match(/^([+-]?(?:\d+|\d*\.\d+))(.*)$/);
  if (!match) return new globalThis.CSSKeywordValue(text);
  const unit = match[2].trim() || 'number';
  return new globalThis.CSSUnitValue(Number(match[1]), unit);
}

function toNumericValue(value) {
  if (value instanceof globalThis.CSSNumericValue) return value;
  if (typeof value === 'number') return new globalThis.CSSUnitValue(value, 'number');
  return parseNumericValue(value);
}

function refreshIndexes(list) {
  const values = list.__zpValues ?? list.__zpMembers;
  for (let index = 0; index < values.length; index += 1) list[index] = values[index];
}

function refreshTransformIndexes(list) {
  for (let index = 0; index < list.__zpTransforms.length; index += 1) list[index] = list.__zpTransforms[index];
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
