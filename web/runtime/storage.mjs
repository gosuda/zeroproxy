export const runtimeSections = [
  { file: import.meta.url, name: "storage_section_08", order: 8, phase: "inner" },
  { file: import.meta.url, name: "storage_section_34", order: 34, phase: "inner" },
];

export function storage_section_08() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const controlledResponseMetadata=new PrivateWeakMap;
  function nativeResponseValue(response,key){return reflectApply(reflectGet(responseNatives,key).get,response,[])}
  function nativeResponseHeaders(response){return nativeResponseValue(response,"headers")}
  function headerGet(headers,name){return reflectApply(headersNatives.get,headers,[name])}
  function publicResponseHeaders(headers){
    const visible=new NativeHeaders(headers);
    for(const name of["X-ZP-Target-URL","X-ZP-Redirected","X-ZP-Response-Type","X-ZP-API-ERROR"])reflectApply(headersNatives.delete,visible,[name]);
    return visible;
  }
  function installControlledResponse(response,targetURL,redirected,responseType){
    const opaque=responseType==="opaque"||responseType==="opaqueredirect",headers=opaque?new NativeHeaders:publicResponseHeaders(nativeResponseHeaders(response)),visibleTarget=responseType==="opaque"?"":targetURL;
    controlledResponseMetadata.set(response,objectFreeze({targetURL:visibleTarget,redirected,responseType,opaque,headers}));
    return response;
  }
  function hydrateControlledResponse(response){
    if(response===undefined||response===null)return response;
    let headers;
    try{headers=nativeResponseHeaders(response)}catch{return response}
    const targetURL=headerGet(headers,"X-ZP-Target-URL"),redirected=headerGet(headers,"X-ZP-Redirected"),responseType=headerGet(headers,"X-ZP-Response-Type");
    if(typeof targetURL==="string"&&targetURL!==""&&reflectApply(arrayIncludes,["0","1"],[redirected])&&reflectApply(arrayIncludes,["basic","cors","opaque","opaqueredirect"],[responseType]))return installControlledResponse(response,targetURL,redirected==="1",responseType);
    return response;
  }
  function facadeAPIResponse(response,targetURL,redirected,responseType){
    const opaque=responseType==="opaque"||responseType==="opaqueredirect",sourceHeaders=nativeResponseHeaders(response),headers=opaque?new NativeHeaders:publicResponseHeaders(sourceHeaders),body=nativeResponseValue(response,"body");
    for(const name of["X-ZP-Target-URL","X-ZP-Redirected","X-ZP-Response-Type"]){const value=headerGet(sourceHeaders,name);if(value!==null)reflectApply(headersNatives.set,headers,[name,value])}
    const target=new NativeResponse(body,{status:nativeResponseValue(response,"status"),statusText:nativeResponseValue(response,"statusText"),headers});
    return installControlledResponse(target,targetURL,redirected,responseType);
  }
  function controlledAPIResponse(response,errorMessage){
    const headers=nativeResponseHeaders(response);
    if(headerGet(headers,"X-ZP-API-ERROR")!==null){void nativeResponseValue(response,"body")?.cancel().catch(()=>{});throw new NativeTypeError(errorMessage)}
    const targetURL=headerGet(headers,"X-ZP-Target-URL"),redirected=headerGet(headers,"X-ZP-Redirected"),responseType=headerGet(headers,"X-ZP-Response-Type");
    if(typeof targetURL!=="string"||targetURL===""||!reflectApply(arrayIncludes,["0","1"],[redirected])||!reflectApply(arrayIncludes,["basic","cors","opaque","opaqueredirect"],[responseType])){void nativeResponseValue(response,"body")?.cancel().catch(()=>{});throw new NativeTypeError(errorMessage)}
    return facadeAPIResponse(response,targetURL,redirected==="1",responseType);
  }
  function opaqueResponseValue(key){
    if(key==="status")return 0;
    if(key==="statusText")return"";
    if(key==="ok"||key==="bodyUsed")return false;
    if(key==="body")return null;
    return undefined;
  }
  function controlledResponseValue(response,key){
    const metadata=controlledResponseMetadata.get(response);
    if(!metadata)return nativeResponseValue(response,key);
    if(key==="url")return metadata.targetURL;
    if(key==="redirected")return metadata.redirected;
    if(key==="type")return metadata.responseType;
    if(key==="headers")return metadata.headers;
    if(metadata.opaque){
      const value=opaqueResponseValue(key);
      if(value!==undefined)return value;
    }
    return nativeResponseValue(response,key);
  }
  function controlledResponseClone(response){
    const clone=reflectApply(responseNatives.clone,response,[]),metadata=controlledResponseMetadata.get(response);
    return metadata?installControlledResponse(clone,metadata.targetURL,metadata.redirected,metadata.responseType):clone;
  }
  function controlledResponseBodyMethod(response,key,args){
    const metadata=controlledResponseMetadata.get(response),receiver=metadata?.opaque?new NativeResponse(null):response;
    return reflectApply(reflectGet(responseNatives,key),receiver,args);
  }
  function controlledCacheResult(result){return hydrateControlledResponse(result)}
  function controlledCacheResults(results){for(let index=0;index<results.length;index+=1)hydrateControlledResponse(results[index]);return results}
  function cacheResult(native,receiver,args,many=false){return reflectApply(promiseThen,reflectApply(native,receiver,args),[many?controlledCacheResults:controlledCacheResult])}
  function controlledCacheAdd(receiver,request){return reflectApply(promiseThen,controlledFetch(request),[response=>{if(!response.ok)throw new NativeTypeError("Cache add request failed");return reflectApply(cacheNatives.put,receiver,[request,response])}])}
  function controlledCacheAddAll(receiver,requests){
    const values=arrayFrom(requests),fetches=reflectApply(arrayMap,values,[request=>controlledFetch(request)]);
    return reflectApply(promiseThen,reflectApply(promiseAll,NativePromise,[fetches]),[responses=>{
      for(const response of responses)if(!response.ok)throw new NativeTypeError("Cache addAll request failed");
      let chain=reflectApply(promiseResolve,NativePromise,[]);
      for(let index=0;index<values.length;index+=1)chain=reflectApply(promiseThen,chain,[()=>reflectApply(cacheNatives.put,receiver,[values[index],responses[index]])]);
      return chain;
    }]);
  }
  const internalCachePrefix="__zeroproxy_internal_";
  function internalCacheName(value){return reflectApply(stringStartsWith,NativeString(value),[internalCachePrefix])}
  async function publicCacheStorageMatch(receiver,requestValue,options){
    const cacheName=options===undefined||options===null?undefined:reflectGet(options,"cacheName");
    if(cacheName!==undefined){
      if(internalCacheName(cacheName))return undefined;
      return controlledCacheResult(await reflectApply(cacheStorageNatives.match,receiver,[requestValue,{...options,cacheName:NativeString(cacheName)}]));
    }
    const names=await reflectApply(cacheStorageNatives.keys,receiver,[]);
    for(let index=0;index<names.length;index+=1){
      if(internalCacheName(names[index]))continue;
      const cache=await reflectApply(cacheStorageNatives.open,receiver,[names[index]]),result=await reflectApply(cacheNatives.match,cache,[requestValue,options]);
      if(result!==undefined)return controlledCacheResult(result);
    }
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function storage_section_34() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function stageResponseAndCacheSurfaces(){
    for(const key of["url","redirected","type","status","statusText","ok","headers","body","bodyUsed"]){
      const descriptor=reflectGet(responseNatives,key);
      if(!descriptor?.get||!descriptor.configurable)throw new Error(`Response descriptor unavailable: ${key}`);
      stage(NativeResponse.prototype,key,{...descriptor,get(){return controlledResponseValue(this,key)},configurable:false});
    }
    const clone=mirrorFunction(function(){return controlledResponseClone(this)},responseNatives.clone);
    stage(NativeResponse.prototype,"clone",{...natives.getOwnPropertyDescriptor(NativeResponse.prototype,"clone"),value:clone,writable:false,configurable:false});
    for(const key of["arrayBuffer","blob","bytes","formData","json","text"]){
      const native=reflectGet(responseNatives,key);
      if(typeof native!=="function")continue;
      const method=mirrorFunction(function(...args){return controlledResponseBodyMethod(this,key,args)},native);
      stage(NativeResponse.prototype,key,{...natives.getOwnPropertyDescriptor(NativeResponse.prototype,key),value:method,writable:false,configurable:false});
    }
    if(cacheNatives){
      const match=mirrorFunction(function(...args){return cacheResult(cacheNatives.match,this,args)},cacheNatives.match);
      const matchAll=mirrorFunction(function(...args){return cacheResult(cacheNatives.matchAll,this,args,true)},cacheNatives.matchAll);
      const add=mirrorFunction(function(request){return controlledCacheAdd(this,request)},cacheNatives.add);
      const addAll=mirrorFunction(function(requests){return controlledCacheAddAll(this,requests)},cacheNatives.addAll);
      stage(NativeCache.prototype,"match",{...natives.getOwnPropertyDescriptor(NativeCache.prototype,"match"),value:match,writable:false,configurable:false});
      stage(NativeCache.prototype,"matchAll",{...natives.getOwnPropertyDescriptor(NativeCache.prototype,"matchAll"),value:matchAll,writable:false,configurable:false});
      stage(NativeCache.prototype,"add",{...natives.getOwnPropertyDescriptor(NativeCache.prototype,"add"),value:add,writable:false,configurable:false});
      stage(NativeCache.prototype,"addAll",{...natives.getOwnPropertyDescriptor(NativeCache.prototype,"addAll"),value:addAll,writable:false,configurable:false});
    }
    if(cacheStorageNatives){
      const match=mirrorFunction(function(requestValue,options){return publicCacheStorageMatch(this,requestValue,options)},cacheStorageNatives.match);
      const open=mirrorFunction(function(name){
        const normalized=NativeString(name);
        return internalCacheName(normalized)?reflectApply(promiseReject,NativePromise,[new NativeDOMException("Reserved cache name","SecurityError")]):reflectApply(cacheStorageNatives.open,this,[normalized]);
      },cacheStorageNatives.open);
      const remove=mirrorFunction(function(name){
        const normalized=NativeString(name);
        return internalCacheName(normalized)?reflectApply(promiseResolve,NativePromise,[false]):reflectApply(cacheStorageNatives.delete,this,[normalized]);
      },cacheStorageNatives.delete);
      const has=mirrorFunction(function(name){
        const normalized=NativeString(name);
        return internalCacheName(normalized)?reflectApply(promiseResolve,NativePromise,[false]):reflectApply(cacheStorageNatives.has,this,[normalized]);
      },cacheStorageNatives.has);
      const keys=mirrorFunction(function(){return reflectApply(promiseThen,reflectApply(cacheStorageNatives.keys,this,[]),[names=>reflectApply(arrayFilter,names,[name=>!internalCacheName(name)])])},cacheStorageNatives.keys);
      for(const [key,value] of[["match",match],["open",open],["delete",remove],["has",has],["keys",keys]])stage(NativeCacheStorage.prototype,key,{...natives.getOwnPropertyDescriptor(NativeCacheStorage.prototype,key),value,writable:false,configurable:false});
    }
  }
  stageResponseAndCacheSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
