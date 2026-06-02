export function createFrameAccessors({
  networkContainmentMarker,
  isDirectExternalFrameElement,
  installNetworkContainment,
  frameWindowFacadeFor,
  frameDocumentFacadeFor,
}) {
  const instrumentedWindows = new WeakSet();

  function frameDescriptor(proto, prop) {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, prop);
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
      const childWin = nativeGet.call(this);
      if (isDirectExternalFrameElement(this)) return childWin;
      const contained = containFrameWindow(childWin, this);
      return frameWindowFacadeFor ? frameWindowFacadeFor(this, contained) : contained;
    };
  }

  function contentDocumentGetter(nativeGet) {
    return function contentDocument() {
      const childDoc = nativeGet.call(this);
      if (!childDoc || isDirectExternalFrameElement(this)) return childDoc;
      const childWin = childDoc.defaultView ? containFrameWindow(childDoc.defaultView, this) : null;
      if (frameDocumentFacadeFor) return frameDocumentFacadeFor(this, childDoc, childWin);
      return childDoc;
    };
  }

  function installFrameAccessors(proto) {
    if (!proto) return;
    const win = frameDescriptor(proto, 'contentWindow');
    if (win && win.get) {
      try {
        Object.defineProperty(proto, 'contentWindow', {
          get: contentWindowGetter(win.get),
          configurable: false,
          enumerable: true,
        });
      } catch {}
    }
    const doc = frameDescriptor(proto, 'contentDocument');
    if (doc && doc.get) {
      try {
        Object.defineProperty(proto, 'contentDocument', {
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
