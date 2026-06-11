const svgValueInterfaces = Object.freeze([
  ['SVGAngle', {
    SVG_ANGLETYPE_UNKNOWN: 0,
    SVG_ANGLETYPE_UNSPECIFIED: 1,
    SVG_ANGLETYPE_DEG: 2,
    SVG_ANGLETYPE_RAD: 3,
    SVG_ANGLETYPE_GRAD: 4,
  }],
  ['SVGLength', {
    SVG_LENGTHTYPE_UNKNOWN: 0,
    SVG_LENGTHTYPE_NUMBER: 1,
    SVG_LENGTHTYPE_PERCENTAGE: 2,
    SVG_LENGTHTYPE_EMS: 3,
    SVG_LENGTHTYPE_EXS: 4,
    SVG_LENGTHTYPE_PX: 5,
    SVG_LENGTHTYPE_CM: 6,
    SVG_LENGTHTYPE_MM: 7,
    SVG_LENGTHTYPE_IN: 8,
    SVG_LENGTHTYPE_PT: 9,
    SVG_LENGTHTYPE_PC: 10,
  }],
  ['SVGNumber'],
  ['SVGStringList'],
  ['SVGLengthList'],
  ['SVGNumberList'],
  ['SVGPoint'],
  ['SVGPointList'],
  ['SVGMatrix'],
  ['SVGRect'],
  ['SVGTransform', {
    SVG_TRANSFORM_UNKNOWN: 0,
    SVG_TRANSFORM_MATRIX: 1,
    SVG_TRANSFORM_TRANSLATE: 2,
    SVG_TRANSFORM_SCALE: 3,
    SVG_TRANSFORM_ROTATE: 4,
    SVG_TRANSFORM_SKEWX: 5,
    SVG_TRANSFORM_SKEWY: 6,
  }],
  ['SVGTransformList'],
  ['SVGPreserveAspectRatio', {
    SVG_PRESERVEASPECTRATIO_UNKNOWN: 0,
    SVG_PRESERVEASPECTRATIO_NONE: 1,
    SVG_PRESERVEASPECTRATIO_XMINYMIN: 2,
    SVG_PRESERVEASPECTRATIO_XMIDYMIN: 3,
    SVG_PRESERVEASPECTRATIO_XMAXYMIN: 4,
    SVG_PRESERVEASPECTRATIO_XMINYMID: 5,
    SVG_PRESERVEASPECTRATIO_XMIDYMID: 6,
    SVG_PRESERVEASPECTRATIO_XMAXYMID: 7,
    SVG_PRESERVEASPECTRATIO_XMINYMAX: 8,
    SVG_PRESERVEASPECTRATIO_XMIDYMAX: 9,
    SVG_PRESERVEASPECTRATIO_XMAXYMAX: 10,
    SVG_MEETORSLICE_UNKNOWN: 0,
    SVG_MEETORSLICE_MEET: 1,
    SVG_MEETORSLICE_SLICE: 2,
  }],
  ['SVGAnimatedAngle'],
  ['SVGAnimatedBoolean'],
  ['SVGAnimatedEnumeration'],
  ['SVGAnimatedInteger'],
  ['SVGAnimatedLength'],
  ['SVGAnimatedLengthList'],
  ['SVGAnimatedNumber'],
  ['SVGAnimatedNumberList'],
  ['SVGAnimatedPreserveAspectRatio'],
  ['SVGAnimatedRect'],
  ['SVGAnimatedString'],
  ['SVGAnimatedTransformList'],
  ['SVGUnitTypes', {
    SVG_UNIT_TYPE_UNKNOWN: 0,
    SVG_UNIT_TYPE_USERSPACEONUSE: 1,
    SVG_UNIT_TYPE_OBJECTBOUNDINGBOX: 2,
  }, 'Illegal constructor'],
]);

export function createSVGValueFacades() {
  return Object.fromEntries(svgValueInterfaces.map(([name, constants, message]) => [name, makeSVGValueConstructor(name, constants || {}, message)]));
}

function makeSVGValueConstructor(name, constants, message) {
  const ctor = function SVGValueConstructor() { throw new TypeError(message || illegalSVGValueMessage(name)); };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  for (const [constantName, value] of Object.entries(constants)) {
    defineConstant(ctor, constantName, value);
    defineConstant(ctor.prototype, constantName, value);
  }
  installSVGValuePrototypeShape(name, ctor.prototype);
  return ctor;
}

function illegalSVGValueMessage(name) {
  return ["Failed to construct '", name, "': Illegal constructor"].join('');
}

function defineConstant(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: false, writable: false });
}

function installSVGValuePrototypeShape(name, proto) {
  if (name === 'SVGAngle' || name === 'SVGLength') defineUnitValueShape(proto);
  else if (name === 'SVGNumber') defineAccessors(proto, ['value']);
  else if (name === 'SVGPoint') {
    defineAccessors(proto, ['x', 'y']);
    defineMethods(proto, { matrixTransform });
  } else if (name === 'SVGRect') defineAccessors(proto, ['x', 'y', 'width', 'height']);
  else if (name === 'SVGMatrix') {
    defineAccessors(proto, ['a', 'b', 'c', 'd', 'e', 'f']);
    defineMethods(proto, { flipX, flipY, inverse, multiply, rotate, rotateFromVector, scale, scaleNonUniform, skewX, skewY, translate });
  } else if (name === 'SVGTransform') {
    defineAccessors(proto, ['type', 'matrix', 'angle'], true);
    defineMethods(proto, { setMatrix, setRotate, setScale, setSkewX, setSkewY, setTranslate });
  } else if (name === 'SVGPreserveAspectRatio') defineAccessors(proto, ['align', 'meetOrSlice']);
  else if (name.startsWith('SVGAnimated')) defineAnimatedShape(name, proto);
  else if (name.endsWith('List')) defineListShape(name, proto);
}

function defineUnitValueShape(proto) {
  defineAccessors(proto, ['unitType'], true);
  defineAccessors(proto, ['value', 'valueAsString', 'valueInSpecifiedUnits']);
  defineMethods(proto, { convertToSpecifiedUnits, newValueSpecifiedUnits });
}

function defineListShape(name, proto) {
  defineAccessors(proto, ['length', 'numberOfItems'], true);
  defineMethods(proto, { appendItem, clear, getItem, initialize, insertItemBefore, removeItem, replaceItem });
  if (name === 'SVGTransformList') defineMethods(proto, { consolidate, createSVGTransformFromMatrix });
  Object.defineProperty(proto, Symbol.iterator, { value: svgValueListIterator, enumerable: false, writable: true, configurable: true });
}

function defineAnimatedShape(name, proto) {
  const readonlyBase = ['SVGAnimatedAngle', 'SVGAnimatedLength', 'SVGAnimatedLengthList', 'SVGAnimatedNumberList', 'SVGAnimatedPreserveAspectRatio', 'SVGAnimatedRect', 'SVGAnimatedTransformList'].includes(name);
  defineAccessors(proto, ['baseVal'], readonlyBase);
  defineAccessors(proto, ['animVal'], true);
}

function defineAccessors(proto, names, readonly = false) {
  for (const name of names) Object.defineProperty(proto, name, accessorDescriptor(name, readonly));
}

function defineMethods(proto, methods) {
  for (const [name, value] of Object.entries(methods)) Object.defineProperty(proto, name, { value, enumerable: true, writable: true, configurable: true });
}

function accessorDescriptor(name, readonly) {
  const descriptor = Object.getOwnPropertyDescriptor({
    get [name]() { return this && Object.prototype.hasOwnProperty.call(this, '__zp_' + name) ? this['__zp_' + name] : defaultSVGValue(name); },
    set [name](value) { Object.defineProperty(this, '__zp_' + name, { value, writable: true, configurable: true }); },
  }, name);
  if (readonly) descriptor.set = undefined;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

function defaultSVGValue(name) {
  return name === 'valueAsString' ? '' : 0;
}

function convertToSpecifiedUnits(unitType) { void unitType; }
function newValueSpecifiedUnits(unitType, valueInSpecifiedUnits) { void unitType; void valueInSpecifiedUnits; }
function matrixTransform(matrix) { void matrix; return this; }
function flipX() { return this; }
function flipY() { return this; }
function inverse() { return this; }
function multiply(secondMatrix) { void secondMatrix; return this; }
function rotate(angle) { void angle; return this; }
function rotateFromVector(x, y) { void x; void y; return this; }
function scale(scaleFactor) { void scaleFactor; return this; }
function scaleNonUniform(scaleFactorX, scaleFactorY) { void scaleFactorX; void scaleFactorY; return this; }
function skewX(angle) { void angle; return this; }
function skewY(angle) { void angle; return this; }
function translate(x, y) { void x; void y; return this; }
function setMatrix(matrix) { void matrix; }
function setRotate(angle, cx, cy) { void angle; void cx; void cy; }
function setScale(sx, sy) { void sx; void sy; }
function setSkewX(angle) { void angle; }
function setSkewY(angle) { void angle; }
function setTranslate(tx, ty) { void tx; void ty; }
function appendItem(newItem) { return newItem; }
function clear() {}
function getItem(index) { void index; return undefined; }
function initialize(newItem) { return newItem; }
function insertItemBefore(newItem, index) { void index; return newItem; }
function removeItem(index) { void index; return undefined; }
function replaceItem(newItem, index) { void index; return newItem; }
function consolidate() { return null; }
function createSVGTransformFromMatrix(matrix) { void matrix; return null; }
const svgValueListIterator = function svgValueListIterator() { return [][Symbol.iterator](); };
Object.defineProperty(svgValueListIterator, 'name', { value: 'values', configurable: true });
