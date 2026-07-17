export const runtimeSections = [
  { file: import.meta.url, name: "cssom_section_14", order: 14, phase: "inner" },
  { file: import.meta.url, name: "cssom_section_30", order: 30, phase: "inner" },
];

export function cssom_section_14() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const styleFacades=new PrivateWeakMap(),styleFacadeState=new PrivateWeakMap(),ruleStyleFacades=new PrivateWeakMap(),computedStyleFacades=new PrivateWeakMap(),cssProjectionPattern=/(?:https?:\/\/|\/_zp\/)[^"'()\s]*#zp-css-v2=[A-Za-z0-9_-]+/giu;
  function blockDynamicCSS(value){if(NativeString(value)!=="")throw new NativeDOMException("Dynamic CSS requires a controlled rewrite","SecurityError")}
  function internalSyntheticRoute(url){return urlProperty(url,"origin")===syntheticDocumentOrigin&&reflectApply(stringStartsWith,urlProperty(url,"pathname"),["/_zp/"])}
  function cssProjectionRecord(value){
    let url;try{url=new NativeURL(NativeString(value),`${syntheticDocumentOrigin}/`)}catch{return null}
    const hash=urlProperty(url,"hash"),prefix="#zp-css-v2=";
    if(!reflectApply(stringStartsWith,hash,[prefix]))return null;
    if(!internalSyntheticRoute(url))throw new NativeDOMException("CSS projection rejected","SecurityError");
    const encoded=reflectApply(stringSlice,hash,[prefix.length]);if(encoded.length>32768)throw new NativeDOMException("CSS projection rejected","SecurityError");
    let payload;try{payload=jsonParse(decodeStaticMetadataText(encoded,"CSS projection"))}catch{throw new NativeDOMException("CSS projection rejected","SecurityError")}
    if(!payload||arrayIsArray(payload)||typeof payload!=="object"||reflectOwnKeys(payload).length!==2||typeof payload.raw!=="string"||typeof payload.target!=="string"||payload.raw.length>65536)throw new NativeDOMException("CSS projection rejected","SecurityError");
    let target;try{target=new NativeURL(payload.target)}catch{throw new NativeDOMException("CSS projection rejected","SecurityError")}
    const protocol=urlProperty(target,"protocol");
    if((protocol!=="http:"&&protocol!=="https:")||urlProperty(target,"href")!==payload.target)throw new NativeDOMException("CSS projection rejected","SecurityError");
    return payload;
  }
  function visibleResourceURL(value,mode="target"){
    if(typeof value!=="string"||value==="")return value;
    const projection=cssProjectionRecord(value);if(projection)return mode==="raw"?projection.raw:projection.target;
    let url;try{url=new NativeURL(value,`${syntheticDocumentOrigin}/`)}catch{return value}
    const canonical=urlProperty(url,"href"),mapped=resourceURLMappings.get(canonical);if(mapped)return mapped;
    if(internalSyntheticRoute(url))throw new NativeDOMException("Internal resource URL concealed","SecurityError");
    return value;
  }
  function assertNoInternalCSSRoute(value){
    if(reflectApply(stringIncludes,value,["#zp-css-v2="])||reflectApply(stringIncludes,value,[`${syntheticDocumentOrigin}/_zp/`])||reflectApply(regexpTest,/url\(\s*["']?\/_zp\//iu,[value]))throw new NativeDOMException("Internal CSS URL concealed","SecurityError");
    return value;
  }
  function projectedCSSValue(value,mode){return reflectApply(stringReplaceAll,value,[cssProjectionPattern,route=>{const projection=cssProjectionRecord(route);return projection?mode==="raw"?projection.raw:projection.target:route}])}
  function indexCSSProjectionValue(value){
    if(typeof value!=="string"||!reflectApply(stringIncludes,value,["#zp-css-v2="]))return;
    reflectApply(stringReplaceAll,value,[cssProjectionPattern,route=>{const projection=cssProjectionRecord(route);if(projection)recordResourceMapping(route,projection.target);return route}]);
  }
  function visibleStyle(owner,nativeStyle){const record=visibleAttributeRecord(owner,"style");if(!record)return nativeStyle;const template=reflectApply(markupNatives.createElement,document,["template"]),styleDocument=nativeOwnerDocument(reflectApply(markupNatives.templateContent.get,template,[])),element=isSVGElementNode(owner)?reflectApply(markupNatives.createElementNS,styleDocument,["http://www.w3.org/2000/svg","svg"]):reflectApply(markupNatives.createElement,styleDocument,["div"]);reflectApply(natives.setAttribute,element,["style",record.attribute]);return reflectApply((isSVGElementNode(owner)?cssNatives.svgStyle:cssNatives.htmlStyle).get, element, [])}
  function virtualCSSValue(value,owner,mode="raw"){if(typeof value!=="string")return value;let visible=projectedCSSValue(value,mode);for(const [internal,target] of resourceURLMappings)visible=reflectApply(stringReplaceAll,visible,[internal,target]);const cssURLs=owner&&visibleAttributeRecord(owner,"style")?.css_urls;if(cssURLs)for(const [internal,target] of objectEntries(cssURLs))try{visible=reflectApply(stringReplaceAll,visible,[urlProperty(new NativeURL(internal,`${syntheticDocumentOrigin}/`),"href"),target])}catch{}return assertNoInternalCSSRoute(visible)}
  function computedStyleMethod(style,key,owner){if(key==="getPropertyValue")return name=>virtualCSSValue(reflectApply(cssNatives.getPropertyValue,style,[name]),owner,"target");if(key==="getPropertyPriority")return name=>reflectApply(cssNatives.getPropertyPriority,style,[name]);if(key==="item")return index=>reflectApply(cssNatives.item,style,[index]);if(key===Symbol.iterator&&cssNatives.iterator)return()=>reflectApply(cssNatives.iterator,style,[])}
  function computedCSSPropertyName(key){if(typeof key!=="string"||key===""||reflectApply(stringStartsWith,key,["--"]))return;if(key==="cssFloat")return"float";let property="";for(let index=0;index<key.length;index+=1){const character=key[index];property+=character>="A"&&character<="Z"?`-${lower(character)}`:character}return reflectApply(stringStartsWith,property,["webkit-"])||reflectApply(stringStartsWith,property,["ms-"])?`-${property}`:property}
  function supportedComputedCSSProperty(key){const property=computedCSSPropertyName(key);if(!property||!cssNatives.supports)return;try{return reflectApply(cssNatives.supports,cssNatives.cssNamespace,[property,"initial"])?property:undefined}catch{}}
  function computedStyleValue(style,key){if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key))return reflectApply(cssNatives.item,style,[NativeNumber(key)]);const value=capturedValue(style,key,computedStyleDescriptorSets);if(value!==undefined)return typeof value==="function"?undefined:value;const property=supportedComputedCSSProperty(key);return property?reflectApply(cssNatives.getPropertyValue,style,[property]):undefined}
  function inlineStyleValue(owner,nativeStyle,key){const visible=visibleStyle(owner,nativeStyle),value=capturedValue(visible,key,computedStyleDescriptorSets);if(value!==undefined)return typeof value==="function"?bindFunction(value,visible):virtualCSSValue(value,owner);const property=supportedComputedCSSProperty(key);return property?virtualCSSValue(reflectApply(cssNatives.getPropertyValue,visible,[property]),owner):undefined}
  function setInlineStyleValue(owner,nativeStyle,key,value){blockDynamicCSS(value);clearVisibleAttribute(owner,"style");const descriptor=capturedDescriptor(nativeStyle,key,computedStyleDescriptorSets);if(descriptor?.set){reflectApply(descriptor.set,nativeStyle,[value]);return true}const property=supportedComputedCSSProperty(key);if(!property)return false;reflectApply(cssNatives.setProperty,nativeStyle,[property,value,""]);return true}
  function computedStyleFacade(style,owner){let facade=computedStyleFacades.get(style);if(facade)return facade;facade=new NativeProxy(inertFacadeTarget(style),{get(_target,key){const method=computedStyleMethod(style,key,owner);return method??virtualCSSValue(computedStyleValue(style,key),owner,"target")},set(){return false},defineProperty(){return false},deleteProperty(){return false}});computedStyleFacades.set(style,facade);return facade}
    const safeGetComputedStyle=mirrorFunction(function(element,pseudo){return computedStyleFacade(reflectApply(cssNatives.getComputedStyle,rawWindow,[element,pseudo]),element)},cssNatives.getComputedStyle)
  function inlineStyleFacade(owner,descriptor){const nativeStyle=reflectApply(descriptor.get,owner,[]);let facade=styleFacades.get(nativeStyle);if(facade)return facade;facade=new NativeProxy(inertFacadeTarget(nativeStyle),{get(_target,key){if(key==="setProperty")return(name,value,priority)=>{blockDynamicCSS(value);return reflectApply(cssNatives.setProperty,nativeStyle,[name,value,priority])};if(key==="removeProperty")return()=>{throw new NativeDOMException("Dynamic CSS requires a controlled rewrite","SecurityError")};return inlineStyleValue(owner,nativeStyle,key)},set(_target,key,value){return setInlineStyleValue(owner,nativeStyle,key,value)},defineProperty(){return false},deleteProperty(){return false}});styleFacades.set(nativeStyle,facade);styleFacadeState.set(facade,{owner,nativeStyle});return facade}
  function ruleStyleMethod(style,key){
    if(key==="setProperty")return(name,value,priority)=>{const converted=NativeString(value);blockDynamicCSS(converted);return reflectApply(cssNatives.setProperty,style,[name,converted,priority])};
    if(key==="removeProperty")return name=>reflectApply(cssNatives.removeProperty,style,[name]);
    if(key==="getPropertyValue")return name=>virtualCSSValue(reflectApply(cssNatives.getPropertyValue,style,[name]),null);
    if(key==="getPropertyPriority")return name=>reflectApply(cssNatives.getPropertyPriority,style,[name]);
    if(key==="item")return index=>reflectApply(cssNatives.item,style,[index]);
    if(key===Symbol.iterator&&cssNatives.iterator)return()=>reflectApply(cssNatives.iterator,style,[]);
  }
  function ruleStyleValue(style,key){
    if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key))return reflectApply(cssNatives.item,style,[NativeNumber(key)]);
    const method=ruleStyleMethod(style,key);
    if(method)return method;
    const value=capturedValue(style,key,computedStyleDescriptorSets);
    if(value!==undefined)return typeof value==="function"?bindFunction(value,style):virtualCSSValue(value,null);
    const property=supportedComputedCSSProperty(key);
    return property?virtualCSSValue(reflectApply(cssNatives.getPropertyValue,style,[property]),null):undefined;
  }
  function setRuleStyleValue(style,key,value){
    const converted=NativeString(value);
    blockDynamicCSS(converted);
    const descriptor=capturedDescriptor(style,key,computedStyleDescriptorSets);
    if(descriptor?.set){reflectApply(descriptor.set,style,[converted]);return true}
    const property=supportedComputedCSSProperty(key);
    if(!property)return false;
    reflectApply(cssNatives.setProperty,style,[property,converted,""]);
    return true;
  }
  function ruleStyleFacade(style){
    let facade=ruleStyleFacades.get(style);
    if(facade)return facade;
    facade=new NativeProxy(inertFacadeTarget(style),{get(_target,key){return ruleStyleValue(style,key)},set(_target,key,value){return setRuleStyleValue(style,key,value)},defineProperty(){return false},deleteProperty(){return false}});
    ruleStyleFacades.set(style,facade);
    styleFacadeState.set(facade,{owner:null,nativeStyle:style});
    return facade;
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function cssom_section_30() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const safeEmptyAdoptedSheets=[];natives.defineProperty(safeEmptyAdoptedSheets,Symbol.iterator,{value:arrayIterator,writable:false,enumerable:false,configurable:false});
  const adoptedShadowHost=reflectApply(markupNatives.createElement,document,["div"]),adoptedShadowProbe=reflectApply(markupNatives.attachShadow,adoptedShadowHost,[{mode:"open"}]);
  function safeAdoptedSheets(sheets){const safe=[];for(let index=0;index<sheets.length;index+=1){const sheet=sheets[index],rules=reflectApply(cssNatives.cssRules.get,sheet,[]);if(reflectApply(cssNatives.cssRuleListLength.get,rules,[])!==0)throw new NativeDOMException("Dynamic adopted stylesheets require a controlled rewrite","SecurityError");safe[index]=sheet}natives.defineProperty(safe,Symbol.iterator,{value:arrayIterator,writable:false,enumerable:false,configurable:false});return safe}
  function validateAdoptedSheets(value){const descriptor=cssNatives.shadowAdoptedStyleSheets;try{reflectApply(descriptor.set,adoptedShadowProbe,[value]);return safeAdoptedSheets(reflectApply(descriptor.get,adoptedShadowProbe,[]))}finally{reflectApply(descriptor.set,adoptedShadowProbe,[safeEmptyAdoptedSheets])}}
  function stageAdoptedStyleSheets(prototype,descriptor){if(!descriptor?.get||!descriptor?.set||!descriptor.configurable)return;stage(prototype,"adoptedStyleSheets",{...descriptor,get(){return reflectApply(descriptor.get,this,[])},set(value){reflectApply(descriptor.set,this,[validateAdoptedSheets(value)])},configurable:false})}
  function stageCSSRuleStyles(){
    for(let index=0;index<cssRuleStyleNatives.length;index+=1){
      const entry=cssRuleStyleNatives[index],descriptor=entry.descriptor;
      if(!entry.prototype||!descriptor?.get||!descriptor.configurable)continue;
      stage(entry.prototype,"style",{...descriptor,get(){return ruleStyleFacade(reflectApply(descriptor.get,this,[]))},configurable:false});
    }
  }
  function indexStylesheetProjections(sheet,seen=new PrivateSet){
    if(!sheet||seen.has(sheet))return;seen.add(sheet);
    let rules;try{rules=reflectApply(cssNatives.cssRules.get,sheet,[])}catch{return}
    const length=reflectApply(cssNatives.cssRuleListLength.get,rules,[]);
    for(let index=0;index<length;index+=1){
      const rule=reflectApply(cssNatives.cssRuleListItem,rules,[index]);if(!rule)continue;
      indexCSSProjectionValue(reflectApply(projectionNatives.cssRuleText.get,rule,[]));
      if(projectionNatives.cssImportStyleSheet?.get)try{indexStylesheetProjections(reflectApply(projectionNatives.cssImportStyleSheet.get,rule,[]),seen)}catch{}
    }
  }
  function indexLinkedStylesheetProjections(event){const element=event.target;if(!isHTMLElementNamed(element,"link")||!projectionNatives.linkSheet?.get)return;try{indexStylesheetProjections(reflectApply(projectionNatives.linkSheet.get,element,[]))}catch{}}
  function stageCSSSurfaces(){
  if(!cssNatives.htmlStyle?.get||!cssNatives.htmlStyle.configurable)throw new Error("HTML style descriptor unavailable");
  stage(HTMLElement.prototype,"style",{...cssNatives.htmlStyle,get(){return inlineStyleFacade(this,cssNatives.htmlStyle)},configurable:false});
  if(cssNatives.svgStyle?.get&&cssNatives.svgStyle.configurable)stage(SVGElement.prototype,"style",{...cssNatives.svgStyle,get(){return inlineStyleFacade(this,cssNatives.svgStyle)},configurable:false});
  if(!cssNatives.cssText?.get||!cssNatives.cssText?.set||!cssNatives.cssText.configurable)throw new Error("CSS text descriptor unavailable");
  stage(CSSStyleDeclaration.prototype,"cssText",{...cssNatives.cssText,get(){const state=styleFacadeState.get(this);if(!state)return virtualCSSValue(reflectApply(cssNatives.cssText.get,this,[]),null);const value=reflectApply(cssNatives.cssText.get,state.nativeStyle,[]);return state.owner?virtualCSSValue(reflectApply(cssNatives.cssText.get,visibleStyle(state.owner,state.nativeStyle),[]),state.owner):virtualCSSValue(value,null)},set(value){blockDynamicCSS(value);const state=styleFacadeState.get(this);if(state?.owner)clearVisibleAttribute(state.owner,"style");reflectApply(cssNatives.cssText.set,state?.nativeStyle??this,[value])},configurable:false});
  if(projectionNatives.styleSheetHref?.get&&projectionNatives.styleSheetHref.configurable)stage(StyleSheet.prototype,"href",{...projectionNatives.styleSheetHref,get(){return visibleResourceURL(reflectApply(projectionNatives.styleSheetHref.get,this,[]),"target")},configurable:false});
  if(projectionNatives.cssRuleText?.get&&projectionNatives.cssRuleText.configurable)stage(CSSRule.prototype,"cssText",{...projectionNatives.cssRuleText,get(){return virtualCSSValue(reflectApply(projectionNatives.cssRuleText.get,this,[]),null,"raw")},set:projectionNatives.cssRuleText.set?function(value){blockDynamicCSS(value);return reflectApply(projectionNatives.cssRuleText.set,this,[value])}:undefined,configurable:false});
  if(globalThis.CSSImportRule&&projectionNatives.cssImportHref?.get&&projectionNatives.cssImportHref.configurable)stage(CSSImportRule.prototype,"href",{...projectionNatives.cssImportHref,get(){return visibleResourceURL(reflectApply(projectionNatives.cssImportHref.get,this,[]),"target")},configurable:false});
  stage(CSSStyleDeclaration.prototype,"setProperty",{value:function(name,value,priority){blockDynamicCSS(value);const state=styleFacadeState.get(this);return reflectApply(cssNatives.setProperty,state?.nativeStyle??this,[name,value,priority])},writable:false,enumerable:true,configurable:false});
  stage(CSSStyleDeclaration.prototype,"removeProperty",{value:function(){throw new NativeDOMException("Dynamic CSS requires a controlled rewrite","SecurityError")},writable:false,enumerable:true,configurable:false});
  stage(CSSStyleSheet.prototype,"insertRule",{value:function(rule,index){blockDynamicCSS(rule);return reflectApply(cssNatives.insertRule,this,[rule,index])},writable:false,enumerable:true,configurable:false});
  if(cssNatives.addRule)stage(CSSStyleSheet.prototype,"addRule",{value:function(selector,style,index){const convertedSelector=NativeString(selector),convertedStyle=NativeString(style);blockDynamicCSS(`${convertedSelector}{${convertedStyle}}`);return reflectApply(cssNatives.addRule,this,[convertedSelector,convertedStyle,index])},writable:false,enumerable:true,configurable:false});
  if(globalThis.StylePropertyMap)for(const entry of [["set",cssNatives.styleMapSet],["append",cssNatives.styleMapAppend]])if(typeof entry[1]==="function")stage(StylePropertyMap.prototype,entry[0],{...natives.getOwnPropertyDescriptor(StylePropertyMap.prototype,entry[0]),value:function(){throw new NativeDOMException("Dynamic CSS Typed OM requires a controlled rewrite","SecurityError")},writable:false,configurable:false});
  if(cssNatives.replace)stage(CSSStyleSheet.prototype,"replace",{value:function(text){blockDynamicCSS(text);return reflectApply(cssNatives.replace,this,[text])},writable:false,enumerable:true,configurable:false});
  if(cssNatives.replaceSync)stage(CSSStyleSheet.prototype,"replaceSync",{value:function(text){blockDynamicCSS(text);return reflectApply(cssNatives.replaceSync,this,[text])},writable:false,enumerable:true,configurable:false});
  stageAdoptedStyleSheets(Document.prototype,cssNatives.documentAdoptedStyleSheets);
  stageAdoptedStyleSheets(ShadowRoot.prototype,cssNatives.shadowAdoptedStyleSheets);
  stageCSSRuleStyles();
  }
  stageCSSSurfaces();
  stageListener(document,"load",indexLinkedStylesheetProjections,true);
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
