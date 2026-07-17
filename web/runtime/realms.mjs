export const runtimeSections = [
  { file: import.meta.url, name: "realms_section_23", order: 23, phase: "inner" },
  { file: import.meta.url, name: "realms_section_25", order: 25, phase: "inner" },
  { file: import.meta.url, name: "realms_section_27", order: 27, phase: "inner" },
];

export function realms_section_23() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const selfIdentityKeys=new PrivateSet(["window","self","globalThis","frames"]),relationshipKeys=new PrivateSet(["top","parent","opener"]),relationshipFacades=new PrivateMap,virtualWindowValues=new PrivateMap([["Function",FunctionFacade],["Request",RequestFacade],["location",locationFacade],["open",controlledOpen],["getComputedStyle",safeGetComputedStyle]]);
  for(const [name,blocker] of disabledNetworkConstructors)virtualWindowValues.set(name,blocker);
  const windowReceiverKeys=new PrivateSet(["addEventListener","removeEventListener","dispatchEvent","getComputedStyle","getSelection","matchMedia","requestAnimationFrame","cancelAnimationFrame","requestIdleCallback","cancelIdleCallback","scroll","scrollBy","scrollTo","moveBy","moveTo","resizeBy","resizeTo","focus","blur","close","stop","print","postMessage","captureEvents","releaseEvents","find"]),receiverFacadeByNative=new PrivateWeakMap();
  let containedSelfFacade,containedKeepaliveFetch;
  function identityFacade(key){if(selfIdentityKeys.has(key))return containedSelfFacade??windowFacade;if(relationshipFacades.has(key))return relationshipFacades.get(key);const value=reflectGet(rawWindow,key,rawWindow),facade=value===null?null:messageSourceFacade(value);relationshipFacades.set(key,facade);return facade}
  function containedWindowValue(value){try{return value!==null&&(typeof value==="object"||typeof value==="function")&&value.window===value&&value.self===value&&typeof value.eval==="function"}catch{return false}}
  const crossWindowRestrictedKeys=new PrivateSet(["document","location","fetch","Worker","SharedWorker","XMLHttpRequest","navigator","localStorage","sessionStorage","indexedDB","caches"]);
  for(const name of disabledNetworkConstructorNames)crossWindowRestrictedKeys.add(name);
  function crossWindowProperty(value,facade,methods,key){
    if(methods.has(key))return methods.get(key);
    if(key==="closed")return NativeBoolean(reflectGet(value,"closed",value));
    if(selfIdentityKeys.has(key))return facade;
    if(relationshipKeys.has(key)){const related=reflectGet(value,key,value);return related===value?facade:messageSourceFacade(related)}
    if(typeof key==="string"&&crossWindowRestrictedKeys.has(key))throw new NativeDOMException("Cross-origin window access denied","SecurityError");
  }
  function crossWindowHas(key){return key==="closed"||key==="opener"||selfIdentityKeys.has(key)||relationshipKeys.has(key)||includesValue(["postMessage","close","focus","blur"],key)}
  function revokeContainedWindow(value){
    containedDocuments.delete(value);
    upgradedContainedWindows.delete(value);
    facadeByRaw.delete(value);
  }
  function activeContainedWindow(value){
    const installed=upgradedContainedWindows.get(value);
    if(!installed)return;
    if(!sameSyntheticOrigin(value)){revokeContainedWindow(value);return}
    if(containedDocuments.get(value)!==value.document){
      instrumentContainedRealm(value);
      return upgradedContainedWindows.get(value);
    }
    return installed;
  }
  function crossWindowFacade(value){
    let facade=crossWindowFacades.get(value);
    if(facade)return facade;
    const target=objectCreate(null),methods=new PrivateMap;
    methods.set("postMessage",mirrorFunction(function(message,targetOriginOrOptions,transfer){return reflectApply(controlledPostMessage,value,[message,targetOriginOrOptions,transfer])},messageNatives.postMessage));
    methods.set("close",mirrorFunction(function(){return reflectApply(reflectGet(value,"close",value),value,[])},popupNatives.close));
    methods.set("focus",mirrorFunction(function(){return reflectApply(reflectGet(value,"focus",value),value,[])},popupNatives.focus));
    methods.set("blur",mirrorFunction(function(){return reflectApply(reflectGet(value,"blur",value),value,[])},popupNatives.blur));
    facade=new NativeProxy(target,{get(_target,key){const installed=activeContainedWindow(value);return installed?containedWindowProperty(value,installed,facade,methods,key):crossWindowProperty(value,facade,methods,key)},set(_target,key,next){const installed=activeContainedWindow(value);if(installed)return reflectSet(installed,key,next,installed);throw new NativeDOMException("Cross-origin window access denied","SecurityError")},defineProperty(_target,key,descriptor){const installed=activeContainedWindow(value);if(installed)return reflectDefineProperty(installed,key,descriptor);throw new NativeDOMException("Cross-origin window access denied","SecurityError")},deleteProperty(_target,key){const installed=activeContainedWindow(value);if(installed)return reflectDeleteProperty(installed,key);throw new NativeDOMException("Cross-origin window access denied","SecurityError")},has(_target,key){const installed=activeContainedWindow(value);return installed?key in installed:crossWindowHas(key)},ownKeys(){const installed=activeContainedWindow(value);return installed?reflectOwnKeys(installed):[]},getOwnPropertyDescriptor(_target,key){const installed=activeContainedWindow(value);return installed?containedWindowDescriptor(value,installed,facade,methods,key):undefined},getPrototypeOf(){return Window.prototype},preventExtensions(){return false}});
    crossWindowFacades.set(value,facade);
    return facade;
  }
  function containedWindowProperty(value,installed,facade,methods,key){
    if(methods.has(key))return methods.get(key);
    if(selfIdentityKeys.has(key))return facade;
    if(relationshipKeys.has(key)){const related=reflectGet(value,key,value);return related===value?facade:messageSourceFacade(related)}
    if(disabledNetworkConstructors.has(key))return disabledNetworkConstructors.get(key);
    return facadeValue(reflectGet(installed,key,installed));
  }
  function containedWindowDescriptor(value,installed,facade,methods,key){
    const descriptor=reflectGetOwnPropertyDescriptor(installed,key);
    if(!descriptor)return;
    const visible={...descriptor,configurable:true};
    if("value"in visible)visible.value=containedWindowProperty(value,installed,facade,methods,key);
    return visible;
  }
  function containedWindowFacade(value,installed){
    upgradedContainedWindows.set(value,installed);
    const facade=containedWindowFacades.get(value)??crossWindowFacade(value);
    containedWindowFacades.set(value,facade);
    containedWindowFacades.set(installed,facade);
    return facade;
  }
  function relationshipSourceFacade(value){
    for(const key of relationshipKeys)if(relationshipFacades.has(key)&&value===reflectGet(rawWindow,key,rawWindow))return{found:true,facade:relationshipFacades.get(key)};
    return{found:false};
  }
  function containedMessageSourceFacade(value){
    try{if(isDocumentNode(value.document))return facadeValue(value)}
    catch{}
  }
  function messageSourceFacade(value){
    if(!value)return value;
    const relationship=relationshipSourceFacade(value);
    if(relationship.found)return relationship.facade;
    if(value===rawWindow)return containedSelfFacade??windowFacade;
    return containedMessageSourceFacade(value)??crossWindowFacade(value);
  }
  function facadeValue(value){if(value===windowFacade)return containedSelfFacade??value;if(containedDocuments.has(value))return instrumentContainedRealm(value);const facade=facadeByRaw.get(value);if(facade)return facade;if(containedWindowValue(value))return instrumentContainedRealm(value);return crossWindowFacades.get(value)??value}
  function facadePropertyValue(key,value){const mapped=facadeValue(value);if(mapped!==value||typeof value!=="function"||!windowReceiverKeys.has(key))return mapped;let facade=receiverFacadeByNative.get(value);if(!facade){facade=new NativeProxy(value,{apply(target,thisArg,args){return reflectApply(target,rawWindowByFacade.get(thisArg)??(thisArg===windowFacade?rawWindow:thisArg),args)}});receiverFacadeByNative.set(value,facade)}return facade}
  const windowFacade=new NativeProxy(windowFacadeTarget,{get(target,key){if(key===abiName)return undefined;if(selfIdentityKeys.has(key)||relationshipKeys.has(key))return identityFacade(key);if(key==="eval")return reflectGet(target,key);if(virtualWindowValues.has(key))return virtualWindowValues.get(key);return facadePropertyValue(key,reflectGet(rawWindow,key,rawWindow))},set(target,key,value){if(key==="eval")return reflectSet(target,key,value);if (key === "location") { requestNavigation(value); return true; }return reflectSet(rawWindow,key,value,rawWindow)},defineProperty(target,key,descriptor){if(key==="eval")return reflectDefineProperty(target,key,descriptor);if (key === "location") { requestNavigation(descriptor?.value); return true; }return reflectDefineProperty(rawWindow,key,descriptor)},deleteProperty(target,key){if(key==="eval")return reflectDeleteProperty(target,key);return reflectDeleteProperty(rawWindow,key)},has(target,key){if(key===abiName)return false;return Reflect.has(target,key)||key in rawWindow},ownKeys(target){const keys=reflectApply(arrayFilter, reflectOwnKeys(rawWindow), [key=>key!==abiName]);if(!includesValue(keys, "eval"))reflectApply(arrayPush, keys, ["eval"]);return keys},getOwnPropertyDescriptor(target,key){const own=reflectGetOwnPropertyDescriptor(target,key);if(own)return own;if(key===abiName)return undefined;const descriptor=reflectGetOwnPropertyDescriptor(rawWindow,key);if(!descriptor)return undefined;if(selfIdentityKeys.has(key)||relationshipKeys.has(key))return{value:identityFacade(key),writable:false,enumerable:descriptor.enumerable,configurable:true};if(virtualWindowValues.has(key))return{value:virtualWindowValues.get(key),writable:false,enumerable:descriptor.enumerable,configurable:true};if("value"in descriptor)return{...descriptor,value:facadePropertyValue(key,descriptor.value),configurable:true};return{...descriptor,configurable:true}},getPrototypeOf(){return Window.prototype},preventExtensions(){return false}});facadeByRaw.set(rawWindow,windowFacade);facadeByRaw.set(windowFacade,windowFacade);
  const scope = new NativeProxy(scopeTarget, {get(_target,key){if(selfIdentityKeys.has(key)||relationshipKeys.has(key))return identityFacade(key);if (key === "eval") return reflectGet(scopeTarget, key);if(virtualWindowValues.has(key))return virtualWindowValues.get(key);return facadePropertyValue(key,reflectGet(rawWindow,key,rawWindow))}, set(_target, key, value) { if (key === "eval") return reflectSet(scopeTarget, key, value); if (key === "location") { requestNavigation(value); return true; }return reflectSet(rawWindow,key,value,rawWindow) }, deleteProperty(_target, key) { if (key === "eval") return reflectDeleteProperty(scopeTarget, key); return reflectDeleteProperty(rawWindow, key) }, defineProperty(_target, key, descriptor) { if (key === "eval") return reflectDefineProperty(scopeTarget, key, descriptor); if (key === "location") { requestNavigation(descriptor?.value); return true; }return reflectDefineProperty(rawWindow,key,descriptor) }, has(_target, key) { if (key === "eval") return true; return key in rawWindow }, ownKeys(){return reflectOwnKeys(rawWindow)}, getOwnPropertyDescriptor(_target, key) { if (key === "eval") return reflectGetOwnPropertyDescriptor(scopeTarget, key); const descriptor=reflectGetOwnPropertyDescriptor(rawWindow,key);return descriptor&&("value" in descriptor?{...descriptor,value:facadePropertyValue(key,descriptor.value),configurable:true}:{...descriptor,configurable:true}) }})
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function realms_section_25() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function sameSyntheticOrigin(realm){try{return realm!==rawWindow&&isDocumentNode(realm.document)}catch{return false}}
  function inheritedDescriptor(value,key){let owner=natives.getPrototypeOf(value),descriptor;while(owner&&!(descriptor=natives.getOwnPropertyDescriptor(owner,key)))owner=natives.getPrototypeOf(owner);return descriptor}
  function existingContainedFacade(realm){try{const realmDocument=realm.document,rawEval=natives.getOwnPropertyDescriptor(realm,"eval"),defaultView=inheritedDescriptor(realmDocument,"defaultView"),candidate=defaultView&&reflectApply(defaultView.get,realmDocument,[]),facadeEval=candidate&&natives.getOwnPropertyDescriptor(candidate,"eval");if(candidate!==realm&&rawEval&&!rawEval.configurable&&!rawEval.writable&&defaultView&&!defaultView.configurable&&facadeEval&&!facadeEval.configurable&&!facadeEval.writable&&facadeEval.value!==rawEval.value&&candidate.window===candidate&&candidate.self===candidate&&candidate.document===realmDocument)return candidate}catch{}}
  function containedRuntimeABI(realm){
    let found=null;
    const keys=reflectOwnKeys(realm);
    for(let index=0;index<keys.length;index+=1){
      const key=keys[index];
      if(typeof key!=="string"||!reflectApply(regexpTest,/^__zp_abi_[a-f0-9]{48}$/,[key]))continue;
      const descriptor=reflectGetOwnPropertyDescriptor(realm,key);
      if(!descriptor||descriptor.enumerable||descriptor.configurable||descriptor.writable||!descriptor.value||typeof descriptor.value!=="object")continue;
      const register=reflectGetOwnPropertyDescriptor(descriptor.value,"registerContainedRelationships")?.value;
      const health=reflectGetOwnPropertyDescriptor(descriptor.value,"runtimeHealth")?.value;
      if(typeof register!=="function"||typeof health!=="function"||reflectApply(health,descriptor.value,[])!==true)continue;
      if(found!==null)throw new NativeDOMException("Contained realm ABI is ambiguous","SecurityError");
      found={register,value:descriptor.value};
    }
    return found;
  }
  function handoffContainedRelationships(realm,selfFacade){
    const parentFacade=containedSelfFacade??windowFacade,topFacade=identityFacade("top"),keepaliveFetch=containedKeepaliveFetch??executeKeepaliveFetch;
    if(!windowFacadeIdentity(selfFacade)||!windowFacadeIdentity(parentFacade)||!windowFacadeIdentity(topFacade))throw new NativeDOMException("Contained realm relationship source rejected","SecurityError");
    const childABI=containedRuntimeABI(realm);
    if(childABI===null)throw new NativeDOMException("Contained realm ABI unavailable","SecurityError");
    reflectApply(childABI.register,childABI.value,[selfFacade,parentFacade,topFacade,keepaliveFetch]);
  }
  function installContainedRuntime(realm){
    const rawEvalDescriptor=natives.getOwnPropertyDescriptor(realm,"eval");
    if(!rawEvalDescriptor?.configurable)throw new NativeDOMException("Contained realm handoff failed","SecurityError");
    const source=containedRuntimeSource(),childDocument=realm.document,childScript=childDocument.createElement("script");
    natives.defineProperty(childScript,"src",{value:runtimeURL.href,writable:false,enumerable:true,configurable:true});
    childScript.nonce=runtimeScript.nonce;
    childScript.dataset.zpRuntimeUrl=runtimeURL.href;
    childScript.dataset.zpAbi=nextRealmABI();
    childScript.dataset.zpTargetUrl=parsedInitialTarget.href;
    childScript.dataset.zpPorts=reflectApply(arrayJoin,approvedPorts,[","]);
    childScript.dataset.zpStrings=stringCompilationAllowed?"1":"0";
    childScript.textContent=source;
    reflectApply(insertionNatives.appendChild,childDocument.head??childDocument.documentElement,[childScript]);
    const installed=existingContainedFacade(realm);
    if(!installed)throw new NativeDOMException("Contained realm runtime installation failed","SecurityError");
    return installed;
  }
  function registerContainedFunctionReflection(realm,facade){
    const childFacade=reflectGet(facade,"Function",facade),childNative=reflectGet(realm,"Function",realm);
    if(typeof childFacade!=="function"||typeof childNative!=="function")throw new NativeDOMException("Contained realm Function reflection unavailable","SecurityError");
    functionSources.set(childFacade,reflectApply(functionToString,childNative,[]));
  }
  function instrumentContainedRealm(realm){
    if(!sameSyntheticOrigin(realm)){
      if(!containedDocuments.has(realm))return realm;
      revokeContainedWindow(realm);
      return crossWindowFacade(realm);
    }
    const realmDocument=realm.document,known=facadeByRaw.get(realm);
    if(known&&containedDocuments.get(realm)===realmDocument)return known;
    const installed=existingContainedFacade(realm)??installContainedRuntime(realm);
    registerContainedFunctionReflection(realm,installed);
    const contained=containedWindowFacade(realm,installed);
    containedDocuments.set(realm,realmDocument);
    try{handoffContainedRelationships(realm,contained)}
    catch(error){revokeContainedWindow(realm);throw error}
    facadeByRaw.set(realm,contained);
    facadeByRaw.set(installed,contained);
    rawWindowByFacade.set(contained,realm);
    return contained;
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function realms_section_27() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function containedDocumentValue(value){if(value){const view=reflectApply(documentNatives.defaultView.get,value,[]);if(view)facadeValue(view)}return value}
  function stageContentWindowAccessor(prototype,windowDescriptor,documentDescriptor){
    if(!prototype||!windowDescriptor?.get||!windowDescriptor.configurable)return false;
    stage(prototype,"contentWindow",{...windowDescriptor,get(){const value=reflectApply(windowDescriptor.get,this,[]);if(!value)return value;const childDocument=documentDescriptor?.get?reflectApply(documentDescriptor.get,this,[]):null;if(childDocument===null)return containedDocuments.has(value)?instrumentContainedRealm(value):crossWindowFacade(value);return facadeValue(value)},configurable:false});
    return true;
  }
  function stageContentDocumentAccessor(prototype,descriptor){
    if(!prototype||!descriptor?.get||!descriptor.configurable)return false;
    stage(prototype,"contentDocument",{...descriptor,get(){return containedDocumentValue(reflectApply(descriptor.get,this,[]))},configurable:false});
    return true;
  }
  function stageSVGDocumentAccessor(prototype,descriptor){
    if(!prototype||typeof descriptor?.value!=="function"||!descriptor.configurable)return;
    stage(prototype,"getSVGDocument",{...descriptor,value:function(){return containedDocumentValue(reflectApply(descriptor.value,this,[]))},writable:false,configurable:false});
  }
  function stageRealmAccessorSurfaces(){
  if(!eventNatives.view?.get||!eventNatives.view.configurable||!eventNatives.source?.get||!eventNatives.source.configurable)throw new Error("event Window descriptor unavailable");
  function visibleMessageOrigin(value){return syntheticToVirtualOrigins.get(value)??value}
  stage(Window.prototype,"postMessage",{value:controlledPostMessage,writable:false,enumerable:true,configurable:false});
  stage(UIEvent.prototype,"view",{...eventNatives.view,get(){return facadeValue(reflectApply(eventNatives.view.get, this, []))},configurable:false});
  stage(MessageEvent.prototype,"source",{...eventNatives.source,get(){return messageSourceFacade(reflectApply(eventNatives.source.get,this,[]))},configurable:false});
  if(eventNatives.origin?.get&&eventNatives.origin.configurable)stage(MessageEvent.prototype,"origin",{...eventNatives.origin,get(){return visibleMessageOrigin(reflectApply(eventNatives.origin.get,this,[]))},configurable:false});
  if(eventNatives.storageURL?.get&&eventNatives.storageURL.configurable)stage(StorageEvent.prototype,"url",{...eventNatives.storageURL,get(){const value=reflectApply(eventNatives.storageURL.get,this,[]);try{const url=new NativeURL(value);if(urlProperty(url,"origin")===rawWindow.location.origin)return new NativeURL(`${urlProperty(url,"pathname")}${urlProperty(url,"search")}${urlProperty(url,"hash")}`,parsedInitialTarget.origin).href}catch{}return value},configurable:false});
  if(!stageContentWindowAccessor(HTMLIFrameElement.prototype,frameNatives.iframeContentWindow,frameNatives.iframeContentDocument)||!stageContentDocumentAccessor(HTMLIFrameElement.prototype,frameNatives.iframeContentDocument))throw new Error("child realm descriptor unavailable");
  stageSVGDocumentAccessor(HTMLIFrameElement.prototype,frameNatives.iframeGetSVGDocument);
  if(globalThis.HTMLFrameElement){
    stageContentWindowAccessor(globalThis.HTMLFrameElement.prototype,frameNatives.frameContentWindow,frameNatives.frameContentDocument);
    stageContentDocumentAccessor(globalThis.HTMLFrameElement.prototype,frameNatives.frameContentDocument);
  }
  if(globalThis.HTMLObjectElement){
    stageContentWindowAccessor(globalThis.HTMLObjectElement.prototype,frameNatives.objectContentWindow,frameNatives.objectContentDocument);
    stageContentDocumentAccessor(globalThis.HTMLObjectElement.prototype,frameNatives.objectContentDocument);
    stageSVGDocumentAccessor(globalThis.HTMLObjectElement.prototype,frameNatives.objectGetSVGDocument);
  }
  if(globalThis.HTMLEmbedElement)stageSVGDocumentAccessor(globalThis.HTMLEmbedElement.prototype,frameNatives.embedGetSVGDocument);
  }
  stageRealmAccessorSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
