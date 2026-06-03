import { frameSandboxAllowsEscape, isFrameElement } from './policy.mjs';

export function createFrameSandbox({ Native, frameSandboxMeta, isDirectExternalFrameElement }) {
  function shouldHideFrameSandbox(el, raw) {
    return frameSandboxAllowsEscape(raw) && !isDirectExternalFrameElement(el);
  }

  function setFrameSandboxAttribute(el, raw) {
    const value = String(raw == null ? '' : raw);
    if (shouldHideFrameSandbox(el, value)) {
      frameSandboxMeta.set(el, value);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
      return;
    }
    frameSandboxMeta.delete(el);
    Native.setAttribute.call(el, 'sandbox', value);
  }

  function sanitizeFrameSandbox(el) {
    if (!isFrameElement(el)) return;
    const raw = Native.getAttribute.call(el, 'sandbox');
    if (raw !== null && shouldHideFrameSandbox(el, raw)) {
      frameSandboxMeta.set(el, raw);
      if (Native.removeAttribute) Native.removeAttribute.call(el, 'sandbox');
    }
  }

  function frameSandboxValue(el) {
    return isFrameElement(el) && frameSandboxMeta.has(el) ? frameSandboxMeta.get(el) : undefined;
  }

  function hasFrameSandboxValue(el) {
    return isFrameElement(el) && frameSandboxMeta.has(el);
  }

  function forgetFrameSandbox(el) {
    if (isFrameElement(el)) frameSandboxMeta.delete(el);
  }

  return {
    setFrameSandboxAttribute,
    sanitizeFrameSandbox,
    frameSandboxValue,
    hasFrameSandboxValue,
    forgetFrameSandbox,
  };
}
