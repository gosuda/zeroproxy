export const runtimeSections = [
  { file: import.meta.url, name: "network_section_07", order: 7, phase: "inner" },
  { file: import.meta.url, name: "network_section_09", order: 9, phase: "inner" },
  { file: import.meta.url, name: "network_section_36", order: 36, phase: "inner" },
];

export function network_section_07() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function apiInputTarget(input,request){
    if(request)return new NativeURL(requestProperty(request,"url"));
    if(typeof input==="string")return new NativeURL(input,parsedInitialTarget.href);
    let href;
    try{href=urlProperty(input,"href")}catch{href=NativeString(input)}
    return new NativeURL(href,parsedInitialTarget.href);
  }
  function virtualizeAPITarget(target){
    if(urlProperty(target,"origin")!==rawWindow.location.origin)return target;
    const virtualPath=`${urlProperty(target,"pathname")}${urlProperty(target,"search")}`;
    return new NativeURL(virtualPath,`${parsedInitialTarget.origin}/`);
  }
  function validAPITarget(target){
    const protocol=urlProperty(target,"protocol"),portText=urlProperty(target,"port");
    const port=portText===""?(protocol==="https:"?443:80):NativeNumber(portText);
    return (protocol==="http:"||protocol==="https:")
      &&urlCredential(target,"username")===""
      &&urlCredential(target,"password")===""
      &&reflectApply(arrayIncludes,approvedPorts,[port]);
  }
  function controlledAPITarget(input,request){
    let target;
    try{target=virtualizeAPITarget(apiInputTarget(input,request))}
    catch{throw new NativeTypeError("Failed to fetch")}
    reflectApply(urlNatives.hash.set,target,[""]);
    if(!validAPITarget(target))throw new NativeTypeError("Failed to fetch");
    return urlProperty(target,"href");
  }
  function allocateAPIPlan(payload){
    const registered={...payload,body_handle:payload.body_expected?cookieOperationID():""};
    return cookieBarrier.catch(()=>{}).then(()=>runtimeCommand("ALLOCATE_API_PLAN",registered,"Failed to fetch")).then(result=>{
      if(!result||typeof result.path!=="string"||result.body_handle!==registered.body_handle)throw new NativeTypeError("Failed to fetch");
      return result;
    });
  }
  function runtimeConnectAllowed(targetURL){try{return typeof wasm_bindgen.policy_csp_allows_connect_json==="function"&&wasm_bindgen.policy_csp_allows_connect_json(jsonStringify(runtimePolicyContext),targetURL)===true}catch{return false}}
  function sealedOpaqueRoute(kind,targetURL){if(runtimeCapability==="")return null;const operation=cookieOperationID();try{const token=history_crypto.seal_history_v2(runtimeCapability,`${kind}:${operation}`,targetURL);return typeof token==="string"?__zpBuildSealedRoute((values,value)=>reflectApply(arrayIncludes,values,[value]),(expression,value)=>reflectApply(regexpTest,expression,[value]),kind,operation,token):null}catch{return null}}
  const controlledSendBeacon=mirrorFunction(function(url,data){try{const targetURL=controlledAPITarget(url),route=sealedOpaqueRoute("beacon",targetURL);return route===null?false:reflectApply(networkNatives.sendBeacon,this,[route,data])}catch{return false}},networkNatives.sendBeacon);
  const activeSealedFormActions=new PrivateWeakMap,activeSealedNavigationAttributes=new PrivateWeakMap;
  function visibleFormAction(form){return visibleAttribute(form,"action","url")??reflectApply(formNatives.action.get,form,[])}
  function visibleSubmitterAction(submitter){if(!isElementNode(submitter))return null;return visibleAttribute(submitter,"formaction","url")??reflectApply(attributeNatives.getAttribute,submitter,["formaction"])}
  function formActionTarget(value){return controlledAPITarget(new NativeURL(value,visibleBase()))}
  function sealFormAction(element,attribute,value,applyNative){const decision=policyDecision(element,attribute,value,"Document"),controlled=controlledRouteDecision(decision);if(controlled?.kind!=="Document")throw new NativeDOMException("Form action blocked","SecurityError");const target=controlledAPITarget(controlled.target),route=sealedOpaqueRoute("form",target);if(route===null)throw new NativeDOMException("Form route unavailable","SecurityError");commitDeferredNavigationRoute(element,attribute,value,target,route,applyNative);activeSealedFormActions.set(element,attribute)}
  function replaceSealedFormAction(element,attribute,value,applyNative){if(activeSealedFormActions.get(element)!==attribute)return false;sealFormAction(element,attribute,value,applyNative);return true}
  function sealedFormActionRemoval(element,attribute){if(activeSealedFormActions.get(element)===attribute)throw new NativeDOMException("Active form action is sealed","SecurityError")}
  function releaseSealedFormActions(form,submitter){reflectApply(promiseThen,reflectApply(promiseResolve,NativePromise,[]),[()=>{activeSealedFormActions.delete(form);if(isElementNode(submitter))activeSealedFormActions.delete(submitter)}])}
  function sealFormSubmission(form,submitter){try{const action=visibleFormAction(form);sealFormAction(form,"action",action,route=>reflectApply(natives.setAttribute,form,["action",route]));const submitterAction=visibleSubmitterAction(submitter);if(submitterAction!==null)sealFormAction(submitter,"formaction",submitterAction,route=>reflectApply(natives.setAttribute,submitter,["formaction",route]))}finally{releaseSealedFormActions(form,submitter)}}
  const controlledFormSubmit=mirrorFunction(function(){sealFormSubmission(this,undefined);return reflectApply(formNatives.submit,this,[])},formNatives.submit);
  const controlledFormRequestSubmit=mirrorFunction(function(submitter){return reflectApply(formNatives.requestSubmit,this,arguments.length?[submitter]:[])},formNatives.requestSubmit);
  function interceptFormSubmission(event){const form=event.target;if(!(form instanceof HTMLFormElement)||event.defaultPrevented)return;try{sealFormSubmission(form,event.submitter)}catch{reflectApply(eventNatives.preventDefault,event,[])}}
  stageListener(rawWindow,"submit",interceptFormSubmission,true);
  function safeDownloadFilename(value){return typeof value==="string"&&value.length>0&&value.length<=255&&!/[\u0000-\u001f\u007f\\/\r\n]/u.test(value)?value:null}
  function dispositionDownloadFilename(value,targetURL){
    if(typeof value==="string"){
      const parameters=reflectApply(stringSplit,value,[";"]);
      for(let index=1;index<parameters.length;index+=1){
        const parameter=reflectApply(stringTrim,parameters[index],[]),normalized=lower(parameter);
        let filename=null;
        if(reflectApply(stringStartsWith,normalized,["filename*=utf-8''"])){
          try{filename=nativeDecodeURIComponent(reflectApply(stringSlice,parameter,[17]))}catch{}
        }else if(reflectApply(stringStartsWith,normalized,["filename="])){
          filename=reflectApply(stringTrim,reflectApply(stringSlice,parameter,[9]),[]);
          if(filename.length>=2&&filename[0]==="\""&&filename[filename.length-1]==="\"")filename=reflectApply(stringSlice,filename,[1,-1]);
        }
        filename=safeDownloadFilename(filename);
        if(filename!==null)return filename;
      }
    }
    try{const target=new NativeURL(targetURL),segments=reflectApply(stringSplit,urlProperty(target,"pathname"),["/"]);for(let index=segments.length-1;index>=0;index-=1){if(segments[index]==="")continue;const decoded=nativeDecodeURIComponent(segments[index]),filename=safeDownloadFilename(decoded);if(filename!==null)return filename;break}}catch{}
    return"download";
  }
  const sealedDownloadActivations=new PrivateWeakSet;
  function activateSealedDownload(anchor,route,targetURL,event){
    const requestedFilename=reflectApply(attributeNatives.getAttribute,anchor,["download"]);
    reflectApply(promiseThen,reflectApply(promiseResolve,NativePromise,[]),[()=>{
      if(event.defaultPrevented)return;
      reflectApply(eventNatives.preventDefault,event,[]);
      const response=reflectApply(natives.fetch,rawWindow,[route,{credentials:"same-origin"}]);
      reflectApply(promiseThen,response,[downloadResponse=>{
        const responseHeaders=reflectApply(responseNatives.headers.get,downloadResponse,[]),disposition=reflectApply(headersNatives.get,responseHeaders,["Content-Disposition"]);
        const body=reflectApply(responseNatives.blob,downloadResponse,[]);
        return reflectApply(promiseThen,body,[blob=>{
          const blobURL=reflectApply(blobNatives.createObjectURL,NativeURL,[blob]);
          const activation=reflectApply(markupNatives.createElement,document,["a"]);
          reflectApply(natives.setAttribute,activation,["href",blobURL]);
          reflectApply(natives.setAttribute,activation,["download",requestedFilename||dispositionDownloadFilename(disposition,targetURL)]);
          const documentBody=reflectApply(documentNatives.body.get,document,[]);
          reflectApply(insertionNatives.appendChild,documentBody,[activation]);
          sealedDownloadActivations.add(activation);
          try{reflectApply(anchorNatives.click,activation,[])}finally{
            reflectApply(anchorNatives.remove,activation,[]);
            reflectApply(timerNatives.setTimeout,rawWindow,[()=>reflectApply(blobNatives.revokeObjectURL,NativeURL,[blobURL]),0]);
          }
        }]);
      },()=>{}]);
    }]);
  }
  function clickedAnchor(event){
    let path;
    try{path=reflectApply(eventNatives.composedPath,event,[])}catch{path=null}
    if(arrayIsArray(path))for(let index=0;index<path.length;index+=1)if(isHTMLElementNamed(path[index],"a")||isHTMLElementNamed(path[index],"area"))return path[index];
    for(let node=event.target;node;node=nativeParentElement(node))if(isHTMLElementNamed(node,"a")||isHTMLElementNamed(node,"area"))return node;
  }
  function consumeSealedDownloadActivation(anchor){
    if(!sealedDownloadActivations.has(anchor))return false;
    sealedDownloadActivations.delete(anchor);
    return true;
  }
  function sealedPingPayload(endpoint,destination){const parameters=new NativeURLSearchParams([["endpoint",endpoint],["to",destination]]);return `https://ping.invalid/?${reflectApply(urlSearchParamsNatives.toString,parameters,[])}`}
  function visiblePingDestination(anchor){const target=virtualizeAPITarget(apiInputTarget(new NativeURL(navigationActivationTarget(anchor),visibleBase())));if(!validAPITarget(target))throw new NativeTypeError("Invalid ping destination");return urlProperty(target,"href")}
  function sealAnchorPings(anchor){
    const visible=visibleAttribute(anchor,"ping","url")??reflectApply(attributeNatives.getAttribute,anchor,["ping"]);
    if(visible===null)return;
    let destination;
    try{destination=visiblePingDestination(anchor)}catch{return}
    const values=reflectApply(stringSplit,reflectApply(stringTrim,visible,[]),[/[\t\n\f\r ]+/u]),routes=[];
    for(let index=0;index<values.length&&routes.length<16;index+=1){
      if(values[index]==="")continue;
      try{const target=controlledAPITarget(new NativeURL(values[index],visibleBase()));if(!runtimeConnectAllowed(target))continue;const route=sealedOpaqueRoute("ping",sealedPingPayload(target,destination));if(route!==null)reflectApply(arrayPush,routes,[route])}catch{}
    }
    rememberAttributeView(anchor,"ping");
    setDynamicAttributeMetadata(anchor,"ping",visible,visible);
    const sealedValue=reflectApply(arrayJoin,routes,[" "]);
    if(sealedValue==="")reflectApply(attributeNatives.removeAttribute,anchor,["ping"]);
    else reflectApply(natives.setAttribute,anchor,["ping",sealedValue]);
  }
  function sealedDownloadTarget(targetURL){
    try{
      const target=controlledAPITarget(new NativeURL(targetURL,visibleBase()));
      return {target,route:sealedOpaqueRoute("download",target)};
    }catch{return {target:null,route:null}}
  }
  function navigationActivationTarget(anchor){return visibleAttribute(anchor,"href","url")??reflectApply(attributeNatives.getAttribute,anchor,["href"])}
  function replaceSealedNavigation(element,attribute,value,applyNative){const active=activeSealedNavigationAttributes.get(element);if(active?.attribute!==attribute)return false;if(active.event)reflectApply(eventNatives.preventDefault,active.event,[]);queueDeferredNavigationAttribute(element,attribute,value,applyNative);return true}
  function releaseSealedNavigation(anchor){reflectApply(promiseThen,reflectApply(promiseResolve,NativePromise,[]),[()=>activeSealedNavigationAttributes.delete(anchor)])}
  function interceptAnchorEgress(event){
    const anchor=clickedAnchor(event);
    if(!anchor||consumeSealedDownloadActivation(anchor))return;
    if(event.defaultPrevented)return;
    if(isHTMLElementNamed(anchor,"a"))sealAnchorPings(anchor);
    if(isHTMLElementNamed(anchor,"area")){reflectApply(eventNatives.preventDefault,event,[]);return}
    const targetURL=navigationActivationTarget(anchor);
    if(targetURL===null)return;
    if(reflectApply(attributeNatives.getAttribute,anchor,["href"])==="/_zp/blocked/navigation"){reflectApply(eventNatives.preventDefault,event,[]);return}
    if(reflectApply(attributeNatives.hasAttribute,anchor,["download"])){
      const sealed=sealedDownloadTarget(targetURL);
      if(sealed.route===null){
        reflectApply(eventNatives.preventDefault,event,[]);
        return;
      }
      setDynamicAttributeMetadata(anchor,"href",targetURL,sealed.target);
      reflectApply(natives.setAttribute,anchor,["href",sealed.route]);
      activateSealedDownload(anchor,sealed.route,sealed.target,event);
      return;
    }
    try{activeSealedNavigationAttributes.set(anchor,{attribute:"href",event});releaseSealedNavigation(anchor)}
    catch{reflectApply(eventNatives.preventDefault,event,[])}
  }
  function interceptNavigationDrag(event){const anchor=clickedAnchor(event);if(anchor&&navigationActivationTarget(anchor)!==null)reflectApply(eventNatives.preventDefault,event,[])}
  function interceptNavigationDrop(event){reflectApply(eventNatives.preventDefault,event,[])}
  stageListener(rawWindow,"click",interceptAnchorEgress,true);
  stageListener(rawWindow,"auxclick",interceptAnchorEgress,true);
  stageListener(rawWindow,"dragstart",interceptNavigationDrag,true);
  stageListener(rawWindow,"drop",interceptNavigationDrop,true);
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function network_section_09() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const requestBodySources=new PrivateWeakMap;
  function clonedFormDataSource(source){
    let iterator;
    try{iterator=reflectApply(formDataNatives.entries,source,[])}catch{return null}
    const clone=new NativeFormData,entries=[];
    for(;;){
      const step=reflectApply(formDataIteratorNext,iterator,[]);
      if(step.done)break;
      const name=step.value[0],value=step.value[1],filename=typeof value==="string"?null:reflectApply(fileNatives.name.get,value,[]);
      reflectApply(arrayPush,entries,[{filename,name,value}]);
      reflectApply(formDataNatives.append,clone,filename===null?[name,value]:[name,value,filename]);
    }
    return{nativeSource:clone,snapshot:{available:true,entries,kind:"form-data",reconstruct:true}};
  }
  function normalizedKeepaliveBodySource(source){
    if(source===null||source===undefined)return{nativeSource:source,snapshot:{available:true,body:null,reconstruct:false}};
    if(typeof source==="string")return{nativeSource:source,snapshot:{available:true,body:encodedText(source),reconstruct:false}};
    const binary=nativeBinaryCopy(source);
    if(binary!==null)return{nativeSource:binary,snapshot:{available:true,body:binary,reconstruct:false}};
    try{return{nativeSource:source,snapshot:{available:true,body:encodedText(reflectApply(urlSearchParamsNatives.toString,source,[])),reconstruct:false}}}catch{}
    try{reflectApply(blobNatives.size.get,source,[]);return{nativeSource:source,snapshot:{available:true,body:source,reconstruct:false}}}catch{}
    const formData=clonedFormDataSource(source);
    if(formData!==null)return formData;
    try{reflectApply(readableStreamNatives.locked.get,source,[]);return{nativeSource:source,snapshot:{available:false,body:null,reconstruct:false}}}catch{}
    const text=NativeString(source);
    return{nativeSource:text,snapshot:{available:true,body:encodedText(text),reconstruct:false}};
  }
  function observeRequestInit(init){
    const state={bodyRead:false,bodySnapshot:null,explicitContentType:false,headersSupplied:false,priorityRead:false,priority:undefined};
    if(init===null||typeof init!=="object"&&typeof init!=="function")return{init,state};
    const observed=new NativeProxy(init,{get(target,key){
      const value=reflectGet(target,key,target);
      if(key==="body"){
        state.bodyRead=true;
        const normalized=normalizedKeepaliveBodySource(value);
        state.bodySnapshot=normalized.snapshot;
        return normalized.nativeSource;
      }
      if(key==="headers"){
        state.headersSupplied=value!==undefined;
        if(value===undefined)return value;
        const headers=new NativeHeaders(value);
        state.explicitContentType=reflectApply(headersNatives.get,headers,["content-type"])!==null;
        return headers;
      }
      if(key==="priority"){state.priorityRead=true;state.priority=value}
      return value;
    }});
    return{init:observed,state};
  }
  function observedPriority(observation,init){
    if(observation.state.priorityRead)return observation.state.priority;
    if(init===null||typeof init!=="object"&&typeof init!=="function")return undefined;
    observation.state.priorityRead=true;
    observation.state.priority=reflectGet(init,"priority");
    return observation.state.priority;
  }
  function requestInputContentType(input){
    try{return reflectApply(headersNatives.get,requestProperty(input,"headers"),["content-type"])}catch{return null}
  }
  function observedBodySnapshot(observation,input){
    const ownSnapshot=observation.state.bodyRead&&observation.state.bodySnapshot!==null,snapshot=ownSnapshot?observation.state.bodySnapshot:requestBodySources.get(input);
    if(!snapshot)return{available:false,body:null,reconstruct:false};
    if(snapshot.kind!=="form-data")return snapshot;
    if(!ownSnapshot)return{...snapshot,autoContentType:observation.state.headersSupplied?false:snapshot.autoContentType};
    return{...snapshot,autoContentType:!observation.state.explicitContentType&&(observation.state.headersSupplied||requestInputContentType(input)===null)};
  }
  function constructObservedRequest(input,init,newTarget=NativeRequest){
    const observation=observeRequestInit(init),request=reflectConstruct(NativeRequest,[input,observation.init],newTarget);
    const bodySource=observedBodySnapshot(observation,input);
    if(bodySource.available)requestBodySources.set(request,bodySource);
    return{bodySource,observation,request};
  }
  const RequestFacade=mirrorFunction(function Request(input,init){
    if(new.target===undefined)return reflectApply(NativeRequest,this,[input,init]);
    return constructObservedRequest(input,init,new.target===RequestFacade?NativeRequest:new.target).request;
  },NativeRequest);
  objectSetPrototypeOf(RequestFacade,objectGetPrototypeOf(NativeRequest));
  const requestPrototypeDescriptor=reflectGetOwnPropertyDescriptor(NativeRequest,"prototype");
  if(requestPrototypeDescriptor)reflectDefineProperty(RequestFacade,"prototype",requestPrototypeDescriptor);
  const requestConstructorDescriptor=requestPrototypeDescriptor&&reflectGetOwnPropertyDescriptor(requestPrototypeDescriptor.value,"constructor");
  if(requestConstructorDescriptor?.configurable)stage(requestPrototypeDescriptor.value,"constructor",{...requestConstructorDescriptor,value:RequestFacade,configurable:false});
  const requestCloneDescriptor=reflectGetOwnPropertyDescriptor(requestPrototypeDescriptor.value,"clone");
  if(requestCloneDescriptor?.configurable){
    const controlledRequestClone=mirrorFunction(function(){
      const clone=reflectApply(requestNatives.clone,this,[]),bodySource=requestBodySources.get(this);
      if(bodySource)requestBodySources.set(clone,bodySource);
      return clone;
    },requestNatives.clone);
    stage(requestPrototypeDescriptor.value,"clone",{...requestCloneDescriptor,value:controlledRequestClone,configurable:false});
  }
  function normalizeControlledFetch(input,init){
    if(typeof NativeRequest!=="function")throw new NativeTypeError("Failed to fetch");
    const construction=constructObservedRequest(input,init),nativeRequest=construction.request;
    const targetURL=controlledAPITarget(input,nativeRequest);
    const referrer=requestProperty(nativeRequest,"referrer"),credentials=requestProperty(nativeRequest,"credentials"),cache=requestProperty(nativeRequest,"cache"),mode=requestProperty(nativeRequest,"mode"),body=requestProperty(nativeRequest,"body"),method=requestProperty(nativeRequest,"method"),redirect=requestProperty(nativeRequest,"redirect"),referrerPolicy=requestProperty(nativeRequest,"referrerPolicy"),integrity=requestProperty(nativeRequest,"integrity")??"",keepalive=requestProperty(nativeRequest,"keepalive")===true,nativePriority=requestProperty(nativeRequest,"priority"),signal=requestProperty(nativeRequest,"signal"),requestHeaders=requestProperty(nativeRequest,"headers");
    const requestBody=body===undefined&&(method==="GET"||method==="HEAD")?null:body;
    const referrerURL=referrer===""?"":referrer==="about:client"?parsedInitialTarget.href:controlledAPITarget(referrer);
    const priority=NativeString(nativePriority??observedPriority(construction.observation,init)??"auto");
    if(!reflectApply(arrayIncludes,["omit","same-origin","include"],[credentials])
      ||mode==="navigate"
      ||mode==="no-cors"&&integrity!==""
      ||!reflectApply(arrayIncludes,["high","low","auto"],[priority])
      ||requestBody!==null&&(method==="GET"||method==="HEAD"))throw new NativeTypeError("Failed to fetch");
    return {
      request:{body:requestBody,cache,credentials,headers:headerEntries(requestHeaders),integrity,keepalive,keepaliveBody:keepalive?construction.bodySource:null,method,mode,priority,redirect,referrerPolicy,signal},
      referrerURL,
      targetURL,
    };
  }
  function validatedKeepaliveChunk(value,length,signal){
    if(signalAborted(signal))throw new NativeDOMException("The operation was aborted","AbortError");
    const chunk=nativeBinaryCopy(value),size=chunk===null?null:nativeBinaryByteLength(chunk);
    if(size===null||length+size>64<<10)throw new NativeTypeError("Failed to fetch");
    return {chunk:size===0?null:chunk,length:length+size};
  }
  function assembledKeepaliveBody(chunks,length){
    const bytes=new NativeUint8Array(length);let offset=0;
    for(const chunk of chunks){reflectApply(typedArrayNatives.set,bytes,[chunk,offset]);offset+=nativeBinaryByteLength(chunk)??0}
    return bytes;
  }
  async function boundedKeepaliveBody(body,signal){
    if(body===null)return null;
    const reader=body.getReader(),chunks=[];let length=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        const validated=validatedKeepaliveChunk(value,length,signal);
        length=validated.length;
        if(validated.chunk!==null)reflectApply(arrayPush,chunks,[validated.chunk]);
      }
    }catch(error){try{await reader.cancel(error)}catch{}throw error}
    return assembledKeepaliveBody(chunks,length);
  }
  let keepaliveBytesInFlight=0;
  function keepaliveBodyByteLength(body){
    const binaryLength=nativeBinaryByteLength(body);
    if(binaryLength!==null)return binaryLength;
    try{return reflectApply(blobNatives.size.get,body,[])}catch{return null}
  }
  function keepaliveReservation(body,enabled){
    if(!enabled)return 0;
    const size=body===null?0:keepaliveBodyByteLength(body);
    if(size===null||keepaliveBytesInFlight+size>64<<10)throw new NativeTypeError("Failed to fetch");
    keepaliveBytesInFlight+=size;
    return size;
  }
  function releaseKeepaliveReservation(size){keepaliveBytesInFlight-=size}
  function transferKeepaliveBody(body){
    if(body===null)return null;
    const buffer=nativeBinaryBuffer(body);
    if(buffer!==null){
      try{return NativeStructuredClone(body,{transfer:[buffer]})}
      catch{throw new NativeTypeError("Failed to fetch")}
    }
    try{return NativeStructuredClone(body,{transfer:[body]})}
    catch{try{return NativeStructuredClone(body)}catch{throw new NativeTypeError("Failed to fetch")}}
  }
  function prepareFormDataKeepaliveBody(snapshot,payload,signal){
    const formData=new NativeFormData;
    for(let index=0;index<snapshot.entries.length;index+=1){
      const entry=snapshot.entries[index],value=typeof entry.value==="string"?entry.value:NativeStructuredClone(entry.value);
      reflectApply(formDataNatives.append,formData,entry.filename===null?[entry.name,value]:[entry.name,value,entry.filename]);
    }
    const headers=new NativeHeaders(payload.headers);
    if(snapshot.autoContentType)reflectApply(headersNatives.delete,headers,["content-type"]);
    const request=reflectConstruct(NativeRequest,[parsedInitialTarget.href,{body:formData,headers,method:"POST"}]);
    payload.headers=headerEntries(requestProperty(request,"headers"));
    return boundedKeepaliveBody(requestProperty(request,"body"),signal);
  }
  function prepareKeepaliveBody(body,ownedBody,payload,signal){
    if(ownedBody?.kind==="form-data")return prepareFormDataKeepaliveBody(ownedBody,payload,signal);
    const transferred=transferKeepaliveBody(ownedBody?.available?ownedBody.body:body);
    return ownedBody?.available?reflectApply(promiseResolve,NativePromise,[transferred]):boundedKeepaliveBody(transferred,signal);
  }
  function gatewayAdmissionHeaders(plan){
    const headers=new NativeHeaders;
    if(plan.body_handle!=="")reflectApply(headersNatives.set,headers,["X-ZP-Body-Handle",plan.body_handle]);
    return headers;
  }
  function executeKeepaliveFetch(payload,body,signal,method,priority,ownedBody){
    const preparedBody=prepareKeepaliveBody(body,ownedBody,payload,signal);
    return reflectApply(promiseThen,preparedBody,[prepared=>{
      const reservation=keepaliveReservation(prepared,true),operation=allocateAPIPlan(payload).then(plan=>{
        if(signalAborted(signal))throw new NativeDOMException("The operation was aborted","AbortError");
        return reflectApply(natives.fetch,rawWindow,[plan.path,{method,body:prepared,headers:gatewayAdmissionHeaders(plan),signal,credentials:"omit",redirect:"error",keepalive:true,priority}]);
      });
      return operation.then(response=>{releaseKeepaliveReservation(reservation);return controlledAPIResponse(response,"Failed to fetch")},error=>{releaseKeepaliveReservation(reservation);throw error});
    }]).catch(error=>{if(error?.name==="AbortError")throw error;throw new NativeTypeError("Failed to fetch")});
  }
  function executeControlledFetch(normalized){
    const request=normalized.request,payload={request_kind:"fetch",target_url:normalized.targetURL,method:request.method,headers:request.headers,body_expected:request.body!==null,mode:request.mode,credentials:request.credentials,redirect:request.redirect,referrer_policy:request.referrerPolicy,referrer:normalized.referrerURL,cache:request.cache,integrity:request.integrity,keepalive:request.keepalive,priority:request.priority};
    if(signalAborted(request.signal))return reflectApply(promiseReject,NativePromise,[new NativeDOMException("The operation was aborted","AbortError")]);
    if(request.keepalive)return (containedKeepaliveFetch??executeKeepaliveFetch)(payload,request.body,request.signal,request.method,request.priority,request.keepaliveBody);
    return allocateAPIPlan(payload).then(plan=>reflectApply(natives.fetch,rawWindow,[plan.path,{method:request.method,body:request.body,headers:gatewayAdmissionHeaders(plan),signal:request.signal,credentials:"omit",redirect:"error",duplex:request.body===null?undefined:"half",priority:request.priority}])).then(response=>controlledAPIResponse(response,"Failed to fetch")).catch(error=>{if(error?.name==="AbortError")throw error;throw new NativeTypeError("Failed to fetch")});
  }
  const controlledFetch=mirrorFunction(function(input,init){
    let normalized;
    try{normalized=normalizeControlledFetch(input,init)}
    catch(error){return reflectApply(promiseReject,NativePromise,[error?.name==="TypeError"?error:new NativeTypeError("Failed to fetch")])}
    return executeControlledFetch(normalized);
  },natives.fetch);
  function apiPlanPayload(kind,targetURL,method,headers,bodyExpected,extra={}){
    return {request_kind:kind,target_url:targetURL,method,headers,body_expected:bodyExpected,mode:extra.mode??"cors",credentials:extra.credentials??"omit",redirect:extra.redirect??"error",referrer_policy:"no-referrer",referrer:"",cache:"no-store",integrity:extra.integrity??"",keepalive:false,priority:"auto",protocols:extra.protocols??[]};
  }
  function requestAllocatedAPIStream(plan,payload,body,signal){
    const options={method:payload.method,body,headers:gatewayAdmissionHeaders(plan),signal,credentials:"omit",redirect:"error"};
    if(body!==null&&body!==undefined)options.duplex="half";
    return reflectApply(natives.fetch,rawWindow,[plan.path,options]).then(response=>controlledAPIResponse(response,"Network request failed"));
  }
  function requestAPIStream(payload,body,signal){
    return allocateAPIPlan(payload).then(plan=>requestAllocatedAPIStream(plan,payload,body,signal));
  }
  function targetServiceWorkerURL(value){
    const target=new NativeURL(`${value}`,visibleBase());
    if(urlProperty(target,"origin")!==parsedInitialTarget.origin||urlCredential(target,"username")!==""||urlCredential(target,"password")!==""||urlProperty(target,"hash")!=="")throw new NativeTypeError("Target service worker URL rejected");
    return urlProperty(target,"href");
  }
  function prepareTargetServiceWorkerMessage(message,transferOrOptions){
    let rawTransfer;
    if(transferOrOptions===undefined)rawTransfer=[];
    else if(arrayIsArray(transferOrOptions))rawTransfer=transferOrOptions;
    else if(transferOrOptions&&typeof transferOrOptions==="object")rawTransfer=transferOrOptions.transfer??[];
    else throw new NativeTypeError("Target service worker transfer list rejected");
    let transfer;
    try{transfer=reflectApply(arrayFrom,Array,[rawTransfer])}catch{throw new NativeTypeError("Target service worker transfer list rejected")}
    if(transfer.length>32)throw new NativeDOMException("Target service worker transfer list rejected","DataCloneError");
    const seen=new PrivateSet;
    for(let index=0;index<transfer.length;index+=1){
      const entry=transfer[index];
      if((typeof entry!=="object"&&typeof entry!=="function")||entry===null||seen.has(entry))throw new NativeDOMException("Target service worker transfer list rejected","DataCloneError");
      seen.add(entry);
    }
    if(transfer.length===0)return{message:NativeStructuredClone(message),transfer};
    return NativeStructuredClone({message,transfer},{transfer});
  }
  const virtualServiceWorkers=new PrivateMap,virtualServiceWorkerRegistrations=new PrivateMap,virtualWorkerStates=objectFreeze(["installing","installed","activating","activated","redundant"]);
  function validVirtualWorkerView(view){
    return view!==null&&typeof view==="object"&&!arrayIsArray(view)&&typeof view.id==="string"&&view.id!==""&&typeof view.scriptURL==="string"&&targetServiceWorkerURL(view.scriptURL)===view.scriptURL&&typeof view.state==="string"&&reflectApply(arrayIncludes,virtualWorkerStates,[view.state])&&numberIsInteger(view.state_revision)&&view.state_revision>=1;
  }
  function validateVirtualRegistrationView(view){
    if(!view||typeof view!=="object"||arrayIsArray(view)||typeof view.id!=="string"||view.id===""||typeof view.scope!=="string"||targetServiceWorkerURL(view.scope)!==view.scope||typeof view.scriptURL!=="string"||targetServiceWorkerURL(view.scriptURL)!==view.scriptURL||!reflectApply(arrayIncludes,["imports","all","none"],[view.updateViaCache])||!reflectApply(arrayIncludes,["classic","module"],[view.type]))throw new NativeDOMException("Target service worker registration rejected","SecurityError");
    for(const worker of [view.installing,view.waiting,view.active])if(worker!==null&&!validVirtualWorkerView(worker))throw new NativeDOMException("Target service worker state rejected","SecurityError");
    return view;
  }
  function dispatchVirtualEvent(target,type,event=new NativeEvent(type)){
    target.dispatchEvent(event);
    const handler=target[`on${type}`];
    if(typeof handler==="function")reflectApply(handler,target,[event]);
  }
  function virtualWorker(view,registrationID,emitStateChange=false){
    if(!view)return null;
    if(!validVirtualWorkerView(view)||typeof registrationID!=="string"||registrationID==="")throw new NativeDOMException("Target service worker state rejected","SecurityError");
    const key=`${registrationID}\0${view.id}`;
    let worker=virtualServiceWorkers.get(key);
    if(!worker){worker=new VirtualServiceWorkerFacade(view,registrationID);virtualServiceWorkers.set(key,worker);return worker}
    const previous=worker._view;
    worker._view=view;
    if(emitStateChange&&view.state_revision>previous.state_revision&&view.state!==previous.state)dispatchVirtualEvent(worker,"statechange");
    return worker;
  }
  function virtualRegistration(view,{emitStateChanges=false,updateFound=false}={}){
    if(!view)return null;
    validateVirtualRegistrationView(view);
    let registration=virtualServiceWorkerRegistrations.get(view.id);
    const previousInstalling=registration?._view.installing?.id??null;
    if(!registration){registration=new VirtualServiceWorkerRegistrationFacade(view);virtualServiceWorkerRegistrations.set(view.id,registration)}
    else registration._view=view;
    for(const worker of [view.installing,view.waiting,view.active])if(worker)virtualWorker(worker,view.id,emitStateChanges);
    if(updateFound&&view.installing&&view.installing.id!==previousInstalling)dispatchVirtualEvent(registration,"updatefound");
    return registration;
  }
  function initializeEventHandlers(target,names){for(const name of names)natives.defineProperty(target,name,{value:null,writable:true,enumerable:true,configurable:true})}
  class VirtualServiceWorkerFacade extends NativeEventTarget{
    constructor(view,registrationID){super();this._view=view;this._registrationID=registrationID;initializeEventHandlers(this,["onstatechange","onerror"])}
    get scriptURL(){return this._view.scriptURL}
    get state(){return this._view.state}
    postMessage(message,transferOrOptions=undefined){
      const prepared=prepareTargetServiceWorkerMessage(message,transferOrOptions);
      void runtimeCommand("TARGET_SERVICE_WORKER_POST_MESSAGE",{operation_id:cookieOperationID(),registration_id:this._registrationID,worker_version:this._view.id,message:prepared.message,transfer:prepared.transfer},"Target service worker message failed",prepared.transfer).catch(()=>dispatchVirtualEvent(this,"error"));
    }
  }
  function virtualNavigationPreloadState(value){
    if(!value||typeof value!=="object"||arrayIsArray(value)||typeof value.enabled!=="boolean"||typeof value.header_value!=="string")throw new NativeDOMException("Target navigation preload state rejected","SecurityError");
    return objectFreeze({enabled:value.enabled,headerValue:value.header_value});
  }
  class VirtualNavigationPreloadManagerFacade{
    constructor(registrationID){this._registrationID=registrationID}
    disable(){return runtimeCommand("TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_DISABLE",{operation_id:cookieOperationID(),registration_id:this._registrationID},"Target navigation preload update failed").then(state=>{virtualNavigationPreloadState(state)})}
    enable(){return runtimeCommand("TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_ENABLE",{operation_id:cookieOperationID(),registration_id:this._registrationID},"Target navigation preload update failed").then(state=>{virtualNavigationPreloadState(state)})}
    getState(){return runtimeCommand("TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_GET",{registration_id:this._registrationID},"Target navigation preload lookup failed").then(virtualNavigationPreloadState)}
    setHeaderValue(value){return runtimeCommand("TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_SET_HEADER",{operation_id:cookieOperationID(),registration_id:this._registrationID,value:NativeString(value)},"Target navigation preload update failed").then(state=>{virtualNavigationPreloadState(state)})}
  }
  class VirtualServiceWorkerRegistrationFacade extends NativeEventTarget{
    constructor(view){super();this._view=view;this._navigationPreload=new VirtualNavigationPreloadManagerFacade(view.id);initializeEventHandlers(this,["onupdatefound"])}
    get scope(){return this._view.scope}
    get navigationPreload(){return this._navigationPreload}
    get updateViaCache(){return this._view.updateViaCache}
    get installing(){return virtualWorker(this._view.installing,this._view.id)}
    get waiting(){return virtualWorker(this._view.waiting,this._view.id)}
    get active(){return virtualWorker(this._view.active,this._view.id)}
    update(){return runtimeCommand("TARGET_SERVICE_WORKER_UPDATE",{operation_id:cookieOperationID(),registration_id:this._view.id,script_url:this._view.scriptURL,scope_url:this._view.scope,type:this._view.type,update_via_cache:this._view.updateViaCache},"Target service worker update failed").then(view=>virtualRegistration(view))}
    unregister(){return runtimeCommand("TARGET_SERVICE_WORKER_UNREGISTER",{operation_id:cookieOperationID(),registration_id:this._view.id},"Target service worker unregister failed").then(result=>{if(typeof result!=="boolean")throw new NativeDOMException("Target service worker unregister result rejected","SecurityError");return result})}
  }
  class VirtualServiceWorkerContainerFacade extends NativeEventTarget{
    constructor(){
      super();
      this._controllerRegistration=runtimeTargetServiceWorkerController?virtualRegistration(runtimeTargetServiceWorkerController):null;
      this._controller=this._controllerRegistration?.active??null;
      this._controllerRevision=0;
      this._ready=null;
      this._readyResolve=null;
      this._onmessage=null;
      this._messagesStarted=false;
      this._messageQueue=[];
      initializeEventHandlers(this,["oncontrollerchange","onmessageerror"]);
    }
    get controller(){return this._controller}
    get onmessage(){return this._onmessage}
    set onmessage(value){this._onmessage=value;if(value!==null&&value!==undefined)this.startMessages()}
    get ready(){
      if(!this._ready){
        if(this._controllerRegistration)this._ready=reflectApply(promiseResolve,NativePromise,[this._controllerRegistration]);
        else this._ready=new NativePromise((resolve,reject)=>{
          this._readyResolve=resolve;
          runtimeCommand("TARGET_SERVICE_WORKER_READY",{},"Target service worker unavailable").then(view=>{
            if(!view||!this._readyResolve)return;
            const registration=virtualRegistration(view),settle=this._readyResolve;
            this._readyResolve=null;
            settle(registration);
          },error=>{this._readyResolve=null;reject(error)});
        });
      }
      return this._ready;
    }
    register(scriptURL,options={}){
      const payload={operation_id:cookieOperationID(),script_url:targetServiceWorkerURL(scriptURL),type:options?.type??"classic",update_via_cache:options?.updateViaCache??"imports"};
      if(options?.scope!==undefined)payload.scope_url=targetServiceWorkerURL(options.scope);
      return runtimeCommand("TARGET_SERVICE_WORKER_REGISTER",payload,"Target service worker registration failed").then(view=>virtualRegistration(view));
    }
    getRegistration(clientURL=parsedInitialTarget.href){return runtimeCommand("TARGET_SERVICE_WORKER_GET_REGISTRATION",{url:targetServiceWorkerURL(clientURL)},"Target service worker lookup failed").then(view=>view?virtualRegistration(view):undefined)}
    getRegistrations(){return runtimeCommand("TARGET_SERVICE_WORKER_GET_REGISTRATIONS",{},"Target service worker lookup failed").then(views=>{if(!arrayIsArray(views))throw new NativeDOMException("Target service worker registrations rejected","SecurityError");return reflectApply(arrayMap,views,[view=>virtualRegistration(view)])})}
    _messageError(ports){
      for(let index=0;index<ports.length;index+=1)try{ports[index].close?.()}catch{}
      dispatchVirtualEvent(this,"messageerror");
    }
    _deliverMessage(event){
      if(this._messagesStarted){dispatchVirtualEvent(this,"message",event);return}
      if(this._messageQueue.length>=32){this._messageError(event.ports??[]);return}
      const record={event,expired:false,timer:null};
      record.timer=reflectApply(timerNatives.setTimeout,globalThis,[()=>{
        if(record.expired||this._messagesStarted)return;
        record.expired=true;
        this._messageQueue=reflectApply(arrayFilter,this._messageQueue,[entry=>entry!==record]);
        this._messageError(event.ports??[]);
      },30_000]);
      reflectApply(arrayPush,this._messageQueue,[record]);
    }
    startMessages(){
      if(this._messagesStarted)return;
      this._messagesStarted=true;
      const queued=this._messageQueue;
      this._messageQueue=[];
      for(let index=0;index<queued.length;index+=1){
        const record=queued[index];
        if(record.expired)continue;
        reflectApply(timerNatives.clearTimeout,globalThis,[record.timer]);
        dispatchVirtualEvent(this,"message",record.event);
      }
    }
  }
  function configureVirtualServiceWorkerPrototypes(){
    if(globalThis.ServiceWorker)objectSetPrototypeOf(VirtualServiceWorkerFacade.prototype,ServiceWorker.prototype);
    if(globalThis.ServiceWorkerRegistration)objectSetPrototypeOf(VirtualServiceWorkerRegistrationFacade.prototype,ServiceWorkerRegistration.prototype);
    if(globalThis.NavigationPreloadManager)objectSetPrototypeOf(VirtualNavigationPreloadManagerFacade.prototype,NavigationPreloadManager.prototype);
    if(globalThis.ServiceWorkerContainer)objectSetPrototypeOf(VirtualServiceWorkerContainerFacade.prototype,ServiceWorkerContainer.prototype);
  }
  function installVirtualServiceWorkerMessages(container){
    if(!serviceWorkerController||!container)return;
    const handleVirtualServiceWorkerMessage=event=>{
      const message=event.data;
      if(message?.v!==1||message.runtime_capability!==runtimeCapability)return;
      if(message.type==="TARGET_SERVICE_WORKER_CONTROLLER_CHANGE"){
        if(!numberIsInteger(message.controller_revision)||message.controller_revision<1||message.controller_revision<=container._controllerRevision||message.controller!==null&&typeof message.controller!=="object")return;
        let registration;
        try{registration=message.controller?virtualRegistration(message.controller,{emitStateChanges:true}):null}catch{return}
        container._controllerRevision=message.controller_revision;
        container._controllerRegistration=registration;
        container._controller=registration?.active??null;
        if(registration&&container._readyResolve){const settle=container._readyResolve;container._readyResolve=null;settle(registration)}
        dispatchVirtualEvent(container,"controllerchange");
      }else if(message.type==="TARGET_SERVICE_WORKER_LIFECYCLE"){
        if(!reflectApply(arrayIncludes,["updatefound","statechange","unregistered"],[message.event_type])||typeof message.registration_id!=="string"||message.registration_id===""||typeof message.worker_version!=="string"||message.worker_version==="")return;
        if(message.event_type==="unregistered"){
          if(message.registration!==null||message.worker!==null)return;
          return;
        }
        if(!message.registration||message.registration.id!==message.registration_id||!validVirtualWorkerView(message.worker)||message.worker.id!==message.worker_version)return;
        try{
          virtualRegistration(message.registration,{emitStateChanges:message.event_type==="statechange",updateFound:message.event_type==="updatefound"});
          if(message.event_type==="statechange")virtualWorker(message.worker,message.registration_id,true);
        }catch{}
      }else if(message.type==="TARGET_SERVICE_WORKER_MESSAGE"){
        const targetEvent=new NativeMessageEvent("message",{data:message.message,origin:parsedInitialTarget.origin,ports:event.ports??[]});
        natives.defineProperty(targetEvent,"source",{value:container._controller,enumerable:true,configurable:true});
        container._deliverMessage(targetEvent);
      }
    };
    stageListener(navigator.serviceWorker,"message",handleVirtualServiceWorkerMessage);
  }
  function createVirtualServiceWorkerContainer(){
    return serviceWorkerNatives.container?new VirtualServiceWorkerContainerFacade:null;
  }
  configureVirtualServiceWorkerPrototypes();
  const virtualServiceWorkerContainer=createVirtualServiceWorkerContainer();
  installVirtualServiceWorkerMessages(virtualServiceWorkerContainer);
  const trustedWorkerModuleBootstrapURL="__ZP_WORKER_BOOTSTRAP_MODULE_URL__",trustedWorkerClassicBootstrapURL="__ZP_WORKER_BOOTSTRAP_CLASSIC_URL__";
  const workerBlobURLs=new PrivateMap,workerBlobCreateDescriptor=natives.getOwnPropertyDescriptor(NativeURL,"createObjectURL"),workerBlobRevokeDescriptor=natives.getOwnPropertyDescriptor(NativeURL,"revokeObjectURL");
  function trackedWorkerObjectURL(blob){const url=reflectApply(blobNatives.createObjectURL,NativeURL,[blob]);if(typeof url!=="string")throw new NativeDOMException("Worker blob URL rejected","SecurityError");const type=reflectApply(blobNatives.type.get,blob,[]);workerBlobURLs.set(url,{blob,leases:0,revoked:false,type});return url}
  function revokedWorkerObjectURL(value){const url=NativeString(value);reflectApply(blobNatives.revokeObjectURL,NativeURL,[url]);const entry=workerBlobURLs.get(url);if(!entry)return;entry.revoked=true;if(entry.leases===0)workerBlobURLs.delete(url)}
  function releaseWorkerBlob(url,entry){entry.leases-=1;if(entry.revoked&&entry.leases===0)workerBlobURLs.delete(url)}
  function capturedWorkerBlob(url){const entry=workerBlobURLs.get(url);if(!entry||entry.revoked)throw new NativeDOMException("Worker blob URL rejected","SecurityError");entry.leases+=1;let released=false;const release=()=>{if(released)return;released=true;releaseWorkerBlob(url,entry)},promise=reflectApply(promiseThen,reflectApply(blobNatives.arrayBuffer,entry.blob,[]),[buffer=>({bytes:new NativeUint8Array(buffer),kind:"blob",media_type:NativeString(entry.type),url})]);return{promise,release}}
  function workerDataPercentBytes(value){const bytes=[];let segment=0,index=0;const flush=end=>{if(end<=segment)return;const encoded=new NativeTextEncoder().encode(reflectApply(stringSlice,value,[segment,end]));for(let offset=0;offset<encoded.length;offset+=1)reflectApply(arrayPush,bytes,[encoded[offset]])};while(index<value.length){if(value[index]==="%"&&index+2<value.length&&reflectApply(regexpTest,/^[0-9a-f]{2}$/iu,[reflectApply(stringSlice,value,[index+1,index+3])])){flush(index);reflectApply(arrayPush,bytes,[NativeNumber(`0x${reflectApply(stringSlice,value,[index+1,index+3])}`)]);index+=3;segment=index;continue}index+=1}flush(value.length);const output=new NativeUint8Array(bytes.length);for(let offset=0;offset<bytes.length;offset+=1)output[offset]=bytes[offset];return output}
  function workerDataBase64Bytes(value){const encoded=workerDataPercentBytes(value);let text="";for(let index=0;index<encoded.length;index+=1)text+=reflectApply(nativeStringFromCharCode,NativeString,[encoded[index]]);let binary;try{binary=reflectApply(nativeAtob,undefined,[text])}catch{throw new NativeDOMException("Worker data URL rejected","SecurityError")}const bytes=new NativeUint8Array(binary.length);for(let index=0;index<bytes.length;index+=1)bytes[index]=reflectApply(nativeStringCharCodeAt,binary,[index]);return bytes}
  function decodedWorkerDataURL(value){const fragment=reflectApply(stringIndexOf,value,["#"]),dataValue=fragment===-1?value:reflectApply(stringSlice,value,[0,fragment]),comma=reflectApply(stringIndexOf,dataValue,[","]);if(comma<5)throw new NativeDOMException("Worker data URL rejected","SecurityError");const metadata=reflectApply(stringSlice,dataValue,[5,comma]),parts=reflectApply(stringSplit,metadata,[";"]),base64=lower(reflectApply(stringTrim,parts[parts.length-1]??"",[]))==="base64";if(base64)reflectApply(arrayPop,parts,[]);const mediaType=reflectApply(stringTrim,reflectApply(arrayJoin,parts,[";"])||"text/plain;charset=US-ASCII",[]),encoded=reflectApply(stringSlice,dataValue,[comma+1]);return{bytes:base64?workerDataBase64Bytes(encoded):workerDataPercentBytes(encoded),kind:"data",media_type:mediaType,url:value}}
  function controlledWorkerTarget(value){const source=NativeString(value);if(reflectApply(regexpTest,/^blob:/iu,[source]))return{executable:capturedWorkerBlob(source),targetURL:source};if(reflectApply(regexpTest,/^data:/iu,[source]))return{executable:{promise:reflectApply(promiseThen,reflectApply(promiseResolve,NativePromise,[]),[()=>decodedWorkerDataURL(source)]),release(){},},targetURL:source};const target=new NativeURL(source,visibleBase());if(urlProperty(target,"origin")!==parsedInitialTarget.origin||urlCredential(target,"username")!==""||urlCredential(target,"password")!=="")throw new NativeDOMException("Worker script origin rejected","SecurityError");return{executable:null,targetURL:urlProperty(target,"href")}}
  function workerABIIdentifier(){return `__zp_abi_${cookieOperationID()}`}
  function workerAllocation(targetURL,sourceKind,options,workerABIIdentifier,executable){const payload={target_url:targetURL,source_kind:sourceKind,options,worker_abi_identifier:workerABIIdentifier};if(!executable)return runtimeCommand("TARGET_WORKER_BOOTSTRAP_ALLOCATE",payload,"Worker bootstrap unavailable");const allocation=reflectApply(promiseThen,executable.promise,[source=>{const transfer=nativeBinaryBuffer(source.bytes);if(transfer===null)throw new NativeDOMException("Worker executable bytes rejected","SecurityError");payload.executable_source={bytes:source.bytes,kind:source.kind,media_type:source.media_type,url:source.url};return runtimeCommand("TARGET_WORKER_BOOTSTRAP_ALLOCATE",payload,"Worker bootstrap unavailable",[transfer])}]);return reflectApply(promiseThen,allocation,[result=>{executable.release();return result},error=>{executable.release();throw error}])}
  function validWorkerGateway(gateway){return gateway&&typeof gateway.id==="string"&&gateway.id!==""&&typeof gateway.key==="string"&&gateway.key!==""&&typeof gateway.expires_at==="number"&&typeof gateway.lease_generation==="number"&&gateway.lease_generation>=1&&gateway.lease_generation%1===0}
  function validWorkerPlan(plan,targetURL,sourceKind,trustedBootstrapURL,workerABIIdentifier){return plan&&plan.bootstrap_url===trustedBootstrapURL&&plan.source_kind===sourceKind&&plan.target_url===targetURL&&plan.abi_identifier===workerABIIdentifier&&plan.root_precompiled===true&&typeof plan.source==="string"&&typeof plan.target_origin==="string"&&plan.bootstrap&&validWorkerGateway(plan.bootstrap.gateway)}
  function releaseWorkerGateway(plan){const gateway=plan.bootstrap.gateway;void reflectApply(promiseThen,runtimeCommand("TARGET_WORKER_BOOTSTRAP_RELEASE",{gateway_id:gateway.id,lease_generation:gateway.lease_generation},"Worker bootstrap release unavailable"),[()=>{},()=>{}])}
  function initializeDedicatedWorker(worker,targetURL,sourceKind,options,trustedBootstrapURL,workerABIIdentifier,executable){
    const channel=new NativeMessageChannel(),port=channel.port1,allocation=workerAllocation(targetURL,sourceKind,options,workerABIIdentifier,executable);
    let initialized=false,terminated=false,plan=null;
    function closePort(){try{reflectApply(messagePortNatives.close,port,[])}catch{}}
    function releasePlan(){if(plan===null)return;const activePlan=plan;plan=null;releaseWorkerGateway(activePlan)}
    function fail(){if(terminated)return;terminated=true;releasePlan();closePort();try{reflectApply(eventNatives.dispatchEvent,worker,[new NativeEvent("error",{cancelable:true})])}catch{}reflectApply(workerNatives.terminate,worker,[])}
    port.onmessage=event=>{
      const message=event.data;
      if(message?.v!==2||typeof message.operation!=="string")return;
      if(message.operation==="ZERO_PROXY_WORKER_PORT_READY_V2"&&!initialized){
        initialized=true;
        reflectApply(promiseThen,allocation,[result=>{
          if(!validWorkerPlan(result,targetURL,sourceKind,trustedBootstrapURL,workerABIIdentifier)){fail();return}
          if(terminated){releaseWorkerGateway(result);return}
          plan=result;
          reflectApply(messagePortNatives.postMessage,port,[{v:2,operation:"ZERO_PROXY_WORKER_INITIALIZE_V2",sequence:0,source_kind:sourceKind,source:result.source,target_origin:result.target_origin,target_url:result.target_url,bootstrap:result.bootstrap,abi_identifier:result.abi_identifier,root_precompiled:result.root_precompiled,string_compilation_allowed:stringCompilationAllowed,worker_abi_identifier:workerABIIdentifier}]);
        },fail]);
      }else if(message.operation==="ZERO_PROXY_WORKER_REJECTED_V2")fail();
      else if(message.operation==="ZERO_PROXY_WORKER_TERMINATE_V2"){terminated=true;releasePlan();closePort()}
    };
    reflectApply(messagePortNatives.start,port,[]);
    reflectApply(workerNatives.postMessage,worker,[{v:2,operation:"ZERO_PROXY_WORKER_PORT_V2"},[channel.port2]]);
  }
  function workerOptionError(shared){return new NativeTypeError(shared?"SharedWorker options rejected":"Worker options rejected")}
  function workerOptionSettings(options,shared){
    if(shared&&typeof options==="string")return{name:options};
    return options===undefined?{}:options;
  }
  function workerOptionString(settings,name,fallback){return settings[name]===undefined?fallback:`${settings[name]}`}
  function validWorkerOptionValues(type,credentials){
    return reflectApply(arrayIncludes,["classic","module"],[type])
      &&reflectApply(arrayIncludes,["omit","same-origin","include"],[credentials]);
  }
  function normalizedWorkerOptions(options,shared){
    const settings=workerOptionSettings(options,shared);
    if(settings===null||typeof settings!=="object")throw workerOptionError(shared);
    const type=workerOptionString(settings,"type","classic");
    const name=workerOptionString(settings,"name","");
    const credentials=workerOptionString(settings,"credentials","same-origin");
    if(!validWorkerOptionValues(type,credentials))throw workerOptionError(shared);
    return {type,name,credentials};
  }
  function applyWorkerPrototype(worker,newTarget,facade){
    if(newTarget&&newTarget!==facade&&newTarget.prototype)objectSetPrototypeOf(worker,newTarget.prototype);
  }
  function createControlledWorker(scriptURL,options,newTarget){
    const workerTarget=controlledWorkerTarget(scriptURL),targetURL=workerTarget.targetURL;
    const settings=normalizedWorkerOptions(options,false);
    const sourceKind=settings.type==="module"?"ModuleWorker":"ClassicWorker";
    const trustedBootstrapURL=settings.type==="module"?trustedWorkerModuleBootstrapURL:trustedWorkerClassicBootstrapURL;
    const bootstrapURL=`${trustedBootstrapURL}#source_kind=${sourceKind}`,workerABI=workerABIIdentifier();
    let worker;
    try{worker=reflectConstruct(natives.Worker,[bootstrapURL,settings])}
    catch(error){workerTarget.executable?.release();throw error}
    applyWorkerPrototype(worker,newTarget,WorkerFacade);
    initializeDedicatedWorker(worker,targetURL,sourceKind,settings,trustedBootstrapURL,workerABI,workerTarget.executable);
    return worker;
  }
  function configureWorkerFacadePrototype(){
    objectSetPrototypeOf(WorkerFacade,objectGetPrototypeOf(natives.Worker));
    const workerPrototype=natives.getOwnPropertyDescriptor(natives.Worker,"prototype");
    if(workerPrototype)natives.defineProperty(WorkerFacade,"prototype",workerPrototype);
  }
  const WorkerFacade=mirrorFunction(function Worker(scriptURL,options){if(!new.target)throw new NativeTypeError("Failed to construct 'Worker'");return createControlledWorker(scriptURL,options,new.target)},natives.Worker);
  configureWorkerFacadePrototype();
  const sharedWorkerHosts=new PrivateMap,sharedWorkerPortClosures=new PrivateWeakMap;
  const MessagePortCloseFacade=mirrorFunction(function close(...arguments_){const release=sharedWorkerPortClosures.get(this);if(release){sharedWorkerPortClosures.delete(this);release()}return reflectApply(messagePortNatives.close,this,arguments_)},messagePortNatives.close);
  function sharedWorkerHost(targetURL,sourceKind,name){
    const key=jsonStringify([sourceKind,targetURL,name]);
    let host=sharedWorkerHosts.get(key);
    const first=!host;
    if(first){host={cleanup:null,connections:0,identity:cookieOperationID(),released:false};sharedWorkerHosts.set(key,host)}
    return{first,host,key}
  }
  function discardSharedWorkerHost(key,host){
    if(host.released)return;
    host.released=true;
    if(sharedWorkerHosts.get(key)===host)sharedWorkerHosts.delete(key);
    host.cleanup?.();
  }
  function retainSharedWorkerHost(shared,key,host){
    const port=reflectApply(sharedWorkerNatives.port.get,shared,[]);
    host.connections+=1;
    let active=true;
    const release=()=>{
      if(!active)return;
      active=false;
      sharedWorkerPortClosures.delete(port);
      reflectApply(eventNatives.removeEventListener,port,["close",release]);
      host.connections-=1;
      if(host.connections===0)discardSharedWorkerHost(key,host);
    };
    sharedWorkerPortClosures.set(port,release);
    reflectApply(eventNatives.addEventListener,port,["close",release,{once:true}]);
    return{port,release}
  }
  function initializeSharedWorker(shared,targetURL,sourceKind,options,trustedBootstrapURL,workerABI,executable,key,host,connection){
    const port=connection.port;
    let initialized=false,plan=null,failed=false,allocationStarted=false;
    const stop=()=>reflectApply(eventNatives.removeEventListener,port,["message",control]);
    const clearHandshake=()=>reflectApply(timerNatives.clearTimeout,rawWindow,[handshakeTimer]);
    const release=()=>{if(plan!==null){releaseWorkerGateway(plan);plan=null}};
    host.cleanup=release;
    const reject=()=>{
      if(failed)return;
      failed=true;clearHandshake();stop();
      if(!allocationStarted)executable?.release();
      discardSharedWorkerHost(key,host);connection.release();
      try{reflectApply(messagePortNatives.close,port,[])}catch{}
      try{reflectApply(eventNatives.dispatchEvent,shared,[new NativeEvent("error",{cancelable:true})])}catch{}
    };
    const control=event=>{
      const message=event.data;
      if(message?.v!==2||typeof message.operation!=="string")return;
      if(message.operation==="ZERO_PROXY_WORKER_PORT_READY_V2"&&!initialized){
        initialized=true;allocationStarted=true;clearHandshake();
        const allocation=workerAllocation(targetURL,sourceKind,options,workerABI,executable);
        reflectApply(promiseThen,allocation,[result=>{
          if(host.released){releaseWorkerGateway(result);return}
          if(!validWorkerPlan(result,targetURL,sourceKind,trustedBootstrapURL,workerABI)){reject();return}
          plan=result;
          reflectApply(messagePortNatives.postMessage,port,[{v:2,operation:"ZERO_PROXY_WORKER_INITIALIZE_V2",sequence:0,source_kind:sourceKind,source:result.source,target_origin:result.target_origin,target_url:result.target_url,bootstrap:result.bootstrap,abi_identifier:result.abi_identifier,root_precompiled:result.root_precompiled,string_compilation_allowed:stringCompilationAllowed,worker_abi_identifier:workerABI}]);
        },reject]);
        return;
      }
      if(message.operation==="ZERO_PROXY_WORKER_READY_V2"){stop();return}
      if(message.operation==="ZERO_PROXY_WORKER_REJECTED_V2")reject();
    };
    const handshakeTimer=reflectApply(timerNatives.setTimeout,rawWindow,[()=>{if(host.released){stop();return}reject()},10_000]);
    reflectApply(eventNatives.addEventListener,port,["message",control]);
    reflectApply(messagePortNatives.start,port,[]);
  }
  function createControlledSharedWorker(scriptURL,options,newTarget){
    const workerTarget=controlledWorkerTarget(scriptURL),targetURL=workerTarget.targetURL;
    const settings=normalizedWorkerOptions(options,true);
    const sourceKind=settings.type==="module"?"SharedModuleWorker":"SharedClassicWorker";
    const trustedBootstrapURL=settings.type==="module"?trustedWorkerModuleBootstrapURL:trustedWorkerClassicBootstrapURL;
    const identity=sharedWorkerHost(targetURL,sourceKind,settings.name),bootstrapURL=`${trustedBootstrapURL}#source_kind=${sourceKind}&identity=${identity.host.identity}`,workerABI=workerABIIdentifier();
    let worker;
    try{worker=reflectConstruct(natives.SharedWorker,[bootstrapURL,settings])}
    catch(error){workerTarget.executable?.release();if(identity.first)discardSharedWorkerHost(identity.key,identity.host);throw error}
    applyWorkerPrototype(worker,newTarget,SharedWorkerFacade);
    const connection=retainSharedWorkerHost(worker,identity.key,identity.host);
    if(identity.first)initializeSharedWorker(worker,targetURL,sourceKind,settings,trustedBootstrapURL,workerABI,workerTarget.executable,identity.key,identity.host,connection);
    else workerTarget.executable?.release();
    return worker;
  }
  function configureSharedWorkerFacadePrototype(){
    if(!SharedWorkerFacade)return;
    objectSetPrototypeOf(SharedWorkerFacade,objectGetPrototypeOf(natives.SharedWorker));
    const sharedWorkerPrototype=natives.getOwnPropertyDescriptor(natives.SharedWorker,"prototype");
    if(sharedWorkerPrototype)natives.defineProperty(SharedWorkerFacade,"prototype",sharedWorkerPrototype);
  }
  function createSharedWorkerFacade(){
    if(!natives.SharedWorker)return null;
    return mirrorFunction(function SharedWorker(scriptURL,options){if(!new.target)throw new NativeTypeError("Failed to construct 'SharedWorker'");return createControlledSharedWorker(scriptURL,options,new.target)},natives.SharedWorker);
  }
  const SharedWorkerFacade=createSharedWorkerFacade();
  configureSharedWorkerFacadePrototype();
  function validWorkletPlan(plan,targetURL,workerABIIdentifier){return plan&&plan.source_kind==="WorkletModule"&&plan.target_url===targetURL&&plan.abi_identifier===workerABIIdentifier&&plan.root_precompiled===true&&typeof plan.module_url==="string"&&plan.module_url!==""}
  function controlledWorkletModule(native,receiver,scriptURL,options){const workerTarget=controlledWorkerTarget(scriptURL),workerABI=workerABIIdentifier(),allocation=workerAllocation(workerTarget.targetURL,"WorkletModule",options??{},workerABI,workerTarget.executable);return reflectApply(promiseThen,allocation,[plan=>{if(!validWorkletPlan(plan,workerTarget.targetURL,workerABI))throw new NativeDOMException("Worklet module rejected","SecurityError");return reflectApply(native,receiver,[plan.module_url,options])}])}
  function normalizedSocketURL(input){
    let target=new NativeURL(NativeString(input),parsedInitialTarget.href);
    if(urlProperty(target,"origin")===rawWindow.location.origin){
      const path=`${urlProperty(target,"pathname")}${urlProperty(target,"search")}`;
      target=new NativeURL(path,parsedInitialTarget.href);
    }
    const protocol=urlProperty(target,"protocol");
    if(protocol==="http:")reflectApply(urlNatives.protocol.set,target,["ws:"]);
    else if(protocol==="https:")reflectApply(urlNatives.protocol.set,target,["wss:"]);
    reflectApply(urlNatives.hash.set,target,[""]);
    return target;
  }
  function validSocketTarget(target){
    const protocol=urlProperty(target,"protocol"),portText=urlProperty(target,"port");
    const port=portText===""?(protocol==="wss:"?443:80):NativeNumber(portText);
    return (protocol==="ws:"||protocol==="wss:")
      &&urlCredential(target,"username")===""
      &&urlCredential(target,"password")===""
      &&reflectApply(arrayIncludes,approvedPorts,[port]);
  }
  function validSocketProtocol(protocol,seen){
    return typeof protocol==="string"
      &&protocol.length>0
      &&protocol.length<=123
      &&/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)
      &&!seen.has(protocol);
  }
  function controlledSocketTarget(input){
    let target;
    try{target=normalizedSocketURL(input)}
    catch(error){throw error?.name==="TypeError"?error:new NativeTypeError("Failed to construct 'WebSocket'")}
    if(!validSocketTarget(target))throw new NativeTypeError("Failed to construct 'WebSocket'");
    return urlProperty(target,"href");
  }
  function socketProtocolSource(value){
    if(value===undefined)return[];
    if(typeof value==="string")return[value];
    try{return arrayFrom(value)}catch{return null}
  }
  function normalizeProtocols(value){
    const source=socketProtocolSource(value);
    if(!source||source.length>32)throw new NativeDOMException("The subprotocol list is invalid","SyntaxError");
    const protocols=[],seen=new PrivateSet;
    for(const value of source){
      const protocol=NativeString(value);
      if(!validSocketProtocol(protocol,seen))throw new NativeDOMException("The subprotocol list is invalid","SyntaxError");
      seen.add(protocol);
      reflectApply(arrayPush,protocols,[protocol]);
    }
    return protocols;
  }
  function eventWithProgress(type,loaded=0,total=null){return new NativeProgressEvent(type,{lengthComputable:total!==null,loaded,total:total??0})}
  const xhrForbiddenHeader=/^(?:accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|proxy-|referer|sec-|te$|trailer$|transfer-encoding$|upgrade$|via$)/i;
  function xhrResponseDecoder(xhr){
    const mime=xhr._effectiveMimeType(),match=/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(mime),label=match?.[1]??match?.[2];
    if(label)try{return new NativeTextDecoder(label)}catch{}
    return new NativeTextDecoder;
  }
  function nativeXHRValue(request,key){return reflectApply(xhrNatives[key].get,request,[])}
  function nativeXHRCall(request,key,args=[]){return reflectApply(xhrNatives[key],request,args)}
  function nativeXHRHeaderBlock(request){
    const headers=new NativeHeaders,block=nativeXHRCall(request,"getAllResponseHeaders");
    const lines=reflectApply(stringSplit,block,[/\r?\n/u]);
    for(let index=0;index<lines.length;index+=1){
      const line=lines[index],separator=reflectApply(stringIndexOf,line,[":"]);
      if(separator<=0)continue;
      const name=reflectApply(stringTrim,reflectApply(stringSlice,line,[0,separator]),[]);
      const value=reflectApply(stringTrim,reflectApply(stringSlice,line,[separator+1]),[]);
      const current=headerGet(headers,name);
      reflectApply(headersNatives.set,headers,[name,current===null?value:`${current}, ${value}`]);
    }
    return headers;
  }
  function nativeXHRProgress(type,event){return eventWithProgress(type,event.loaded,event.lengthComputable?event.total:null)}
  function nativeXHRResponseBytes(request){
    const bytes=nativeBinaryCopy(nativeXHRValue(request,"response")),length=bytes===null?null:nativeBinaryByteLength(bytes);
    if(length===null)throw new NativeTypeError("Network request failed");
    if(length>16<<20)throw new NativeTypeError("Response exceeds limit");
    return bytes;
  }
  class ProgressTarget extends NativeEventTarget{
    constructor(){super();this.onloadstart=null;this.onprogress=null;this.onload=null;this.onerror=null;this.onabort=null;this.ontimeout=null;this.onloadend=null;}
    emit(type,event){this.dispatchEvent(event);const handler=this[`on${type}`];if(typeof handler==="function")handler.call(this,event);}
  }
  class XMLHttpRequestFacadeCore extends NativeEventTarget{
    constructor(){
      super();
      this._readyState=XMLHttpRequestFacade.UNSENT;this._responseType="";this._timeout=0;this._withCredentials=false;this._upload=new ProgressTarget;
      this.onreadystatechange=null;this.onloadstart=null;this.onprogress=null;this.onload=null;this.onerror=null;this.onabort=null;this.ontimeout=null;this.onloadend=null;
      this._headers=[];this._responseHeaders=new NativeHeaders;this._status=0;this._statusText="";this._responseURL="";this._method="";this._url="";this._async=true;this._sent=false;this._terminal=false;this._nativeRequest=null;this._generation=0;this._uploadPending=false;this._uploadProgressSeen=false;this._uploadTotal=null;this._timeoutHandle=null;this._bytes=new NativeUint8Array;this._responseText="";this._responseDocument=undefined;this._mimeType="";
    }
    get readyState(){return this._readyState}
    get timeout(){return this._timeout}
    set timeout(value){const number=NativeNumber(value),integer=number-number%1;this._timeout=integer>0?(integer>0xffffffff?0xffffffff:integer):0}
    get upload(){return this._upload}
    get withCredentials(){return this._withCredentials}
    set withCredentials(value){
      if(this._sent||this.readyState===XMLHttpRequestFacade.LOADING||this.readyState===XMLHttpRequestFacade.DONE)throw new NativeDOMException("Credentials mode is unavailable","InvalidStateError");
      this._withCredentials=NativeBoolean(value);
    }
    get responseType(){return this._responseType??""}
    set responseType(value){
      value=NativeString(value);
      if(!["","text","arraybuffer","blob","json","document"].includes(value))throw new NativeDOMException("Unsupported responseType","SyntaxError");
      if(this.readyState===XMLHttpRequestFacade.LOADING||this.readyState===XMLHttpRequestFacade.DONE)throw new NativeDOMException("Response is active","InvalidStateError");
      this._responseType=value;
    }
    get status(){return this._status}
    get statusText(){return this._statusText}
    get responseURL(){return this._responseURL}
    get responseText(){if(this.responseType!==""&&this.responseType!=="text")throw new NativeDOMException("responseText is unavailable","InvalidStateError");return this._responseText}
    get responseXML(){
      if(this.responseType!==""&&this.responseType!=="document")throw new NativeDOMException("responseXML is unavailable","InvalidStateError");
      return this._documentResponse(this.responseType==="document");
    }
    get response(){
      if(this.readyState!==XMLHttpRequestFacade.DONE)return null;
      if(this.responseType===""||this.responseType==="text")return this._responseText;
      if(this.responseType==="arraybuffer"){const copy=nativeBinaryCopy(this._bytes);return copy===null?null:nativeBinaryBuffer(copy)}
      if(this.responseType==="blob")return new NativeBlob([this._bytes],{type:this._effectiveMimeType().split(";")[0].trim().toLowerCase()});
      if(this.responseType==="json"){try{const text=decodedText(new NativeTextDecoder,this._bytes);return text===""?null:jsonParse(text)}catch{return null}}
      if(this.responseType==="document")return this._documentResponse(true);
      return null;
    }
    _documentResponse(allowHTML){
      if(this.readyState!==XMLHttpRequestFacade.DONE)return null;
      if(this._responseDocument!==undefined)return this._responseDocument;
      const type=this._effectiveMimeType().split(";")[0].trim().toLowerCase()||"text/xml";
      const xml=reflectApply(arrayIncludes,["text/xml","application/xml","application/xhtml+xml","image/svg+xml"],[type]);
      if(!xml&&!(allowHTML&&type==="text/html"))return this._responseDocument=null;
      try{
        const document=new NativeDOMParser().parseFromString(this._responseText,type);
        return this._responseDocument=document.documentElement?.localName==="parsererror"?null:document;
      }catch{return this._responseDocument=null}
    }
    _effectiveMimeType(){return this._mimeType||headerGet(this._responseHeaders,"content-type")||""}
    _emit(type,event=new NativeEvent(type)){this.dispatchEvent(event);const handler=this[`on${type}`];if(typeof handler==="function")handler.call(this,event);}
    _state(value){this._readyState=value;this._emit("readystatechange");}
    open(method,url,async=true){
      if(async===false)throw new NativeDOMException("Synchronous XMLHttpRequest is unavailable","InvalidAccessError");
      method=NativeString(method);
      if(!method||!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method))throw new NativeDOMException("Invalid HTTP method","SyntaxError");
      method=method.toUpperCase();
      if(method==="CONNECT"||method==="TRACE"||method==="TRACK")throw new NativeDOMException("Forbidden HTTP method","SecurityError");
      this._generation+=1;
      const previous=this._nativeRequest;
      this._nativeRequest=null;
      if(previous)try{nativeXHRCall(previous,"abort")}catch{}
      this._clearTimer();
      this._url=controlledAPITarget(url);this._method=method;this._async=true;this._headers=[];this._responseHeaders=new NativeHeaders;this._status=0;this._statusText="";this._responseURL="";this._bytes=new NativeUint8Array;this._responseText="";this._responseDocument=undefined;this._sent=false;this._terminal=false;this._uploadPending=false;this._uploadProgressSeen=false;this._uploadTotal=null;this._state(XMLHttpRequestFacade.OPENED);
    }
    setRequestHeader(name,value){
      if(this.readyState!==XMLHttpRequestFacade.OPENED||this._sent)throw new NativeDOMException("The object is not in the OPENED state","InvalidStateError");
      name=NativeString(name);value=reflectApply(stringTrim,NativeString(value),[]);
      if(!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)||/[\r\n]/.test(value))throw new NativeDOMException("Invalid request header","SyntaxError");
      if(xhrForbiddenHeader.test(name))return;
      const lower=reflectApply(stringToLowerCase,name,[]);
      for(let index=0;index<this._headers.length;index+=1)if(reflectApply(stringToLowerCase,this._headers[index][0],[])===lower){this._headers[index][1]=`${this._headers[index][1]}, ${value}`;return}
      reflectApply(arrayPush,this._headers,[[name,value]]);
    }
    overrideMimeType(value){if(this.readyState===XMLHttpRequestFacade.LOADING||this.readyState===XMLHttpRequestFacade.DONE)throw new NativeDOMException("Response is active","InvalidStateError");this._mimeType=NativeString(value);this._responseDocument=undefined}
    getResponseHeader(name){if(this.readyState<XMLHttpRequestFacade.HEADERS_RECEIVED)return null;return headerGet(this._responseHeaders,NativeString(name))}
    getAllResponseHeaders(){if(this.readyState<XMLHttpRequestFacade.HEADERS_RECEIVED)return "";let output="";for(const [name,value] of headerEntries(this._responseHeaders))output+=`${name}: ${value}\r\n`;return output}
    _clearTimer(){if(this._timeoutHandle!==null){clearTimeout(this._timeoutHandle);this._timeoutHandle=null}}
    _networkError(kind){
      this._status=0;this._statusText="";this._responseURL="";this._responseHeaders=new NativeHeaders;this._bytes=new NativeUint8Array;this._responseText="";this._responseDocument=undefined;
      this._complete(kind);
    }
    _complete(kind){
      if(this._terminal)return;
      this._terminal=true;this._clearTimer();this._sent=false;this._nativeRequest=null;this._state(XMLHttpRequestFacade.DONE);
      const byteLength=nativeBinaryByteLength(this._bytes)??0;
      if(kind==="load")this._emit("load",eventWithProgress("load",byteLength,byteLength));
      else this._emit(kind,eventWithProgress(kind));
      this._emit("loadend",eventWithProgress("loadend",byteLength,byteLength));
    }
    _finishPendingUpload(kind){
      if(!this._uploadPending)return;
      this._uploadPending=false;
      if(kind==="load"&&!this._uploadProgressSeen&&this._uploadTotal!==null)
        this.upload.emit("progress",eventWithProgress("progress",this._uploadTotal,this._uploadTotal));
      const terminalEvent=this._uploadTotal===null?eventWithProgress(kind):eventWithProgress(kind,this._uploadTotal,this._uploadTotal);
      this.upload.emit(kind,terminalEvent);
      this.upload.emit("loadend",this._uploadTotal===null?eventWithProgress("loadend"):eventWithProgress("loadend",this._uploadTotal,this._uploadTotal));
    }
    _forwardUploadEvent(type,event,generation,request){
      if(generation!==this._generation||request!==this._nativeRequest||!this._uploadPending)return;
      if(type==="loadstart"&&event.lengthComputable)this._uploadTotal=event.total;
      if(type==="progress"&&event.loaded>0)this._uploadProgressSeen=true;
      if(type==="load"&&!this._uploadProgressSeen&&this._uploadTotal!==null){
        this._uploadProgressSeen=true;
        this.upload.emit("progress",eventWithProgress("progress",this._uploadTotal,this._uploadTotal));
      }
      const projected=(type==="load"||type==="loadend")&&this._uploadTotal!==null
        ?eventWithProgress(type,this._uploadTotal,this._uploadTotal)
        :nativeXHRProgress(type,event);
      this.upload.emit(type,projected);
      if(type==="loadend")this._uploadPending=false;
    }
    _startRequestTimeout(){
      if(this.timeout<=0)return;
      this._timeoutHandle=setTimeout(()=>{
        if(this._terminal)return;
        this._generation+=1;
        const request=this._nativeRequest;
        this._nativeRequest=null;
        if(request)try{nativeXHRCall(request,"abort")}catch{}
        this._finishPendingUpload("timeout");
        this._networkError("timeout");
      },this.timeout);
    }
    _acceptNativeResponseHeaders(request){
      if(this.readyState>=XMLHttpRequestFacade.HEADERS_RECEIVED)return;
      const targetURL=nativeXHRCall(request,"getResponseHeader",["X-ZP-Target-URL"]);
      const responseType=nativeXHRCall(request,"getResponseHeader",["X-ZP-Response-Type"]);
      const status=nativeXHRValue(request,"status");
      if(typeof targetURL!=="string"||targetURL===""||!["basic","cors"].includes(responseType)||status===0)throw new NativeTypeError("Network request failed");
      this._status=status;
      this._statusText=nativeXHRValue(request,"statusText");
      this._responseURL=controlledAPITarget(targetURL);
      this._responseHeaders=publicResponseHeaders(nativeXHRHeaderBlock(request));
      this._state(XMLHttpRequestFacade.HEADERS_RECEIVED);
    }
    _nativeStateChanged(request,generation){
      if(generation!==this._generation||request!==this._nativeRequest||this._terminal)return;
      const state=nativeXHRValue(request,"readyState");
      if(state!==XMLHttpRequestFacade.HEADERS_RECEIVED&&state!==XMLHttpRequestFacade.LOADING)return;
      try{
        this._acceptNativeResponseHeaders(request);
        if(state===XMLHttpRequestFacade.LOADING)this._state(XMLHttpRequestFacade.LOADING);
      }catch{
        this._nativeRequest=null;
        try{nativeXHRCall(request,"abort")}catch{}
        this._networkError("error");
      }
    }
    _nativeProgress(request,generation,event){
      if(generation!==this._generation||request!==this._nativeRequest||this._terminal)return;
      try{
        this._acceptNativeResponseHeaders(request);
        if(this.readyState!==XMLHttpRequestFacade.LOADING)this._state(XMLHttpRequestFacade.LOADING);
        this._emit("progress",nativeXHRProgress("progress",event));
      }catch{
        this._nativeRequest=null;
        try{nativeXHRCall(request,"abort")}catch{}
        this._networkError("error");
      }
    }
    _nativeLoaded(request,generation){
      if(generation!==this._generation||request!==this._nativeRequest||this._terminal)return;
      try{
        this._acceptNativeResponseHeaders(request);
        this._bytes=nativeXHRResponseBytes(request);
        this._responseText=decodedText(xhrResponseDecoder(this),this._bytes);
        if(this._uploadPending)this._finishPendingUpload("load");
        this._complete("load");
      }catch{
        this._networkError("error");
      }
    }
    _nativeFailed(request,generation,kind){
      if(generation!==this._generation||request!==this._nativeRequest||this._terminal)return;
      this._finishPendingUpload(kind);
      this._networkError(kind);
    }
    _startNativeRequest(plan,body,generation){
      if(generation!==this._generation||this._terminal)return;
      let request;
      try{
        request=reflectConstruct(natives.XMLHttpRequest,[]);
        this._nativeRequest=request;
        const listen=(target,type,handler)=>reflectApply(eventNatives.addEventListener,target,[type,handler]);
        listen(request,"readystatechange",()=>this._nativeStateChanged(request,generation));
        listen(request,"progress",event=>this._nativeProgress(request,generation,event));
        listen(request,"load",()=>this._nativeLoaded(request,generation));
        listen(request,"error",()=>this._nativeFailed(request,generation,"error"));
        listen(request,"abort",()=>this._nativeFailed(request,generation,"abort"));
        const upload=nativeXHRValue(request,"upload");
        for(const type of["loadstart","progress","load","error","abort","timeout","loadend"])
          listen(upload,type,event=>this._forwardUploadEvent(type,event,generation,request));
        nativeXHRCall(request,"open",[this._method,plan.path,true]);
        reflectApply(xhrNatives.responseType.set,request,["arraybuffer"]);
        if(plan.body_handle!=="")nativeXHRCall(request,"setRequestHeader",["X-ZP-Body-Handle",plan.body_handle]);
        nativeXHRCall(request,"send",[body]);
      }catch{
        if(request){
          if(this._nativeRequest===request)this._nativeRequest=null;
          try{nativeXHRCall(request,"abort")}catch{}
        }
        this._networkError("error");
      }
    }
    _requestFailed(){
      if(this._terminal)return;
      this._finishPendingUpload("error");
      this._networkError("error");
    }
    send(body=null){
      if(this.readyState!==XMLHttpRequestFacade.OPENED||this._sent)throw new NativeDOMException("The object is not in the OPENED state","InvalidStateError");
      this._sent=true;
      this._terminal=false;
      if((this._method==="GET"||this._method==="HEAD")&&body!==null)body=null;
      this._uploadPending=body!==null;
      this._uploadProgressSeen=false;
      this._uploadTotal=null;
      this._emit("loadstart",eventWithProgress("loadstart"));
      this._startRequestTimeout();
      const generation=this._generation,payload=apiPlanPayload("xhr",this._url,this._method,this._headers,body!==null,{credentials:this.withCredentials?"include":"same-origin",redirect:"follow"});
      payload.xhr_native_content_type=body!==null&&!reflectApply(arraySome,this._headers,[pair=>reflectApply(stringToLowerCase,pair[0],[])==="content-type"]);
      allocateAPIPlan(payload)
        .then(plan=>this._startNativeRequest(plan,body,generation))
        .catch(()=>this._requestFailed());
    }
    abort(){
      if(!this._sent)return;
      this._generation+=1;
      const request=this._nativeRequest;
      this._nativeRequest=null;
      if(request)try{nativeXHRCall(request,"abort")}catch{}
      this._finishPendingUpload("abort");
      this._networkError("abort");
    }
  }
  const XMLHttpRequestFacade=function XMLHttpRequest(){
    if(!new.target)throw new NativeTypeError("Failed to construct 'XMLHttpRequest'");
    return reflectConstruct(XMLHttpRequestFacadeCore,[],new.target===XMLHttpRequestFacade?XMLHttpRequestFacadeCore:new.target);
  };
  natives.defineProperty(XMLHttpRequestFacade,"prototype",{...natives.getOwnPropertyDescriptor(XMLHttpRequestFacade,"prototype"),value:XMLHttpRequestFacadeCore.prototype});
  natives.defineProperty(XMLHttpRequestFacadeCore.prototype,"constructor",{...natives.getOwnPropertyDescriptor(XMLHttpRequestFacadeCore.prototype,"constructor"),value:XMLHttpRequestFacade});
  XMLHttpRequestFacade.UNSENT=0;XMLHttpRequestFacade.OPENED=1;XMLHttpRequestFacade.HEADERS_RECEIVED=2;XMLHttpRequestFacade.LOADING=3;XMLHttpRequestFacade.DONE=4;
  XMLHttpRequestFacade.prototype.UNSENT=0;XMLHttpRequestFacade.prototype.OPENED=1;XMLHttpRequestFacade.prototype.HEADERS_RECEIVED=2;XMLHttpRequestFacade.prototype.LOADING=3;XMLHttpRequestFacade.prototype.DONE=4;
  objectSetPrototypeOf(XMLHttpRequestFacade,objectGetPrototypeOf(natives.XMLHttpRequest));
  class SSEParser{
    constructor(owner,state){this.owner=owner;this.state=state;this.decoder=new NativeTextDecoder;this.line="";this.cr=false;this.event="";this.data=[];this.dataLength=0;}
    push(bytes){this._text(decodedText(this.decoder,bytes,{stream:true}))}
    finish(){this._text(decodedText(this.decoder));if(this.cr){this._line();this.cr=false}if(this.line)this._line();}
    _text(text){
      for(const character of text){
        if(this.cr){this._line();this.cr=false;if(character==="\n")continue}
        if(character==="\r"){this.cr=true;continue}
        if(character==="\n"){this._line();continue}
        if(this.line.length>=65_536)throw new NativeTypeError("EventSource line exceeds limit");
        this.line+=character;
      }
    }
    _dispatch(){
      if(!this.data.length)return;
      const type=this.event||"message",data=this.data.join("\n");
      this.owner._message(type,data);
      this.data=[];
      this.dataLength=0;
      this.event="";
    }
    _field(line){
      const colon=line.indexOf(":"),field=colon<0?line:line.slice(0,colon);
      const value=colon<0?"":line.slice(colon+1).replace(/^ /,"");
      if(field==="data"){
        this.dataLength+=value.length+1;
        if(this.dataLength>16<<20)throw new NativeTypeError("EventSource event exceeds limit");
        this.data.push(value);
      }else if(field==="event")this.event=value;
      else if(field==="id"&&!value.includes("\0")&&value.length<=4_096)this.state.lastEventID=value;
      else if(field==="retry"&&/^[0-9]+$/.test(value))this.state.retry=Math.min(30_000,Math.max(100,Number(value)));
    }
    _line(){
      const line=this.line;
      this.line="";
      if(line===""){this._dispatch();return}
      if(line[0]!==":")this._field(line);
    }
  }
  class EventSourceFacade extends NativeEventTarget{
    #state;
    constructor(url,options={}){
      super();
      const targetURL=controlledAPITarget(url),withCredentials=options?.withCredentials===true;
      const payload=apiPlanPayload("eventsource",targetURL,"GET",[["Accept","text/event-stream"]],false,{credentials:withCredentials?"include":"same-origin",redirect:"follow"});
      payload.instance_id=cookieOperationID();
      const state={url:targetURL,withCredentials,readyState:EventSourceFacade.CONNECTING,lastEventID:"",retry:1_000,attempt:0,closed:false,timer:null,controller:null,payload,planPromise:null};
      this.#state=state;
      this.onopen=null;this.onmessage=null;this.onerror=null;
      state.planPromise=allocateAPIPlan(payload);
      NativePromise.resolve().then(()=>this._connect());
    }
    get url(){return this.#state.url}
    get withCredentials(){return this.#state.withCredentials}
    get readyState(){return this.#state.readyState}
    _emit(type,event=new NativeEvent(type)){this.dispatchEvent(event);const handler=this[`on${type}`];if(typeof handler==="function")handler.call(this,event);}
    _message(type,data){const state=this.#state,event=new NativeMessageEvent(type,{data,origin:new NativeURL(state.url).origin,lastEventId:state.lastEventID});this.dispatchEvent(event);if(type==="message"&&typeof this.onmessage==="function")this.onmessage.call(this,event);}
    _retryLater(){const state=this.#state;if(state.closed)return;state.readyState=EventSourceFacade.CONNECTING;this._emit("error");state.timer=setTimeout(()=>this._connect(),state.retry)}
    async _readEventStream(body){
      const parser=new SSEParser(this,this.#state),reader=body?.getReader();
      if(!reader)throw new NativeTypeError("EventSource stream unavailable");
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        const chunk=nativeBinaryCopy(value);
        if(chunk===null)throw new NativeTypeError("EventSource stream unavailable");
        parser.push(chunk);
      }
      parser.finish();
    }
    async _consumeResponse(response){
      const state=this.#state,status=controlledResponseValue(response,"status"),headers=controlledResponseValue(response,"headers"),body=controlledResponseValue(response,"body");
      if(status!==200||!/^text\/event-stream(?:;|$)/i.test(headerGet(headers,"content-type")??"")){
        void body?.cancel().catch(()=>{});
        throw new NativeTypeError("EventSource response rejected");
      }
      if(state.closed)return;
      state.readyState=EventSourceFacade.OPEN;
      this._emit("open");
      await this._readEventStream(body);
      if(!state.closed)this._retryLater();
    }
    _reconnectPlan(){
      const state=this.#state,reconnect=state.attempt++>0;
      return state.planPromise.then(plan=>{
        if(!reconnect)return plan;
        return runtimeCommand("EVENTSOURCE_RECONNECT",{id:plan.id},"EventSource reconnect rejected").then(()=>plan);
      });
    }
    _connect(){
      const state=this.#state;
      if(state.closed)return;
      state.timer=null;
      state.controller=new NativeAbortController;
      this._reconnectPlan()
        .then(plan=>requestAllocatedAPIStream(plan,state.payload,null,controllerSignal(state.controller)))
        .then(response=>this._consumeResponse(response))
        .catch(()=>{if(!state.closed)this._retryLater()});
    }
    close(){
      const state=this.#state;
      if(state.closed)return;
      state.closed=true;state.readyState=EventSourceFacade.CLOSED;
      if(state.timer!==null){clearTimeout(state.timer);state.timer=null}
      if(state.controller)abortController(state.controller);
      void state.planPromise.then(plan=>runtimeCommand("EVENTSOURCE_REVOKE",{id:plan.id},"EventSource revoke failed")).catch(()=>{});
    }
  }
  EventSourceFacade.CONNECTING=0;EventSourceFacade.OPEN=1;EventSourceFacade.CLOSED=2;EventSourceFacade.prototype.CONNECTING=0;EventSourceFacade.prototype.OPEN=1;EventSourceFacade.prototype.CLOSED=2;
  function socketCloseEvent(code,reason,wasClean){return NativeCloseEvent?new NativeCloseEvent("close",{code,reason,wasClean}):new NativeEvent("close")}
  function socketNetworkError(){return new NativeDOMException("WebSocket connection failed","NetworkError")}
  const webSocketControls=new PrivateWeakMap;
  class WebSocketFacade extends NativeEventTarget{
    #state;
    constructor(url,protocols){
      super();
      const targetURL=controlledSocketTarget(url),offered=normalizeProtocols(protocols);
      this.#state={url:targetURL,offered,protocol:"",extensions:"",readyState:WebSocketFacade.CONNECTING,binaryType:"blob",bufferedAmount:0,port:null,requestID:"",nextSequence:0,queued:new PrivateMap,sendBarrier:NativePromise.resolve(),closed:false,errorEmitted:false,ready:false,opened:false,maxMessageBytes:256<<10,sendHighWaterMark:1<<20,closeRequested:null,closeDispatched:false};
      this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;
      webSocketControls.set(this,{send:value=>this.#queueSend(value,true),cancel:error=>this.#cancel(error)});
      const payload=apiPlanPayload("websocket",targetURL,"GET",[],false,{protocols:offered,credentials:"include"});
      allocateAPIPlan(payload).then(plan=>this.#openPlan(plan)).catch(()=>this.#fail(1006,"",false));
    }
    get url(){return this.#state.url}
    get protocol(){return this.#state.protocol}
    get extensions(){return this.#state.extensions}
    get readyState(){return this.#state.readyState}
    get bufferedAmount(){return this.#state.bufferedAmount}
    get binaryType(){return this.#state.binaryType}
    set binaryType(value){
      value=NativeString(value);
      if(value==="blob"||value==="arraybuffer")this.#state.binaryType=value;
    }
    #emit(type,event=new NativeEvent(type)){reflectApply(eventNatives.dispatchEvent,this,[event]);const handler=this[`on${type}`];if(typeof handler==="function")try{handler.call(this,event)}catch{}}
    #openPlan(plan){
      const state=this.#state;
      if(state.closed)return;
      if(!NativeMessageChannel){this.#fail(1006,"",false);return}
      const channel=new NativeMessageChannel;
      state.requestID=plan.id;state.port=channel.port1;
      channel.port1.onmessage=event=>this.#streamEvent(event.data);
      channel.port1.onmessageerror=()=>this.#fail(1006,"",false);
      channel.port1.start?.();
      void runtimeStreamCommand("OPEN_API_STREAM",{id:plan.id},channel.port2,"WebSocket stream unavailable").catch(()=>{try{channel.port1.close()}catch{}this.#fail(1006,"",false)});
    }
    #streamReady(message){
      const state=this.#state,maxMessage=message.max_message_bytes,highWater=message.send_high_water_mark;
      if(state.ready||state.readyState===WebSocketFacade.CLOSED||!numberIsInteger(maxMessage)||maxMessage<1||maxMessage>4<<20||!numberIsInteger(highWater)||highWater<maxMessage||highWater>16<<20){this.#fail(1006,"",false);return}
      state.ready=true;state.maxMessageBytes=maxMessage;state.sendHighWaterMark=highWater;
      if(state.closeRequested)this.#queueClose();
    }
    #streamOpen(message){
      const state=this.#state;
      if(!state.ready||state.opened||state.readyState===WebSocketFacade.CLOSED){this.#fail(1006,"",false);return}
      const protocol=typeof message.protocol==="string"&&(message.protocol===""||reflectApply(arrayIncludes,state.offered,[message.protocol]))?message.protocol:"";
      if(typeof message.protocol!=="string"||message.protocol!==protocol){this.#fail(1006,"",false);return}
      state.opened=true;state.protocol=protocol;
      if(state.readyState===WebSocketFacade.CLOSING){this.#queueClose();return}
      if(state.readyState!==WebSocketFacade.CONNECTING){this.#fail(1006,"",false);return}
      state.readyState=WebSocketFacade.OPEN;
      this.#emit("open");
    }
    #streamAck(message){
      const state=this.#state,queued=state.queued.get(message.seq);
      if(!queued||!numberIsInteger(message.seq)){this.#fail(1006,"",false);return}
      state.queued.delete(message.seq);
      state.bufferedAmount=state.bufferedAmount>=queued.bytes?state.bufferedAmount-queued.bytes:0;
      queued.resolve?.();
    }
    #streamMessage(message){
      const state=this.#state,binary=nativeBinaryCopy(message.data);
      if((state.readyState!==WebSocketFacade.OPEN&&state.readyState!==WebSocketFacade.CLOSING)||binary===null||(message.data_kind!=="text"&&message.data_kind!=="binary")){
        this.#fail(1006,"",false);
        return;
      }
      let data;
      if(message.data_kind==="text"){
        try{data=decodedText(new NativeTextDecoder("utf-8",{fatal:true}),binary)}
        catch{this.#fail(1006,"",false);return}
      }else data=state.binaryType==="arraybuffer"?nativeBinaryBuffer(binary):new NativeBlob([binary]);
      this.#emit("message",new NativeMessageEvent("message",{data,origin:new NativeURL(state.url).origin}));
    }
    #streamError(){
      const state=this.#state;
      if(state.closed||state.errorEmitted)return;
      state.errorEmitted=true;this.#emit("error");
    }
    #streamClose(message){
      if(!numberIsInteger(message.code)||message.code<0||message.code>65535||typeof message.reason!=="string"||message.was_clean!==true&&message.was_clean!==false||(nativeBinaryByteLength(encodedText(message.reason))??124)>123){this.#fail(1006,"",false);return}
      this.#finish(message.code,message.reason,message.was_clean);
    }
    #streamEvent(message){
      const state=this.#state;
      if(state.closed)return;
      if(!message||message.v!==2||message.request_id!==state.requestID||typeof message.type!=="string"){this.#fail(1006,"",false);return}
      switch(message.type){
        case"ready":this.#streamReady(message);break;
        case"open":this.#streamOpen(message);break;
        case"ack":this.#streamAck(message);break;
        case"message":this.#streamMessage(message);break;
        case"error":this.#fail(1006,"",false);break;
        case"close":this.#streamClose(message);break;
        default:this.#fail(1006,"",false);
      }
    }
    #fail(code,reason,wasClean){if(this.#state.closed)return;try{this.#streamError()}finally{this.#finish(code,reason,wasClean)}}
    #finish(code,reason,wasClean){
      const state=this.#state;
      if(state.closed)return;
      state.closed=true;state.readyState=WebSocketFacade.CLOSED;
      const error=socketNetworkError();
      for(const queued of state.queued.values())queued.reject?.(error);
      state.queued.clear();
      try{state.port?.close()}catch{}
      this.#emit("close",socketCloseEvent(code,reason,wasClean));
    }
    #messageForSend(value){
      const state=this.#state,blobSize=nativeBlobSize(value);
      if(blobSize!==null&&blobSize>state.maxMessageBytes)throw new NativeDOMException("WebSocket message exceeds controlled limit","QuotaExceededError");
      if(typeof value==="string")return{kind:"text",data:encodedText(value),blob:null};
      const binary=nativeBinaryCopy(value);
      if(binary!==null)return{kind:"binary",data:binary,blob:null};
      if(blobSize!==null)return{kind:"binary",data:undefined,blob:value,bytes:blobSize};
      const text=NativeString(value);return{kind:"text",data:encodedText(text),blob:null};
    }
    #releaseQueued(sequence,error){
      const state=this.#state,queued=state.queued.get(sequence);
      if(!queued)return;
      state.queued.delete(sequence);
      state.bufferedAmount=state.bufferedAmount>=queued.bytes?state.bufferedAmount-queued.bytes:0;
      if(error)queued.reject?.(error);
    }
    async #deliverQueued(sequence,message){
      const state=this.#state,payload=message.blob?new NativeUint8Array(await reflectApply(blobNatives.arrayBuffer,message.blob,[])):message.data;
      const draining=state.readyState===WebSocketFacade.OPEN||state.readyState===WebSocketFacade.CLOSING&&state.opened&&state.closeRequested?.cancel!==true;
      if(state.closed||!draining){this.#releaseQueued(sequence,socketNetworkError());return}
      const buffer=nativeBinaryBuffer(payload);
      if(buffer===null)throw socketNetworkError();
      state.port?.postMessage({v:2,type:"send",request_id:state.requestID,seq:sequence,kind:message.kind,data:payload},[buffer]);
    }
    #queueSend(value,acknowledged){
      const state=this.#state;
      if(state.readyState===WebSocketFacade.CONNECTING)throw new NativeDOMException("WebSocket is connecting","InvalidStateError");
      if(state.readyState!==WebSocketFacade.OPEN)return acknowledged?reflectApply(promiseReject,NativePromise,[socketNetworkError()]):undefined;
      const message=this.#messageForSend(value),dataLength=message.data===undefined?null:nativeBinaryByteLength(message.data);
      if(message.data!==undefined&&(dataLength===null||dataLength>state.maxMessageBytes))
        throw new NativeDOMException("WebSocket message exceeds controlled limit","QuotaExceededError");
      message.bytes??=dataLength;
      if(state.bufferedAmount>state.sendHighWaterMark-message.bytes||state.queued.size>=64)
        throw new NativeDOMException("WebSocket send queue is full","QuotaExceededError");
      const sequence=state.nextSequence++;
      let resolve,reject,promise;
      if(acknowledged)promise=new NativePromise((accepted,denied)=>{resolve=accepted;reject=denied});
      state.queued.set(sequence,{bytes:message.bytes,resolve,reject});
      state.bufferedAmount+=message.bytes;
      state.sendBarrier=state.sendBarrier
        .then(()=>this.#deliverQueued(sequence,message))
        .catch(()=>this.#fail(1006,"",false));
      return promise;
    }
    send(value){this.#queueSend(value,false)}
    #cancel(error){
      const state=this.#state;
      if(state.readyState===WebSocketFacade.CLOSED)return;
      state.readyState=WebSocketFacade.CLOSING;state.closeRequested={cancel:true,error};
      if(state.ready)this.#queueClose();
    }
    #queueClose(){
      const state=this.#state;
      if(state.closeDispatched||!state.ready||!state.port)return;
      state.closeDispatched=true;
      state.sendBarrier=state.sendBarrier.then(()=>{
        if(state.closed)return;
        if(state.closeRequested?.cancel||!state.opened){
          state.port.postMessage({v:2,type:"cancel",request_id:state.requestID});
          this.#finish(1006,"",false);
          return;
        }
        state.port.postMessage({v:2,type:"close",request_id:state.requestID,code:state.closeRequested.code,reason:state.closeRequested.reason});
      }).catch(()=>this.#fail(1006,"",false));
    }
    close(code,reason){
      const state=this.#state;
      if(state.readyState===WebSocketFacade.CLOSING||state.readyState===WebSocketFacade.CLOSED)return;
      const hasCode=arguments.length>0&&code!==undefined;
      reason=arguments.length>1?NativeString(reason):"";
      if(hasCode){
        code=NativeNumber(code);
        if(!numberIsInteger(code)||(code!==1000&&(code<3000||code>4999)))throw new NativeDOMException("Invalid WebSocket close code","InvalidAccessError");
      }
      if((nativeBinaryByteLength(encodedText(reason))??0)>123)throw new NativeDOMException("Invalid WebSocket close reason","SyntaxError");
      const wireCode=hasCode?code:reason===""?1005:1000;
      state.readyState=WebSocketFacade.CLOSING;state.closeRequested={code:wireCode,reason};
      if(state.ready)this.#queueClose();
    }
  }
  WebSocketFacade.CONNECTING=0;WebSocketFacade.OPEN=1;WebSocketFacade.CLOSING=2;WebSocketFacade.CLOSED=3;WebSocketFacade.prototype.CONNECTING=0;WebSocketFacade.prototype.OPEN=1;WebSocketFacade.prototype.CLOSING=2;WebSocketFacade.prototype.CLOSED=3;
  class WebSocketStreamFacade{
    #state;
    constructor(url,options={}){
      options=options??{};
      if(typeof options!=="object")throw new NativeTypeError("Invalid WebSocketStream options");
      const signal=options.signal;
      if(signal!==undefined)signalAborted(signal);
      const socket=new WebSocketFacade(url,options.protocols);socket.binaryType="arraybuffer";
      const control=webSocketControls.get(socket);
      let resolveOpened,rejectOpened,resolveClosed,rejectClosed,readableController,writableController;
      const opened=new NativePromise((resolve,reject)=>{resolveOpened=resolve;rejectOpened=reject});
      const closed=new NativePromise((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject});
      const state={socket,control,opened,closed,openedSettled:false,terminal:false,abortError:null,networkError:null,readable:null,writable:null};
      this.#state=state;
      const cancel=reason=>{const error=reason instanceof NativeError?reason:new NativeDOMException("The operation was aborted","AbortError");state.abortError=error;control.cancel(error)};
      state.readable=new NativeReadableStream({start(controller){readableController=controller},cancel});
      state.writable=new NativeWritableStream({start(controller){writableController=controller},write:value=>control.send(value),close:()=>{socket.close(1000,"");return closed},abort:reason=>{cancel(reason);return undefined}});
      void opened.catch(()=>{});void closed.catch(()=>{});
      reflectApply(eventNatives.addEventListener,socket,["open",()=>{
        if(state.terminal)return;
        state.openedSettled=true;resolveOpened({readable:state.readable,writable:state.writable,protocol:socket.protocol,extensions:socket.extensions});
      },{once:true}]);
      reflectApply(eventNatives.addEventListener,socket,["message",event=>{
        if(state.terminal)return;
        try{reflectApply(readableStreamControllerNatives.enqueue,readableController,[event.data])}catch{control.cancel(socketNetworkError())}
      }]);
      reflectApply(eventNatives.addEventListener,socket,["error",()=>{
        if(state.terminal)return;
        state.networkError=socketNetworkError();
        if(!state.openedSettled){state.openedSettled=true;rejectOpened(state.abortError??state.networkError)}
      },{once:true}]);
      reflectApply(eventNatives.addEventListener,socket,["close",event=>{
        if(state.terminal)return;
        state.terminal=true;
        const error=state.abortError??state.networkError??socketNetworkError();
        if(!state.openedSettled){state.openedSettled=true;rejectOpened(error)}
        if(event.wasClean&&!state.abortError){
          try{reflectApply(readableStreamControllerNatives.close,readableController,[])}catch{}
          resolveClosed({closeCode:event.code,reason:event.reason});
        }else{
          try{reflectApply(readableStreamControllerNatives.error,readableController,[error])}catch{}
          try{reflectApply(writableStreamControllerNatives.error,writableController,[error])}catch{}
          rejectClosed(error);
        }
      },{once:true}]);
      if(signal!==undefined){
        const abort=()=>cancel(new NativeDOMException("The operation was aborted","AbortError"));
        if(signalAborted(signal))abort();else reflectApply(eventNatives.addEventListener,signal,["abort",abort,{once:true}]);
      }
    }
    get opened(){return this.#state.opened}
    get closed(){return this.#state.closed}
    close(closeInfo={}){
      closeInfo=closeInfo??{};
      if(typeof closeInfo!=="object")throw new NativeTypeError("Invalid WebSocketStream close options");
      const code=closeInfo.closeCode===undefined?1000:closeInfo.closeCode,reason=closeInfo.reason===undefined?"":closeInfo.reason;
      this.#state.socket.close(code,reason);
    }
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function network_section_36() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function stageServiceAndFormSurfaces(){
    if(serviceWorkerNatives.container&&virtualServiceWorkerContainer)stage(Navigator.prototype,"serviceWorker",{...serviceWorkerNatives.container,get(){return virtualServiceWorkerContainer},configurable:false});
    stage(HTMLFormElement.prototype,"submit",{...natives.getOwnPropertyDescriptor(HTMLFormElement.prototype,"submit"),value:controlledFormSubmit,writable:false,configurable:false});
    if(formNatives.requestSubmit)stage(HTMLFormElement.prototype,"requestSubmit",{...natives.getOwnPropertyDescriptor(HTMLFormElement.prototype,"requestSubmit"),value:controlledFormRequestSubmit,writable:false,configurable:false});
  }
  function stageWorkerBlobSurfaces(){
    if(workerBlobCreateDescriptor?.configurable&&typeof blobNatives.createObjectURL==="function")stage(NativeURL,"createObjectURL",{...workerBlobCreateDescriptor,value:function(blob){return trackedWorkerObjectURL(blob)},configurable:false});
    if(workerBlobRevokeDescriptor?.configurable&&typeof blobNatives.revokeObjectURL==="function")stage(NativeURL,"revokeObjectURL",{...workerBlobRevokeDescriptor,value:function(url){return revokedWorkerObjectURL(url)},configurable:false});
  }
  function stageWorkerPrototypeConstructors(){
    if(natives.Worker){
      const descriptor=natives.getOwnPropertyDescriptor(natives.Worker.prototype,"constructor");
      if(descriptor?.configurable)stage(natives.Worker.prototype,"constructor",{...descriptor,value:WorkerFacade,configurable:false});
    }
    if(natives.SharedWorker&&SharedWorkerFacade){
      const descriptor=natives.getOwnPropertyDescriptor(natives.SharedWorker.prototype,"constructor");
      if(descriptor?.configurable)stage(natives.SharedWorker.prototype,"constructor",{...descriptor,value:SharedWorkerFacade,configurable:false});
    }
  }
  function stageMessagePortSurface(){
    const descriptor=messagePortNatives.prototype&&natives.getOwnPropertyDescriptor(messagePortNatives.prototype,"close");
    if(messagePortNatives.close&&descriptor?.configurable)stage(messagePortNatives.prototype,"close",{...descriptor,value:MessagePortCloseFacade,writable:false,configurable:false});
  }
  function stageWorkerSurfaces(){
    stageServiceAndFormSurfaces();
    stageWorkerBlobSurfaces();
    stageWorkerPrototypeConstructors();
    stageMessagePortSurface();
  }
  function stageWorkletSurfaces(){
    const stagedWorkletPrototypes=new PrivateSet;
    for(const [prototype,native] of[[globalThis.AudioWorklet?.prototype,workletNatives.audio],[globalThis.Worklet?.prototype,workletNatives.worklet]]){
      const descriptor=prototype&&natives.getOwnPropertyDescriptor(prototype,"addModule");
      if(native&&descriptor?.configurable&&!stagedWorkletPrototypes.has(prototype)){
        stagedWorkletPrototypes.add(prototype);
        stage(prototype,"addModule",{...descriptor,value:function(scriptURL,options){return controlledWorkletModule(native,this,scriptURL,options)},configurable:false});
      }
    }
  }
  function stageNetworkConstructorSurfaces(){
    for(const [name,value] of [["XMLHttpRequest",XMLHttpRequestFacade],["EventSource",EventSourceFacade],["WebSocket",WebSocketFacade],["WebSocketStream",WebSocketStreamFacade],["Worker",WorkerFacade],["SharedWorker",SharedWorkerFacade]])if(value&&name in rawWindow)stage(rawWindow,name,{...natives.getOwnPropertyDescriptor(rawWindow,name),value,writable:false,configurable:false});
    if(networkNatives.sendBeacon)stage(Navigator.prototype,"sendBeacon",{value:controlledSendBeacon,writable:false,enumerable:true,configurable:false});
    for(const [name,blocker] of disabledNetworkConstructors){const descriptor=natives.getOwnPropertyDescriptor(rawWindow,name);if(!descriptor?.configurable)throw new NativeError("Disabled network constructor descriptor unavailable");stage(rawWindow,name,{...descriptor,value:blocker,writable:false,configurable:false})}
    for(const record of disabledCapabilityMethods)stage(record.target,record.member,{...record.descriptor,value:record.facade,writable:false,configurable:false});
  }
  function stageGlobalSurfaces(){
    stageFunctionAndTimerSurfaces();
    stageWorkerSurfaces();
    stageWorkletSurfaces();
    stageNetworkConstructorSurfaces();
  }
  stageGlobalSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
