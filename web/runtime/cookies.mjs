export const runtimeSections = [
  { file: import.meta.url, name: "cookies_section_06", order: 6, phase: "inner" },
];

export function cookies_section_06() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  let cookieSequence=0,cookieProjection=[],cookieBarrier=NativePromise.resolve(),historyEntryID="",runtimeCookieTopLevelSite="",runtimePolicyContext,runtimeDocumentPolicy,documentDecodeMetadata,runtimeImportMapHandle=null,runtimeTargetServiceWorkerController=null;
  function installCookieSnapshot(snapshot){
    const jar=snapshot?.jar_or_delta;
    if(!snapshot||!numberIsInteger(snapshot.cookie_seq)||snapshot.cookie_seq<cookieSequence||jar?.kind!=="SNAPSHOT"||!arrayIsArray(jar.cookies))throw new NativeDOMException("Cookie snapshot rejected","SecurityError");
    const projected=[];
    for(const cookie of jar.cookies){
      if(!cookie||typeof cookie!=="object"||typeof cookie.name!=="string"||typeof cookie.value!=="string"||typeof cookie.domain!=="string"||typeof cookie.path!=="string"||cookie.http_only===true)throw new NativeDOMException("Cookie snapshot rejected","SecurityError");
      reflectApply(arrayPush,projected,[objectFreeze({...cookie})]);
    }
    cookieSequence=snapshot.cookie_seq;
    cookieProjection=projected;
  }
  function decodeCookieBootstrap(value){
    if(typeof value!=="string"||value.length===0||value.length>4<<20||!/^[A-Za-z0-9_-]+$/.test(value))throw new NativeDOMException("Cookie snapshot rejected","SecurityError");
    const normalized=reflectApply(stringReplaceAll,reflectApply(stringReplaceAll,value,["-","+"]),["_","/"]),padded=normalized+"=".repeat((4-normalized.length%4)%4);
    let binary;
    try{binary=reflectApply(nativeAtob,globalThis,[padded])}catch{throw new NativeDOMException("Cookie snapshot rejected","SecurityError")}
    const bytes=reflectApply(uint8ArrayFrom,NativeUint8Array,[binary,character=>reflectApply(nativeStringCharCodeAt,character,[0])]);
    try{return jsonParse(decodedText(new NativeTextDecoder,bytes))}catch{throw new NativeDOMException("Cookie snapshot rejected","SecurityError")}
  }
  function validatedDocumentPolicy(value){
    const trusted=value?.trusted_types,names=trusted?.allowed_policy_names;
    if(!value||typeof value!=="object"||arrayIsArray(value)||reflectOwnKeys(value).length!==4||value.version!==1||!numberIsInteger(value.enforced_report_endpoint_count)||value.enforced_report_endpoint_count<0||value.enforced_report_endpoint_count>4096||!numberIsInteger(value.report_only_endpoint_count)||value.report_only_endpoint_count<0||value.report_only_endpoint_count>4096||!trusted||typeof trusted!=="object"||arrayIsArray(trusted)||reflectOwnKeys(trusted).length!==5||typeof trusted.directive_present!=="boolean"||typeof trusted.allow_any!=="boolean"||typeof trusted.allow_duplicates!=="boolean"||typeof trusted.require_for_script!=="boolean"||!arrayIsArray(names)||names.length>128||reflectApply(arraySome,names,[name=>typeof name!=="string"||!reflectApply(regexpTest,/^[A-Za-z0-9#=_/@.%-]{1,128}$/,[name])]))throw new NativeDOMException("Document policy bootstrap rejected","SecurityError");
    return objectFreeze({...value,trusted_types:objectFreeze({...trusted,allowed_policy_names:objectFreeze(arrayFrom(names))})});
  }
  function stageTrustedTypesPolicyBoundary(){
    if(!nativeTrustedTypes||typeof trustedTypesCreatePolicy!=="function")return;
    let owner=nativeTrustedTypes,descriptor;
    while(owner&&!(descriptor=natives.getOwnPropertyDescriptor(owner,"createPolicy")))owner=objectGetPrototypeOf(owner);
    if(!owner||typeof descriptor.value!=="function"||!descriptor.configurable)throw new NativeError("Trusted Types policy boundary unavailable");
    const createPolicy=mirrorFunction(function(name,...rules){
      if(NativeString(name)===runtimeTrustedTypesPolicyName)throw new NativeTypeError("Trusted Types policy name is reserved");
      return reflectApply(trustedTypesCreatePolicy,this,[name,...rules]);
    },trustedTypesCreatePolicy);
    stage(owner,"createPolicy",{...descriptor,value:createPolicy,writable:false,configurable:false});
  }
  function loadCookieBootstrap(){
    if(cookieRouteID===""){
      runtimeCapability="";historyEntryID="";
      const port=parsedInitialTarget.port||(parsedInitialTarget.protocol==="https:"?"443":"80"),origin=`${parsedInitialTarget.protocol}//${parsedInitialTarget.hostname}:${port}`;
      runtimeCookieTopLevelSite=`${parsedInitialTarget.protocol}//${parsedInitialTarget.hostname}`;runtimePolicyContext=objectFreeze({profile_id:"runtime",tab_id:"runtime",document_id:"runtime",virtual_origin:origin,virtual_site:runtimeCookieTopLevelSite,target_url:parsedInitialTarget.href,effective_base_url:parsedInitialTarget.href,referrer_url:null,referrer_policy:"strict-origin-when-cross-origin",document_charset:"utf-8",target_csp:[],target_csp_report_only:[],relay_profile:"unbound-test",approved_target_ports:approvedPorts,policy_version:2});runtimeDocumentPolicy=validatedDocumentPolicy({version:1,trusted_types:{directive_present:false,allow_any:true,allowed_policy_names:[],allow_duplicates:false,require_for_script:false},enforced_report_endpoint_count:0,report_only_endpoint_count:0});
      return;
    }
    const bootstrapState=decodeCookieBootstrap(cookieBootstrapSource),policy=bootstrapState?.policy_context,documentPolicy=bootstrapState?.document_policy,decodeMetadata=bootstrapState?.decode_metadata;
    if(!bootstrapState||typeof bootstrapState.runtime_capability!=="string"||!reflectApply(regexpTest,/^[A-Za-z0-9_-]{32}$/,[bootstrapState.runtime_capability])||typeof bootstrapState.entry_id!=="string"||!reflectApply(regexpTest,/^[A-Za-z0-9_-]{32}$/,[bootstrapState.entry_id])||!policy||policy.policy_version!==2||policy.target_url!==parsedInitialTarget.href||typeof policy.virtual_origin!=="string"||typeof policy.virtual_site!=="string"||typeof policy.referrer_policy!=="string"||typeof policy.document_charset!=="string"||!arrayIsArray(policy.target_csp)||!arrayIsArray(policy.target_csp_report_only)||policy.target_csp.length>16||policy.target_csp_report_only.length>16||reflectApply(arraySome,[...policy.target_csp,...policy.target_csp_report_only],[value=>typeof value!=="string"||value.length>64<<10])||typeof policy.relay_profile!=="string"||!arrayIsArray(policy.approved_target_ports)||!decodeMetadata||typeof decodeMetadata.encoding_used!=="string"||typeof decodeMetadata.replacement!=="boolean"||typeof decodeMetadata.source!=="string")throw new NativeDOMException("Runtime capability rejected","SecurityError");
    runtimeDocumentPolicy=validatedDocumentPolicy(documentPolicy);
    if(bootstrapState.import_map_handle!=null&&typeof bootstrapState.import_map_handle!=="string")throw new NativeDOMException("Import map bootstrap rejected","SecurityError");
    if(typeof bootstrapState.cookie_top_level_site!=="string"||bootstrapState.cookie_top_level_site.length===0)throw new NativeDOMException("Cookie site bootstrap rejected","SecurityError");
    if(bootstrapState.target_service_worker_controller!==undefined&&bootstrapState.target_service_worker_controller!==null&&(typeof bootstrapState.target_service_worker_controller!=="object"||arrayIsArray(bootstrapState.target_service_worker_controller)))throw new NativeDOMException("Target service worker bootstrap rejected","SecurityError");
    runtimeCapability=bootstrapState.runtime_capability;historyEntryID=bootstrapState.entry_id;runtimeCookieTopLevelSite=bootstrapState.cookie_top_level_site;documentDecodeMetadata=objectFreeze({encoding_used:decodeMetadata.encoding_used,replacement:decodeMetadata.replacement,source:decodeMetadata.source});runtimeImportMapHandle=bootstrapState.import_map_handle??null;runtimeTargetServiceWorkerController=bootstrapState.target_service_worker_controller??null;runtimePolicyContext=objectFreeze({...policy,approved_target_ports:approvedPorts});
    installCookieSnapshot(bootstrapState.snapshot);
  }
  function cookieString(){return reflectApply(arrayJoin,reflectApply(arrayMap,cookieProjection,[cookie=>`${cookie.name}=${cookie.value}`]),["; "])}
  function cookieDefaultPath(path){if(!reflectApply(stringStartsWith,path,["/"])||path==="/")return"/";const index=path.lastIndexOf("/");return index<=0?"/":reflectApply(stringSlice,path,[0,index])}
  function validCookiePair(name,value){return name!==""&&!/[\x00-\x20\x7f;,=]/.test(name)&&/^(?:\"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*\"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/.test(value)}
  function cookieAttribute(piece){
    const attribute=reflectApply(stringTrim,piece,[]),equals=attribute.indexOf("=");
    return {
      name:lower(reflectApply(stringTrim,equals<0?attribute:reflectApply(stringSlice,attribute,[0,equals]),[])),
      value:equals<0?"":reflectApply(stringTrim,reflectApply(stringSlice,attribute,[equals+1]),[]),
    };
  }
  function applyCookieDomain(cookie,value,host){
    const candidate=lower(value.replace(/^\./,""));
    if(candidate===""||host!==candidate&&!host.endsWith(`.${candidate}`))return false;
    if(candidate!==host)cookie.domainDeferred=true;
    cookie.domain=candidate;
    return true;
  }
  const cookieAttributeHandlers=objectFreeze({
    path(cookie,value){if(reflectApply(stringStartsWith,value,["/"]))cookie.path=value},
    secure(cookie){cookie.secure=true},
    httponly(cookie){cookie.httpOnly=true},
    samesite(cookie,value){const normalized=lower(value);cookie.sameSite=normalized==="none"?"NONE":normalized==="strict"?"STRICT":"LAX"},
    "max-age"(cookie,value){if(/^-?\d+$/.test(value)&&NativeNumber(value)<=0)cookie.deleteCookie=true},
    partitioned(cookie){cookie.partitioned=true},
  });
  function applyCookieAttribute(cookie,piece,host){
    const attribute=cookieAttribute(piece);
    if(attribute.name==="domain")return applyCookieDomain(cookie,attribute.value,host);
    const handler=reflectGetOwnPropertyDescriptor(cookieAttributeHandlers,attribute.name)?.value;
    if(handler)reflectApply(handler,cookieAttributeHandlers,[cookie,attribute.value]);
    return true;
  }
  function validOptimisticCookie(cookie,host){
    if(cookie.httpOnly||cookie.secure&&parsedInitialTarget.protocol!=="https:"||cookie.sameSite==="NONE"&&!cookie.secure||cookie.partitioned&&!cookie.secure)return false;
    if(reflectApply(stringStartsWith,cookie.name,["__Host-"])&&(!cookie.secure||cookie.domain!==host||cookie.path!=="/"))return false;
    if(reflectApply(stringStartsWith,cookie.name,["__Secure-"])&&!cookie.secure)return false;
    if(reflectApply(stringStartsWith,cookie.name,["__Http-"]))return false;
    return !cookie.domainDeferred;
  }
  function optimisticCookie(raw){
    const pieces=reflectApply(stringSplit,raw,[";"]);
    const pair=reflectApply(stringTrim,reflectApply(arrayShift,pieces,[])??"",[]);
    const separator=pair.indexOf("=");
    if(separator<=0)return null;
    const name=reflectApply(stringSlice,pair,[0,separator]);
    const value=reflectApply(stringSlice,pair,[separator+1]);
    if(!validCookiePair(name,value))return null;
    const target=new NativeURL(parsedInitialTarget.href);
    const host=urlProperty(target,"hostname");
    const cookie={
      name,
      value,
      domain:host,
      path:cookieDefaultPath(urlProperty(target,"pathname")),
      secure:false,
      httpOnly:false,
      sameSite:"LAX",
      deleteCookie:false,
      partitioned:false,
      domainDeferred:false,
    };
    for(const piece of pieces)if(!applyCookieAttribute(cookie,piece,host))return null;
    if(!validOptimisticCookie(cookie,host))return null;
    return {
      name:cookie.name,
      value:cookie.value,
      domain:cookie.domain,
      path:cookie.path,
      secure:cookie.secure,
      http_only:false,
      same_site:cookie.sameSite,
      creation_seq:cookieSequence+1,
      ...(cookie.partitioned?{partition_key:runtimeCookieTopLevelSite}:{}),
      deleteCookie:cookie.deleteCookie,
    };
  }
  function sameCookieIdentity(left,right){return left.name===right.name&&left.domain===right.domain&&left.path===right.path&&(left.partition_key??null)===(right.partition_key??null)}
  function applyOptimisticCookie(cookie){
    if(!cookie)return;
    const next=reflectApply(arrayFilter,cookieProjection,[entry=>!sameCookieIdentity(entry,cookie)]);
    if(!cookie.deleteCookie)reflectApply(arrayPush,next,[objectFreeze(cookie)]);
    cookieProjection=next;
  }
  function cookieOperationID(){const bytes=new NativeUint8Array(24);reflectApply(cryptoGetRandomValues,nativeCrypto,[bytes]);return reflectApply(arrayJoin,arrayFrom(bytes,byte=>reflectApply(stringPadStart,reflectApply(numberToString,byte,[16]),[2,"0"])),[""])}
  function refreshCookieProjection(){
    if(cookieRouteID===""||!serviceWorkerController)return NativePromise.resolve();
    return runtimeCommand("DOCUMENT_COOKIE_SNAPSHOT",{target_url:parsedInitialTarget.href,known_seq:0},"Cookie authority unavailable").then(snapshot=>{installCookieSnapshot(snapshot);return snapshot});
  }
  function setDocumentCookie(value){
    const raw=NativeString(value);
    if(cookieRouteID==="")return;
    applyOptimisticCookie(optimisticCookie(raw));
    const baseSequence=cookieSequence;
    const operation=cookieBarrier.then(()=>runtimeCommand("DOCUMENT_COOKIE_MUTATE",{target_url:parsedInitialTarget.href,raw,op_id:cookieOperationID(),base_seq:baseSequence},"Cookie mutation failed")).then(result=>{
      if(result?.snapshot){installCookieSnapshot(result.snapshot);return result}
      return refreshCookieProjection().then(()=>result);
    });
    cookieBarrier=operation.catch(()=>refreshCookieProjection());
    void cookieBarrier.catch(()=>{});
  }
  function installCookieCommitListener(){
    if(!serviceWorkerController)return;
    const handleCookieCommit=event=>{
      if(event.data?.v===2&&event.data?.operation==="COOKIE_COMMIT")refreshCookieProjection();
    };
    stageListener(navigator.serviceWorker,"message",handleCookieCommit);
  }
  loadCookieBootstrap();
  stageTrustedTypesPolicyBoundary();
  bindRuntimeCapability();
  installCookieCommitListener();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
