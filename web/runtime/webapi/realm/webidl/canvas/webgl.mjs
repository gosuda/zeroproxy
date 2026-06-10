const webGLInfoToken = {};

const objectNames = [
  'WebGLBuffer',
  'WebGLFramebuffer',
  'WebGLProgram',
  'WebGLRenderbuffer',
  'WebGLShader',
  'WebGLTexture',
  'WebGLUniformLocation',
  'WebGLVertexArrayObject',
  'WebGLSampler',
  'WebGLQuery',
  'WebGLSync',
  'WebGLTransformFeedback',
];

const contextConstants = {
  DEPTH_BUFFER_BIT: 0x00000100,
  STENCIL_BUFFER_BIT: 0x00000400,
  COLOR_BUFFER_BIT: 0x00004000,
  POINTS: 0x0000,
  LINES: 0x0001,
  TRIANGLES: 0x0004,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  NO_ERROR: 0,
  INVALID_ENUM: 0x0500,
  INVALID_VALUE: 0x0501,
  INVALID_OPERATION: 0x0502,
  OUT_OF_MEMORY: 0x0505,
  CONTEXT_LOST_WEBGL: 0x9242,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
};

const context2Constants = {
  READ_BUFFER: 0x0c02,
  RED: 0x1903,
  RGB8: 0x8051,
  RGBA8: 0x8058,
  TEXTURE_3D: 0x806f,
  TEXTURE_2D_ARRAY: 0x8c1a,
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER: 0x8ca8,
  TRANSFORM_FEEDBACK: 0x8e22,
  UNIFORM_BUFFER: 0x8a11,
  HALF_FLOAT: 0x140b,
  INVALID_INDEX: 0xffffffff,
  TIMEOUT_IGNORED: -1,
};

export function createWebGLFacades(EventBase) {
  class WebGLRenderingContext {
    constructor() { throw new TypeError("Failed to construct 'WebGLRenderingContext': Illegal constructor"); }
    get canvas() { return null; }
    get drawingBufferWidth() { return 0; }
    get drawingBufferHeight() { return 0; }
    get drawingBufferColorSpace() { return 'srgb'; }
    set drawingBufferColorSpace(_value) {}
    get unpackColorSpace() { return 'srgb'; }
    set unpackColorSpace(_value) {}
    getContextAttributes() { return null; }
    getSupportedExtensions() { return []; }
    getExtension() { return null; }
    getError() { return 0; }
    isContextLost() { return true; }
    getParameter() { return null; }
    getShaderPrecisionFormat() { return new WebGLShaderPrecisionFormat(webGLInfoToken); }
    getProgramInfoLog() { return ''; }
    getShaderInfoLog() { return ''; }
    getShaderSource() { return ''; }
    getAttachedShaders() { return []; }
    getActiveAttrib() { return null; }
    getActiveUniform() { return null; }
    getUniformLocation() { return null; }
    getAttribLocation() { return -1; }
    createBuffer() { return null; }
    createFramebuffer() { return null; }
    createProgram() { return null; }
    createRenderbuffer() { return null; }
    createShader() { return null; }
    createTexture() { return null; }
  }
  installContextSurface(WebGLRenderingContext, contextConstants);
  Object.defineProperty(WebGLRenderingContext.prototype, Symbol.toStringTag, { value: 'WebGLRenderingContext', configurable: true });

  class WebGL2RenderingContext extends WebGLRenderingContext {
    constructor() { throw new TypeError("Failed to construct 'WebGL2RenderingContext': Illegal constructor"); }
    createQuery() { return null; }
    createSampler() { return null; }
    createTransformFeedback() { return null; }
    createVertexArray() { return null; }
    fenceSync() { return null; }
    clientWaitSync() { return this.WAIT_FAILED; }
    getQuery() { return null; }
    getQueryParameter() { return null; }
    getSamplerParameter() { return null; }
    getSyncParameter() { return null; }
  }
  installContextSurface(WebGL2RenderingContext, { ...contextConstants, ...context2Constants });
  Object.defineProperty(WebGL2RenderingContext.prototype, Symbol.toStringTag, { value: 'WebGL2RenderingContext', configurable: true });

  class WebGLActiveInfo {
    constructor(token, init = {}) {
      if (token !== webGLInfoToken) throw new TypeError("Failed to construct 'WebGLActiveInfo': Illegal constructor");
      defineHidden(this, '__zpSize', Number(init.size ?? 0) || 0);
      defineHidden(this, '__zpType', Number(init.type ?? 0) || 0);
      defineHidden(this, '__zpName', String(init.name ?? ''));
    }
    get size() { return this.__zpSize; }
    get type() { return this.__zpType; }
    get name() { return this.__zpName; }
  }
  Object.defineProperty(WebGLActiveInfo.prototype, Symbol.toStringTag, { value: 'WebGLActiveInfo', configurable: true });

  class WebGLShaderPrecisionFormat {
    constructor(token, init = {}) {
      if (token !== webGLInfoToken) throw new TypeError("Failed to construct 'WebGLShaderPrecisionFormat': Illegal constructor");
      defineHidden(this, '__zpRangeMin', Number(init.rangeMin ?? 0) || 0);
      defineHidden(this, '__zpRangeMax', Number(init.rangeMax ?? 0) || 0);
      defineHidden(this, '__zpPrecision', Number(init.precision ?? 0) || 0);
    }
    get rangeMin() { return this.__zpRangeMin; }
    get rangeMax() { return this.__zpRangeMax; }
    get precision() { return this.__zpPrecision; }
  }
  Object.defineProperty(WebGLShaderPrecisionFormat.prototype, Symbol.toStringTag, { value: 'WebGLShaderPrecisionFormat', configurable: true });

  const webGLContextEventState = new WeakMap();
  function WebGLContextEvent(type, init = {}) {
    if (!new.target) throw new TypeError("Failed to construct 'WebGLContextEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 1) throw new TypeError("Failed to construct 'WebGLContextEvent': 1 argument required, but only 0 present.");
    const eventType = webGLContextEventType(type);
    const eventInit = init === null || init === undefined ? {} : Object(init);
    const event = Reflect.construct(EventBase, [eventType, eventInit], new.target);
    webGLContextEventState.set(event, { statusMessage: webGLContextEventStatusMessage(eventInit) });
    return event;
  }
  Object.setPrototypeOf(WebGLContextEvent, EventBase);
  WebGLContextEvent.prototype = Object.create(EventBase.prototype);
  Object.defineProperties(WebGLContextEvent.prototype, {
    statusMessage: { get() { return webGLContextEventValue(this).statusMessage; }, enumerable: true, configurable: true },
    constructor: { value: WebGLContextEvent, writable: true, configurable: true },
  });
  Object.defineProperty(WebGLContextEvent.prototype, Symbol.toStringTag, { value: 'WebGLContextEvent', configurable: true });
  Object.defineProperty(WebGLContextEvent, 'prototype', { writable: false });

  function webGLContextEventValue(event) {
    const state = webGLContextEventState.get(event);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  const facades = { WebGLRenderingContext, WebGL2RenderingContext, WebGLActiveInfo, WebGLShaderPrecisionFormat, WebGLContextEvent };
  for (const name of objectNames) facades[name] = makeIllegalWebGLObject(name);
  return facades;
}


function webGLContextEventType(value) {
  if (typeof value === 'symbol') throw new TypeError("Failed to construct 'WebGLContextEvent': Cannot convert a Symbol value to a string");
  return String(value);
}

function webGLContextEventStatusMessage(init) {
  const value = init.statusMessage;
  if (value === undefined) return '';
  if (typeof value === 'symbol') throw new TypeError("Failed to construct 'WebGLContextEvent': Failed to read the 'statusMessage' property from 'WebGLContextEventInit': Cannot convert a Symbol value to a string");
  return String(value);
}

function installContextSurface(Constructor, constants) {
  for (const [name, value] of Object.entries(constants)) {
    Object.defineProperty(Constructor, name, { value, enumerable: true, configurable: true });
    Object.defineProperty(Constructor.prototype, name, { value, enumerable: true, configurable: true });
  }
  for (const method of contextNoopMethods) {
    if (!Constructor.prototype[method]) Constructor.prototype[method] = function noop() {};
  }
  for (const method of contextFalseMethods) {
    if (!Constructor.prototype[method]) Constructor.prototype[method] = function returnsFalse() { return false; };
  }
}

function makeIllegalWebGLObject(name) {
  const ctor = function WebGLObjectConstructor() { throw new TypeError("Failed to construct '" + name + "': Illegal constructor"); };
  Object.defineProperty(ctor, 'name', { value: name, configurable: true });
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, { value: name, configurable: true });
  return ctor;
}

const contextNoopMethods = [
  'activeTexture', 'attachShader', 'bindAttribLocation', 'bindBuffer', 'bindFramebuffer', 'bindRenderbuffer', 'bindTexture', 'blendColor', 'blendEquation', 'blendEquationSeparate', 'blendFunc', 'blendFuncSeparate', 'bufferData', 'bufferSubData', 'clear', 'clearColor', 'clearDepth', 'clearStencil', 'colorMask', 'compileShader', 'copyTexImage2D', 'copyTexSubImage2D', 'cullFace', 'deleteBuffer', 'deleteFramebuffer', 'deleteProgram', 'deleteRenderbuffer', 'deleteShader', 'deleteTexture', 'depthFunc', 'depthMask', 'depthRange', 'detachShader', 'disable', 'disableVertexAttribArray', 'drawArrays', 'drawElements', 'enable', 'enableVertexAttribArray', 'finish', 'flush', 'framebufferRenderbuffer', 'framebufferTexture2D', 'frontFace', 'generateMipmap', 'hint', 'lineWidth', 'linkProgram', 'pixelStorei', 'polygonOffset', 'readPixels', 'renderbufferStorage', 'sampleCoverage', 'scissor', 'shaderSource', 'stencilFunc', 'stencilFuncSeparate', 'stencilMask', 'stencilMaskSeparate', 'stencilOp', 'stencilOpSeparate', 'texImage2D', 'texParameterf', 'texParameteri', 'texSubImage2D', 'uniform1f', 'uniform1i', 'useProgram', 'validateProgram', 'vertexAttribPointer', 'viewport'
];

const contextFalseMethods = [
  'isBuffer', 'isEnabled', 'isFramebuffer', 'isProgram', 'isRenderbuffer', 'isShader', 'isTexture'
];

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
