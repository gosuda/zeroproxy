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
  ['SVGSymbolElement', 'symbol', 'SVGElement'],
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
  Object.defineProperty(ctor, Symbol.hasInstance, { value: (value) => matchesSVGLocalName(value, localNames), configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: interfaceName, configurable: true });
  if (parentCtor?.prototype) {
    Object.setPrototypeOf(ctor.prototype, parentCtor.prototype);
    Object.setPrototypeOf(ctor, parentCtor);
  }
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
