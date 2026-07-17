export const runtimeSections = [
  { file: import.meta.url, name: "navigation_section_22", order: 22, phase: "inner" },
  { file: import.meta.url, name: "navigation_section_29", order: 29, phase: "inner" },
];

export function navigation_section_22() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const blockedNavigation=function(){throw new NativeDOMException("Navigation is unavailable","SecurityError")};
  function navigationBlocker(native){return mirrorFunction(function(){return blockedNavigation()},native)}
  function controlledNavigationTarget(value){const target=new NativeURL(NativeString(value),visibleBase()),protocol=urlProperty(target,"protocol"),portText=urlProperty(target,"port"),port=portText===""?(protocol==="https:"?443:80):NativeNumber(portText);if((protocol!=="http:"&&protocol!=="https:")||urlCredential(target,"username")!==""||urlCredential(target,"password")!==""||!reflectApply(arrayIncludes,approvedPorts,[port]))throw new NativeDOMException("Navigation target blocked","SecurityError");return urlProperty(target,"href")}
  function requestNavigation(value,replace=false,targetWindow=rawWindow){const navigation=sealedNavigationRoute(value),targetLocation=targetWindow.location;return replace?reflectApply(navigationNatives.locationReplace,targetLocation,[navigation.route]):reflectApply(navigationNatives.locationAssign,targetLocation,[navigation.route])}
  function locationComponent(name,value){const target=new NativeURL(parsedInitialTarget.href);reflectApply(reflectGet(urlNatives,name).set,target,[NativeString(value)]);requestNavigation(urlProperty(target,"href"))}
  function sealedNavigationRoute(value){const target=controlledNavigationTarget(value),route=sealedOpaqueRoute("navigation",target);if(route===null)throw new NativeDOMException("Navigation route unavailable","SecurityError");return{route,target}}
  function controlledOpenPlan(url,target,features){
    const targetName=NativeString(target),rawURL=NativeString(url),route=rawURL===""?"":sealedNavigationRoute(rawURL).route,arguments_=[route,targetName];
    if(features!==undefined)reflectApply(arrayPush,arguments_,[features]);
    return{arguments_};
  }
  function controlledPopupResult(popup){
    if(!popup)return null;
    return popup===rawWindow?windowFacade:crossWindowFacade(popup);
  }
  const controlledOpen=mirrorFunction(function(url="",target="_blank",features){
    const plan=controlledOpenPlan(url,target,features);
    return controlledPopupResult(reflectApply(documentNatives.open,rawWindow,plan.arguments_));
  },documentNatives.open)
  const blockedHistoryBack=mirrorFunction(function(){return reflectApply(navigationNatives.back,this,[])},navigationNatives.back),blockedHistoryForward=mirrorFunction(function(){return reflectApply(navigationNatives.forward,this,[])},navigationNatives.forward),blockedHistoryGo=mirrorFunction(function(delta){return reflectApply(navigationNatives.go,this,[delta])},navigationNatives.go);
  const historyTargets=new PrivateMap;
  function historyLocationKey(){return `${rawWindow.location.pathname}${rawWindow.location.search}${rawWindow.location.hash}`}
  function updateVisibleHistoryTarget(target){
    parsedInitialTarget=targetURLRecord(new NativeURL(target));
    fallbackBase=parsedInitialTarget.href;
  }
  function historyTarget(value){
    const target=new NativeURL(NativeString(value),visibleBase());
    if(
      urlProperty(target,"protocol")!==parsedInitialTarget.protocol
      ||urlCredential(target,"username")!==parsedInitialTarget.username
      ||urlCredential(target,"password")!==parsedInitialTarget.password
      ||urlProperty(target,"host")!==parsedInitialTarget.host
    )throw new NativeDOMException("History URL must remain same-origin","SecurityError");
    return urlProperty(target,"href");
  }
  function historyFailureOracleIsSafe(value){
    try{return urlProperty(new NativeURL(value,rawWindow.location.href),"origin")!==rawWindow.location.origin}
    catch{return true}
  }
  function nativeHistoryFailure(receiver,state,title,url,replace){
    return reflectApply(replace?navigationNatives.replaceState:navigationNatives.pushState,receiver,[state,title,url]);
  }
  function resolveHistoryTarget(receiver,state,title,url,replace){
    try{return{native:false,target:historyTarget(url)}}
    catch(error){
      if(historyFailureOracleIsSafe(url))return{native:true,result:nativeHistoryFailure(receiver,state,title,url,replace)};
      if(typeof NativeStructuredClone==="function")NativeStructuredClone(state);
      throw error;
    }
  }
  function sealedHistoryPath(target){
    let token;
    try{token=history_crypto.seal_history_v2(runtimeCapability,historyEntryID,target)}
    catch{throw new NativeDOMException("History route unavailable","SecurityError")}
    const route=typeof token==="string"?__zpBuildHistoryRoute((expression,value)=>reflectApply(regexpTest,expression,[value]),historyEntryID,token):null;
    if(route===null)throw new NativeDOMException("History route unavailable","SecurityError");
    return route;
  }
  function commitHistoryTarget(receiver,state,title,target,replace){
    const path=sealedHistoryPath(target),result=reflectApply(replace?navigationNatives.replaceState:navigationNatives.pushState,receiver,[state,title,path]);
    if(rawWindow.location.pathname===path){
      historyTargets.set(path,target);
      updateVisibleHistoryTarget(target);
    }
    return result;
  }
  function historyURLResolution(receiver,state,title,url,hasURL,replace){
    if(url===null||url===undefined)return{handled:true,result:reflectApply(replace?navigationNatives.replaceState:navigationNatives.pushState,receiver,hasURL?[state,title,url]:[state,title])};
    const convertedURL=`${url}`;
    if(convertedURL==="")return{handled:true,result:reflectApply(replace?navigationNatives.replaceState:navigationNatives.pushState,receiver,[state,title,convertedURL])};
    return{handled:false,url:convertedURL};
  }
  function updateHistoryEntry(receiver,state,title,url,hasURL,replace){
    reflectApply(historyNatives.state.get,receiver,[]);
    const convertedTitle=`${title}`,urlResolution=historyURLResolution(receiver,state,convertedTitle,url,hasURL,replace);
    if(urlResolution.handled)return urlResolution.result;
    const resolution=resolveHistoryTarget(receiver,state,convertedTitle,urlResolution.url,replace);
    return resolution.native?resolution.result:commitHistoryTarget(receiver,state,convertedTitle,resolution.target,replace);
  }
  historyTargets.set(historyLocationKey(),parsedInitialTarget.href);
  const updateHistoryAfterTraversal=()=>{
    const target=historyTargets.get(historyLocationKey());
    if(target)updateVisibleHistoryTarget(target);
  };
  stageListener(rawWindow,"popstate",updateHistoryAfterTraversal);
  const locationFacade=Object.freeze(objectSetPrototypeOf({get href(){return parsedInitialTarget.href},set href(value){requestNavigation(value)},get origin(){return parsedInitialTarget.origin},get protocol(){return parsedInitialTarget.protocol},set protocol(value){locationComponent("protocol",value)},get host(){return parsedInitialTarget.host},set host(value){locationComponent("host",value)},get hostname(){return parsedInitialTarget.hostname},set hostname(value){locationComponent("hostname",value)},get port(){return parsedInitialTarget.port},set port(value){locationComponent("port",value)},get pathname(){return parsedInitialTarget.pathname},set pathname(value){locationComponent("pathname",value)},get search(){return parsedInitialTarget.search},set search(value){locationComponent("search",value)},get hash(){return parsedInitialTarget.hash},set hash(value){locationComponent("hash",value)},assign(value){requestNavigation(value)},replace(value){requestNavigation(value,true)},reload(){blockedNavigation()},toString(){return parsedInitialTarget.href},valueOf(){return this}}, Location.prototype))
  function mirrorLocationFacadeMethods(){for(const [method,native] of [["assign",navigationNatives.locationAssign],["replace",navigationNatives.locationReplace],["reload",navigationNatives.locationReload]])mirrorFunction(locationFacade[method],native)}
  mirrorLocationFacadeMethods();
  const protectedFacadeEvalDescriptor={...evalDescriptor,value:indirectEval,writable:false,configurable:false};
  const windowFacadeTarget=objectCreate(null),scopeTarget=objectCreate(null);
  natives.defineProperty(windowFacadeTarget,"eval",protectedFacadeEvalDescriptor);
  natives.defineProperty(scopeTarget,"eval",protectedFacadeEvalDescriptor);
  function protectedEvalDescriptorMatches(descriptor,value){return descriptor&&"value"in descriptor&&descriptor.value===value&&descriptor.writable===false&&descriptor.configurable===false&&descriptor.enumerable===evalDescriptor.enumerable}
  function evalDescriptorsPrepared(){
    const rawDescriptor=natives.getOwnPropertyDescriptor(rawWindow,"eval");
    return rawDescriptor&&"value"in rawDescriptor&&rawDescriptor.value===natives.eval&&rawDescriptor.writable===false&&rawDescriptor.configurable===true&&rawDescriptor.enumerable===evalDescriptor.enumerable
      &&protectedEvalDescriptorMatches(natives.getOwnPropertyDescriptor(windowFacadeTarget,"eval"),indirectEval)
      &&protectedEvalDescriptorMatches(natives.getOwnPropertyDescriptor(scopeTarget,"eval"),indirectEval);
  }
  function evalDescriptorsHealthy(){return protectedEvalDescriptorMatches(natives.getOwnPropertyDescriptor(rawWindow,"eval"),natives.eval)&&protectedEvalDescriptorMatches(natives.getOwnPropertyDescriptor(windowFacadeTarget,"eval"),indirectEval)&&protectedEvalDescriptorMatches(natives.getOwnPropertyDescriptor(scopeTarget,"eval"),indirectEval)}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function navigation_section_29() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const svgURLAttributeOwners=new PrivateWeakMap();
  function stageSVGURLProperty(prototype,descriptor){
    if(!prototype||!descriptor?.get||!descriptor.configurable)return;
    stage(prototype,"href",{...descriptor,get(){const value=reflectApply(descriptor.get,this,[]);svgURLAttributeOwners.set(value,this);return value},configurable:false});
  }
  function stageSVGURLSurfaces(){
    stageSVGURLProperty(globalThis.SVGImageElement?.prototype,svgURLNatives.imageHref);
    stageSVGURLProperty(globalThis.SVGUseElement?.prototype,svgURLNatives.useHref);
    stageSVGURLProperty(globalThis.SVGScriptElement?.prototype,svgURLNatives.scriptHref);
    const base=svgURLNatives.animatedBaseVal,animated=svgURLNatives.animatedAnimVal;
    if(!base?.get||!base?.set||!base.configurable||!animated?.get||!animated.configurable)throw new Error("SVG URL descriptor unavailable");
    stage(SVGAnimatedString.prototype,"baseVal",{...base,get(){const owner=svgURLAttributeOwners.get(this);return owner?visibleAttribute(owner,"href","url")??reflectApply(base.get,this,[]):reflectApply(base.get,this,[])},set(value){const converted=NativeString(value),owner=svgURLAttributeOwners.get(this);if(!owner){reflectApply(base.set,this,[converted]);return}if(setControlledDynamicAttribute(owner,"href",converted,internal=>reflectApply(base.set,this,[internal])))return;clearVisibleAttribute(owner,"href");reflectApply(base.set,this,[converted])},configurable:false});
    stage(SVGAnimatedString.prototype,"animVal",{...animated,get(){const owner=svgURLAttributeOwners.get(this);return owner?visibleAttribute(owner,"href","url")??reflectApply(animated.get,this,[]):reflectApply(animated.get,this,[])},configurable:false});
  }
  function projectedHyperlinkURL(element){const target=visibleAttribute(element,"href","url");return target===undefined?null:new NativeURL(target,visibleBase())}
  function setProjectedHyperlinkHref(element,entry,value){const converted=NativeString(value),apply=internal=>reflectApply(entry.href.set,element,[internal]);if(setControlledDynamicAttribute(element,"href",converted,apply))return;clearVisibleAttribute(element,"href");apply(converted)}
  function stageHyperlinkProjection(entry){
    if(!entry.href?.get||!entry.href?.set)throw new Error("Hyperlink href descriptor unavailable");
    for(const property of["origin","protocol","username","password","host","hostname","port","pathname","search","hash"]){
      const descriptor=entry.descriptors[property];if(!descriptor?.get||!descriptor.configurable)throw new Error(`Hyperlink descriptor unavailable: ${property}`);
      const projected={...descriptor,get(){const nativeValue=reflectApply(descriptor.get,this,[]),url=projectedHyperlinkURL(this);if(url===null)return nativeValue;return property==="username"||property==="password"?urlCredential(url,property):urlProperty(url,property)},configurable:false};
      if(descriptor.set)projected.set=function(value){const url=projectedHyperlinkURL(this);if(url===null){reflectApply(descriptor.set,this,[value]);return}const urlDescriptor=property==="username"||property==="password"?reflectGet(urlCredentialNatives,property):reflectGet(urlNatives,property);reflectApply(urlDescriptor.set,url,[NativeString(value)]);setProjectedHyperlinkHref(this,entry,urlProperty(url,"href"))};
      stage(entry.prototype,property,projected);
    }
    if(!entry.toString?.value||!entry.toString.configurable)throw new Error("Hyperlink toString descriptor unavailable");
    stage(entry.prototype,"toString",{...entry.toString,value:function(){const nativeValue=reflectApply(entry.toString.value,this,[]);return visibleAttribute(this,"href","url")??nativeValue},writable:false,configurable:false});
  }
  function stageCurrentSource(prototype,property,descriptor){if(!descriptor?.get||!descriptor.configurable)throw new Error(`Current source descriptor unavailable: ${property}`);stage(prototype,property,{...descriptor,get(){const value=reflectApply(descriptor.get,this,[]);return value===""?value:visibleResourceURL(value,"target")},configurable:false})}
  function stageCustomizedBuiltInGuard(){
    const prototype=globalThis.CustomElementRegistry?.prototype,native=customElementNatives.define;
    if(!prototype||!native)return;
    const descriptor=natives.getOwnPropertyDescriptor(prototype,"define");
    if(!descriptor?.configurable)throw new Error("Custom element definition descriptor unavailable");
    const guarded=mirrorFunction(function(name,constructor,options){if(arguments.length<3)return reflectApply(native,this,arrayFrom(arguments));const extension=options==null?undefined:options.extends;if(extension!==undefined)throw new NativeDOMException("Customized built-ins are unavailable","SecurityError");return reflectApply(native,this,[name,constructor])},native);
    stage(prototype,"define",{...descriptor,value:guarded,writable:false,configurable:false});
  }
  function stageNavigationSurfaces(){
  stageCustomizedBuiltInGuard();
  if(globalThis.Navigation)for(const [name,native] of [["navigate",navigationNatives.navigate],["back",navigationNatives.backNavigation],["forward",navigationNatives.forwardNavigation],["reload",navigationNatives.reloadNavigation],["traverseTo",navigationNatives.traverseTo]])if(native)stage(globalThis.Navigation.prototype,name,{value:navigationBlocker(native),writable:false,enumerable:true,configurable:false});
  for(const entry of [[HTMLAnchorElement.prototype,"href","href"],[HTMLAreaElement.prototype,"href","href"],[HTMLFormElement.prototype,"action","action"],[HTMLInputElement.prototype,"formAction","formaction"],[HTMLButtonElement.prototype,"formAction","formaction"],[HTMLIFrameElement.prototype,"src","src"],[HTMLImageElement.prototype,"src","src"],[HTMLInputElement.prototype,"src","src"],[HTMLScriptElement.prototype,"src","src"],[HTMLLinkElement.prototype,"href","href"],[HTMLSourceElement.prototype,"src","src"],[HTMLVideoElement.prototype,"src","src"],[HTMLVideoElement.prototype,"poster","poster"],[HTMLAudioElement.prototype,"src","src"],[HTMLTrackElement.prototype,"src","src"],[HTMLObjectElement.prototype,"data","data"],[HTMLEmbedElement.prototype,"src","src"],[HTMLBodyElement.prototype,"background","background"]])stageURLProperty(entry[0],entry[1],entry[2]);
  if(globalThis.HTMLFrameElement)stageURLProperty(HTMLFrameElement.prototype,"src","src");
  stageReflectedProperty(HTMLImageElement.prototype,"srcset","srcset",projectionNatives.imageSrcset,true);
  stageReflectedProperty(HTMLLinkElement.prototype,"imageSrcset","imagesrcset",projectionNatives.linkImageSrcset,true);
  stageReflectedProperty(HTMLSourceElement.prototype,"srcset","srcset",projectionNatives.sourceSrcset,true);
  stageReflectedProperty(HTMLAnchorElement.prototype,"ping","ping",projectionNatives.anchorPing,true);
  stageReflectedProperty(HTMLAreaElement.prototype,"ping","ping",projectionNatives.areaPing,true);
  for(let index=0;index<hyperlinkProjectionNatives.length;index+=1)stageHyperlinkProjection(hyperlinkProjectionNatives[index]);
  stageCurrentSource(HTMLImageElement.prototype,"currentSrc",projectionNatives.imageCurrentSrc);
  stageCurrentSource(HTMLMediaElement.prototype,"currentSrc",projectionNatives.mediaCurrentSrc);
  stageSVGURLSurfaces();
  stageReflectedProperty(HTMLElement.prototype,"nonce","nonce",reflectedNatives.nonce);
  stageReflectedProperty(HTMLScriptElement.prototype,"type","type",reflectedNatives.scriptType,true);
  stageReflectedProperty(HTMLScriptElement.prototype,"integrity","integrity",reflectedNatives.scriptIntegrity);
  stageReflectedProperty(HTMLLinkElement.prototype,"integrity","integrity",reflectedNatives.linkIntegrity);
  stageReflectedProperty(HTMLMetaElement.prototype,"httpEquiv","http-equiv",reflectedNatives.metaHttpEquiv,true);
  stageReflectedProperty(HTMLMetaElement.prototype,"content","content",reflectedNatives.metaContent,true);
  }
  stageNavigationSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
