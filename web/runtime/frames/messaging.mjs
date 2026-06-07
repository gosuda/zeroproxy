export function createFrameMessaging({
  Native,
  document,
  proxyOrigin,
  urlMeta,
  frameWindowOrigins,
  directExternalFrameWindowOrigins,
  postMessageWrappers,
  membraneRawTargets,
  frameTargetOriginMarker,
  maskNativeFunction,
  isDirectExternalFrameElement,
  messageSourceFacadeFor,
}) {
  const {
    MessageEvent = globalThis.MessageEvent,
    Object = globalThis.Object,
    String = globalThis.String,
    URL = globalThis.URL,
    objectCreate = globalThis.Object.create,
    objectDefineProperty = globalThis.Object.defineProperty,
    reflectApply = globalThis.Reflect.apply,
    reflectGet = globalThis.Reflect.get,
  } = Native;

  function frameTargetURL(frame, includeVisibleSrc = false) {
    try {
      return urlMeta.get(frame) ||
        Native.getAttribute.call(frame, 'data-zp-target-url') ||
        (includeVisibleSrc ? Native.getAttribute.call(frame, 'src') : '') ||
        '';
    } catch {
      return '';
    }
  }

  function httpOrigin(raw) {
    try {
      const u = new URL(String(raw));
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {}
    return '';
  }

  function isWildcardMessageOrigin(value) {
    return value === '*' || value === '/';
  }

  function targetURLOrigin(frame, includeVisibleSrc) {
    try {
      const target = frameTargetURL(frame, includeVisibleSrc);
      return target ? new URL(target).origin : '';
    } catch {
      return '';
    }
  }

  function frameOwnsSource(frame, source) {
    try {
      const child = frame.contentWindow;
      if (child === source) return true;
      return rawPostMessageTarget(child) === rawPostMessageTarget(source);
    } catch {
      return false;
    }
  }

  function documentFrames() {
    if (!document || !document.querySelectorAll) return null;
    try {
      return document.querySelectorAll('iframe,frame');
    } catch {
      return null;
    }
  }

  function frameAllowedForSource(frame, source, directOnly) {
    if (!frameOwnsSource(frame, source)) return false;
    return !directOnly || isDirectExternalFrameElement(frame);
  }

  function frameOriginForSourceByPolicy(source, directOnly, includeVisibleSrc) {
    if (!source) return '';
    const frames = documentFrames();
    if (!frames) return '';
    for (const frame of frames) {
      if (!frameAllowedForSource(frame, source, directOnly)) continue;
      const origin = targetURLOrigin(frame, includeVisibleSrc);
      if (origin) return origin;
    }
    return '';
  }

  function rawPostMessageTarget(target) {
    try {
      if (target && (typeof target === 'object' || typeof target === 'function')) {
        const raw = Native.weakMapGet ? reflectApply(Native.weakMapGet, membraneRawTargets, [target]) : membraneRawTargets.get(target);
        return raw || target;
      }
    } catch {}
    return target;
  }

  function normalizePostMessageTargetOrigin(targetOrigin) {
    if (targetOrigin == null) return targetOrigin;
    const s = String(targetOrigin);
    if (isWildcardMessageOrigin(s)) return s;
    if (httpOrigin(s)) return proxyOrigin;
    return s;
  }

  function normalizePostMessageTargetOriginForTarget(target, targetOrigin) {
    if (targetOrigin == null) return targetOrigin;
    const s = String(targetOrigin);
    if (isWildcardMessageOrigin(s)) return s;
    const requestedOrigin = httpOrigin(s);
    const directOrigin = directExternalFrameOriginForSource(target);
    if (directOrigin && requestedOrigin === directOrigin) return directOrigin;
    const frameOrigin = frameOriginForTargetWindow(target);
    if (frameOrigin && requestedOrigin === frameOrigin) return proxyOrigin;
    return normalizePostMessageTargetOrigin(s);
  }

  function frameOriginForTargetWindow(target) {
    try {
      return frameOriginForSource(target) || frameWindowOrigins.get(target) || '';
    } catch {
      return '';
    }
  }

  function postMessageWrapperFor(target) {
    target = rawPostMessageTarget(target);
    if (!target) return undefined;
    if (postMessageWrappers.has(target)) return postMessageWrappers.get(target);
    const nativePostMessage = reflectGet(Object(target), 'postMessage');
    if (typeof nativePostMessage !== 'function') return undefined;
    const wrapped = function postMessage(message, targetOrigin, transfer) {
      if (arguments.length < 2) return reflectApply(nativePostMessage, target, [message, proxyOrigin]);
      const mapped = normalizePostMessageTargetOriginForTarget(target, targetOrigin);
      return arguments.length > 2 ? reflectApply(nativePostMessage, target, [message, mapped, transfer]) : reflectApply(nativePostMessage, target, [message, mapped]);
    };
    maskNativeFunction(wrapped, 'postMessage');
    postMessageWrappers.set(target, wrapped);
    return wrapped;
  }

  function virtualOriginForMessage(ev) {
    if (!ev || !ev.source) return '';
    const directOrigin = directExternalFrameOriginForSource(ev.source);
    if (directOrigin && ev.origin === directOrigin) return '';
    if (ev.origin !== proxyOrigin) return '';
    try {
      const origin = frameOriginForSource(ev.source) || frameWindowOrigins.get(ev.source) || ev.source[frameTargetOriginMarker];
      return origin || '';
    } catch {
      return '';
    }
  }

  function frameOriginForSource(source) {
    return frameOriginForSourceByPolicy(source, false, false);
  }

  function directExternalFrameOriginForSource(source) {
    try {
      const directOrigin = directExternalFrameWindowOrigins.get(source);
      if (directOrigin) return directOrigin;
    } catch {}
    return frameOriginForSourceByPolicy(source, true, true);
  }

  function virtualizeMessageEvent(ev) {
    if (!ev) return ev;
    const origin = virtualOriginForMessage(ev);
    const source = virtualSourceForMessage(ev);
    if (!origin && source !== ev.source) return cloneMessageEvent(ev, ev.origin, source);
    if (!origin) return ev;
    if (source !== ev.source) return cloneMessageEvent(ev, origin, source);
    return syntheticMessageEvent(ev, origin, source);
  }

  function virtualSourceForMessage(ev) {
    return messageSourceFacadeFor ? messageSourceFacadeFor(ev.source, ev) || ev.source : ev.source;
  }

  function syntheticMessageEvent(ev, origin, source) {
    try {
      return new MessageEvent(ev.type, { data: ev.data, origin, lastEventId: ev.lastEventId || '', source, ports: ev.ports || [] });
    } catch {
      return defineMessageOriginSource(ev, origin, source);
    }
  }

  function defineMessageOriginSource(ev, origin, source) {
    try {
      objectDefineProperty(ev, 'origin', { value: origin, enumerable: true, configurable: true });
      objectDefineProperty(ev, 'source', { value: source, enumerable: true, configurable: true });
      return ev;
    } catch {}
    return cloneMessageEvent(ev, origin, source);
  }

  function cloneMessageEvent(ev, origin, source) {
    try {
      const clone = objectCreate(ev);
      objectDefineProperty(clone, 'type', { value: ev.type, configurable: true });
      objectDefineProperty(clone, 'data', { value: ev.data, configurable: true });
      objectDefineProperty(clone, 'origin', { value: origin, configurable: true });
      objectDefineProperty(clone, 'lastEventId', { value: ev.lastEventId || '', configurable: true });
      objectDefineProperty(clone, 'source', { value: source, configurable: true });
      objectDefineProperty(clone, 'ports', { value: ev.ports || [], configurable: true });
      return clone;
    } catch {
      return ev;
    }
  }

  function rememberFrameOrigin(frame) {
    if (!frame) return;
    const target = frameTargetURL(frame);
    if (!target) return;
    try {
      const child = frame.contentWindow;
      if (child) {
        const origin = new URL(target).origin;
        frameWindowOrigins.set(child, origin);
        const rawChild = rawPostMessageTarget(child);
        if (rawChild && rawChild !== child) frameWindowOrigins.set(rawChild, origin);
        if (isDirectExternalFrameElement(frame)) directExternalFrameWindowOrigins.set(child, origin);
      }
    } catch {}
  }

  return {
    postMessageWrapperFor,
    virtualizeMessageEvent,
    rememberFrameOrigin,
  };
}
