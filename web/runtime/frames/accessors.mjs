export function createFrameAccessors({
  Native,
  networkContainmentMarker,
  isDirectExternalFrameElement,
  shouldContainFrameWindow,
  installNetworkContainment,
  frameWindowFacadeFor,
  frameDocumentFacadeFor,
}) {
  const {
    WeakSet = globalThis.WeakSet,
    objectDefineProperty = globalThis.Object.defineProperty,
    objectGetOwnPropertyDescriptor = globalThis.Object.getOwnPropertyDescriptor,
    objectGetPrototypeOf = globalThis.Object.getPrototypeOf,
    reflectApply = globalThis.Reflect.apply,
  } = Native;
  const instrumentedWindows = new WeakSet();

  function frameDescriptor(proto, prop) {
    for (let p = proto; p; p = objectGetPrototypeOf(p)) {
      const d = objectGetOwnPropertyDescriptor(p, prop);
      if (d) return d;
    }
    return null;
  }

  function alreadyContained(childWin) {
    try {
      return !!childWin[networkContainmentMarker];
    } catch {
      return instrumentedWindows.has(childWin);
    }
  }

  function removeFrame(frame) {
    try {
      if (frame && frame.remove) frame.remove();
    } catch {}
  }

  function containFrameWindow(childWin, frame) {
    if (!childWin) return childWin;
    if (alreadyContained(childWin)) return childWin;
    instrumentedWindows.add(childWin);
    try {
      installNetworkContainment(childWin);
    } catch (e) {
      instrumentedWindows.delete(childWin);
      removeFrame(frame);
      throw e;
    }
    return childWin;
  }

  function contentWindowGetter(nativeGet) {
    return function contentWindow() {
      const childWin = reflectApply(nativeGet, this, []);
      if (isDirectExternalFrameElement(this)) return childWin;
      const exposed = shouldContainFrameWindow && shouldContainFrameWindow(this, childWin)
        ? containFrameWindow(childWin, this)
        : childWin;
      return frameWindowFacadeFor ? frameWindowFacadeFor(this, exposed) : exposed;
    };
  }

  function contentDocumentGetter(nativeGet) {
    return function contentDocument() {
      const childDoc = reflectApply(nativeGet, this, []);
      if (!childDoc || isDirectExternalFrameElement(this)) return childDoc;
      const rawWin = childDoc.defaultView || null;
      const childWin = rawWin && shouldContainFrameWindow && shouldContainFrameWindow(this, rawWin)
        ? containFrameWindow(rawWin, this)
        : rawWin;
      if (frameDocumentFacadeFor) return frameDocumentFacadeFor(this, childDoc, childWin);
      return childDoc;
    };
  }

  function installFrameAccessors(proto) {
    if (!proto) return;
    const win = frameDescriptor(proto, 'contentWindow');
    if (win && win.get) {
      try {
        objectDefineProperty(proto, 'contentWindow', {
          get: contentWindowGetter(win.get),
          configurable: false,
          enumerable: true,
        });
      } catch {}
    }
    const doc = frameDescriptor(proto, 'contentDocument');
    if (doc && doc.get) {
      try {
        objectDefineProperty(proto, 'contentDocument', {
          get: contentDocumentGetter(doc.get),
          configurable: false,
          enumerable: true,
        });
      } catch {}
    }
  }

  return {
    containFrameWindow,
    installFrameAccessors,
  };
}
