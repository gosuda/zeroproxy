const imageDataState = new WeakMap();
const contextToken = {};
const bitmapToken = {};
const patternToken = {};
const metricsToken = {};

export function createCanvasFacades() {
  class ImageData {
    constructor(dataOrWidth, width, height, settings = undefined) {
      if (arguments.length < 2) throw new TypeError(`Failed to construct 'ImageData': 2 arguments required, but only ${arguments.length} present.`);
      if (isImageDataArray(dataOrWidth)) initImageDataFromData(this, dataOrWidth, width, height, settings);
      else {
        if (arguments.length > 3) throw new TypeError("Failed to construct 'ImageData': Overload resolution failed.");
        initImageDataFromSize(this, dataOrWidth, width, height);
      }
    }
  }
  Object.defineProperty(ImageData, 'length', { value: 2, configurable: true });
  const imageDataConstructorDescriptor = Object.getOwnPropertyDescriptor(ImageData.prototype, 'constructor');
  delete ImageData.prototype.constructor;
  Object.defineProperties(ImageData.prototype, {
    width: { get() { return imageDataValue(this, 'width'); }, enumerable: true, configurable: true },
    height: { get() { return imageDataValue(this, 'height'); }, enumerable: true, configurable: true },
    colorSpace: { get() { return imageDataValue(this, 'colorSpace'); }, enumerable: true, configurable: true },
    data: { get() { return imageDataValue(this, 'data'); }, enumerable: true, configurable: true },
    pixelFormat: { get() { return imageDataValue(this, 'pixelFormat'); }, enumerable: true, configurable: true },
  });
  Object.defineProperty(ImageData.prototype, 'constructor', imageDataConstructorDescriptor);
  Object.defineProperty(ImageData.prototype, Symbol.toStringTag, { value: 'ImageData', configurable: true });

  class CanvasGradient {
    constructor(token) {
      if (token !== patternToken) throw new TypeError("Failed to construct 'CanvasGradient': Illegal constructor");
      defineHidden(this, '__zpStops', []);
    }
    addColorStop(offset, color) {
      const position = Number(offset);
      if (!Number.isFinite(position) || position < 0 || position > 1) throw new DOMException('The provided value is outside the range (0.0, 1.0).', 'IndexSizeError');
      this.__zpStops.push([position, String(color)]);
    }
  }
  Object.defineProperty(CanvasGradient.prototype, Symbol.toStringTag, { value: 'CanvasGradient', configurable: true });

  class CanvasPattern {
    constructor(token) {
      if (token !== patternToken) throw new TypeError("Failed to construct 'CanvasPattern': Illegal constructor");
    }
    setTransform() {}
  }
  Object.defineProperty(CanvasPattern.prototype, Symbol.toStringTag, { value: 'CanvasPattern', configurable: true });

  class TextMetrics {
    constructor(token, width = 0) {
      if (token !== metricsToken) throw new TypeError("Failed to construct 'TextMetrics': Illegal constructor");
      defineHidden(this, '__zpWidth', Number(width) || 0);
    }
    get width() { return this.__zpWidth; }
    get actualBoundingBoxLeft() { return 0; }
    get actualBoundingBoxRight() { return this.__zpWidth; }
    get fontBoundingBoxAscent() { return 0; }
    get fontBoundingBoxDescent() { return 0; }
    get actualBoundingBoxAscent() { return 0; }
    get actualBoundingBoxDescent() { return 0; }
    get emHeightAscent() { return 0; }
    get emHeightDescent() { return 0; }
    get hangingBaseline() { return 0; }
    get alphabeticBaseline() { return 0; }
    get ideographicBaseline() { return 0; }
  }
  Object.defineProperty(TextMetrics.prototype, Symbol.toStringTag, { value: 'TextMetrics', configurable: true });

  class CanvasRenderingContext2D {
    constructor(token, canvas = null) {
      if (token !== contextToken) throw new TypeError("Failed to construct 'CanvasRenderingContext2D': Illegal constructor");
      initCanvasContext(this, canvas);
    }
    get canvas() { return this.__zpCanvas; }
    save() {}
    restore() {}
    scale() {}
    rotate() {}
    translate() {}
    transform() {}
    setTransform() {}
    resetTransform() {}
    clearRect() {}
    fillRect() {}
    strokeRect() {}
    beginPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    rect() {}
    arc() {}
    fill() {}
    stroke() {}
    clip() {}
    drawImage() {}
    fillText() {}
    strokeText() {}
    measureText(text) { return new TextMetrics(metricsToken, String(text).length * 10); }
    createImageData(width, height) { return new ImageData(width, height); }
    getImageData(_sx, _sy, sw, sh) { return new ImageData(sw, sh); }
    putImageData() {}
    createLinearGradient() { return new CanvasGradient(patternToken); }
    createRadialGradient() { return new CanvasGradient(patternToken); }
    createConicGradient() { return new CanvasGradient(patternToken); }
    createPattern() { return new CanvasPattern(patternToken); }
  }
  Object.defineProperty(CanvasRenderingContext2D.prototype, Symbol.toStringTag, { value: 'CanvasRenderingContext2D', configurable: true });

  class OffscreenCanvasRenderingContext2D extends CanvasRenderingContext2D {
    constructor(token, canvas = null) {
      if (token !== contextToken) throw new TypeError("Failed to construct 'OffscreenCanvasRenderingContext2D': Illegal constructor");
      super(contextToken, canvas);
    }
  }
  Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, Symbol.toStringTag, { value: 'OffscreenCanvasRenderingContext2D', configurable: true });

  class ImageBitmap {
    constructor(token, width = 0, height = 0) {
      if (token !== bitmapToken) throw new TypeError("Failed to construct 'ImageBitmap': Illegal constructor");
      defineHidden(this, '__zpWidth', normalizeDimension(width, 0));
      defineHidden(this, '__zpHeight', normalizeDimension(height, 0));
      defineHidden(this, '__zpClosed', false);
    }
    get width() { return this.__zpClosed ? 0 : this.__zpWidth; }
    get height() { return this.__zpClosed ? 0 : this.__zpHeight; }
    close() { defineHidden(this, '__zpClosed', true); }
  }
  Object.defineProperty(ImageBitmap.prototype, Symbol.toStringTag, { value: 'ImageBitmap', configurable: true });

  function createImageBitmap(source, sx = undefined, sy = undefined, sw = undefined, sh = undefined, options = {}) {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'createImageBitmap' on 'Window': 1 argument required, but only 0 present.");
    const dimensions = imageBitmapDimensions(source, arguments.length >= 5 ? { width: sw, height: sh, ...options } : sx);
    return Promise.resolve(new ImageBitmap(bitmapToken, dimensions.width, dimensions.height));
  }

  class ImageBitmapRenderingContext {
    constructor(token, canvas = null) {
      if (token !== contextToken) throw new TypeError("Failed to construct 'ImageBitmapRenderingContext': Illegal constructor");
      defineHidden(this, '__zpCanvas', canvas);
    }
    get canvas() { return this.__zpCanvas; }
    transferFromImageBitmap(imageBitmap) { void imageBitmap; }
  }
  Object.defineProperty(ImageBitmapRenderingContext.prototype, Symbol.toStringTag, { value: 'ImageBitmapRenderingContext', configurable: true });

  class OffscreenCanvas {
    constructor(width, height) {
      defineHidden(this, '__zpWidth', normalizeDimension(width, 0));
      defineHidden(this, '__zpHeight', normalizeDimension(height, 0));
      defineHidden(this, '__zpContexts', new Map());
    }
    get width() { return this.__zpWidth; }
    set width(value) { defineHidden(this, '__zpWidth', normalizeDimension(value, 0)); }
    get height() { return this.__zpHeight; }
    set height(value) { defineHidden(this, '__zpHeight', normalizeDimension(value, 0)); }
    getContext(type) { return canvasContextFor(this, type, true); }
    transferToImageBitmap() { return new ImageBitmap(bitmapToken, this.width, this.height); }
    convertToBlob(options = {}) { return Promise.resolve(new Blob([], { type: String(options.type || 'image/png') })); }
  }
  Object.defineProperty(OffscreenCanvas.prototype, Symbol.toStringTag, { value: 'OffscreenCanvas', configurable: true });

  class Path2D {
    constructor() { defineHidden(this, '__zpCommands', []); }
    addPath(path, transform = undefined) { void path; void transform; }
    closePath() {}
    moveTo(x, y) { void x; void y; }
    lineTo(x, y) { void x; void y; }
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) { void cp1x; void cp1y; void cp2x; void cp2y; void x; void y; }
    quadraticCurveTo(cpx, cpy, x, y) { void cpx; void cpy; void x; void y; }
    arc(x, y, radius, startAngle, endAngle, counterclockwise = false) { void x; void y; void radius; void startAngle; void endAngle; void counterclockwise; }
    arcTo(x1, y1, x2, y2, radius) { void x1; void y1; void x2; void y2; void radius; }
    ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise = false) { void x; void y; void radiusX; void radiusY; void rotation; void startAngle; void endAngle; void counterclockwise; }
    rect(x, y, width, height) { void x; void y; void width; void height; }
    roundRect(x, y, width, height, radii = undefined) { void x; void y; void width; void height; void radii; }
  }
  Object.defineProperty(Path2D.prototype, Symbol.toStringTag, { value: 'Path2D', configurable: true });

  return {
    CanvasGradient,
    CanvasPattern,
    CanvasRenderingContext2D,
    createImageBitmap,
    ImageBitmap,
    ImageBitmapRenderingContext,
    ImageData,
    OffscreenCanvas,
    OffscreenCanvasRenderingContext2D,
    Path2D,
    TextMetrics,
    installCanvasElementReflections(proto) {
      installCanvasElementReflections(proto, ImageBitmap, CanvasRenderingContext2D, ImageBitmapRenderingContext, OffscreenCanvas);
    },
  };
}

function initCanvasContext(context, canvas) {
  defineHidden(context, '__zpCanvas', canvas);
  context.fillStyle = '#000000';
  context.strokeStyle = '#000000';
  context.globalAlpha = 1;
  context.lineWidth = 1;
  context.font = '10px sans-serif';
  context.textAlign = 'start';
  context.textBaseline = 'alphabetic';
}

function installCanvasElementReflections(proto, ImageBitmap, CanvasRenderingContext2D, ImageBitmapRenderingContext, OffscreenCanvas) {
  defineCanvasProperty(proto, 'width', 300);
  defineCanvasProperty(proto, 'height', 150);
  if (!proto.getContext) proto.getContext = function getContext(type) { return isCanvasElement(this) ? canvasContextFor(this, type, false, CanvasRenderingContext2D, ImageBitmapRenderingContext) : null; };
  if (!proto.toDataURL) proto.toDataURL = function toDataURL(type = 'image/png') { return isCanvasElement(this) ? 'data:' + String(type || 'image/png') + ';base64,' : ''; };
  if (!proto.toBlob) proto.toBlob = function toBlob(callback, type = 'image/png') { if (typeof callback === 'function') Promise.resolve().then(() => callback(new Blob([], { type: String(type || 'image/png') }))); };
  if (!proto.captureStream) proto.captureStream = function captureStream() { return new MediaStream(); };
  if (!proto.transferControlToOffscreen) proto.transferControlToOffscreen = function transferControlToOffscreen() { return new OffscreenCanvas(canvasDimension(this, 'width', 300), canvasDimension(this, 'height', 150)); };
}

function canvasContextFor(canvas, type, offscreen, CanvasRenderingContext2D = globalThis.CanvasRenderingContext2D, ImageBitmapRenderingContext = globalThis.ImageBitmapRenderingContext) {
  const contextType = String(type || '').toLowerCase();
  if (contextType !== '2d' && contextType !== 'bitmaprenderer') return null;
  const contexts = canvas.__zpContexts || new Map();
  if (!canvas.__zpContexts) defineHidden(canvas, '__zpContexts', contexts);
  if (contexts.has(contextType)) return contexts.get(contextType);
  const context = contextType === 'bitmaprenderer' ? new ImageBitmapRenderingContext(contextToken, canvas) : new (offscreen ? globalThis.OffscreenCanvasRenderingContext2D : CanvasRenderingContext2D)(contextToken, canvas);
  contexts.set(contextType, context);
  return context;
}

function defineCanvasProperty(proto, name, fallback) {
  if (Object.getOwnPropertyDescriptor(proto, name)) return;
  Object.defineProperty(proto, name, {
    get() { return isCanvasElement(this) ? canvasDimension(this, name, fallback) : undefined; },
    set(value) { if (isCanvasElement(this)) this.setAttribute?.(name, String(normalizeDimension(value, fallback))); },
    configurable: true,
  });
}

function canvasDimension(element, name, fallback) {
  return normalizeDimension(element.getAttribute?.(name), fallback);
}

function initImageDataFromData(target, data, width, height, settings) {
  const options = imageDataSettings(settings);
  const actualWidth = normalizeDimension(width, 0);
  const actualHeight = height === undefined ? data.length / 4 / actualWidth : normalizeDimension(height, 0);
  if (data.length % 4 !== 0) throw new DOMException("Failed to construct 'ImageData': The input data length is not a multiple of 4.", 'InvalidStateError');
  if (!Number.isInteger(actualHeight) || actualWidth <= 0 || actualHeight <= 0 || data.length !== actualWidth * actualHeight * 4) throw new DOMException('The source width and height do not match the ImageData data length.', 'IndexSizeError');
  const pixelFormat = imageDataPixelFormat(options);
  validateImageDataArrayPixelFormat(data, pixelFormat);
  initImageDataState(target, data, actualWidth, actualHeight, options.colorSpace, pixelFormat);
}

function initImageDataFromSize(target, width, height, settings) {
  const options = imageDataSettings(settings);
  const actualWidth = normalizeDimension(width, 0);
  const actualHeight = normalizeDimension(height, 0);
  if (actualWidth <= 0 || actualHeight <= 0) throw new DOMException('The source width is zero or not a number.', 'IndexSizeError');
  const pixelFormat = imageDataPixelFormat(options);
  const DataCtor = pixelFormat === 'rgba-float16' ? Float16Array : Uint8ClampedArray;
  initImageDataState(target, new DataCtor(actualWidth * actualHeight * 4), actualWidth, actualHeight, options.colorSpace, pixelFormat);
}

function initImageDataState(target, data, width, height, colorSpace, pixelFormat) {
  imageDataState.set(target, { data, width, height, colorSpace, pixelFormat });
  Object.defineProperty(target, 'data', { value: data, enumerable: true, configurable: true });
}

function imageDataValue(target, key) {
  const state = imageDataState.get(target);
  if (!state) throw new TypeError('Illegal invocation');
  return state[key];
}

function imageDataSettings(settings) {
  if (settings === undefined || settings === null) return { colorSpace: 'srgb', pixelFormat: 'rgba-unorm8' };
  if (typeof settings !== 'object' && typeof settings !== 'function') throw new TypeError("Failed to construct 'ImageData': The provided value is not of type 'ImageDataSettings'.");
  const colorSpace = settings.colorSpace === undefined ? 'srgb' : String(settings.colorSpace);
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw new TypeError(`Failed to construct 'ImageData': Failed to read the 'colorSpace' property from 'ImageDataSettings': The provided value '${colorSpace}' is not a valid enum value of type PredefinedColorSpace.`);
  const pixelFormat = settings.pixelFormat === undefined ? 'rgba-unorm8' : String(settings.pixelFormat);
  if (pixelFormat !== 'rgba-unorm8' && pixelFormat !== 'rgba-float16') throw new TypeError(`Failed to construct 'ImageData': Failed to read the 'pixelFormat' property from 'ImageDataSettings': The provided value '${pixelFormat}' is not a valid enum value of type ImageDataPixelFormat.`);
  return { colorSpace, pixelFormat };
}

function imageDataPixelFormat(settings) {
  return settings.pixelFormat || 'rgba-unorm8';
}

function isImageDataArray(value) {
  return value instanceof Uint8ClampedArray || (typeof Float16Array === 'function' && value instanceof Float16Array);
}

function validateImageDataArrayPixelFormat(data, pixelFormat) {
  if (data instanceof Uint8ClampedArray && pixelFormat !== 'rgba-unorm8') throw new DOMException("Failed to construct 'ImageData': Uint8ClampedArray must use rgba-unorm8 pixelFormat.", 'InvalidStateError');
  if (typeof Float16Array === 'function' && data instanceof Float16Array && pixelFormat !== 'rgba-float16') throw new DOMException("Failed to construct 'ImageData': Float16Array must use rgba-float16 pixelFormat.", 'InvalidStateError');
}

function imageBitmapDimensions(source, options = {}) {
  const optionWidth = options && typeof options === 'object' ? options.resizeWidth ?? options.width : undefined;
  const optionHeight = options && typeof options === 'object' ? options.resizeHeight ?? options.height : undefined;
  return {
    width: normalizeDimension(optionWidth ?? source?.width ?? source?.videoWidth ?? source?.naturalWidth, 0),
    height: normalizeDimension(optionHeight ?? source?.height ?? source?.videoHeight ?? source?.naturalHeight, 0),
  };
}

function normalizeDimension(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function isCanvasElement(value) {
  return value?.nodeType === 1 && value.localName === 'canvas';
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
