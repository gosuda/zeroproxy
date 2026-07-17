export const runtimeSections = [
  { file: import.meta.url, name: "dynamic_code_section_03", order: 3, phase: "outer" },
  { file: import.meta.url, name: "dynamic_code_section_04", order: 4, phase: "inner" },
  { file: import.meta.url, name: "dynamic_code_section_21", order: 21, phase: "inner" },
  { file: import.meta.url, name: "dynamic_code_section_24", order: 24, phase: "inner" },
  { file: import.meta.url, name: "dynamic_code_section_35", order: 35, phase: "inner" },
];

export function dynamic_code_section_03() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
function compilerInteger(value){return typeof value==="number"&&value>=0&&value<=9007199254740991&&value%1===0}
function compilerRecord(value){return value!==null&&typeof value==="object"&&!arrayIsArray(value)}
function compilerNullableString(value){return value===null||typeof value==="string"}
function compilerArrayValid(values,predicate){if(!arrayIsArray(values))return false;for(let index=0;index<values.length;index+=1)if(!predicate(values[index]))return false;return true}
function compilerEdit(value){return compilerRecord(value)&&typeof value.kind==="string"&&compilerInteger(value.start)&&compilerInteger(value.end)&&value.start<=value.end&&typeof value.replacement==="string"}
function compilerMapSpan(value){return compilerRecord(value)&&compilerInteger(value.original_start)&&compilerInteger(value.original_end)&&compilerInteger(value.generated_start)&&compilerInteger(value.generated_end)&&value.original_start<=value.original_end&&value.generated_start<=value.generated_end}
function compilerModuleSpecifier(value){return compilerMapSpan(value)&&value.original_start<value.original_end&&value.generated_start<value.generated_end&&typeof value.specifier==="string"&&(value.module_type==="javascript"||value.module_type==="json")}
function compilerSourceMap(value){return compilerRecord(value)&&value.version===3&&typeof value.file==="string"&&arrayIsArray(value.sources)&&value.sources.length===1&&typeof value.sources[0]==="string"&&arrayIsArray(value.sourcesContent)&&value.sourcesContent.length===1&&typeof value.sourcesContent[0]==="string"&&arrayIsArray(value.names)&&typeof value.mappings==="string"}
function compilerErrorStage(value){return value==="validation"||value==="parse"||value==="analysis"||value==="resolve"||value==="transform"||value==="codegen"||value==="policy"}
function compilerFailure(result,syntax){const error=result?.error,valid=compilerRecord(result)&&result.schema_version===1&&result.ok===false&&result.code===null&&arrayIsArray(result.edits)&&result.edits.length===0&&arrayIsArray(result.edit_map)&&result.edit_map.length===0&&result.source_map===null&&arrayIsArray(result.module_specifiers)&&result.module_specifiers.length===0&&result.source_url===null&&result.source_mapping_url===null&&compilerRecord(error)&&typeof error.code==="string"&&error.code.length>0&&typeof error.source_kind==="string"&&error.source_kind.length>0&&compilerErrorStage(error.stage)&&(error.recoverability==="none"||error.recoverability==="retryable")&&(error.line===undefined||compilerInteger(error.line)&&error.line>=1)&&(error.column===undefined||compilerInteger(error.column)&&error.column>=1)&&arrayIsArray(result.diagnostics);if(!valid)throw new NativeDOMException("Compiler failure","SecurityError");if(syntax&&error.code==="PARSE_FAILED")throw new NativeSyntaxError("Invalid executable source");throw new NativeDOMException(error.code,"SecurityError")} 
function compilerSuccess(result){return compilerRecord(result)&&result.schema_version===1&&result.ok===true&&typeof result.code==="string"&&compilerArrayValid(result.edits,compilerEdit)&&compilerArrayValid(result.edit_map,compilerMapSpan)&&result.edit_map.length===result.edits.length&&compilerSourceMap(result.source_map)&&compilerArrayValid(result.module_specifiers,compilerModuleSpecifier)&&compilerNullableString(result.source_url)&&compilerNullableString(result.source_mapping_url)&&arrayIsArray(result.diagnostics)}
const compilerCacheEntries=new PrivateMap();let compilerCacheOrder=[],compilerCacheBytes=0,compilerVersionsEncoded=null;
const compilerCacheNow=bindFunction(Date.now,Date),compilerCacheMaxEntries=128,compilerCacheMaxBytes=16<<20,compilerCacheMaxAge=5*60_000;
function compilerCacheRemove(entry){if(compilerCacheEntries.get(entry.key)!==entry)return;compilerCacheEntries.delete(entry.key);compilerCacheBytes-=entry.bytes}
function compilerCacheExpire(){const now=compilerCacheNow();while(compilerCacheOrder.length>0){const entry=compilerCacheOrder[0];if(compilerCacheEntries.get(entry.key)!==entry){reflectApply(arrayShift,compilerCacheOrder,[]);continue}if(now-entry.created<compilerCacheMaxAge)break;reflectApply(arrayShift,compilerCacheOrder,[]);compilerCacheRemove(entry)}}
function compilerCacheValid(result,dynamic){if(compilerVersionsEncoded===null||wasm_bindgen.compiler_versions_json()!==compilerVersionsEncoded)return false;if(dynamic)return compilerRecord(result)&&result.schema_version===1&&result.ok===true&&arrayIsArray(result.parameters)&&!reflectApply(arraySome,result.parameters,[parameter=>!compilerSuccess(parameter)])&&compilerSuccess(result.body)&&arrayIsArray(result.diagnostics);return compilerSuccess(result)}
function compilerCacheGet(key,dynamic){compilerCacheExpire();const entry=compilerCacheEntries.get(key);if(!entry)return null;if(entry.dynamic!==dynamic||!compilerCacheValid(entry.result,dynamic)){compilerCacheRemove(entry);return null}return entry.result}
function compilerCacheSet(key,result,dynamic){const bytes=encodedText(jsonStringify(result)).byteLength;if(bytes>compilerCacheMaxBytes)return result;compilerCacheExpire();while(compilerCacheEntries.size>=compilerCacheMaxEntries||compilerCacheBytes+bytes>compilerCacheMaxBytes){const entry=reflectApply(arrayShift,compilerCacheOrder,[]);if(!entry)break;compilerCacheRemove(entry)}const entry=objectFreeze({bytes,created:compilerCacheNow(),dynamic,key,result});compilerCacheEntries.set(key,entry);reflectApply(arrayPush,compilerCacheOrder,[entry]);compilerCacheBytes+=bytes;if(compilerCacheOrder.length>compilerCacheMaxEntries*2)compilerCacheOrder=reflectApply(arrayFilter,compilerCacheOrder,[record=>compilerCacheEntries.get(record.key)===record]);return result}
function compilerCacheKey(source,family,strictness,type){const context=jsonStringify({abi_version:1,compiler_versions:compilerVersionsEncoded,family,policy_version:2,realm:abiName,referrer:parsedInitialTarget.href,rewrite_artifact_version:"2.0.0",strictness,type}),key=wasm_bindgen.compiler_cache_key(source,context);if(typeof key!=="string"||!reflectApply(regexpTest,/^[a-f0-9]{64}$/,[key]))throw new NativeDOMException("Compiler cache key blocked","SecurityError");return key}
function compileResult(source,kind){let result;try{const key=compilerCacheKey(source,kind,null,"source");result=compilerCacheGet(key,false);if(!result){result=jsonParse(wasm_bindgen.compile_json(source,kind,abiName));if(result?.ok===true&&compilerSuccess(result))compilerCacheSet(key,result,false)}}catch{throw new NativeDOMException("Executable source blocked","SecurityError")}if(result?.ok!==true)compilerFailure(result,kind==="IndirectEvalScript"||kind==="TimerString");if(!compilerSuccess(result))throw new NativeDOMException("Compiler failure","SecurityError");return result}
function compile(source,kind){return compileResult(source,kind).code}
function directEvalStrictness(metadata){if(!metadata||typeof metadata!=="object"||arrayIsArray(metadata)||objectGetPrototypeOf(metadata)!==objectGetPrototypeOf({}))throw new NativeDOMException("Direct eval metadata blocked","SecurityError");const keys=reflectOwnKeys(metadata),descriptor=reflectGetOwnPropertyDescriptor(metadata,"caller_strict");if(keys.length!==1||keys[0]!=="caller_strict"||!descriptor||!("value"in descriptor)||typeof descriptor.value!=="boolean")throw new NativeDOMException("Direct eval metadata blocked","SecurityError");return descriptor.value}
function compileDirectEval(source,metadata){let result;try{const strict=directEvalStrictness(metadata),key=compilerCacheKey(source,"DirectEvalScript",strict,"source");result=compilerCacheGet(key,false);if(!result){result=jsonParse(wasm_bindgen.compile_json_with_direct_eval_strictness(source,"DirectEvalScript",abiName,strict));if(result?.ok===true&&compilerSuccess(result))compilerCacheSet(key,result,false)}}catch{throw new NativeDOMException("Executable source blocked","SecurityError")}if(result?.ok!==true)compilerFailure(result,true);if(!compilerSuccess(result))throw new NativeDOMException("Compiler failure","SecurityError");return result.code}
function compileDynamicFunction(parameters,body,family){let result;try{const source=jsonStringify({body,parameters}),key=compilerCacheKey(source,family,null,"dynamic-function");result=compilerCacheGet(key,true);if(!result){result=jsonParse(wasm_bindgen.compile_dynamic_function_json(jsonStringify(parameters),body,family,abiName));if(result?.ok===true&&compilerCacheValid(result,true))compilerCacheSet(key,result,true)}}catch{throw new NativeDOMException("Dynamic function compiler unavailable","SecurityError")}if(result?.ok!==true)compilerFailure(result,true);if(!compilerCacheValid(result,true))throw new NativeDOMException("Compiler failure","SecurityError");return{parameters:reflectApply(arrayMap,result.parameters,[parameter=>parameter.code]),body:result.body.code}}
function scriptSourceURL(value){let result=NativeString(value);result=reflectApply(stringReplaceAll,result,["<","%3C"]);result=reflectApply(stringReplaceAll,result,[">","%3E"]);result=reflectApply(stringReplaceAll,result,["\r","%0D"]);result=reflectApply(stringReplaceAll,result,["\n","%0A"]);result=reflectApply(stringReplaceAll,result,["\u2028","%E2%80%A8"]);return reflectApply(stringReplaceAll,result,["\u2029","%E2%80%A9"])}
function executableResultWithMap(source,result,prefix,fallbackSourceURL,suffix=""){const effectiveSourceURL=scriptSourceURL(result.source_url??fallbackSourceURL),executable=`${prefix}${result.code}${suffix}`,map=wasm_bindgen.source_map_base64(source,executable,prefix.length,effectiveSourceURL,jsonStringify(result.edit_map),result.source_mapping_url??undefined);return `${executable}\n//# sourceURL=${effectiveSourceURL}\n//# sourceMappingURL=data:application/json;base64,${map}`}
function executableWithMap(source,kind,prefix,fallbackSourceURL){return executableResultWithMap(source,compileResult(source,kind),prefix,fallbackSourceURL)}
function mirrorFunction(facade,native){if(typeof native!=="function")return facade;const nameDescriptor=natives.getOwnPropertyDescriptor(native,"name");if(nameDescriptor)natives.defineProperty(facade,"name",nameDescriptor);const lengthDescriptor=natives.getOwnPropertyDescriptor(native,"length");if(lengthDescriptor)natives.defineProperty(facade,"length",lengthDescriptor);functionSources.set(facade,reflectApply(functionToString,native,[]));return facade}
function blockedConstructor(name){const native=globalThis[name],blocker=function(){throw new NativeDOMException(`${name} is disabled by ZeroProxy policy`,"NotSupportedError")};if(typeof native==="function"){objectSetPrototypeOf(blocker,objectGetPrototypeOf(native));const prototype=natives.getOwnPropertyDescriptor(native,"prototype");if(prototype){natives.defineProperty(blocker,"prototype",prototype);const constructor=natives.getOwnPropertyDescriptor(prototype.value,"constructor");if(!constructor?.configurable)throw new NativeError("Disabled network prototype constructor unavailable");stage(prototype.value,"constructor",{...constructor,value:blocker,configurable:false,writable:false})}}return mirrorFunction(blocker,native)}
function blockedCapabilityMethod(label,native){return mirrorFunction(function(){throw new NativeDOMException(`${label} is disabled by ZeroProxy policy`,"NotSupportedError")},native)}
function blockMarkup(value){if(NativeString(value)!=="")throw new NativeDOMException("Dynamic markup is blocked until it can be rewritten","SecurityError")}
function loadRuntimeCompilers(){
  const request=new XMLHttpRequest();
  request.open("GET","__ZP_COMPILER_WASM_URL__",false);
  request.overrideMimeType("text/plain; charset=x-user-defined");
  request.send();
  if(request.status!==200)throw new Error("compiler load failed");
  const compilerBytes=reflectApply(uint8ArrayFrom,NativeUint8Array,[request.responseText,character=>character.charCodeAt(0)&255]);
  wasm_bindgen.initSync({module:compilerBytes});
  const encodedVersions=wasm_bindgen.compiler_versions_json(),versions=jsonParse(encodedVersions);
  if(!versions||versions.cache_schema_version!==1||versions.result_schema_version!==1||versions.abi_version!==1||typeof versions.compiler_version!=="string"||typeof versions.parser_version!=="string"||!arrayIsArray(versions.browser_versions)||versions.browser_versions.length!==2||reflectApply(arraySome,versions.browser_versions,[value=>typeof value!=="string"||value.length===0])||typeof wasm_bindgen.compiler_cache_key!=="function")throw new Error("compiler cache ABI mismatch");
  compilerVersionsEncoded=encodedVersions;
  const historyRequest=new XMLHttpRequest();
  historyRequest.open("GET","__ZP_HISTORY_CRYPTO_WASM_URL__",false);
  historyRequest.overrideMimeType("text/plain; charset=x-user-defined");
  historyRequest.send();
  if(historyRequest.status!==200)throw new Error("history crypto load failed");
  const historyBytes=reflectApply(uint8ArrayFrom,NativeUint8Array,[historyRequest.responseText,character=>character.charCodeAt(0)&255]);
  history_crypto.initSync({module:historyBytes});
}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dynamic_code_section_04() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  advanceRuntimeInstallPhase("INSTANTIATE_DYNAMIC_COMPILER");
  loadRuntimeCompilers();
  advanceRuntimeInstallPhase("BUILD_FACADES");
  const rawWindow=globalThis,syntheticDocumentOrigin=rawWindow.location.origin,facadeByRaw=new PrivateWeakMap(),disabledNetworkConstructorNames=objectFreeze(__ZP_DISABLED_NETWORK_GLOBALS__),disabledNetworkConstructors=new PrivateMap,disabledNetworkFacadeByNative=new PrivateMap;
  for(const name of disabledNetworkConstructorNames){const native=reflectGet(rawWindow,name,rawWindow);if(typeof native!=="function")continue;let facade=disabledNetworkFacadeByNative.get(native);if(!facade){facade=blockedConstructor(name);disabledNetworkFacadeByNative.set(native,facade)}disabledNetworkConstructors.set(name,facade)}
  const disabledCapabilityMethodDefinitions=objectFreeze(__ZP_DISABLED_CAPABILITY_METHODS__),disabledCapabilityMethods=[];
  for(const definition of disabledCapabilityMethodDefinitions){const owner=reflectGet(rawWindow,definition.owner,rawWindow),target=definition.kind==="static-method"?(disabledNetworkConstructors.get(definition.owner)??owner):owner?.prototype,descriptor=target&&natives.getOwnPropertyDescriptor(definition.kind==="static-method"?owner:target,definition.member);if(!target||!descriptor||!("value"in descriptor)||typeof descriptor.value!=="function")continue;reflectApply(arrayPush,disabledCapabilityMethods,[objectFreeze({descriptor,facade:blockedCapabilityMethod(definition.label,descriptor.value),member:definition.member,target})])}
  const blockedRTC=disabledNetworkConstructors.get("RTCPeerConnection"),blockedTransport=disabledNetworkConstructors.get("WebTransport");
  const stringCompilationAllowed=stringCompilationPolicy;
  function denyStringCompilation(){throw new natives.EvalError("String compilation is disabled by ZeroProxy policy")}
  const blockedSharedWorker=blockedConstructor("SharedWorker");
  const serviceWorkerController=navigator.serviceWorker?.controller;
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dynamic_code_section_21() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const indirectEval=mirrorFunction(function(value){if(typeof value!=="string")return value;if(!stringCompilationAllowed)return denyStringCompilation();return natives.eval(compile(value,"IndirectEvalScript"))},natives.eval);
  function dynamicConstructor(family){switch(family){case"FunctionBody":return natives.Function;case"AsyncFunctionBody":return dynamicNatives.AsyncFunction;case"GeneratorFunctionBody":return dynamicNatives.GeneratorFunction;default:return dynamicNatives.AsyncGeneratorFunction}}
  function dynamicFunctionSource(family,parameters,body){const prefix=family==="AsyncFunctionBody"?"async function":family==="GeneratorFunctionBody"?"function*":family==="AsyncGeneratorFunctionBody"?"async function*":"function";return`${prefix} anonymous(${reflectApply(arrayJoin,parameters,[","])}\n) {\n${body}\n}`}
  function dynamicFunction(family,callKind,newTarget,args){const converted=arrayFrom(args,toDynamicSource),argumentCount=converted.length,constructor=dynamicConstructor(family);if(!stringCompilationAllowed)return denyStringCompilation();const body=argumentCount?reflectApply(arrayPop,converted,[]):"",compiled=compileDynamicFunction(converted,body,family),invocationArgs=compiled.parameters;if(argumentCount)reflectApply(arrayPush,invocationArgs,[compiled.body]);const result=callKind==="construct"?reflectConstruct(constructor,invocationArgs,newTarget):reflectApply(constructor,undefined,invocationArgs);if(typeof result==="function")functionSources.set(result,dynamicFunctionSource(family,converted,body));return result}
  function functionFacade(family,constructor){const facade=function(...args){return dynamicFunction(family,new.target?"construct":"call",new.target,args)};objectSetPrototypeOf(facade,objectGetPrototypeOf(constructor));const prototype=natives.getOwnPropertyDescriptor(constructor,"prototype");if(prototype)natives.defineProperty(facade,"prototype",prototype);return mirrorFunction(facade,constructor)}
  const FunctionFacade=functionFacade("FunctionBody",natives.Function),AsyncFunctionFacade=functionFacade("AsyncFunctionBody",dynamicNatives.AsyncFunction),GeneratorFunctionFacade=functionFacade("GeneratorFunctionBody",dynamicNatives.GeneratorFunction),AsyncGeneratorFunctionFacade=functionFacade("AsyncGeneratorFunctionBody",dynamicNatives.AsyncGeneratorFunction);
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dynamic_code_section_24() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function safeTimer(native,kind,handler,delay,args){if(typeof handler==="function")return reflectApply(native,rawWindow,[handler,delay,...args]);const source=NativeString(handler);if(!stringCompilationAllowed)return denyStringCompilation();return reflectApply(native,rawWindow,[compile(source,kind),delay,...args])}
  const safeSetTimeout=mirrorFunction(function(handler,delay,...args){return safeTimer(timerNatives.setTimeout,"TimerString",handler,delay,args)},timerNatives.setTimeout),safeSetInterval=mirrorFunction(function(handler,delay,...args){return safeTimer(timerNatives.setInterval,"TimerString",handler,delay,args)},timerNatives.setInterval);
  function windowFacadeIdentity(value){
    try{return value!==null&&(typeof value==="object"||typeof value==="function")&&value.window===value&&value.self===value}
    catch{return false}
  }
  function registerContainedRelationships(selfFacade,parentFacade,topFacade,keepaliveFetch){
    if(containedSelfFacade!==undefined)throw new NativeDOMException("Contained realm relationship handoff repeated","SecurityError");
    if(!windowFacadeIdentity(selfFacade)||typeof keepaliveFetch!=="function")throw new NativeDOMException("Contained realm self handoff failed","SecurityError");
    containedSelfFacade=selfFacade;
    containedKeepaliveFetch=keepaliveFetch;
    relationshipFacades.set("parent",parentFacade);
    relationshipFacades.set("top",topFacade);
    facadeByRaw.set(rawWindow,selfFacade);
    facadeByRaw.set(windowFacade,selfFacade);
    rawWindowByFacade.set(selfFacade,rawWindow);
    return true;
  }
  function abiThisValue(value){return facadeValue(value)}
  function abiEvalSource(value,metadata){if(typeof value!=="string")return value;if(!stringCompilationAllowed)return denyStringCompilation();return compileDirectEval(value,metadata)}
  function targetModuleImport(originalURL,moduleID,value,options){const pending=reflectApply(promiseResolve,NativePromise,[]);return reflectApply(promiseThen,pending,[async()=>{const specifier=toDynamicSource(value),plan=await runtimeCommand("TARGET_MODULE_IMPORT_ALLOCATE",{module_id:moduleID,referrer_url:originalURL,specifier},"Dynamic module import unavailable");if(!plan||typeof plan.path!=="string"||typeof plan.target_url!=="string"||!reflectApply(arrayIncludes,["javascript","json"],[plan.module_type]))throw new NativeDOMException("Dynamic module route rejected","SecurityError");return import(plan.path,options)}])}
  function importMapURLLike(value){if(value!==""&&reflectApply(arrayIncludes,["/","." ,"?","#"],[value[0]]))return true;try{new NativeURL(value);return true}catch{return false}}
  function sortedImportEntries(value){if(value===null||typeof value!=="object"||arrayIsArray(value))throw new NativeTypeError("Invalid import map");const entries=objectEntries(value);for(let index=1;index<entries.length;index+=1){const current=entries[index];let cursor=index;while(cursor>0&&entries[cursor-1][0]>current[0]){entries[cursor]=entries[cursor-1];cursor-=1}entries[cursor]=current}return entries}
  function normalizeImportTable(value,baseURL){const table=[];for(const [rawKey,rawAddress]of sortedImportEntries(value)){let key=rawKey;if(importMapURLLike(key)){try{key=urlProperty(new NativeURL(key,baseURL),"href")}catch{continue}}let address=null;if(rawAddress!==null){if(typeof rawAddress!=="string")throw new NativeTypeError("Invalid import map");try{address=urlProperty(new NativeURL(rawAddress,baseURL),"href")}catch{}if(key[key.length-1]==="/"&&address?.[address.length-1]!=="/")address=null}let replaced=false;for(let index=0;index<table.length;index+=1)if(table[index][0]===key){table[index]=objectFreeze([key,address]);replaced=true;break}if(!replaced)reflectApply(arrayPush,table,[objectFreeze([key,address])])}return objectFreeze(table)}
  let parsedRuntimeImportMap;
  function runtimeImportMap(){if(parsedRuntimeImportMap!==undefined)return parsedRuntimeImportMap;if(runtimeImportMapHandle===null){parsedRuntimeImportMap=null;return null}let handle,wire;try{handle=jsonParse(runtimeImportMapHandle);wire=jsonParse(handle.source)}catch{throw new NativeDOMException("Import map bootstrap rejected","SecurityError")}if(!handle||handle.version!==1||typeof handle.source!=="string"||handle.source.length>1<<20||typeof handle.base!=="string"||!wire||typeof wire!=="object"||arrayIsArray(wire))throw new NativeDOMException("Import map bootstrap rejected","SecurityError");const imports=normalizeImportTable(wire.imports??{},handle.base),scopes=[];for(const [rawScope,table]of sortedImportEntries(wire.scopes??{})){let scope;try{scope=urlProperty(new NativeURL(rawScope,handle.base),"href")}catch{continue}reflectApply(arrayPush,scopes,[objectFreeze([scope,normalizeImportTable(table,handle.base)])])}parsedRuntimeImportMap=objectFreeze({imports,scopes:objectFreeze(scopes)});return parsedRuntimeImportMap}
  function resolveImportTable(table,specifier){for(const [key,address]of table)if(key===specifier){if(address===null)throw new NativeTypeError("Blocked by import map");return address}let bestKey="",bestAddress;for(const [key,address]of table)if(key[key.length-1]==="/"&&reflectApply(stringStartsWith,specifier,[key])&&key.length>bestKey.length){bestKey=key;bestAddress=address}if(bestKey==="")return undefined;if(bestAddress===null)throw new NativeTypeError("Blocked by import map");try{return urlProperty(new NativeURL(reflectApply(stringSlice,specifier,[bestKey.length]),bestAddress),"href")}catch{throw new NativeTypeError("Invalid module address")}}
  function importScopeMatches(scope,referrer){if(!reflectApply(stringStartsWith,referrer,[scope]))return false;const remainder=reflectApply(stringSlice,referrer,[scope.length]);return scope[scope.length-1]==="/"||remainder===""||remainder[0]==="/"}
  function targetModuleResolve(originalURL,value){const specifier=toDynamicSource(value),map=runtimeImportMap(),urlLike=importMapURLLike(specifier);let normalized=specifier;if(urlLike)try{normalized=urlProperty(new NativeURL(specifier,originalURL),"href")}catch{throw new NativeTypeError("Invalid module specifier")}if(map){const matching=[];for(const scope of map.scopes)if(importScopeMatches(scope[0],originalURL))reflectApply(arrayPush,matching,[scope]);for(let index=1;index<matching.length;index+=1){const current=matching[index];let cursor=index;while(cursor>0&&matching[cursor-1][0].length<current[0].length){matching[cursor]=matching[cursor-1];cursor-=1}matching[cursor]=current}for(const scope of matching){const result=resolveImportTable(scope[1],normalized);if(result!==undefined)return result}const result=resolveImportTable(map.imports,normalized);if(result!==undefined)return result}if(urlLike)return normalized;throw new NativeTypeError("Unmapped bare module specifier")}
  const moduleMetaFacades=new PrivateWeakMap,moduleContexts=new PrivateWeakMap;
  function moduleMeta(nativeMeta,originalURL){
    if(nativeMeta===null||(typeof nativeMeta!=="object"&&typeof nativeMeta!=="function")||typeof originalURL!=="string")throw new NativeDOMException("Invalid native module context","SecurityError");
    const existing=moduleMetaFacades.get(nativeMeta);
    if(existing){if(existing.originalURL!==originalURL)throw new NativeDOMException("Module context identity mismatch","SecurityError");return existing.facade}
    const facade=objectFreeze({url:originalURL,resolve:value=>targetModuleResolve(originalURL,value)});
    moduleMetaFacades.set(nativeMeta,objectFreeze({facade,originalURL}));
    return facade;
  }
  function moduleContext(nativeMeta,originalURL,moduleID=null){
    if(nativeMeta===null||(typeof nativeMeta!=="object"&&typeof nativeMeta!=="function")||typeof originalURL!=="string"||moduleID!==null&&(typeof moduleID!=="string"||!reflectApply(regexpTest,/^[a-f0-9]{64}$/,[moduleID])))throw new NativeDOMException("Invalid native module context","SecurityError");
    const existing=moduleContexts.get(nativeMeta);
    if(existing){if(existing.originalURL!==originalURL||existing.moduleID!==moduleID)throw new NativeDOMException("Module context identity mismatch","SecurityError");return existing.context}
    const context=objectFreeze({scope,thisValue:abiThisValue,evalSource:abiEvalSource,indirectEval,dynamicFunction,importMeta:moduleMeta(nativeMeta,originalURL),importModule:(value,options)=>targetModuleImport(originalURL,moduleID,value,options)});
    moduleContexts.set(nativeMeta,objectFreeze({context,moduleID,originalURL}));
    return context;
  }
  const abi=objectFreeze({scope,thisValue:abiThisValue,evalSource:abiEvalSource,indirectEval,dynamicFunction,importOperand(value){return value},importModule:(value,options)=>targetModuleImport(parsedInitialTarget.href,null,value,options),moduleMeta,moduleContext,registerBase,registerScript,registerModuleScript,activateDynamicModule,registerContainedRelationships,sourceRegistry:new PrivateWeakMap(), runtimeHealth() { return ready && evalDescriptorsHealthy() }});
  let cachedRuntimeSource=runtimeScript.textContent||undefined;
  function containedRuntimeSource(){if(cachedRuntimeSource)return cachedRuntimeSource;const request=new natives.XMLHttpRequest;request.open("GET",runtimeURL.href,false);request.overrideMimeType("text/plain; charset=utf-8");request.send();if(request.status!==200)throw new NativeDOMException("Contained realm runtime unavailable","SecurityError");cachedRuntimeSource=request.responseText;return cachedRuntimeSource}
  function nextRealmABI(){const bytes=new NativeUint8Array(24);reflectApply(cryptoGetRandomValues,nativeCrypto,[bytes]);return `__zp_abi_${reflectApply(arrayJoin, arrayFrom(bytes,byte=>reflectApply(stringPadStart,reflectApply(numberToString,byte,[16]),[2,"0"])), [""])}`}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dynamic_code_section_35() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function stageFunctionAndTimerSurfaces(){
    const safeFunctionToString=mirrorFunction(function(){return functionSources.get(this)??reflectApply(functionToString,this,[])},functionToString);
    stage(natives.Function.prototype,"toString",{...natives.getOwnPropertyDescriptor(natives.Function.prototype,"toString"),value:safeFunctionToString,writable:false,configurable:false});
    stage(natives.Function.prototype,"constructor",{value:FunctionFacade,writable:false,enumerable:false,configurable:false});
    stage(dynamicNatives.AsyncFunction.prototype,"constructor",{value:AsyncFunctionFacade,writable:false,enumerable:false,configurable:false});
    stage(dynamicNatives.GeneratorFunction.prototype,"constructor",{value:GeneratorFunctionFacade,writable:false,enumerable:false,configurable:false});
    stage(dynamicNatives.AsyncGeneratorFunction.prototype,"constructor",{value:AsyncGeneratorFunctionFacade,writable:false,enumerable:false,configurable:false});
    stage(rawWindow,"setTimeout",{...natives.getOwnPropertyDescriptor(rawWindow,"setTimeout"),value:safeSetTimeout,writable:false,configurable:false});
    stage(rawWindow,"setInterval",{...natives.getOwnPropertyDescriptor(rawWindow,"setInterval"),value:safeSetInterval,writable:false,configurable:false});
    stage(rawWindow,"getComputedStyle",{...natives.getOwnPropertyDescriptor(rawWindow,"getComputedStyle"),value:safeGetComputedStyle,writable:false,configurable:false});
    stage(rawWindow,"open",{...natives.getOwnPropertyDescriptor(rawWindow,"open"),value:controlledOpen,writable:false,configurable:false});
    stageProtectedEval(rawWindow,"eval",{...evalDescriptor,value:natives.eval,writable:false,configurable:false});
    stage(rawWindow,"fetch",{...natives.getOwnPropertyDescriptor(rawWindow,"fetch"),value:controlledFetch,writable:false,configurable:false});
    stage(rawWindow,"MutationObserver",{...natives.getOwnPropertyDescriptor(rawWindow,"MutationObserver"),value:MutationObserverFacade,writable:false,configurable:false});
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
