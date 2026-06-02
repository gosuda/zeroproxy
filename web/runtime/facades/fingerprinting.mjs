export function createFingerprintingFacades({ define }) {
  const canvasHookedWindows = new WeakSet();
  const audioHookedWindows = new WeakSet();

  function installCanvasAntiFingerprinting(w) {
    if (!w || canvasHookedWindows.has(w) || !w.CanvasRenderingContext2D || !w.HTMLCanvasElement) return;
    canvasHookedWindows.add(w);
    installCanvasGetImageDataNoise(w.CanvasRenderingContext2D.prototype);
    installCanvasToDataURLNoise(w.HTMLCanvasElement.prototype);
  }
  function installCanvasGetImageDataNoise(ctxProto) {
    const origGetImageData = ctxProto && ctxProto.getImageData;
    if (typeof origGetImageData !== 'function') return;
    define(ctxProto, 'getImageData', function(...args) {
      const imageData = origGetImageData.apply(this, args);
      const data = imageData && imageData.data;
      if (data && data.length > 1) {
        data[0] = data[0] ^ 1;
        data[data.length - 2] = data[data.length - 2] ^ 1;
      }
      return imageData;
    });
  }
  function installCanvasToDataURLNoise(canvasProto) {
    const origToDataURL = canvasProto && canvasProto.toDataURL;
    if (typeof origToDataURL !== 'function') return;
    define(canvasProto, 'toDataURL', function(...args) {
      perturbCanvasForExport(this);
      return origToDataURL.apply(this, args);
    });
  }
  function perturbCanvasForExport(canvas) {
    const width = canvas.width >>> 0;
    const height = canvas.height >>> 0;
    if (!width || !height) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const fillStyle = ctx.fillStyle;
    const globalAlpha = ctx.globalAlpha;
    try {
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',' + ((Math.random() * 256) | 0) + ',0.01)';
      ctx.fillRect((Math.random() * Math.min(width, 8)) | 0, (Math.random() * Math.min(height, 8)) | 0, 1, 1);
    } finally {
      try { ctx.fillStyle = fillStyle; } catch {}
      try { ctx.globalAlpha = globalAlpha; } catch {}
    }
  }

  function installAudioAntiFingerprinting(w) {
    if (!w || audioHookedWindows.has(w) || !w.AudioBuffer) return;
    audioHookedWindows.add(w);
    const proto = w.AudioBuffer.prototype;
    const origGetChannelData = proto && proto.getChannelData;
    if (typeof origGetChannelData !== 'function') return;
    define(proto, 'getChannelData', function(channel) {
      const f32 = origGetChannelData.call(this, channel);
      const limit = Math.min(f32.length, 100);
      for (let i = 0; i < limit; i++) {
        if (f32[i] !== 0) {
          f32[i] += (Math.random() - 0.5) * 1e-7;
          break;
        }
      }
      return f32;
    });
  }

  return {
    installCanvasAntiFingerprinting,
    installAudioAntiFingerprinting,
  };
}
