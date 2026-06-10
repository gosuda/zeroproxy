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
  return ctor;
}

function illegalSVGValueMessage(name) {
  return ["Failed to construct '", name, "': Illegal constructor"].join('');
}

function defineConstant(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: false, writable: false });
}
