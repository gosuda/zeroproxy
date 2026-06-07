const NativeSet = Set;
const NativeString = String;

export function isFrameElement(el) {
  const tag = el && el.localName;
  return tag === 'iframe' || tag === 'frame';
}

export function frameSandboxAllowsEscape(raw) {
  const tokens = new NativeSet(NativeString(raw || '').toLowerCase().split(/\s+/).filter(Boolean));
  return tokens.has('allow-scripts') && tokens.has('allow-same-origin');
}
