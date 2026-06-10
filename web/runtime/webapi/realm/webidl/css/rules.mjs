const cssRuleToken = {};
const styleSheetToken = {};
const listToken = {};
const ruleListSlots = new WeakMap();
const sheetListSlots = new WeakMap();
const mediaListSlots = new WeakMap();

const ruleConstants = {
  STYLE_RULE: 1,
  CHARSET_RULE: 2,
  IMPORT_RULE: 3,
  MEDIA_RULE: 4,
  FONT_FACE_RULE: 5,
  PAGE_RULE: 6,
  KEYFRAMES_RULE: 7,
  KEYFRAME_RULE: 8,
  MARGIN_RULE: 9,
  NAMESPACE_RULE: 10,
  COUNTER_STYLE_RULE: 11,
  SUPPORTS_RULE: 12,
  FONT_FEATURE_VALUES_RULE: 14,
};

export function createCSSOMRuleFacades(CSSStyleDeclarationBase) {
  function CSSRuleList(token, rules) {
    if (token !== listToken) throw new TypeError("Failed to construct 'CSSRuleList': Illegal constructor");
    ruleListSlots.set(this, [...rules]);
    refreshIndexes(this, ruleListSlots.get(this));
  }
  Object.defineProperty(CSSRuleList.prototype, 'length', { get() { return ruleListValues(this).length; }, enumerable: true, configurable: true });
  Object.defineProperty(CSSRuleList.prototype, 'item', { value(index) { return ruleListValues(this)[Number(index)] ?? null; }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(CSSRuleList.prototype, Symbol.iterator, { value: function values() { return ruleListValues(this)[Symbol.iterator](); }, writable: true, configurable: true });
  Object.defineProperty(CSSRuleList.prototype, Symbol.toStringTag, { value: 'CSSRuleList', configurable: true });

  function MediaList(token, text = '') {
    if (token !== listToken) throw new TypeError("Failed to construct 'MediaList': Illegal constructor");
    mediaListSlots.set(this, { values: mediaValuesFromText(text), indexedLength: 0 });
    refreshMediaIndexes(this);
  }
  Object.defineProperty(MediaList.prototype, 'mediaText', { get() { return mediaListValues(this).join(', '); }, set(value) { mediaListState(this).values = mediaValuesFromText(value); refreshMediaIndexes(this); }, enumerable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, 'length', { get() { return mediaListValues(this).length; }, enumerable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, 'item', { value(index) { return mediaListValues(this)[Number(index)] ?? null; }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, 'appendMedium', { value(value) { const medium = String(value); const state = mediaListState(this); if (!state.values.includes(medium)) state.values.push(medium); refreshMediaIndexes(this); }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, 'deleteMedium', { value(value) { const medium = String(value); const state = mediaListState(this); const index = state.values.indexOf(medium); if (index < 0) throw new DOMException(`Failed to execute 'deleteMedium' on 'MediaList': Failed to delete '${medium}'.`, 'NotFoundError'); state.values.splice(index, 1); refreshMediaIndexes(this); }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, 'toString', { value: function toString() { return this.mediaText; }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, Symbol.iterator, { value: function values() { return mediaListValues(this)[Symbol.iterator](); }, writable: true, configurable: true });
  Object.defineProperty(MediaList.prototype, Symbol.toStringTag, { value: 'MediaList', configurable: true });

  function StyleSheetList(token, sheets) {
    if (token !== listToken) throw new TypeError("Failed to construct 'StyleSheetList': Illegal constructor");
    sheetListSlots.set(this, [...sheets]);
    refreshSheetIndexes(this, sheetListSlots.get(this));
  }
  Object.defineProperty(StyleSheetList.prototype, 'length', { get() { return styleSheetListValues(this).length; }, enumerable: true, configurable: true });
  Object.defineProperty(StyleSheetList.prototype, 'item', { value(index) { return styleSheetListValues(this)[Number(index)] ?? null; }, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(StyleSheetList.prototype, Symbol.iterator, { value: function values() { return styleSheetListValues(this)[Symbol.iterator](); }, writable: true, configurable: true });
  Object.defineProperty(StyleSheetList.prototype, Symbol.toStringTag, { value: 'StyleSheetList', configurable: true });

  class StyleSheet {
    constructor(token) {
      if (token !== styleSheetToken) throw new TypeError("Failed to construct 'StyleSheet': Illegal constructor");
      defineHidden(this, '__zpSheetType', 'text/css');
      defineHidden(this, '__zpSheetHref', null);
      defineHidden(this, '__zpSheetOwnerNode', null);
      defineHidden(this, '__zpSheetParentStyleSheet', null);
      defineHidden(this, '__zpSheetTitle', null);
      defineHidden(this, '__zpSheetMedia', new MediaList(listToken));
      defineHidden(this, '__zpSheetDisabled', false);
    }
    get type() { return this.__zpSheetType; }
    get href() { return this.__zpSheetHref; }
    get ownerNode() { return this.__zpSheetOwnerNode; }
    get parentStyleSheet() { return this.__zpSheetParentStyleSheet; }
    get title() { return this.__zpSheetTitle; }
    get media() { return this.__zpSheetMedia; }
    get disabled() { return this.__zpSheetDisabled; }
    set disabled(value) { defineHidden(this, '__zpSheetDisabled', Boolean(value)); }
  }
  Object.defineProperty(StyleSheet.prototype, Symbol.toStringTag, { value: 'StyleSheet', configurable: true });

  class CSSStyleSheet extends StyleSheet {
    constructor() {
      super(styleSheetToken);
      defineHidden(this, '__zpOwnerRule', null);
      defineHidden(this, '__zpRules', []);
    }
    get ownerRule() { return this.__zpOwnerRule; }
    get cssRules() { return makeRuleList(this.__zpRules); }
    get rules() { return this.cssRules; }
    insertRule(rule, index = 0) { return insertRuleInto(this, rule, index); }
    deleteRule(index) { deleteRuleFrom(this, arguments.length ? index : 0); }
    removeRule(index = 0) { this.deleteRule(index); }
    addRule(selector = 'undefined', style = '', index = this.__zpRules.length) { return this.insertRule(String(selector) + ' { ' + String(style) + ' }', index); }
    replaceSync(text) {
      this.__zpRules.length = 0;
      const source = String(arguments.length ? text : '').trim();
      if (source) insertRuleInto(this, source, 0);
    }
    replace(text) {
      this.replaceSync(arguments.length ? text : '');
      return Promise.resolve(this);
    }
  }
  Object.defineProperty(CSSStyleSheet.prototype, Symbol.toStringTag, { value: 'CSSStyleSheet', configurable: true });

  class CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSRule': Illegal constructor");
      defineHidden(this, '__zpRuleType', init.type ?? 0);
      defineHidden(this, '__zpRuleText', String(init.cssText ?? ''));
      defineHidden(this, '__zpParentRule', init.parentRule ?? null);
      defineHidden(this, '__zpParentStyleSheet', init.parentStyleSheet ?? null);
    }
    get type() { return this.__zpRuleType; }
    get cssText() { return this.__zpRuleText; }
    set cssText(value) { defineHidden(this, '__zpRuleText', String(value)); }
    get parentRule() { return this.__zpParentRule; }
    get parentStyleSheet() { return this.__zpParentStyleSheet; }
  }
  defineRuleConstants(CSSRule);
  Object.defineProperty(CSSRule.prototype, Symbol.toStringTag, { value: 'CSSRule', configurable: true });

  class CSSGroupingRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSGroupingRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpRules', []);
    }
    get cssRules() { return makeRuleList(this.__zpRules); }
    insertRule(rule, index = 0) { return insertRuleInto(this, rule, index); }
    deleteRule(index) { deleteRuleFrom(this, arguments.length ? index : 0); }
  }
  Object.defineProperty(CSSGroupingRule.prototype, Symbol.toStringTag, { value: 'CSSGroupingRule', configurable: true });

  class CSSConditionRule extends CSSGroupingRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSConditionRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpConditionText', String(init.conditionText ?? ''));
    }
    get conditionText() { return this.__zpConditionText; }
  }
  Object.defineProperty(CSSConditionRule.prototype, Symbol.toStringTag, { value: 'CSSConditionRule', configurable: true });

  class CSSStyleRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSStyleRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.STYLE_RULE });
      defineHidden(this, '__zpSelectorText', String(init.selectorText ?? ''));
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      const styleText = String(init.styleText ?? '');
      this.__zpStyle.cssText = styleText;
      applyRuleDeclarations(this.__zpStyle, styleText);
    }
    get selectorText() { return this.__zpSelectorText; }
    set selectorText(value) { defineHidden(this, '__zpSelectorText', String(value)); }
    get style() { return this.__zpStyle; }
    get styleMap() { return undefined; }
    get cssRules() { return makeRuleList([]); }
    insertRule(rule) { throw new DOMException('Nested CSS rules are not supported by the virtual CSSStyleRule facade.', 'NotSupportedError'); }
    deleteRule(index) { throw new DOMException('Nested CSS rules are not supported by the virtual CSSStyleRule facade.', 'NotSupportedError'); }
  }
  Object.defineProperty(CSSStyleRule.prototype, Symbol.toStringTag, { value: 'CSSStyleRule', configurable: true });

  class CSSMediaRule extends CSSConditionRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSMediaRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.MEDIA_RULE, conditionText: init.conditionText ?? init.mediaText ?? '' });
      defineHidden(this, '__zpMedia', new MediaList(listToken, this.conditionText));
    }
    get media() { return this.__zpMedia; }
  }
  Object.defineProperty(CSSMediaRule.prototype, Symbol.toStringTag, { value: 'CSSMediaRule', configurable: true });

  class CSSSupportsRule extends CSSConditionRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSSupportsRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.SUPPORTS_RULE });
    }
  }
  Object.defineProperty(CSSSupportsRule.prototype, Symbol.toStringTag, { value: 'CSSSupportsRule', configurable: true });

  class CSSImportRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSImportRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.IMPORT_RULE });
      defineHidden(this, '__zpHref', String(init.href ?? ''));
      defineHidden(this, '__zpImportMedia', new MediaList(listToken, init.mediaText ?? ''));
      defineHidden(this, '__zpImportStyleSheet', init.styleSheet ?? null);
      defineHidden(this, '__zpLayerName', init.layerName ?? null);
      defineHidden(this, '__zpSupportsText', init.supportsText ?? null);
    }
    get href() { return this.__zpHref; }
    get media() { return this.__zpImportMedia; }
    get styleSheet() { return this.__zpImportStyleSheet; }
    get layerName() { return this.__zpLayerName; }
    get supportsText() { return this.__zpSupportsText; }
  }
  Object.defineProperty(CSSImportRule.prototype, Symbol.toStringTag, { value: 'CSSImportRule', configurable: true });

  class CSSFontFaceRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSFontFaceRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.FONT_FACE_RULE });
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSFontFaceRule.prototype, Symbol.toStringTag, { value: 'CSSFontFaceRule', configurable: true });

  class CSSPageRule extends CSSGroupingRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSPageRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.PAGE_RULE });
      defineHidden(this, '__zpSelectorText', String(init.selectorText ?? ''));
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get selectorText() { return this.__zpSelectorText; }
    set selectorText(value) { defineHidden(this, '__zpSelectorText', String(value)); }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSPageRule.prototype, Symbol.toStringTag, { value: 'CSSPageRule', configurable: true });

  class CSSMarginRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSMarginRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.MARGIN_RULE });
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get name() { return this.__zpName; }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSMarginRule.prototype, Symbol.toStringTag, { value: 'CSSMarginRule', configurable: true });

  class CSSKeyframesRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSKeyframesRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.KEYFRAMES_RULE });
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpRules', []);
    }
    get name() { return this.__zpName; }
    set name(value) { defineHidden(this, '__zpName', String(value)); }
    get cssRules() { return makeRuleList(this.__zpRules); }
    get length() { return this.__zpRules.length; }
    appendRule(rule) { this.__zpRules.push(createKeyframeRule(rule, this.parentStyleSheet)); }
    deleteRule(key) {
      const text = String(key);
      const index = this.__zpRules.findIndex((rule) => rule.keyText === text);
      if (index !== -1) this.__zpRules.splice(index, 1);
    }
    findRule(key) { return this.__zpRules.find((rule) => rule.keyText === String(key)) ?? null; }
  }
  Object.defineProperty(CSSKeyframesRule.prototype, Symbol.toStringTag, { value: 'CSSKeyframesRule', configurable: true });

  class CSSKeyframeRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSKeyframeRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.KEYFRAME_RULE });
      defineHidden(this, '__zpKeyText', String(init.keyText ?? ''));
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get keyText() { return this.__zpKeyText; }
    set keyText(value) { defineHidden(this, '__zpKeyText', String(value)); }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSKeyframeRule.prototype, Symbol.toStringTag, { value: 'CSSKeyframeRule', configurable: true });

  class CSSNamespaceRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSNamespaceRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.NAMESPACE_RULE });
      defineHidden(this, '__zpNamespaceURI', String(init.namespaceURI ?? ''));
      defineHidden(this, '__zpPrefix', init.prefix ?? null);
    }
    get namespaceURI() { return this.__zpNamespaceURI; }
    get prefix() { return this.__zpPrefix; }
  }
  Object.defineProperty(CSSNamespaceRule.prototype, Symbol.toStringTag, { value: 'CSSNamespaceRule', configurable: true });

  class CSSLayerBlockRule extends CSSGroupingRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSLayerBlockRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpName', String(init.name ?? ''));
    }
    get name() { return this.__zpName; }
  }
  Object.defineProperty(CSSLayerBlockRule.prototype, Symbol.toStringTag, { value: 'CSSLayerBlockRule', configurable: true });

  class CSSLayerStatementRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSLayerStatementRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpNameList', Object.freeze(Array.from(init.nameList ?? [])));
    }
    get nameList() { return this.__zpNameList.slice(); }
  }
  Object.defineProperty(CSSLayerStatementRule.prototype, Symbol.toStringTag, { value: 'CSSLayerStatementRule', configurable: true });

  class CSSContainerRule extends CSSConditionRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSContainerRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpContainerName', String(init.containerName ?? ''));
      defineHidden(this, '__zpContainerQuery', String(init.containerQuery ?? init.conditionText ?? ''));
    }
    get containerName() { return this.__zpContainerName; }
    get containerQuery() { return this.__zpContainerQuery; }
  }
  Object.defineProperty(CSSContainerRule.prototype, Symbol.toStringTag, { value: 'CSSContainerRule', configurable: true });

  class CSSScopeRule extends CSSGroupingRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSScopeRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpStart', String(init.start ?? ''));
      defineHidden(this, '__zpEnd', String(init.end ?? ''));
    }
    get start() { return this.__zpStart; }
    get end() { return this.__zpEnd; }
  }
  Object.defineProperty(CSSScopeRule.prototype, Symbol.toStringTag, { value: 'CSSScopeRule', configurable: true });

  class CSSStartingStyleRule extends CSSGroupingRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSStartingStyleRule': Illegal constructor");
      super(cssRuleToken, init);
    }
  }
  Object.defineProperty(CSSStartingStyleRule.prototype, Symbol.toStringTag, { value: 'CSSStartingStyleRule', configurable: true });

  class CSSNestedDeclarations extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSNestedDeclarations': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSNestedDeclarations.prototype, Symbol.toStringTag, { value: 'CSSNestedDeclarations', configurable: true });

  class CSSCounterStyleRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSCounterStyleRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.COUNTER_STYLE_RULE });
      const descriptors = descriptorMap(init.styleText ?? '');
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpSystem', descriptorValue(descriptors, 'system', 'symbolic'));
      defineHidden(this, '__zpSymbols', descriptorValue(descriptors, 'symbols'));
      defineHidden(this, '__zpAdditiveSymbols', descriptorValue(descriptors, 'additive-symbols'));
      defineHidden(this, '__zpNegative', descriptorValue(descriptors, 'negative'));
      defineHidden(this, '__zpPrefix', descriptorValue(descriptors, 'prefix'));
      defineHidden(this, '__zpSuffix', descriptorValue(descriptors, 'suffix', '. '));
      defineHidden(this, '__zpRange', descriptorValue(descriptors, 'range', 'auto'));
      defineHidden(this, '__zpPad', descriptorValue(descriptors, 'pad'));
      defineHidden(this, '__zpFallback', descriptorValue(descriptors, 'fallback', 'decimal'));
      defineHidden(this, '__zpSpeakAs', descriptorValue(descriptors, 'speak-as', 'auto'));
    }
    get name() { return this.__zpName; }
    set name(value) { defineHidden(this, '__zpName', String(value)); }
    get system() { return this.__zpSystem; }
    set system(value) { defineHidden(this, '__zpSystem', String(value)); }
    get symbols() { return this.__zpSymbols; }
    set symbols(value) { defineHidden(this, '__zpSymbols', String(value)); }
    get additiveSymbols() { return this.__zpAdditiveSymbols; }
    set additiveSymbols(value) { defineHidden(this, '__zpAdditiveSymbols', String(value)); }
    get negative() { return this.__zpNegative; }
    set negative(value) { defineHidden(this, '__zpNegative', String(value)); }
    get prefix() { return this.__zpPrefix; }
    set prefix(value) { defineHidden(this, '__zpPrefix', String(value)); }
    get suffix() { return this.__zpSuffix; }
    set suffix(value) { defineHidden(this, '__zpSuffix', String(value)); }
    get range() { return this.__zpRange; }
    set range(value) { defineHidden(this, '__zpRange', String(value)); }
    get pad() { return this.__zpPad; }
    set pad(value) { defineHidden(this, '__zpPad', String(value)); }
    get fallback() { return this.__zpFallback; }
    set fallback(value) { defineHidden(this, '__zpFallback', String(value)); }
    get speakAs() { return this.__zpSpeakAs; }
    set speakAs(value) { defineHidden(this, '__zpSpeakAs', String(value)); }
  }
  Object.defineProperty(CSSCounterStyleRule.prototype, Symbol.toStringTag, { value: 'CSSCounterStyleRule', configurable: true });

  class CSSFontFeatureValuesRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSFontFeatureValuesRule': Illegal constructor");
      super(cssRuleToken, { ...init, type: ruleConstants.FONT_FEATURE_VALUES_RULE });
      defineHidden(this, '__zpFontFamily', String(init.fontFamily ?? ''));
      defineHidden(this, '__zpValueText', String(init.valueText ?? ''));
    }
    get fontFamily() { return this.__zpFontFamily; }
    set fontFamily(value) { defineHidden(this, '__zpFontFamily', String(value)); }
    get valueText() { return this.__zpValueText; }
    set valueText(value) { defineHidden(this, '__zpValueText', String(value)); }
  }
  Object.defineProperty(CSSFontFeatureValuesRule.prototype, Symbol.toStringTag, { value: 'CSSFontFeatureValuesRule', configurable: true });

  class CSSFontPaletteValuesRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSFontPaletteValuesRule': Illegal constructor");
      super(cssRuleToken, init);
      const descriptors = descriptorMap(init.styleText ?? '');
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpFontFamily', descriptorValue(descriptors, 'font-family'));
      defineHidden(this, '__zpBasePalette', descriptorValue(descriptors, 'base-palette'));
      defineHidden(this, '__zpOverrideColors', descriptorValue(descriptors, 'override-colors'));
    }
    get name() { return this.__zpName; }
    get fontFamily() { return this.__zpFontFamily; }
    get basePalette() { return this.__zpBasePalette; }
    get overrideColors() { return this.__zpOverrideColors; }
  }
  Object.defineProperty(CSSFontPaletteValuesRule.prototype, Symbol.toStringTag, { value: 'CSSFontPaletteValuesRule', configurable: true });

  class CSSPropertyRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSPropertyRule': Illegal constructor");
      super(cssRuleToken, init);
      const descriptors = descriptorMap(init.styleText ?? '');
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpSyntax', descriptorValue(descriptors, 'syntax', '*'));
      defineHidden(this, '__zpInherits', descriptorValue(descriptors, 'inherits', 'false') === 'true');
      defineHidden(this, '__zpInitialValue', descriptorValue(descriptors, 'initial-value'));
    }
    get name() { return this.__zpName; }
    get syntax() { return this.__zpSyntax; }
    get inherits() { return this.__zpInherits; }
    get initialValue() { return this.__zpInitialValue; }
  }
  Object.defineProperty(CSSPropertyRule.prototype, Symbol.toStringTag, { value: 'CSSPropertyRule', configurable: true });

  class CSSPositionTryRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSPositionTryRule': Illegal constructor");
      super(cssRuleToken, init);
      defineHidden(this, '__zpName', String(init.name ?? ''));
      defineHidden(this, '__zpStyle', new CSSStyleDeclarationBase());
      applyRuleDeclarations(this.__zpStyle, init.styleText ?? '');
    }
    get name() { return this.__zpName; }
    get style() { return this.__zpStyle; }
  }
  Object.defineProperty(CSSPositionTryRule.prototype, Symbol.toStringTag, { value: 'CSSPositionTryRule', configurable: true });

  class CSSViewTransitionRule extends CSSRule {
    constructor(token, init = {}) {
      if (token !== cssRuleToken) throw new TypeError("Failed to construct 'CSSViewTransitionRule': Illegal constructor");
      super(cssRuleToken, init);
      const descriptors = descriptorMap(init.styleText ?? '');
      defineHidden(this, '__zpNavigation', descriptorValue(descriptors, 'navigation', 'auto'));
      defineHidden(this, '__zpTypes', descriptorValue(descriptors, 'types').split(/\s+/).filter(Boolean));
    }
    get navigation() { return this.__zpNavigation; }
    get types() { return this.__zpTypes.slice(); }
  }
  Object.defineProperty(CSSViewTransitionRule.prototype, Symbol.toStringTag, { value: 'CSSViewTransitionRule', configurable: true });

  const atRuleFactories = [
    ['@media', (text, parentStyleSheet) => new CSSMediaRule(cssRuleToken, { cssText: text, mediaText: conditionFromAtRule(text, '@media'), parentStyleSheet })],
    ['@supports', (text, parentStyleSheet) => new CSSSupportsRule(cssRuleToken, { cssText: text, conditionText: conditionFromAtRule(text, '@supports'), parentStyleSheet })],
    ['@import', (text, parentStyleSheet) => new CSSImportRule(cssRuleToken, { cssText: text, href: quotedToken(text), mediaText: afterQuotedToken(text), parentStyleSheet })],
    ['@font-face', (text, parentStyleSheet) => new CSSFontFaceRule(cssRuleToken, { cssText: text, styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@font-feature-values', (text, parentStyleSheet) => new CSSFontFeatureValuesRule(cssRuleToken, { cssText: text, fontFamily: conditionFromAtRule(text, '@font-feature-values'), valueText: styleTextFromBraces(text), parentStyleSheet })],
    ['@font-palette-values', (text, parentStyleSheet) => new CSSFontPaletteValuesRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@font-palette-values'), styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@page', (text, parentStyleSheet) => new CSSPageRule(cssRuleToken, { cssText: text, selectorText: conditionFromAtRule(text, '@page'), styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@keyframes', (text, parentStyleSheet) => createKeyframesRule(text, parentStyleSheet)],
    ['@namespace', (text, parentStyleSheet) => new CSSNamespaceRule(cssRuleToken, { cssText: text, namespaceURI: quotedToken(text), prefix: namespacePrefix(text), parentStyleSheet })],
    ['@counter-style', (text, parentStyleSheet) => new CSSCounterStyleRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@counter-style'), styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@property', (text, parentStyleSheet) => new CSSPropertyRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@property'), styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@position-try', (text, parentStyleSheet) => new CSSPositionTryRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@position-try'), styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@view-transition', (text, parentStyleSheet) => new CSSViewTransitionRule(cssRuleToken, { cssText: text, styleText: styleTextFromBraces(text), parentStyleSheet })],
    ['@layer', (text, parentStyleSheet) => createLayerRule(text, parentStyleSheet)],
    ['@container', (text, parentStyleSheet) => new CSSContainerRule(cssRuleToken, { cssText: text, conditionText: conditionFromAtRule(text, '@container'), containerQuery: conditionFromAtRule(text, '@container'), parentStyleSheet })],
    ['@scope', (text, parentStyleSheet) => new CSSScopeRule(cssRuleToken, { cssText: text, start: conditionFromAtRule(text, '@scope'), parentStyleSheet })],
    ['@starting-style', (text, parentStyleSheet) => new CSSStartingStyleRule(cssRuleToken, { cssText: text, parentStyleSheet })],
  ];

  return { StyleSheet, CSSStyleSheet, CSSRule, CSSRuleList, CSSGroupingRule, CSSConditionRule, CSSStyleRule, CSSMediaRule, CSSSupportsRule, CSSImportRule, CSSFontFaceRule, CSSPageRule, CSSMarginRule, CSSKeyframesRule, CSSKeyframeRule, CSSNamespaceRule, CSSLayerBlockRule, CSSLayerStatementRule, CSSContainerRule, CSSScopeRule, CSSStartingStyleRule, CSSNestedDeclarations, CSSCounterStyleRule, CSSFontFeatureValuesRule, CSSFontPaletteValuesRule, CSSPropertyRule, CSSPositionTryRule, CSSViewTransitionRule, MediaList, StyleSheetList, makeStyleSheetList };

  function insertRuleInto(owner, rule, index) {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position > owner.__zpRules.length) throw new DOMException('The index is not in the allowed range.', 'IndexSizeError');
    owner.__zpRules.splice(position, 0, createRuleFromText(rule, owner));
    return position;
  }

  function deleteRuleFrom(owner, index) {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= owner.__zpRules.length) throw new DOMException('The index is not in the allowed range.', 'IndexSizeError');
    owner.__zpRules.splice(position, 1);
  }

  function createRuleFromText(rule, owner) {
    const text = String(rule).trim();
    const parentStyleSheet = owner instanceof CSSStyleSheet ? owner : owner.parentStyleSheet;
    return createAtRuleFromText(text, parentStyleSheet) ?? createStyleLikeRule(text, parentStyleSheet);
  }

  function createAtRuleFromText(text, parentStyleSheet) {
    for (const [prefix, factory] of atRuleFactories) {
      if (text.startsWith(prefix)) return factory(text, parentStyleSheet);
    }
    return null;
  }

  function createStyleLikeRule(text, parentStyleSheet) {
    if (text.startsWith('&')) return new CSSNestedDeclarations(cssRuleToken, { cssText: text, styleText: styleTextFromBraces(text), parentStyleSheet });
    const brace = text.indexOf('{');
    const selectorText = brace === -1 ? text : text.slice(0, brace).trim();
    return new CSSStyleRule(cssRuleToken, { cssText: text, selectorText, styleText: styleTextFromBraces(text), parentStyleSheet });
  }

  function createLayerRule(text, parentStyleSheet) {
    if (text.includes('{')) return new CSSLayerBlockRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@layer'), parentStyleSheet });
    const nameList = text.slice('@layer'.length).replace(';', '').split(',').map((item) => item.trim()).filter(Boolean);
    return new CSSLayerStatementRule(cssRuleToken, { cssText: text, nameList, parentStyleSheet });
  }

  function createKeyframesRule(text, parentStyleSheet) {
    const rule = new CSSKeyframesRule(cssRuleToken, { cssText: text, name: conditionFromAtRule(text, '@keyframes'), parentStyleSheet });
    const body = styleTextFromBraces(text);
    const match = body.match(/([^{}]+)\{([^{}]*)\}/);
    if (match) rule.appendRule(match[1].trim() + ' { ' + match[2].trim() + ' }');
    return rule;
  }

  function createKeyframeRule(rule, parentStyleSheet) {
    const text = String(rule).trim();
    const brace = text.indexOf('{');
    const keyText = brace === -1 ? text : text.slice(0, brace).trim();
    return new CSSKeyframeRule(cssRuleToken, { cssText: text, keyText, styleText: styleTextFromBraces(text), parentStyleSheet });
  }
}

function makeRuleList(rules) {
  return new globalThis.CSSRuleList(listToken, rules);
}
function makeStyleSheetList(sheets) {
  return new globalThis.StyleSheetList(listToken, sheets);
}

function conditionFromAtRule(text, prefix) {
  const body = text.slice(prefix.length).trim();
  const brace = body.indexOf('{');
  return (brace === -1 ? body : body.slice(0, brace)).trim();
}
function styleTextFromBraces(text) {
  const source = String(text);
  const brace = source.indexOf('{');
  if (brace === -1) return '';
  const end = source.lastIndexOf('}');
  return source.slice(brace + 1, end === -1 ? source.length : end).trim();
}

function descriptorMap(text) {
  const out = Object.create(null);
  for (const part of String(text).split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    if (key) out[key] = part.slice(colon + 1).trim();
  }
  return out;
}

function descriptorValue(map, name, fallback = '') {
  return map[name] ?? fallback;
}

function quotedToken(text) {
  const match = String(text).match(/['\"]([^'\"]*)['\"]/);
  return match ? match[1] : '';
}

function afterQuotedToken(text) {
  const source = String(text);
  const match = source.match(/['\"][^'\"]*['\"]/);
  if (!match) return '';
  return source.slice((match.index ?? 0) + match[0].length).replace(';', '').trim();
}

function namespacePrefix(text) {
  const source = String(text).slice('@namespace'.length).trim();
  const quote = source.search(/['\"]/);
  const prefix = quote === -1 ? '' : source.slice(0, quote).trim();
  return prefix || null;
}


function refreshIndexes(list, rules = ruleListValues(list)) {
  for (let index = 0; index < rules.length; index += 1) {
    Object.defineProperty(list, index, { value: rules[index], enumerable: true, configurable: true });
  }
}

function refreshSheetIndexes(list, sheets = styleSheetListValues(list)) {
  for (let index = 0; index < sheets.length; index += 1) {
    Object.defineProperty(list, index, { value: sheets[index], enumerable: true, configurable: true });
  }
}

function ruleListValues(list) {
  const values = ruleListSlots.get(list);
  if (!values) throw new TypeError('Illegal invocation');
  return values;
}

function styleSheetListValues(list) {
  const values = sheetListSlots.get(list);
  if (!values) throw new TypeError('Illegal invocation');
  return values;
}

function refreshMediaIndexes(list) {
  const state = mediaListState(list);
  for (let index = 0; index < state.indexedLength; index += 1) delete list[index];
  for (let index = 0; index < state.values.length; index += 1) {
    Object.defineProperty(list, index, { value: state.values[index], enumerable: true, configurable: true });
  }
  state.indexedLength = state.values.length;
}

function mediaListState(list) {
  const state = mediaListSlots.get(list);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}

function mediaListValues(list) {
  return mediaListState(list).values;
}

function mediaValuesFromText(text) {
  const seen = new Set();
  const values = [];
  for (const chunk of String(text || '').split(',')) {
    const medium = chunk.trim();
    if (medium && !seen.has(medium)) {
      seen.add(medium);
      values.push(medium);
    }
  }
  return values;
}

function applyRuleDeclarations(style, styleText) {
  for (const chunk of String(styleText || '').split(';')) {
    const colon = chunk.indexOf(':');
    if (colon <= 0) continue;
    style.setProperty(chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim());
  }
}

function defineRuleConstants(CSSRule) {
  for (const [key, value] of Object.entries(ruleConstants)) {
    Object.defineProperty(CSSRule, key, { value, enumerable: true, configurable: true });
    Object.defineProperty(CSSRule.prototype, key, { value, enumerable: true, configurable: true });
  }
}

function defineHidden(target, key, value) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}
