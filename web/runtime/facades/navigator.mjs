const NativeArray = Array;

const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
const TARGET_PLATFORM = 'Win32';
const TARGET_UA_BRANDS = [
  { brand: 'Chromium', version: '148' },
  { brand: 'Not:A-Brand', version: '24' },
  { brand: 'Google Chrome', version: '148' }
];
const TARGET_UA_FULL_VERSION_LIST = [
  { brand: 'Chromium', version: '148.0.7778.217' },
  { brand: 'Not:A-Brand', version: '24.0.0.0' },
  { brand: 'Google Chrome', version: '148.0.7778.217' }
];

function copyBrands(source, freezeBrand) {
  const out = new NativeArray(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const brand = { brand: source[i].brand, version: source[i].version };
    out[i] = freezeBrand ? freezeBrand(brand) : brand;
  }
  return out;
}

function userAgentBrands(objectFreeze) {
  return copyBrands(TARGET_UA_BRANDS, objectFreeze);
}

function highEntropyBrands() {
  return copyBrands(TARGET_UA_BRANDS);
}

function fullVersionList() {
  return copyBrands(TARGET_UA_FULL_VERSION_LIST);
}

function highEntropyValues() {
  return {
    architecture: 'x86',
    bitness: '64',
    brands: highEntropyBrands(),
    fullVersionList: fullVersionList(),
    mobile: false,
    model: '',
    platform: 'Windows',
    platformVersion: '15.0.0',
    uaFullVersion: '148.0.7778.217',
    fullVersion: '148.0.7778.217',
    wow64: false
  };
}

function selectHighEntropyValues(hints, values, Native) {
  const {
    String = globalThis.String,
    arrayFrom = globalThis.Array.from,
    arrayIsArray = globalThis.Array.isArray,
    objectHasOwn = globalThis.Object.hasOwn,
  } = Native;
  const out = { brands: values.brands, mobile: false, platform: 'Windows' };
  for (const hint of arrayIsArray(hints) ? arrayFrom(hints, String) : []) {
    if (objectHasOwn(values, hint)) out[hint] = values[hint];
  }
  return out;
}

function makeUserAgentData(maskMethods, Native) {
  const {
    Promise = globalThis.Promise,
    objectFreeze = globalThis.Object.freeze,
  } = Native;
  const data = {
    brands: userAgentBrands(objectFreeze),
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues(hints) {
      return Promise.resolve(selectHighEntropyValues(hints, highEntropyValues(), Native));
    },
    toJSON() {
      return { brands: this.brands, mobile: false, platform: 'Windows' };
    }
  };
  maskMethods(data, ['getHighEntropyValues','toJSON']);
  try { objectFreeze(data.brands); objectFreeze(data); } catch {}
  return data;
}

function navigatorPrototype(w, nav, objectGetPrototypeOf) {
  return w.Navigator && w.Navigator.prototype || objectGetPrototypeOf(nav);
}

function installNavigatorAccessors({ nav, proto, userAgentData, defineAccessor }) {
  defineAccessor(proto, 'userAgent', () => TARGET_USER_AGENT);
  defineAccessor(nav, 'userAgent', () => TARGET_USER_AGENT);
  defineAccessor(proto, 'appVersion', () => TARGET_APP_VERSION);
  defineAccessor(nav, 'appVersion', () => TARGET_APP_VERSION);
  defineAccessor(proto, 'platform', () => TARGET_PLATFORM);
  defineAccessor(nav, 'platform', () => TARGET_PLATFORM);
  defineAccessor(proto, 'userAgentData', () => userAgentData);
  defineAccessor(nav, 'userAgentData', () => userAgentData);
}

export function createNavigatorFacade({ Native, defineAccessor, maskMethods }) {
  const { objectGetPrototypeOf = globalThis.Object.getPrototypeOf } = Native;
  return {
    installNavigatorIdentity(w) {
      const nav = w && w.navigator;
      if (!nav) return;
      installNavigatorAccessors({
        nav,
        proto: navigatorPrototype(w, nav, objectGetPrototypeOf),
        userAgentData: makeUserAgentData(maskMethods, Native),
        defineAccessor,
      });
    }
  };
}
