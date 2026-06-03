const TARGET_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const TARGET_APP_VERSION = TARGET_USER_AGENT.replace(/^Mozilla\//, '');
const TARGET_PLATFORM = 'Win32';
const TARGET_UA_BRANDS = Object.freeze([
  Object.freeze({ brand: 'Chromium', version: '148' }),
  Object.freeze({ brand: 'Not:A-Brand', version: '24' }),
  Object.freeze({ brand: 'Google Chrome', version: '148' })
]);
const TARGET_UA_FULL_VERSION_LIST = Object.freeze([
  Object.freeze({ brand: 'Chromium', version: '148.0.7778.217' }),
  Object.freeze({ brand: 'Not:A-Brand', version: '24.0.0.0' }),
  Object.freeze({ brand: 'Google Chrome', version: '148.0.7778.217' })
]);

function userAgentBrands() {
  return TARGET_UA_BRANDS.map(brand => Object.freeze({ brand: brand.brand, version: brand.version }));
}

function highEntropyBrands() {
  return TARGET_UA_BRANDS.map(brand => ({ brand: brand.brand, version: brand.version }));
}

function fullVersionList() {
  return TARGET_UA_FULL_VERSION_LIST.map(brand => ({ brand: brand.brand, version: brand.version }));
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

function selectHighEntropyValues(hints, values) {
  const out = { brands: values.brands, mobile: false, platform: 'Windows' };
  for (const hint of Array.isArray(hints) ? hints.map(String) : []) {
    if (Object.hasOwn(values, hint)) out[hint] = values[hint];
  }
  return out;
}

function makeUserAgentData(maskMethods) {
  const data = {
    brands: userAgentBrands(),
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues(hints) {
      return Promise.resolve(selectHighEntropyValues(hints, highEntropyValues()));
    },
    toJSON() {
      return { brands: this.brands, mobile: false, platform: 'Windows' };
    }
  };
  maskMethods(data, ['getHighEntropyValues','toJSON']);
  try { Object.freeze(data.brands); Object.freeze(data); } catch {}
  return data;
}

function navigatorPrototype(w, nav) {
  return w.Navigator && w.Navigator.prototype || Object.getPrototypeOf(nav);
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

export function createNavigatorFacade({ defineAccessor, maskMethods }) {
  return {
    installNavigatorIdentity(w) {
      const nav = w && w.navigator;
      if (!nav) return;
      installNavigatorAccessors({
        nav,
        proto: navigatorPrototype(w, nav),
        userAgentData: makeUserAgentData(maskMethods),
        defineAccessor,
      });
    }
  };
}
