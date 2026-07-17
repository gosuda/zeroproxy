export const runtimeSections = [
  { file: import.meta.url, name: "capture_section_00", order: 0, phase: "emergency" },
  { file: import.meta.url, name: "capture_section_01", order: 1, phase: "outer" },
];

export function capture_section_00() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
const emergencyApply=Reflect.apply,emergencyCreateElement=Document.prototype.createElement,emergencyReplaceChildren=Element.prototype.replaceChildren,emergencyTextContent=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");
function emergencyBlock(error){try{const body=emergencyApply(emergencyCreateElement,document,["body"]);emergencyApply(emergencyTextContent.set,body,["ZeroProxy blocked this document because its privacy runtime could not be installed."]);emergencyApply(emergencyReplaceChildren,document.documentElement,[body])}catch{}throw error}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function capture_section_01() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
const reflectApply=Reflect.apply,reflectConstruct=Reflect.construct,reflectGet=Reflect.get,reflectSet=Reflect.set,reflectDefineProperty=Reflect.defineProperty,reflectDeleteProperty=Reflect.deleteProperty,reflectOwnKeys=Reflect.ownKeys,reflectGetOwnPropertyDescriptor=Reflect.getOwnPropertyDescriptor,objectGetPrototypeOf=Object.getPrototypeOf,objectSetPrototypeOf=Object.setPrototypeOf;
const NativeString=String,NativeNumber=Number,NativeBoolean=Boolean,NativeError=Error,jsonParse=JSON.parse,jsonStringify=JSON.stringify,stringReplaceAll=String.prototype.replaceAll,stringToLowerCase=String.prototype.toLowerCase,stringStartsWith=String.prototype.startsWith,stringIncludes=String.prototype.includes,stringSplit=String.prototype.split,stringSlice=String.prototype.slice,stringTrim=String.prototype.trim,arrayFrom=Array.from,arrayIsArray=Array.isArray,arrayPush=Array.prototype.push,arrayPop=Array.prototype.pop,arrayShift=Array.prototype.shift,arrayMap=Array.prototype.map,arrayFilter=Array.prototype.filter,arrayForEach=Array.prototype.forEach,arrayIncludes=Array.prototype.includes,arrayIndexOf=Array.prototype.indexOf,arrayJoin=Array.prototype.join,arrayReverse=Array.prototype.reverse,arraySome=Array.prototype.some,numberIsInteger=Number.isInteger,regexpTest=RegExp.prototype.test,objectEntries=Object.entries,objectCreate=Object.create,objectFreeze=Object.freeze,objectAssign=Object.assign,trustedHTMLToString=globalThis.TrustedHTML?.prototype.toString,toDynamicSource=value=>`${value}`;
const arrayIterator=Array.prototype[Symbol.iterator];
const arraySort=Array.prototype.sort;
const elementPrototype=Element.prototype,NativeDOMException=DOMException,NativeTypeError=TypeError,NativeSyntaxError=SyntaxError,NativeURL=URL,NativeURLSearchParams=URLSearchParams,NativeProxy=Proxy,NativePromise=Promise,promiseReject=Promise.reject,promiseResolve=Promise.resolve,promiseThen=Promise.prototype.then,promiseAll=Promise.all,NativeWeakRef=WeakRef,NativeFinalizationRegistry=FinalizationRegistry,NativeUint8Array=Uint8Array,uint8ArrayFrom=Uint8Array.from,NativeArrayBuffer=ArrayBuffer,arrayBufferIsView=ArrayBuffer.isView,NativeBlob=Blob,NativeEventTarget=EventTarget,NativeEvent=Event,NativeMessageEvent=MessageEvent,NativeProgressEvent=ProgressEvent,NativeCloseEvent=globalThis.CloseEvent,NativeAbortController=AbortController,NativeTextEncoder=TextEncoder,NativeTextDecoder=TextDecoder,NativeDOMParser=DOMParser;
const NativeRequest=globalThis.Request,NativeResponse=globalThis.Response,NativeHeaders=globalThis.Headers,NativeMessageChannel=globalThis.MessageChannel,NativeCache=globalThis.Cache,NativeCacheStorage=globalThis.CacheStorage,NativeFormData=globalThis.FormData,NativeFile=globalThis.File;
const NativeReadableStream=globalThis.ReadableStream,NativeWritableStream=globalThis.WritableStream;
const readableStreamControllerNatives=objectFreeze({close:ReadableStreamDefaultController.prototype.close,enqueue:ReadableStreamDefaultController.prototype.enqueue,error:ReadableStreamDefaultController.prototype.error}),writableStreamControllerNatives=objectFreeze({error:WritableStreamDefaultController.prototype.error});
const nativeTrustedTypes=globalThis.trustedTypes,trustedTypesCreatePolicy=nativeTrustedTypes?.createPolicy;
const weakRefDeref=WeakRef.prototype.deref;
const nativeDecodeURIComponent=globalThis.decodeURIComponent,nativeAtob=globalThis.atob,nativeBtoa=globalThis.btoa,blobNatives=objectFreeze({arrayBuffer:Blob.prototype.arrayBuffer,size:Object.getOwnPropertyDescriptor(Blob.prototype,"size"),type:Object.getOwnPropertyDescriptor(Blob.prototype,"type"),createObjectURL:NativeURL.createObjectURL,revokeObjectURL:NativeURL.revokeObjectURL});
const nativeStringCharCodeAt=String.prototype.charCodeAt,nativeStringFromCharCode=String.fromCharCode;
const stringIndexOf=String.prototype.indexOf;
const nativeTypedArrayPrototype=objectGetPrototypeOf(NativeUint8Array.prototype),arrayBufferNatives=objectFreeze({byteLength:Object.getOwnPropertyDescriptor(NativeArrayBuffer.prototype,"byteLength"),isView:NativeArrayBuffer.isView,slice:NativeArrayBuffer.prototype.slice}),typedArrayNatives=objectFreeze({buffer:Object.getOwnPropertyDescriptor(nativeTypedArrayPrototype,"buffer"),byteLength:Object.getOwnPropertyDescriptor(nativeTypedArrayPrototype,"byteLength"),byteOffset:Object.getOwnPropertyDescriptor(nativeTypedArrayPrototype,"byteOffset"),set:nativeTypedArrayPrototype.set}),dataViewNatives=objectFreeze({buffer:Object.getOwnPropertyDescriptor(DataView.prototype,"buffer"),byteLength:Object.getOwnPropertyDescriptor(DataView.prototype,"byteLength"),byteOffset:Object.getOwnPropertyDescriptor(DataView.prototype,"byteOffset")}),textEncoderNatives=objectFreeze({encode:NativeTextEncoder.prototype.encode}),textDecoderNatives=objectFreeze({decode:NativeTextDecoder.prototype.decode});
const NativeStructuredClone=globalThis.structuredClone;
const nativeCrypto=globalThis.crypto;
const evalDescriptor=reflectGetOwnPropertyDescriptor(globalThis,"eval");
if(!evalDescriptor||!("value"in evalDescriptor)||typeof evalDescriptor.value!=="function"||!evalDescriptor.configurable)throw new NativeError("eval descriptor unavailable");
const natives=objectFreeze({eval:(0,eval),EvalError,Function,fetch,XMLHttpRequest,WebSocket,Worker,SharedWorker,RTCPeerConnection:globalThis.RTCPeerConnection,WebTransport:globalThis.WebTransport,defineProperty:Object.defineProperty,getOwnPropertyDescriptor:Object.getOwnPropertyDescriptor,getPrototypeOf:Object.getPrototypeOf,nodeBaseURI:Object.getOwnPropertyDescriptor(Node.prototype,"baseURI"),nodeValue:Object.getOwnPropertyDescriptor(Node.prototype,"nodeValue"),textContent:Object.getOwnPropertyDescriptor(Node.prototype,"textContent"),baseHref:Object.getOwnPropertyDescriptor(HTMLBaseElement.prototype,"href"),attrValue:Object.getOwnPropertyDescriptor(Attr.prototype,"value"),attributes:Object.getOwnPropertyDescriptor(Element.prototype,"attributes"),setAttribute:Element.prototype.setAttribute,setAttributeNS:Element.prototype.setAttributeNS,setAttributeNode:Element.prototype.setAttributeNode,setAttributeNodeNS:Element.prototype.setAttributeNodeNS,toggleAttribute:Element.prototype.toggleAttribute,setNamedItem:NamedNodeMap.prototype.setNamedItem,setNamedItemNS:NamedNodeMap.prototype.setNamedItemNS});
const bootstrapNatives=objectFreeze({currentScript:Object.getOwnPropertyDescriptor(Document.prototype,"currentScript"),documentURL:Object.getOwnPropertyDescriptor(Document.prototype,"URL"),scriptSrc:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src"),getAttribute:Element.prototype.getAttribute,removeAttribute:Element.prototype.removeAttribute,parametersGet:URLSearchParams.prototype.get});
const urlNatives=objectFreeze({href:Object.getOwnPropertyDescriptor(URL.prototype,"href"),hash:Object.getOwnPropertyDescriptor(URL.prototype,"hash"),origin:Object.getOwnPropertyDescriptor(URL.prototype,"origin"),protocol:Object.getOwnPropertyDescriptor(URL.prototype,"protocol"),host:Object.getOwnPropertyDescriptor(URL.prototype,"host"),hostname:Object.getOwnPropertyDescriptor(URL.prototype,"hostname"),port:Object.getOwnPropertyDescriptor(URL.prototype,"port"),pathname:Object.getOwnPropertyDescriptor(URL.prototype,"pathname"),search:Object.getOwnPropertyDescriptor(URL.prototype,"search")});
const urlSearchParamsNatives=objectFreeze({toString:URLSearchParams.prototype.toString});
const urlCredentialNatives=objectFreeze({username:Object.getOwnPropertyDescriptor(URL.prototype,"username"),password:Object.getOwnPropertyDescriptor(URL.prototype,"password")});
function prototypeDescriptor(prototype,property){for(let current=prototype;current!==null;current=Object.getPrototypeOf(current)){const descriptor=Object.getOwnPropertyDescriptor(current,property);if(descriptor)return descriptor}}
const responseNatives=objectFreeze({url:prototypeDescriptor(Response.prototype, "url"),redirected:prototypeDescriptor(Response.prototype, "redirected"),type:prototypeDescriptor(Response.prototype, "type"),status:prototypeDescriptor(Response.prototype, "status"),statusText:prototypeDescriptor(Response.prototype, "statusText"),ok:prototypeDescriptor(Response.prototype, "ok"),headers:prototypeDescriptor(Response.prototype, "headers"),body:prototypeDescriptor(Response.prototype, "body"),bodyUsed:prototypeDescriptor(Response.prototype, "bodyUsed"),clone:Response.prototype.clone,arrayBuffer:Response.prototype.arrayBuffer,blob:Response.prototype.blob,bytes:Response.prototype.bytes,formData:Response.prototype.formData,json:Response.prototype.json,text:Response.prototype.text});
const requestNatives=objectFreeze({url:prototypeDescriptor(Request.prototype, "url"),referrer:prototypeDescriptor(Request.prototype, "referrer"),credentials:prototypeDescriptor(Request.prototype, "credentials"),cache:prototypeDescriptor(Request.prototype, "cache"),mode:prototypeDescriptor(Request.prototype, "mode"),body:prototypeDescriptor(Request.prototype, "body"),method:prototypeDescriptor(Request.prototype, "method"),redirect:prototypeDescriptor(Request.prototype, "redirect"),referrerPolicy:prototypeDescriptor(Request.prototype, "referrerPolicy"),integrity:prototypeDescriptor(Request.prototype, "integrity"),keepalive:prototypeDescriptor(Request.prototype, "keepalive"),priority:prototypeDescriptor(Request.prototype, "priority"),signal:prototypeDescriptor(Request.prototype, "signal"),headers:prototypeDescriptor(Request.prototype, "headers"),clone:Request.prototype.clone});
const abortControllerNatives=objectFreeze({abort:AbortController.prototype.abort,signal:Object.getOwnPropertyDescriptor(AbortController.prototype,"signal")}),abortSignalNatives=objectFreeze({aborted:Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")});
const headersNatives=objectFreeze({get:Headers.prototype.get,set:Headers.prototype.set,delete:Headers.prototype.delete,entries:Headers.prototype.entries});
const headersIteratorNext=objectGetPrototypeOf(reflectApply(headersNatives.entries,new NativeHeaders,[])).next;
const nativeXHRPrototype=natives.XMLHttpRequest.prototype;
const xhrNatives=objectFreeze({
  abort:nativeXHRPrototype.abort,
  getAllResponseHeaders:nativeXHRPrototype.getAllResponseHeaders,
  getResponseHeader:nativeXHRPrototype.getResponseHeader,
  open:nativeXHRPrototype.open,
  send:nativeXHRPrototype.send,
  setRequestHeader:nativeXHRPrototype.setRequestHeader,
  readyState:prototypeDescriptor(nativeXHRPrototype,"readyState"),
  response:prototypeDescriptor(nativeXHRPrototype,"response"),
  responseType:prototypeDescriptor(nativeXHRPrototype,"responseType"),
  status:prototypeDescriptor(nativeXHRPrototype,"status"),
  statusText:prototypeDescriptor(nativeXHRPrototype,"statusText"),
  upload:prototypeDescriptor(nativeXHRPrototype,"upload"),
});
const formDataNatives=objectFreeze({append:FormData.prototype.append,entries:FormData.prototype.entries});
const formDataIteratorNext=objectGetPrototypeOf(reflectApply(formDataNatives.entries,new NativeFormData,[])).next;
const readableStreamNatives=objectFreeze({locked:Object.getOwnPropertyDescriptor(ReadableStream.prototype,"locked")});
const fileNatives=objectFreeze({name:Object.getOwnPropertyDescriptor(File.prototype,"name")});
function captureCacheNatives(CacheClass){
  if(!CacheClass)return null;
  return objectFreeze({match:CacheClass.prototype.match,matchAll:CacheClass.prototype.matchAll,put:CacheClass.prototype.put,add:CacheClass.prototype.add,addAll:CacheClass.prototype.addAll});
}
function captureCacheStorageNatives(CacheStorageClass){
  if(!CacheStorageClass)return null;
  return objectFreeze({match:CacheStorageClass.prototype.match,open:CacheStorageClass.prototype.open,delete:CacheStorageClass.prototype.delete,has:CacheStorageClass.prototype.has,keys:CacheStorageClass.prototype.keys});
}
function optionalPrototypeDescriptor(Constructor,property){
  return Constructor?Object.getOwnPropertyDescriptor(Constructor.prototype,property):null;
}
function optionalOwnDescriptor(enabled,value,property){
  return enabled?Object.getOwnPropertyDescriptor(value,property):null;
}
function captureSharedWorkerNatives(){
  if(!globalThis.SharedWorker)return null;
  return objectFreeze({port:Object.getOwnPropertyDescriptor(SharedWorker.prototype,"port")});
}
const cacheNatives=captureCacheNatives(NativeCache);
const cacheStorageNatives=captureCacheStorageNatives(NativeCacheStorage);
const functionBind=Function.prototype.bind,numberToString=Number.prototype.toString,stringPadStart=String.prototype.padStart,cryptoGetRandomValues=Crypto.prototype.getRandomValues;
function bootstrapValue(script,parameters,attributeName,parameterName,fallback){const attribute=script?reflectApply(bootstrapNatives.getAttribute,script,[attributeName]):null,parameter=parameters?reflectApply(bootstrapNatives.parametersGet,parameters,[parameterName]):null;return attribute||parameter||fallback}
function urlProperty(url,name){return reflectApply(reflectGet(urlNatives,name).get,url,[])}
function urlCredential(url,name){return reflectApply(reflectGet(urlCredentialNatives,name).get,url,[])}
function requestProperty(request,name){const descriptor=reflectGet(requestNatives,name);return descriptor?.get?reflectApply(descriptor.get,request,[]):undefined}
function signalAborted(signal){return reflectApply(abortSignalNatives.aborted.get,signal,[])}
function controllerSignal(controller){return reflectApply(abortControllerNatives.signal.get,controller,[])}
function abortController(controller){return reflectApply(abortControllerNatives.abort,controller,[])}
function headerEntries(headers){const iterator=reflectApply(headersNatives.entries,headers,[]),pairs=[];for(;;){const step=reflectApply(headersIteratorNext,iterator,[]);if(step.done)return pairs;reflectApply(arrayPush,pairs,[step.value])}}
function nativeBlobSize(value){try{return reflectApply(blobNatives.size.get,value,[])}catch{return null}}
function nativeArrayBufferInfo(value){try{return{buffer:value,byteLength:reflectApply(arrayBufferNatives.byteLength.get,value,[]),byteOffset:0}}catch{return null}}
function nativeViewInfo(value){if(!reflectApply(arrayBufferNatives.isView,NativeArrayBuffer,[value]))return null;try{return{buffer:reflectApply(typedArrayNatives.buffer.get,value,[]),byteLength:reflectApply(typedArrayNatives.byteLength.get,value,[]),byteOffset:reflectApply(typedArrayNatives.byteOffset.get,value,[])}}catch{}try{return{buffer:reflectApply(dataViewNatives.buffer.get,value,[]),byteLength:reflectApply(dataViewNatives.byteLength.get,value,[]),byteOffset:reflectApply(dataViewNatives.byteOffset.get,value,[])}}catch{return null}}
function nativeBinaryInfo(value){return nativeArrayBufferInfo(value)??nativeViewInfo(value)}
function nativeBinaryByteLength(value){return nativeBinaryInfo(value)?.byteLength??null}
function nativeBinaryBuffer(value){return nativeBinaryInfo(value)?.buffer??null}
function nativeBinaryCopy(value){const info=nativeBinaryInfo(value);if(!info)return null;try{const source=new NativeUint8Array(info.buffer,info.byteOffset,info.byteLength),copy=new NativeUint8Array(info.byteLength);reflectApply(typedArrayNatives.set,copy,[source,0]);return copy}catch{return null}}
function encodedText(value){return reflectApply(textEncoderNatives.encode,new NativeTextEncoder,[value])}
function decodedText(decoder,value,options){return options===undefined?reflectApply(textDecoderNatives.decode,decoder,value===undefined?[]:[value]):reflectApply(textDecoderNatives.decode,decoder,[value,options])}
function targetURLRecord(url){return objectFreeze({href:urlProperty(url,"href"),origin:urlProperty(url,"origin"),protocol:urlProperty(url,"protocol"),username:urlCredential(url,"username"),password:urlCredential(url,"password"),host:urlProperty(url,"host"),hostname:urlProperty(url,"hostname"),port:urlProperty(url,"port"),pathname:urlProperty(url,"pathname"),search:urlProperty(url,"search"),hash:urlProperty(url,"hash")})}
function invalidApprovedPort(port){return !numberIsInteger(port)||port<1||port>65535}
function validRuntimePolicyMetadata(state){
  return NativeBoolean(state.runtimeScript)
    && NativeBoolean(state.runtimeURL)
    && reflectApply(regexpTest,/^__zp_abi_[a-f0-9]{48}$/,[state.abiName]);
}
function validRuntimeCookieRoute(value){return value===""||reflectApply(regexpTest,/^[A-Za-z0-9_-]{32}$/,[value])}
function validRuntimePorts(ports){return ports.length>0&&!reflectApply(arraySome,ports,[invalidApprovedPort])}
function validateRuntimeBootstrap(state){
  if(!validRuntimePolicyMetadata(state))throw new NativeError("invalid runtime policy metadata");
  if(!validRuntimeCookieRoute(state.cookieRouteID))throw new NativeError("invalid runtime cookie route");
  if(!reflectApply(arrayIncludes,["0","1"],[state.stringCompilationSetting]))throw new NativeError("invalid runtime policy metadata");
  if(!validRuntimePorts(state.approvedPorts))throw new NativeError("invalid runtime policy metadata");
  if(!reflectApply(arrayIncludes,["http:","https:"],[state.parsedInitialTarget.protocol]))throw new NativeError("invalid target URL");
}
function scrubRuntimeScript(script){if(!script)return;for(const name of ["src","data-zp-runtime-pending","data-zp-runtime-guard","data-zp-runtime-url","data-zp-abi","data-zp-target-url","data-zp-cookie-route","data-zp-cookie-bootstrap","data-zp-strings","data-zp-ports"])reflectApply(bootstrapNatives.removeAttribute,script,[name]);reflectDeleteProperty(script,"src")}
function validRuntimeLoadGuardShape(guard){
  if(!guard||objectGetPrototypeOf(guard)!==Object.prototype)return false;
  const keys=reflectOwnKeys(guard),complete=reflectGetOwnPropertyDescriptor(guard,"complete");
  return keys.length===1&&keys[0]==="complete"&&!!complete&&complete.enumerable===true&&
    !complete.configurable&&!complete.writable&&typeof complete.value==="function";
}
function runtimeLoadGuardValue(key){
  if(typeof key!=="string"||!reflectApply(regexpTest,/^__zp_runtime_guard_[A-Za-z0-9_-]{1,128}$/,[key]))throw new NativeDOMException("Runtime load guard rejected","SecurityError");
  const descriptor=reflectGetOwnPropertyDescriptor(globalThis,key);
  if(!descriptor||descriptor.enumerable||!descriptor.configurable||descriptor.writable)throw new NativeDOMException("Runtime load guard rejected","SecurityError");
  return descriptor.value;
}
function trustedRuntimeLoadGuard(script){
  if(!script||reflectApply(bootstrapNatives.getAttribute,script,["data-zp-runtime-pending"])===null)return null;
  const guard=runtimeLoadGuardValue(reflectApply(bootstrapNatives.getAttribute,script,["data-zp-runtime-guard"]));
  if(!validRuntimeLoadGuardShape(guard))throw new NativeDOMException("Runtime load guard rejected","SecurityError");
  return guard;
}
function readRuntimeBootstrap(){
  const runtimeScript=reflectApply(bootstrapNatives.currentScript.get,document,[]);
  const documentURL=reflectApply(bootstrapNatives.documentURL.get,document,[]);
  const scriptSource=runtimeScript?reflectApply(bootstrapNatives.scriptSrc.get,runtimeScript,[]):"";
  const runtimeSourceURL=scriptSource||bootstrapValue(runtimeScript,null,"data-zp-runtime-url","",null);
  const parsedRuntimeURL=runtimeSourceURL?new NativeURL(runtimeSourceURL,documentURL):null;
  const runtimeHash=parsedRuntimeURL?urlProperty(parsedRuntimeURL,"hash"):"";
  const runtimeParameters=runtimeHash?new NativeURLSearchParams(reflectApply(stringSlice,runtimeHash,[1])):null;
  const abiName=bootstrapValue(runtimeScript,runtimeParameters,"data-zp-abi","abi",reflectApply(stringSlice,runtimeHash,[1]));
  const initialTargetURL=bootstrapValue(runtimeScript,runtimeParameters,"data-zp-target-url","url",documentURL);
  const cookieRouteID=bootstrapValue(runtimeScript,runtimeParameters,"data-zp-cookie-route","cookie","");
  const cookieBootstrapSource=bootstrapValue(runtimeScript,runtimeParameters,"data-zp-cookie-bootstrap","bootstrap","");
  const stringCompilationSetting=bootstrapValue(runtimeScript,runtimeParameters,"data-zp-strings","strings","1");
  const portSource=NativeString(bootstrapValue(runtimeScript,runtimeParameters,"data-zp-ports","ports","80,443"));
  const approvedPorts=objectFreeze(reflectApply(arrayMap,reflectApply(stringSplit,portSource,[","]),[value=>NativeNumber(value)]));
  const parsedInitialTarget=targetURLRecord(new NativeURL(initialTargetURL));
  const runtimeLoadGuard=trustedRuntimeLoadGuard(runtimeScript);
  if(parsedRuntimeURL)reflectApply(urlNatives.hash.set,parsedRuntimeURL,[""]);
  const runtimeURL=parsedRuntimeURL?objectFreeze({href:urlProperty(parsedRuntimeURL,"href"),hash:runtimeHash}):null;
  const state={runtimeScript,runtimeURL,runtimeLoadGuard,abiName,cookieRouteID,cookieBootstrapSource,stringCompilationSetting,approvedPorts,parsedInitialTarget};
  scrubRuntimeScript(runtimeScript);validateRuntimeBootstrap(state);return objectFreeze(state)
}
function internalTrustedTypesPolicyName(){
  const script=reflectApply(bootstrapNatives.currentScript.get,document,[]);
  const source=script?reflectApply(bootstrapNatives.scriptSrc.get,script,[]):"";
  if(source==="")return"zeroproxy-runtime-v2";
  const parsed=new NativeURL(source,reflectApply(bootstrapNatives.documentURL.get,document,[])),hash=urlProperty(parsed,"hash"),parameters=hash?new NativeURLSearchParams(reflectApply(stringSlice,hash,[1])):null;
  const name=parameters?reflectApply(bootstrapNatives.parametersGet,parameters,["tt"]):null;
  if(name===null)return"zeroproxy-runtime-v2";
  if(!/^zp-[A-Za-z0-9_-]{16,128}$/.test(name))throw new NativeDOMException("Runtime Trusted Types policy rejected","SecurityError");
  return name;
}
function bindFunction(value,thisArg){return reflectApply(functionBind,value,[thisArg])}
const runtimeTrustedTypesPolicyName=internalTrustedTypesPolicyName(),runtimeTrustedHTMLPolicy=trustedTypesCreatePolicy?reflectApply(trustedTypesCreatePolicy,nativeTrustedTypes,[runtimeTrustedTypesPolicyName,{createHTML:value=>value}]):null,runtimeTrustedHTMLCreate=runtimeTrustedHTMLPolicy?bindFunction(runtimeTrustedHTMLPolicy.createHTML,runtimeTrustedHTMLPolicy):null;
function runtimeHTML(value){return runtimeTrustedHTMLCreate?reflectApply(runtimeTrustedHTMLCreate,undefined,[value]):value}
function lower(value){return reflectApply(stringToLowerCase,NativeString(value),[])}
function includesValue(value,search,position){const args=position===undefined?[search]:[search,position];return typeof value==="string"?reflectApply(stringIncludes,value,args):reflectApply(arrayIncludes,value,args)}
function arrayWithFirst(first,rest){const result=[first];for(let index=0;index<rest.length;index+=1)result[index+1]=rest[index];return result}
function markupInput(value){if(trustedHTMLToString)try{return{nativeValue:value,source:reflectApply(trustedHTMLToString,value,[])}}catch{}const source=NativeString(value);return{nativeValue:source,source}}
function markupInputs(values){const nativeValues=[],sources=[];for(let index=0;index<values.length;index+=1){const input=markupInput(values[index]);nativeValues[index]=input.nativeValue;sources[index]=input.source}return{nativeValues,source:reflectApply(arrayJoin,sources,[""])}}
function* indexedValues(values){for(let index=0;index<values.length;index+=1)yield values[index]}
function* indexedKeys(values){for(let index=0;index<values.length;index+=1)yield index}
function* indexedEntries(values){for(let index=0;index<values.length;index+=1)yield [index,values[index]]}
function privateCollection(Base,keys){class PrivateCollection extends Base{}for(const key of keys){const descriptor=natives.getOwnPropertyDescriptor(Base.prototype,key);if(descriptor)natives.defineProperty(PrivateCollection.prototype,key,{...descriptor,configurable:false})}return PrivateCollection}
const PrivateMap=privateCollection(Map,["size","get","set","has","delete","clear","entries","keys","values","forEach",Symbol.iterator]),PrivateWeakMap=privateCollection(WeakMap,["get","set","has","delete"]),PrivateSet=privateCollection(Set,["size","add","has","delete","clear","entries","keys","values","forEach",Symbol.iterator]),PrivateWeakSet=privateCollection(WeakSet,["add","has","delete"]);
const dynamicNatives=Object.freeze({AsyncFunction:objectGetPrototypeOf(async function(){}).constructor,GeneratorFunction:objectGetPrototypeOf(function*(){}).constructor,AsyncGeneratorFunction:objectGetPrototypeOf(async function*(){}).constructor});
const timerNatives=Object.freeze({setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval});
const documentNatives = Object.freeze({ location:Object.getOwnPropertyDescriptor(Document.prototype,"location"),defaultView:Object.getOwnPropertyDescriptor(Document.prototype,"defaultView"),URL:Object.getOwnPropertyDescriptor(Document.prototype,"URL"),documentURI:Object.getOwnPropertyDescriptor(Document.prototype,"documentURI"),referrer:Object.getOwnPropertyDescriptor(Document.prototype,"referrer"),domain:Object.getOwnPropertyDescriptor(Document.prototype,"domain"),cookie:Object.getOwnPropertyDescriptor(Document.prototype,"cookie"),contentType:Object.getOwnPropertyDescriptor(Document.prototype,"contentType"),open:globalThis.open, documentElement: Object.getOwnPropertyDescriptor(Document.prototype, "documentElement"), body: Object.getOwnPropertyDescriptor(Document.prototype, "body"), head: Object.getOwnPropertyDescriptor(Document.prototype, "head") });
const eventNatives=Object.freeze({view:Object.getOwnPropertyDescriptor(UIEvent.prototype,"view"),source:Object.getOwnPropertyDescriptor(MessageEvent.prototype,"source"),origin:Object.getOwnPropertyDescriptor(MessageEvent.prototype,"origin"),storageURL:optionalPrototypeDescriptor(globalThis.StorageEvent,"url"),addEventListener:EventTarget.prototype.addEventListener,removeEventListener:EventTarget.prototype.removeEventListener,dispatchEvent:EventTarget.prototype.dispatchEvent,composedPath:Event.prototype.composedPath,preventDefault:Event.prototype.preventDefault,defaultPrevented:Object.getOwnPropertyDescriptor(Event.prototype,"defaultPrevented")})
const frameNatives=Object.freeze({
  iframeContentWindow:Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"contentWindow"),
  iframeContentDocument:Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"contentDocument"),
  iframeGetSVGDocument:Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"getSVGDocument"),
  frameContentWindow:optionalOwnDescriptor(globalThis.HTMLFrameElement,globalThis.HTMLFrameElement?.prototype,"contentWindow"),
  frameContentDocument:optionalOwnDescriptor(globalThis.HTMLFrameElement,globalThis.HTMLFrameElement?.prototype,"contentDocument"),
  objectContentWindow:optionalOwnDescriptor(globalThis.HTMLObjectElement,globalThis.HTMLObjectElement?.prototype,"contentWindow"),
  objectContentDocument:optionalOwnDescriptor(globalThis.HTMLObjectElement,globalThis.HTMLObjectElement?.prototype,"contentDocument"),
  objectGetSVGDocument:optionalOwnDescriptor(globalThis.HTMLObjectElement,globalThis.HTMLObjectElement?.prototype,"getSVGDocument"),
  embedGetSVGDocument:optionalOwnDescriptor(globalThis.HTMLEmbedElement,globalThis.HTMLEmbedElement?.prototype,"getSVGDocument"),
});
const networkNatives=Object.freeze({sendBeacon:Navigator.prototype.sendBeacon});
const serviceWorkerNatives=Object.freeze({container:optionalOwnDescriptor(globalThis.ServiceWorkerContainer,Navigator.prototype,"serviceWorker")});
const formNatives=Object.freeze({action:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,"action"),method:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,"method"),enctype:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,"enctype"),submit:HTMLFormElement.prototype.submit,requestSubmit:HTMLFormElement.prototype.requestSubmit});
const popupNatives=Object.freeze({close:globalThis.close,focus:globalThis.focus,blur:globalThis.blur});
const anchorNatives=Object.freeze({click:HTMLElement.prototype.click,remove:Element.prototype.remove});
const customElementNatives=objectFreeze({define:globalThis.CustomElementRegistry?.prototype.define});
const sharedWorkerNatives=captureSharedWorkerNatives(),workerNatives=objectFreeze({postMessage:globalThis.Worker?.prototype.postMessage,terminate:globalThis.Worker?.prototype.terminate}),messagePortNatives=objectFreeze({close:globalThis.MessagePort?.prototype.close,postMessage:globalThis.MessagePort?.prototype.postMessage,prototype:globalThis.MessagePort?.prototype,start:globalThis.MessagePort?.prototype.start}),workletNatives=objectFreeze({audio:globalThis.AudioWorklet?.prototype.addModule,worklet:globalThis.Worklet?.prototype.addModule});
const messageNatives=Object.freeze({postMessage:globalThis.postMessage});
const attributeNatives=Object.freeze({getAttribute:Element.prototype.getAttribute,getAttributeNS:Element.prototype.getAttributeNS,getAttributeNames:Element.prototype.getAttributeNames,hasAttribute:Element.prototype.hasAttribute,hasAttributeNS:Element.prototype.hasAttributeNS,removeAttribute:Element.prototype.removeAttribute,removeAttributeNS:Element.prototype.removeAttributeNS,removeAttributeNode:Element.prototype.removeAttributeNode});
const insertionNatives=Object.freeze({cloneNode:Node.prototype.cloneNode,appendChild:Node.prototype.appendChild,insertBefore:Node.prototype.insertBefore,replaceChild:Node.prototype.replaceChild,elementAppend:Element.prototype.append,elementPrepend:Element.prototype.prepend,elementBefore:Element.prototype.before,elementAfter:Element.prototype.after,elementReplaceWith:Element.prototype.replaceWith,insertAdjacentElement:Element.prototype.insertAdjacentElement,insertAdjacentText:Element.prototype.insertAdjacentText,elementReplaceChildren:Element.prototype.replaceChildren,elementMoveBefore:Element.prototype.moveBefore,documentAppend:Document.prototype.append,documentPrepend:Document.prototype.prepend,documentReplaceChildren:Document.prototype.replaceChildren,documentMoveBefore:Document.prototype.moveBefore,fragmentAppend:DocumentFragment.prototype.append,fragmentPrepend:DocumentFragment.prototype.prepend,fragmentReplaceChildren:DocumentFragment.prototype.replaceChildren,fragmentMoveBefore:DocumentFragment.prototype.moveBefore,rangeInsertNode:Range.prototype.insertNode,rangeSurroundContents:Range.prototype.surroundContents});
const childNodeNatives=objectFreeze({removeChild:Node.prototype.removeChild,elementRemove:Element.prototype.remove,characterDataRemove:CharacterData.prototype.remove,documentTypeRemove:DocumentType.prototype.remove,characterDataBefore:CharacterData.prototype.before,characterDataAfter:CharacterData.prototype.after,characterDataReplaceWith:CharacterData.prototype.replaceWith,documentTypeBefore:DocumentType.prototype.before,documentTypeAfter:DocumentType.prototype.after,documentTypeReplaceWith:DocumentType.prototype.replaceWith});
const parserNatives=Object.freeze({elementInnerHTML:Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML"),elementOuterHTML:Object.getOwnPropertyDescriptor(Element.prototype,"outerHTML"),shadowInnerHTML:Object.getOwnPropertyDescriptor(ShadowRoot.prototype,"innerHTML"),srcdoc:Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"srcdoc"),insertAdjacentHTML:Element.prototype.insertAdjacentHTML,open:Document.prototype.open,write:Document.prototype.write,writeln:Document.prototype.writeln,contextualFragment:Range.prototype.createContextualFragment,parseFromString:DOMParser.prototype.parseFromString,setHTML:Element.prototype.setHTML,setHTMLUnsafe:Element.prototype.setHTMLUnsafe,shadowSetHTML:ShadowRoot.prototype.setHTML,shadowSetHTMLUnsafe:ShadowRoot.prototype.setHTMLUnsafe,documentParseHTML:Document.parseHTML,documentParseHTMLUnsafe:Document.parseHTMLUnsafe});
const xsltNatives=globalThis.XSLTProcessor?objectFreeze({transformToFragment:XSLTProcessor.prototype.transformToFragment,transformToDocument:XSLTProcessor.prototype.transformToDocument}):null;
const markupNatives = Object.freeze({ createElement:Document.prototype.createElement,createElementNS:Document.prototype.createElementNS,createAttribute:Document.prototype.createAttribute,createAttributeNS:Document.prototype.createAttributeNS,createRange:Document.prototype.createRange,templateContent:Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype,"content"),childNodes:Object.getOwnPropertyDescriptor(Node.prototype,"childNodes"),parentNode:Object.getOwnPropertyDescriptor(Node.prototype,"parentNode"),parentElement:Object.getOwnPropertyDescriptor(Node.prototype,"parentElement"),ownerDocument:Object.getOwnPropertyDescriptor(Node.prototype,"ownerDocument"),shadowHost:Object.getOwnPropertyDescriptor(ShadowRoot.prototype,"host"),shadowRoot:Object.getOwnPropertyDescriptor(Element.prototype,"shadowRoot"),rangeStartContainer:Object.getOwnPropertyDescriptor(AbstractRange.prototype,"startContainer"),selectNodeContents:Range.prototype.selectNodeContents,attachShadow:Element.prototype.attachShadow, localName: Object.getOwnPropertyDescriptor(Element.prototype, "localName"), namespaceURI: Object.getOwnPropertyDescriptor(Element.prototype, "namespaceURI"), nodeType: Object.getOwnPropertyDescriptor(Node.prototype, "nodeType"), getRootNode: Node.prototype.getRootNode, isConnected: Object.getOwnPropertyDescriptor(Node.prototype, "isConnected"), firstChild: Object.getOwnPropertyDescriptor(Node.prototype, "firstChild"), nextSibling: Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling") });
function nativeNodeType(value){try{return reflectApply(markupNatives.nodeType.get,value,[])}catch{return 0}}
function nativeLocalName(value){try{return reflectApply(reflectGet(markupNatives,"localName").get,value,[])}catch{return""}}
function nativeNamespaceURI(value){try{return reflectApply(reflectGet(markupNatives,"namespaceURI").get,value,[])}catch{return null}}
function isNode(value){return nativeNodeType(value)!==0}
function isElementNode(value){return nativeNodeType(value)===1}
function isDocumentNode(value){return nativeNodeType(value)===9}
function isDocumentFragmentNode(value){return nativeNodeType(value)===11}
function isShadowRootNode(value){try{reflectApply(markupNatives.shadowHost.get,value,[]);return true}catch{return false}}
function isAttrNode(value){return nativeNodeType(value)===2}
function isCharacterDataNode(value){const type=nativeNodeType(value);return type===3||type===4||type===7||type===8}
function isHTMLElementNamed(value,name){return nativeNamespaceURI(value)==="http://www.w3.org/1999/xhtml"&&nativeLocalName(value)===name}
function isHTMLBaseElement(value){return isHTMLElementNamed(value,"base")}
function isHTMLMetaElement(value){return isHTMLElementNamed(value,"meta")}
function isHTMLScriptElement(value){return isHTMLElementNamed(value,"script")}
function isHTMLTemplateElement(value){return isHTMLElementNamed(value,"template")}
function isSVGElementNode(value){return isElementNode(value)&&nativeNamespaceURI(value)==="http://www.w3.org/2000/svg"}
function nativeParentNode(value){return reflectApply(markupNatives.parentNode.get,value,[])}
function nativeParentElement(value){return reflectApply(markupNatives.parentElement.get,value,[])}
function nativeOwnerDocument(value){return reflectApply(markupNatives.ownerDocument.get,value,[])}
function nativeFirstChild(value){return reflectApply(markupNatives.firstChild.get,value,[])}
function nativeNextSibling(value){return reflectApply(markupNatives.nextSibling.get,value,[])}
function nativeIsConnected(value){return reflectApply(markupNatives.isConnected.get,value,[])}
function nativeRootNode(value){return reflectApply(markupNatives.getRootNode,value,[])}
function nativeDocumentElement(value){return reflectApply(documentNatives.documentElement.get,value,[])}
function nativeDocumentBody(value){return reflectApply(documentNatives.body.get,value,[])}
function nativeDocumentHead(value){return reflectApply(documentNatives.head.get,value,[])}
const reflectedNatives=Object.freeze({nonce:Object.getOwnPropertyDescriptor(HTMLElement.prototype,"nonce"),scriptType:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"type"),scriptIntegrity:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"integrity"),linkIntegrity:Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"integrity"),metaHttpEquiv:Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype,"httpEquiv"),metaContent:Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype,"content")});
function captureHyperlinkProjection(prototype){
  const descriptors=objectCreate(null);
  for(const property of["origin","protocol","username","password","host","hostname","port","pathname","search","hash"])descriptors[property]=Object.getOwnPropertyDescriptor(prototype,property);
  return objectFreeze({prototype,descriptors,href:Object.getOwnPropertyDescriptor(prototype,"href"),toString:Object.getOwnPropertyDescriptor(prototype,"toString")});
}
const hyperlinkProjectionNatives=objectFreeze([captureHyperlinkProjection(HTMLAnchorElement.prototype),captureHyperlinkProjection(HTMLAreaElement.prototype)]);
const projectionNatives=objectFreeze({
  anchorPing:Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype,"ping"),
  areaPing:Object.getOwnPropertyDescriptor(HTMLAreaElement.prototype,"ping"),
  imageSrcset:Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"srcset"),
  linkImageSrcset:Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"imageSrcset"),
  sourceSrcset:Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype,"srcset"),
  imageCurrentSrc:Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"currentSrc"),
  mediaCurrentSrc:Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,"currentSrc"),
  styleSheetHref:Object.getOwnPropertyDescriptor(StyleSheet.prototype,"href"),
  cssRuleText:Object.getOwnPropertyDescriptor(CSSRule.prototype,"cssText"),
  cssImportHref:optionalPrototypeDescriptor(globalThis.CSSImportRule,"href"),
  cssImportStyleSheet:optionalPrototypeDescriptor(globalThis.CSSImportRule,"styleSheet"),
  linkSheet:Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"sheet"),
  documentImplementation:Object.getOwnPropertyDescriptor(Document.prototype,"implementation"),
  createDocument:DOMImplementation.prototype.createDocument,
});
const svgURLNatives=objectFreeze({animatedBaseVal:Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype,"baseVal"),animatedAnimVal:Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype,"animVal"),imageHref:Object.getOwnPropertyDescriptor(SVGImageElement.prototype,"href"),useHref:Object.getOwnPropertyDescriptor(SVGUseElement.prototype,"href"),scriptHref:Object.getOwnPropertyDescriptor(SVGScriptElement.prototype,"href")});
const attributeNodeNatives = Object.freeze({ getAttributeNode:Element.prototype.getAttributeNode,getAttributeNodeNS:Element.prototype.getAttributeNodeNS,ownerElement:Object.getOwnPropertyDescriptor(Attr.prototype,"ownerElement"),length:Object.getOwnPropertyDescriptor(NamedNodeMap.prototype,"length"),item:NamedNodeMap.prototype.item,getNamedItem:NamedNodeMap.prototype.getNamedItem,getNamedItemNS:NamedNodeMap.prototype.getNamedItemNS,removeNamedItem:NamedNodeMap.prototype.removeNamedItem,removeNamedItemNS:NamedNodeMap.prototype.removeNamedItemNS,iterator:NamedNodeMap.prototype[Symbol.iterator],entries:NamedNodeMap.prototype.entries,keys:NamedNodeMap.prototype.keys,values:NamedNodeMap.prototype.values,forEach:NamedNodeMap.prototype.forEach, name: Object.getOwnPropertyDescriptor(Attr.prototype, "name"), namespaceURI: Object.getOwnPropertyDescriptor(Attr.prototype, "namespaceURI") });
function nativeAttrName(value){return reflectApply(attributeNodeNatives.name.get,value,[])}
function nativeAttrNamespaceURI(value){return reflectApply(attributeNodeNatives.namespaceURI.get,value,[])}
const selectorNatives=Object.freeze({elementQuerySelector:Element.prototype.querySelector,elementQuerySelectorAll:Element.prototype.querySelectorAll,documentQuerySelector:Document.prototype.querySelector,documentQuerySelectorAll:Document.prototype.querySelectorAll,fragmentQuerySelector:DocumentFragment.prototype.querySelector,fragmentQuerySelectorAll:DocumentFragment.prototype.querySelectorAll,matches:Element.prototype.matches,closest:Element.prototype.closest,nodeListLength:Object.getOwnPropertyDescriptor(NodeList.prototype,"length"),nodeListItem:NodeList.prototype.item,nodeListIterator:NodeList.prototype[Symbol.iterator],serializeToString:XMLSerializer.prototype.serializeToString,importNode:Document.prototype.importNode});
function captureScriptNatives(){
  return Object.freeze({
    text:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"text"),
    textContent:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"textContent"),
    innerText:Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"innerText")??Object.getOwnPropertyDescriptor(HTMLElement.prototype,"innerText"),
  });
}
const scriptNatives=captureScriptNatives();
const adoptionNatives=Object.freeze({adoptNode:Document.prototype.adoptNode});
const cssNatives=Object.freeze({htmlStyle:Object.getOwnPropertyDescriptor(HTMLElement.prototype,"style"),svgStyle:Object.getOwnPropertyDescriptor(SVGElement.prototype,"style"),cssText:Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype,"cssText"),setProperty:CSSStyleDeclaration.prototype.setProperty,removeProperty:CSSStyleDeclaration.prototype.removeProperty,insertRule:CSSStyleSheet.prototype.insertRule,addRule:CSSStyleSheet.prototype.addRule,replace:CSSStyleSheet.prototype.replace,replaceSync:CSSStyleSheet.prototype.replaceSync,styleMapSet:globalThis.StylePropertyMap?.prototype.set,styleMapAppend:globalThis.StylePropertyMap?.prototype.append,getComputedStyle:globalThis.getComputedStyle,getPropertyValue:CSSStyleDeclaration.prototype.getPropertyValue,getPropertyPriority:CSSStyleDeclaration.prototype.getPropertyPriority,item:CSSStyleDeclaration.prototype.item,iterator:CSSStyleDeclaration.prototype[Symbol.iterator],cssNamespace:globalThis.CSS,supports:globalThis.CSS?.supports,documentAdoptedStyleSheets:Object.getOwnPropertyDescriptor(Document.prototype,"adoptedStyleSheets"),shadowAdoptedStyleSheets:Object.getOwnPropertyDescriptor(ShadowRoot.prototype,"adoptedStyleSheets"),cssRules:Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype,"cssRules"),cssRuleListLength:Object.getOwnPropertyDescriptor(CSSRuleList.prototype,"length"),cssRuleListItem:CSSRuleList.prototype.item});
function captureCSSRuleStyleNatives(){
  const entries=[],keys=reflectOwnKeys(globalThis);
  for(let index=0;index<keys.length;index+=1){
    const key=keys[index];if(typeof key!=="string"||!reflectApply(stringStartsWith,key,["CSS"]))continue;
    const constructor=reflectGet(globalThis,key,globalThis),prototype=typeof constructor==="function"?reflectGetOwnPropertyDescriptor(constructor,"prototype")?.value:null,descriptor=prototype&&reflectGetOwnPropertyDescriptor(prototype,"style");
    if(descriptor?.get)reflectApply(arrayPush,entries,[objectFreeze({prototype,descriptor})]);
  }
  return objectFreeze(entries);
}
const cssRuleStyleNatives=captureCSSRuleStyleNatives();
const navigationNatives=Object.freeze({pushState:History.prototype.pushState,replaceState:History.prototype.replaceState,back:History.prototype.back,forward:History.prototype.forward,go:History.prototype.go,locationAssign:globalThis.location.assign,locationReplace:globalThis.location.replace,locationReload:globalThis.location.reload,navigate:globalThis.Navigation?.prototype.navigate,backNavigation:globalThis.Navigation?.prototype.back,forwardNavigation:globalThis.Navigation?.prototype.forward,reloadNavigation:globalThis.Navigation?.prototype.reload,traverseTo:globalThis.Navigation?.prototype.traverseTo});
const historyNatives=Object.freeze({state:Object.getOwnPropertyDescriptor(History.prototype,"state")});
const performanceNatives=Object.freeze({getEntries:Performance.prototype.getEntries,getEntriesByType:Performance.prototype.getEntriesByType,getEntriesByName:Performance.prototype.getEntriesByName,observerGetEntries:PerformanceObserverEntryList.prototype.getEntries,observerGetEntriesByType:PerformanceObserverEntryList.prototype.getEntriesByType,observerGetEntriesByName:PerformanceObserverEntryList.prototype.getEntriesByName,name:Object.getOwnPropertyDescriptor(PerformanceEntry.prototype,"name"),entryType:Object.getOwnPropertyDescriptor(PerformanceEntry.prototype,"entryType"),toJSON:PerformanceEntry.prototype.toJSON});
const mutationNatives = Object.freeze({ MutationObserver:globalThis.MutationObserver,observe:MutationObserver.prototype.observe,disconnect:MutationObserver.prototype.disconnect,takeRecords:MutationObserver.prototype.takeRecords,data:Object.getOwnPropertyDescriptor(CharacterData.prototype,"data"), target: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "target"), type: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "type"), attributeName: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "attributeName"), oldValue: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "oldValue"), addedNodes: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "addedNodes"), removedNodes: Object.getOwnPropertyDescriptor(MutationRecord.prototype, "removedNodes") });
function nativeMutationValue(record,key){return reflectApply(reflectGet(mutationNatives,key).get,record,[])}
const captureNativesComplete=true;
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
