const SVG_NS = 'http://www.w3.org/2000/svg';

const svgTagInterfaceEntries = Object.freeze([
  ['a', 'SVGAElement'],
  ['animate', 'SVGAnimateElement'],
  ['animateMotion', 'SVGAnimateMotionElement'],
  ['animateTransform', 'SVGAnimateTransformElement'],
  ['circle', 'SVGCircleElement'],
  ['clipPath', 'SVGClipPathElement'],
  ['defs', 'SVGDefsElement'],
  ['desc', 'SVGDescElement'],
  ['ellipse', 'SVGEllipseElement'],
  ['feBlend', 'SVGFEBlendElement'],
  ['feColorMatrix', 'SVGFEColorMatrixElement'],
  ['feComponentTransfer', 'SVGFEComponentTransferElement'],
  ['feComposite', 'SVGFECompositeElement'],
  ['feConvolveMatrix', 'SVGFEConvolveMatrixElement'],
  ['feDiffuseLighting', 'SVGFEDiffuseLightingElement'],
  ['feDisplacementMap', 'SVGFEDisplacementMapElement'],
  ['feDistantLight', 'SVGFEDistantLightElement'],
  ['feDropShadow', 'SVGFEDropShadowElement'],
  ['feFlood', 'SVGFEFloodElement'],
  ['feFuncA', 'SVGFEFuncAElement'],
  ['feFuncB', 'SVGFEFuncBElement'],
  ['feFuncG', 'SVGFEFuncGElement'],
  ['feFuncR', 'SVGFEFuncRElement'],
  ['feGaussianBlur', 'SVGFEGaussianBlurElement'],
  ['feImage', 'SVGFEImageElement'],
  ['feMerge', 'SVGFEMergeElement'],
  ['feMergeNode', 'SVGFEMergeNodeElement'],
  ['feMorphology', 'SVGFEMorphologyElement'],
  ['feOffset', 'SVGFEOffsetElement'],
  ['fePointLight', 'SVGFEPointLightElement'],
  ['feSpecularLighting', 'SVGFESpecularLightingElement'],
  ['feSpotLight', 'SVGFESpotLightElement'],
  ['feTile', 'SVGFETileElement'],
  ['feTurbulence', 'SVGFETurbulenceElement'],
  ['filter', 'SVGFilterElement'],
  ['foreignObject', 'SVGForeignObjectElement'],
  ['g', 'SVGGElement'],
  ['image', 'SVGImageElement'],
  ['line', 'SVGLineElement'],
  ['linearGradient', 'SVGLinearGradientElement'],
  ['marker', 'SVGMarkerElement'],
  ['mask', 'SVGMaskElement'],
  ['metadata', 'SVGMetadataElement'],
  ['mpath', 'SVGMPathElement'],
  ['path', 'SVGPathElement'],
  ['pattern', 'SVGPatternElement'],
  ['polygon', 'SVGPolygonElement'],
  ['polyline', 'SVGPolylineElement'],
  ['radialGradient', 'SVGRadialGradientElement'],
  ['rect', 'SVGRectElement'],
  ['script', 'SVGScriptElement'],
  ['set', 'SVGSetElement'],
  ['stop', 'SVGStopElement'],
  ['style', 'SVGStyleElement'],
  ['svg', 'SVGSVGElement'],
  ['switch', 'SVGSwitchElement'],
  ['symbol', 'SVGSymbolElement'],
  ['text', 'SVGTextElement'],
  ['textPath', 'SVGTextPathElement'],
  ['title', 'SVGTitleElement'],
  ['tspan', 'SVGTSpanElement'],
  ['use', 'SVGUseElement'],
  ['view', 'SVGViewElement'],
]);

const svgElementConstructorEntries = Object.freeze([
  ['SVGGraphicsElement', ['a', 'circle', 'defs', 'ellipse', 'foreignObject', 'g', 'image', 'line', 'path', 'polygon', 'polyline', 'rect', 'svg', 'switch', 'text', 'textPath', 'tspan', 'use'], 'SVGElement'],
  ['SVGGeometryElement', ['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect'], 'SVGGraphicsElement'],
  ['SVGTextContentElement', ['text', 'textPath', 'tspan'], 'SVGGraphicsElement'],
  ['SVGTextPositioningElement', ['text', 'tspan'], 'SVGTextContentElement'],
  ['SVGGradientElement', ['linearGradient', 'radialGradient'], 'SVGElement'],
  ['SVGAnimationElement', ['animate', 'animateMotion', 'animateTransform', 'set'], 'SVGElement'],
  ['SVGComponentTransferFunctionElement', ['feFuncA', 'feFuncB', 'feFuncG', 'feFuncR'], 'SVGElement'],
  ['SVGAElement', 'a', 'SVGGraphicsElement'],
  ['SVGAnimateElement', 'animate', 'SVGAnimationElement'],
  ['SVGAnimateMotionElement', 'animateMotion', 'SVGAnimationElement'],
  ['SVGAnimateTransformElement', 'animateTransform', 'SVGAnimationElement'],
  ['SVGCircleElement', 'circle', 'SVGGeometryElement'],
  ['SVGClipPathElement', 'clipPath', 'SVGElement'],
  ['SVGDefsElement', 'defs', 'SVGGraphicsElement'],
  ['SVGDescElement', 'desc', 'SVGElement'],
  ['SVGEllipseElement', 'ellipse', 'SVGGeometryElement'],
  ['SVGFEBlendElement', 'feBlend', 'SVGElement'],
  ['SVGFEColorMatrixElement', 'feColorMatrix', 'SVGElement'],
  ['SVGFEComponentTransferElement', 'feComponentTransfer', 'SVGElement'],
  ['SVGFECompositeElement', 'feComposite', 'SVGElement'],
  ['SVGFEConvolveMatrixElement', 'feConvolveMatrix', 'SVGElement'],
  ['SVGFEDiffuseLightingElement', 'feDiffuseLighting', 'SVGElement'],
  ['SVGFEDisplacementMapElement', 'feDisplacementMap', 'SVGElement'],
  ['SVGFEDistantLightElement', 'feDistantLight', 'SVGElement'],
  ['SVGFEDropShadowElement', 'feDropShadow', 'SVGElement'],
  ['SVGFEFloodElement', 'feFlood', 'SVGElement'],
  ['SVGFEFuncAElement', 'feFuncA', 'SVGComponentTransferFunctionElement'],
  ['SVGFEFuncBElement', 'feFuncB', 'SVGComponentTransferFunctionElement'],
  ['SVGFEFuncGElement', 'feFuncG', 'SVGComponentTransferFunctionElement'],
  ['SVGFEFuncRElement', 'feFuncR', 'SVGComponentTransferFunctionElement'],
  ['SVGFEGaussianBlurElement', 'feGaussianBlur', 'SVGElement'],
  ['SVGFEImageElement', 'feImage', 'SVGElement'],
  ['SVGFEMergeElement', 'feMerge', 'SVGElement'],
  ['SVGFEMergeNodeElement', 'feMergeNode', 'SVGElement'],
  ['SVGFEMorphologyElement', 'feMorphology', 'SVGElement'],
  ['SVGFEOffsetElement', 'feOffset', 'SVGElement'],
  ['SVGFEPointLightElement', 'fePointLight', 'SVGElement'],
  ['SVGFESpecularLightingElement', 'feSpecularLighting', 'SVGElement'],
  ['SVGFESpotLightElement', 'feSpotLight', 'SVGElement'],
  ['SVGFETileElement', 'feTile', 'SVGElement'],
  ['SVGFETurbulenceElement', 'feTurbulence', 'SVGElement'],
  ['SVGFilterElement', 'filter', 'SVGElement'],
  ['SVGForeignObjectElement', 'foreignObject', 'SVGGraphicsElement'],
  ['SVGGElement', 'g', 'SVGGraphicsElement'],
  ['SVGImageElement', 'image', 'SVGGraphicsElement'],
  ['SVGLineElement', 'line', 'SVGGeometryElement'],
  ['SVGLinearGradientElement', 'linearGradient', 'SVGGradientElement'],
  ['SVGMarkerElement', 'marker', 'SVGElement'],
  ['SVGMaskElement', 'mask', 'SVGElement'],
  ['SVGMetadataElement', 'metadata', 'SVGElement'],
  ['SVGMPathElement', 'mpath', 'SVGElement'],
  ['SVGPathElement', 'path', 'SVGGeometryElement'],
  ['SVGPatternElement', 'pattern', 'SVGElement'],
  ['SVGPolygonElement', 'polygon', 'SVGGeometryElement'],
  ['SVGPolylineElement', 'polyline', 'SVGGeometryElement'],
  ['SVGRadialGradientElement', 'radialGradient', 'SVGGradientElement'],
  ['SVGRectElement', 'rect', 'SVGGeometryElement'],
  ['SVGScriptElement', 'script', 'SVGElement'],
  ['SVGSetElement', 'set', 'SVGAnimationElement'],
  ['SVGStopElement', 'stop', 'SVGElement'],
  ['SVGStyleElement', 'style', 'SVGElement'],
  ['SVGSVGElement', 'svg', 'SVGGraphicsElement'],
  ['SVGSwitchElement', 'switch', 'SVGGraphicsElement'],
  ['SVGSymbolElement', 'symbol', 'SVGGraphicsElement'],
  ['SVGTextElement', 'text', 'SVGTextPositioningElement'],
  ['SVGTextPathElement', 'textPath', 'SVGTextContentElement'],
  ['SVGTitleElement', 'title', 'SVGElement'],
  ['SVGTSpanElement', 'tspan', 'SVGTextPositioningElement'],
  ['SVGUseElement', 'use', 'SVGGraphicsElement'],
  ['SVGViewElement', 'view', 'SVGElement'],
]);

export function createSVGWebIDL() {
  const svgInterfaceByTag = Object.freeze(Object.fromEntries(svgTagInterfaceEntries));
  const svgElementConstructors = Object.freeze(makeSVGElementConstructors());
  return {
    svgElementConstructors,
    elementToStringTag(element) {
      if (!isSVGNamespace(element)) return null;
      return svgInterfaceByTag[String(element.localName || '')] || 'SVGElement';
    },
    interfaceNameForTag(localName) {
      return svgInterfaceByTag[String(localName || '')] || 'SVGElement';
    },
  };
}

function makeSVGElementConstructors() {
  const constructors = {};
  maybeLinkBaseSVGElement();
  for (const [interfaceName, localNames, parentName] of svgElementConstructorEntries) {
    constructors[interfaceName] = makeSVGConstructor(
      interfaceName,
      localNames,
      constructors[parentName] || globalThis[parentName],
    );
  }
  return constructors;
}

function maybeLinkBaseSVGElement() {
  const svgPrototype = globalThis.SVGElement?.prototype;
  const elementPrototype = globalThis.Element?.prototype;
  if (!svgPrototype || !elementPrototype) return;
  if (Object.getPrototypeOf(svgPrototype) !== elementPrototype) Object.setPrototypeOf(svgPrototype, elementPrototype);
  if (!Object.getOwnPropertyDescriptor(svgPrototype, Symbol.toStringTag)) {
    Object.defineProperty(svgPrototype, Symbol.toStringTag, { value: 'SVGElement', configurable: true });
  }
}

function makeSVGConstructor(interfaceName, localNames, parentCtor) {
  const ctor = function SVGElementConstructor() { throw new TypeError(`Failed to construct '${interfaceName}': Illegal constructor`); };
  Object.defineProperty(ctor, 'name', { value: interfaceName, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: interfaceName, configurable: true });
  if (parentCtor?.prototype) {
    Object.setPrototypeOf(ctor.prototype, parentCtor.prototype);
    Object.setPrototypeOf(ctor, parentCtor);
  }
  installSVGElementPrototypeShape(interfaceName, ctor);
  return ctor;
}

function matchesSVGLocalName(value, localNames) {
  if (!isSVGNamespace(value)) return false;
  if (Array.isArray(localNames)) return localNames.includes(value.localName);
  return value.localName === localNames;
}

function isSVGNamespace(value) {
  return value?.nodeType === 1 && value.namespaceURI === SVG_NS;
}

function installSVGElementPrototypeShape(interfaceName, ctor) {
  if (interfaceName === 'SVGTextContentElement') {
    defineSVGConstants(ctor, { LENGTHADJUST_UNKNOWN: 0, LENGTHADJUST_SPACING: 1, LENGTHADJUST_SPACINGANDGLYPHS: 2 });
    defineSVGReadonlyAccessors(ctor.prototype, ['textLength', 'lengthAdjust']);
    defineSVGMethods(ctor.prototype, { getCharNumAtPosition, getComputedTextLength, getEndPositionOfChar, getExtentOfChar, getNumberOfChars, getRotationOfChar, getStartPositionOfChar, getSubStringLength, selectSubString });
  } else if (interfaceName === 'SVGTextPositioningElement') {
    defineSVGReadonlyAccessors(ctor.prototype, ['x', 'y', 'dx', 'dy', 'rotate']);
  } else if (interfaceName === 'SVGAnimationElement') {
    defineSVGReadonlyAccessors(ctor.prototype, ['targetElement', 'requiredExtensions', 'systemLanguage']);
    defineSVGEventAccessors(ctor.prototype, ['onbegin', 'onend', 'onrepeat']);
    defineSVGMethods(ctor.prototype, { beginElement, beginElementAt, endElement, endElementAt, getCurrentTime, getSimpleDuration, getStartTime });
  } else if (interfaceName === 'SVGGradientElement') {
    defineSVGConstants(ctor, { SVG_SPREADMETHOD_UNKNOWN: 0, SVG_SPREADMETHOD_PAD: 1, SVG_SPREADMETHOD_REFLECT: 2, SVG_SPREADMETHOD_REPEAT: 3 });
    defineSVGReadonlyAccessors(ctor.prototype, ['gradientUnits', 'gradientTransform', 'spreadMethod', 'href']);
  }
  else if (interfaceName === 'SVGElement') {
    defineSVGEventAccessors(ctor.prototype, ['onabort', 'onanimationcancel', 'onanimationend', 'onanimationiteration', 'onanimationstart']);
    defineSVGMethods(ctor.prototype, { blur, focus });
    defineSVGReadonlyAccessors(ctor.prototype, ['attributeStyleMap', 'className', 'dataset']);
    defineSVGReflectingAccessors(ctor.prototype, ['autofocus', 'nonce']);
  }
  const accessors = svgElementShapeAccessors[interfaceName];
  if (accessors) defineSVGReadonlyAccessors(ctor.prototype, accessors);
  const mutableAccessors = svgElementShapeMutableAccessors[interfaceName];
  if (mutableAccessors) defineSVGReflectingAccessors(ctor.prototype, mutableAccessors);
  const constants = svgElementShapeConstants[interfaceName];
  if (constants) defineSVGConstants(ctor, constants);
  const methods = svgElementShapeMethods[interfaceName];
  if (methods) defineSVGMethods(ctor.prototype, methods);
}

const svgFilterPrimitiveAccessors = ['x', 'y', 'width', 'height', 'result'];
const svgElementShapeAccessors = {
  SVGGraphicsElement: ['transform', 'nearestViewportElement', 'farthestViewportElement', 'requiredExtensions', 'systemLanguage'],
  SVGGeometryElement: ['pathLength'],
  SVGComponentTransferFunctionElement: ['type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'],
  SVGCircleElement: ['cx', 'cy', 'r'],
  SVGClipPathElement: ['clipPathUnits', 'transform'],
  SVGEllipseElement: ['cx', 'cy', 'rx', 'ry'],
  SVGFEBlendElement: [...svgFilterPrimitiveAccessors, 'in1', 'in2', 'mode'],
  SVGFEColorMatrixElement: [...svgFilterPrimitiveAccessors, 'in1', 'type', 'values'],
  SVGFEComponentTransferElement: [...svgFilterPrimitiveAccessors, 'in1'],
  SVGFECompositeElement: [...svgFilterPrimitiveAccessors, 'in1', 'in2', 'operator', 'k1', 'k2', 'k3', 'k4'],
  SVGFEConvolveMatrixElement: [...svgFilterPrimitiveAccessors, 'in1', 'orderX', 'orderY', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLengthX', 'kernelUnitLengthY', 'preserveAlpha'],
  SVGFEDiffuseLightingElement: [...svgFilterPrimitiveAccessors, 'in1', 'surfaceScale', 'diffuseConstant', 'kernelUnitLengthX', 'kernelUnitLengthY'],
  SVGFEDisplacementMapElement: [...svgFilterPrimitiveAccessors, 'in1', 'in2', 'scale', 'xChannelSelector', 'yChannelSelector'],
  SVGFEDistantLightElement: ['azimuth', 'elevation'],
  SVGFEDropShadowElement: [...svgFilterPrimitiveAccessors, 'in1', 'dx', 'dy', 'stdDeviationX', 'stdDeviationY'],
  SVGFEFloodElement: svgFilterPrimitiveAccessors,
  SVGFEGaussianBlurElement: [...svgFilterPrimitiveAccessors, 'in1', 'stdDeviationX', 'stdDeviationY'],
  SVGFEImageElement: [...svgFilterPrimitiveAccessors, 'href', 'preserveAspectRatio'],
  SVGFEMergeElement: svgFilterPrimitiveAccessors,
  SVGFEMergeNodeElement: ['in1'],
  SVGFEMorphologyElement: [...svgFilterPrimitiveAccessors, 'in1', 'operator', 'radiusX', 'radiusY'],
  SVGFEOffsetElement: [...svgFilterPrimitiveAccessors, 'in1', 'dx', 'dy'],
  SVGFEPointLightElement: ['x', 'y', 'z'],
  SVGFESpecularLightingElement: [...svgFilterPrimitiveAccessors, 'in1', 'surfaceScale', 'specularConstant', 'specularExponent', 'kernelUnitLengthX', 'kernelUnitLengthY'],
  SVGFESpotLightElement: ['x', 'y', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'specularExponent', 'limitingConeAngle'],
  SVGFETileElement: [...svgFilterPrimitiveAccessors, 'in1'],
  SVGFETurbulenceElement: [...svgFilterPrimitiveAccessors, 'baseFrequencyX', 'baseFrequencyY', 'numOctaves', 'seed', 'stitchTiles', 'type'],
  SVGFilterElement: ['filterUnits', 'primitiveUnits', 'x', 'y', 'width', 'height', 'href'],
  SVGForeignObjectElement: ['x', 'y', 'width', 'height'],
  SVGLineElement: ['x1', 'y1', 'x2', 'y2'],
  SVGLinearGradientElement: ['x1', 'y1', 'x2', 'y2'],
  SVGMaskElement: ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height', 'requiredExtensions', 'systemLanguage'],
  SVGMPathElement: ['href'],
  SVGPatternElement: ['patternUnits', 'patternContentUnits', 'patternTransform', 'x', 'y', 'width', 'height', 'href', 'viewBox', 'preserveAspectRatio', 'requiredExtensions', 'systemLanguage'],
  SVGPolygonElement: ['points', 'animatedPoints'],
  SVGPolylineElement: ['points', 'animatedPoints'],
  SVGRadialGradientElement: ['cx', 'cy', 'r', 'fx', 'fy', 'fr'],
  SVGRectElement: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  SVGStopElement: ['offset'],
  SVGScriptElement: ['href'],
  SVGStyleElement: ['sheet'],
  SVGUseElement: ['x', 'y', 'width', 'height', 'href'],
  SVGSymbolElement: ['viewBox', 'preserveAspectRatio'],
  SVGTextPathElement: ['href', 'startOffset', 'method', 'spacing'],
  SVGViewElement: ['viewBox', 'preserveAspectRatio', 'zoomAndPan'],
  SVGSVGElement: ['currentTranslate', 'height', 'preserveAspectRatio', 'viewBox', 'width', 'x', 'y'],
  SVGAElement: ['href', 'target'],
  SVGImageElement: ['x', 'y', 'width', 'height', 'href', 'preserveAspectRatio'],
  SVGMarkerElement: ['markerHeight', 'markerUnits', 'markerWidth', 'orientAngle', 'orientType', 'preserveAspectRatio', 'refX', 'refY', 'viewBox'],
};

const svgElementShapeMutableAccessors = {
  SVGAElement: ['download', 'hreflang', 'interestForElement', 'ping', 'referrerPolicy', 'rel', 'relList', 'type'],
  SVGImageElement: ['crossOrigin', 'decoding'],
  SVGScriptElement: ['async', 'type'],
  SVGStyleElement: ['disabled', 'media', 'title', 'type'],
  SVGSVGElement: ['currentScale', 'zoomAndPan'],
  SVGViewElement: ['zoomAndPan'],
};

const svgElementShapeConstants = {
  SVGComponentTransferFunctionElement: { SVG_FECOMPONENTTRANSFER_TYPE_UNKNOWN: 0, SVG_FECOMPONENTTRANSFER_TYPE_IDENTITY: 1, SVG_FECOMPONENTTRANSFER_TYPE_TABLE: 2, SVG_FECOMPONENTTRANSFER_TYPE_DISCRETE: 3, SVG_FECOMPONENTTRANSFER_TYPE_LINEAR: 4, SVG_FECOMPONENTTRANSFER_TYPE_GAMMA: 5 },
  SVGFEBlendElement: { SVG_FEBLEND_MODE_UNKNOWN: 0, SVG_FEBLEND_MODE_NORMAL: 1, SVG_FEBLEND_MODE_MULTIPLY: 2, SVG_FEBLEND_MODE_SCREEN: 3, SVG_FEBLEND_MODE_DARKEN: 4, SVG_FEBLEND_MODE_LIGHTEN: 5, SVG_FEBLEND_MODE_OVERLAY: 6, SVG_FEBLEND_MODE_COLOR_DODGE: 7, SVG_FEBLEND_MODE_COLOR_BURN: 8, SVG_FEBLEND_MODE_HARD_LIGHT: 9, SVG_FEBLEND_MODE_SOFT_LIGHT: 10, SVG_FEBLEND_MODE_DIFFERENCE: 11, SVG_FEBLEND_MODE_EXCLUSION: 12, SVG_FEBLEND_MODE_HUE: 13, SVG_FEBLEND_MODE_SATURATION: 14, SVG_FEBLEND_MODE_COLOR: 15, SVG_FEBLEND_MODE_LUMINOSITY: 16 },
  SVGFEColorMatrixElement: { SVG_FECOLORMATRIX_TYPE_UNKNOWN: 0, SVG_FECOLORMATRIX_TYPE_MATRIX: 1, SVG_FECOLORMATRIX_TYPE_SATURATE: 2, SVG_FECOLORMATRIX_TYPE_HUEROTATE: 3, SVG_FECOLORMATRIX_TYPE_LUMINANCETOALPHA: 4 },
  SVGFECompositeElement: { SVG_FECOMPOSITE_OPERATOR_UNKNOWN: 0, SVG_FECOMPOSITE_OPERATOR_OVER: 1, SVG_FECOMPOSITE_OPERATOR_IN: 2, SVG_FECOMPOSITE_OPERATOR_OUT: 3, SVG_FECOMPOSITE_OPERATOR_ATOP: 4, SVG_FECOMPOSITE_OPERATOR_XOR: 5, SVG_FECOMPOSITE_OPERATOR_ARITHMETIC: 6 },
  SVGFEConvolveMatrixElement: { SVG_EDGEMODE_UNKNOWN: 0, SVG_EDGEMODE_DUPLICATE: 1, SVG_EDGEMODE_WRAP: 2, SVG_EDGEMODE_NONE: 3 },
  SVGFEDisplacementMapElement: { SVG_CHANNEL_UNKNOWN: 0, SVG_CHANNEL_R: 1, SVG_CHANNEL_G: 2, SVG_CHANNEL_B: 3, SVG_CHANNEL_A: 4 },
  SVGFEMorphologyElement: { SVG_MORPHOLOGY_OPERATOR_UNKNOWN: 0, SVG_MORPHOLOGY_OPERATOR_ERODE: 1, SVG_MORPHOLOGY_OPERATOR_DILATE: 2 },
  SVGFETurbulenceElement: { SVG_TURBULENCE_TYPE_UNKNOWN: 0, SVG_TURBULENCE_TYPE_FRACTALNOISE: 1, SVG_TURBULENCE_TYPE_TURBULENCE: 2, SVG_STITCHTYPE_UNKNOWN: 0, SVG_STITCHTYPE_STITCH: 1, SVG_STITCHTYPE_NOSTITCH: 2 },
  SVGMarkerElement: { SVG_MARKERUNITS_UNKNOWN: 0, SVG_MARKERUNITS_USERSPACEONUSE: 1, SVG_MARKERUNITS_STROKEWIDTH: 2, SVG_MARKER_ORIENT_UNKNOWN: 0, SVG_MARKER_ORIENT_AUTO: 1, SVG_MARKER_ORIENT_ANGLE: 2 },
  SVGSVGElement: { SVG_ZOOMANDPAN_UNKNOWN: 0, SVG_ZOOMANDPAN_DISABLE: 1, SVG_ZOOMANDPAN_MAGNIFY: 2 },
  SVGTextPathElement: { TEXTPATH_METHODTYPE_UNKNOWN: 0, TEXTPATH_METHODTYPE_ALIGN: 1, TEXTPATH_METHODTYPE_STRETCH: 2, TEXTPATH_SPACINGTYPE_UNKNOWN: 0, TEXTPATH_SPACINGTYPE_AUTO: 1, TEXTPATH_SPACINGTYPE_EXACT: 2 },
  SVGViewElement: { SVG_ZOOMANDPAN_UNKNOWN: 0, SVG_ZOOMANDPAN_DISABLE: 1, SVG_ZOOMANDPAN_MAGNIFY: 2 },
};

const svgElementShapeMethods = {
  SVGGraphicsElement: { getBBox, getCTM, getScreenCTM },
  SVGGeometryElement: { getPointAtLength, getTotalLength, isPointInFill, isPointInStroke },
  SVGSVGElement: { animationsPaused, checkEnclosure, checkIntersection, createSVGAngle, createSVGLength, createSVGMatrix, createSVGNumber, createSVGPoint, createSVGRect, createSVGTransform, createSVGTransformFromMatrix, deselectAll, forceRedraw, getCurrentTime, getElementById, getEnclosureList, getIntersectionList, pauseAnimations, setCurrentTime, suspendRedraw, unpauseAnimations, unsuspendRedraw, unsuspendRedrawAll },
  SVGImageElement: { decode },
  SVGMarkerElement: { setOrientToAngle, setOrientToAuto },
  SVGFEDropShadowElement: { setStdDeviation },
  SVGFEGaussianBlurElement: { setStdDeviation },
};

function getBBox() { return null; }
function getCTM() { return null; }
function getScreenCTM() { return null; }
function getPointAtLength(distance) { void distance; return null; }
function getTotalLength() { return 0; }
function isPointInFill() { return false; }
function isPointInStroke() { return false; }
function setStdDeviation(stdDeviationX, stdDeviationY) { void stdDeviationX; void stdDeviationY; }
function blur() {}
function focus() {}
function checkEnclosure(element, rect) { void element; void rect; return false; }
function checkIntersection(element, rect) { void element; void rect; return false; }
function createSVGAngle() { return new globalThis.SVGAngle(); }
function createSVGLength() { return new globalThis.SVGLength(); }
function createSVGMatrix() { return new globalThis.SVGMatrix(); }
function createSVGNumber() { return new globalThis.SVGNumber(); }
function createSVGPoint() { return new globalThis.SVGPoint(); }
function animationsPaused() { return false; }
function createSVGTransform() { return new globalThis.SVGTransform(); }
function createSVGTransformFromMatrix(matrix) { const transform = new globalThis.SVGTransform(); transform.setMatrix?.(matrix); return transform; }
function deselectAll() {}
function forceRedraw() {}
function getElementById(id) { return this?.querySelector?.('#' + String(id)) || null; }
function getEnclosureList(rect, referenceElement) { void rect; void referenceElement; return []; }
function getIntersectionList(rect, referenceElement) { void rect; void referenceElement; return []; }
function pauseAnimations() {}
function setCurrentTime(seconds) { void seconds; }
function suspendRedraw(maxWaitMilliseconds) { void maxWaitMilliseconds; return 0; }
function unpauseAnimations() {}
function unsuspendRedraw(suspendHandleID) { void suspendHandleID; }
function unsuspendRedrawAll() {}
function decode() { return Promise.resolve(); }
function setOrientToAngle(angle) { void angle; }
function setOrientToAuto() {}
function createSVGRect() { return new globalThis.SVGRect(); }

function defineSVGConstants(ctor, constants) {
  for (const [name, value] of Object.entries(constants)) {
    defineSVGConstant(ctor, name, value);
    defineSVGConstant(ctor.prototype, name, value);
  }
}

function defineSVGConstant(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: false, writable: false });
}

function defineSVGReadonlyAccessors(proto, names) {
  for (const name of names) Object.defineProperty(proto, name, svgAccessorDescriptor(name, true));
}

function defineSVGEventAccessors(proto, names) {
  for (const name of names) Object.defineProperty(proto, name, svgAccessorDescriptor(name, false));
}

function defineSVGMethods(proto, methods) {
  for (const [name, value] of Object.entries(methods)) Object.defineProperty(proto, name, { value, enumerable: true, writable: true, configurable: true });
}


function defineSVGReflectingAccessors(proto, names) {
  for (const name of names) Object.defineProperty(proto, name, svgAccessorDescriptor(name, false));
}
function svgAccessorDescriptor(name, readonly) {
  const descriptor = Object.getOwnPropertyDescriptor({
    get [name]() { return this?.['__zp_' + name] ?? null; },
    set [name](value) { Object.defineProperty(this, '__zp_' + name, { value: typeof value === 'function' ? value : null, writable: true, configurable: true }); },
  }, name);
  if (readonly) descriptor.set = undefined;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

function getCharNumAtPosition() { return -1; }
function getComputedTextLength() { return 0; }
function getEndPositionOfChar(charnum) { void charnum; return null; }
function getExtentOfChar(charnum) { void charnum; return null; }
function getNumberOfChars() { return String(this?.textContent || '').length; }
function getRotationOfChar(charnum) { void charnum; return 0; }
function getStartPositionOfChar(charnum) { void charnum; return null; }
function getSubStringLength(charnum, nchars) { void charnum; void nchars; return 0; }
function selectSubString(charnum, nchars) { void charnum; void nchars; }
function beginElement() {}
function beginElementAt(offset) { void offset; }
function endElement() {}
function endElementAt(offset) { void offset; }
function getCurrentTime() { return 0; }
function getSimpleDuration() { return 0; }
function getStartTime() { return 0; }
