export const runtimeSections = [
  { file: import.meta.url, name: "abi_section_37", order: 37, phase: "inner" },
];

export function abi_section_37() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function stageABI(){
    if(abiName in rawWindow)throw new NativeError("ABI identifier collision");
    stage(rawWindow,abiName,{value:abi,writable:false,enumerable:false,configurable:false});
  }
  function compilerABIHealthy(){
    if(typeof wasm_bindgen.source_map_base64!=="function"||typeof wasm_bindgen.compile_json_with_direct_eval_strictness!=="function"||typeof wasm_bindgen.compile_dynamic_function_json!=="function"||typeof wasm_bindgen.compiler_versions_json!=="function"||typeof wasm_bindgen.compiler_cache_key!=="function"||typeof wasm_bindgen.policy_csp_allows_connect_json!=="function")return false;
    let versions;
    try{versions=jsonParse(wasm_bindgen.compiler_versions_json())}catch{return false}
    return wasm_bindgen.compiler_versions_json()===compilerVersionsEncoded&&versions?.cache_schema_version===1&&versions.result_schema_version===1&&versions.abi_version===1&&typeof compile("1+1","IndirectEvalScript")==="string";
  }
  function capabilityBindingHealthy(){
    if(cookieRouteID==="")return runtimePort===null&&runtimeCapability==="";
    return runtimePort!==null&&serviceWorkerController!==null&&reflectApply(regexpTest,/^[A-Za-z0-9_-]{32}$/,[runtimeCapability]);
  }
  function facadeBrandsHealthy(){
    if(scope.window!==windowFacade||objectGetPrototypeOf(RequestFacade)!==objectGetPrototypeOf(NativeRequest)||reflectGetOwnPropertyDescriptor(RequestFacade,"prototype")?.value!==reflectGetOwnPropertyDescriptor(NativeRequest,"prototype")?.value)return false;
    if(MutationObserverFacade.prototype!==mutationNatives.MutationObserver.prototype||objectGetPrototypeOf(MutationObserverFacade)!==mutationNatives.MutationObserver)return false;
    if(natives.Worker&&(objectGetPrototypeOf(WorkerFacade)!==objectGetPrototypeOf(natives.Worker)||reflectGetOwnPropertyDescriptor(WorkerFacade,"prototype")?.value!==reflectGetOwnPropertyDescriptor(natives.Worker,"prototype")?.value))return false;
    return true;
  }
  function requiredEgressHooksHealthy(){
    const value=(object,key)=>natives.getOwnPropertyDescriptor(object,key)?.value;
    if(value(rawWindow,"eval")!==natives.eval||value(rawWindow,"fetch")!==controlledFetch||value(rawWindow,"XMLHttpRequest")!==XMLHttpRequestFacade||value(rawWindow,"MutationObserver")!==MutationObserverFacade)return false;
    if(natives.WebSocket&&value(rawWindow,"WebSocket")!==WebSocketFacade)return false;
    if(natives.Worker&&value(rawWindow,"Worker")!==WorkerFacade)return false;
    for(const [name,blocker] of disabledNetworkConstructors)if(value(rawWindow,name)!==blocker)return false;
    for(const record of disabledCapabilityMethods)if(natives.getOwnPropertyDescriptor(record.target,record.member)?.value!==record.facade)return false;
    return natives.getOwnPropertyDescriptor(Document.prototype,"cookie")?.get!==documentNatives.cookie.get;
  }
  const bootstrapAttributeNames=objectFreeze(["src","data-zp-runtime-pending","data-zp-runtime-guard","data-zp-runtime-url","data-zp-abi","data-zp-target-url","data-zp-cookie-route","data-zp-cookie-bootstrap","data-zp-strings","data-zp-ports"]);
  function concealmentHealthy(){
    if(includesValue(reflectOwnKeys(windowFacade),abiName)||reflectGetOwnPropertyDescriptor(windowFacade,abiName)!==undefined||abiName in windowFacade)return false;
    if(windowFacade.window!==windowFacade||windowFacade.self!==windowFacade||windowFacade.frames!==windowFacade||windowFacade.location!==locationFacade)return false;
    for(const name of bootstrapAttributeNames)if(reflectApply(bootstrapNatives.getAttribute,runtimeScript,[name])!==null)return false;
    return reflectApply(selectorNatives.documentQuerySelector,document,[staticProjectionSelector])===null;
  }
  function removeRuntimeBootstrap(){
    reflectApply(childNodeNatives.elementRemove,runtimeScript,[]);
    if(nativeIsConnected(runtimeScript)||nativeParentNode(runtimeScript)!==null)throw new NativeError("runtime bootstrap node remained visible");
  }
  function verifyRuntimeInstallation(){
    verifyStagedDescriptors();
    const abiDescriptor=natives.getOwnPropertyDescriptor(rawWindow,abiName);
    if(ready||installFailed||runtimeInstallPhase()!=="VERIFY_DESCRIPTORS_EGRESS_ABI"||abiDescriptor?.value!==abi||abiDescriptor.enumerable||abiDescriptor.writable||abiDescriptor.configurable!==true||!evalDescriptorsPrepared()||!compilerABIHealthy()||!capabilityBindingHealthy()||!facadeBrandsHealthy()||!requiredEgressHooksHealthy()||!concealmentHealthy())throw new NativeError("runtime self-test failed");
  }
  stageABI();
  const staticProjectionSelector="[data-zp-m-v2],[data-zp-style-v2]";
  const validateProjectionElement=element=>{validateMetadata(element);validateStyleMetadata(element)};
  const hydrateProjectionElement=element=>{hydrateMetadata(element);hydrateStyleMetadata(element)};
  const hydrateSubtree=node=>{if(isElementNode(node)){hydrateProjectionElement(node);for(const element of nativeNodeListArray(reflectApply(selectorNatives.elementQuerySelectorAll,node,[staticProjectionSelector])))hydrateProjectionElement(element)}};
  const metadataObserver=new mutationNatives.MutationObserver(records=>{for(const record of records)for(const node of nativeNodeListArray(nativeMutationValue(record,"addedNodes")))hydrateSubtree(node)});
  function visitStaticMetadata(visitor){for(const element of nativeNodeListArray(reflectApply(selectorNatives.documentQuerySelectorAll,document,[staticProjectionSelector])))visitor(element)}
  visitStaticMetadata(validateProjectionElement);
  stageMutation(()=>{
    reflectApply(mutationNatives.observe,metadataObserver,[document,{childList:true,subtree:true}]);
    return()=>reflectApply(mutationNatives.disconnect,metadataObserver,[]);
  });
  advanceRuntimeInstallPhase("INSTALL_REQUIRED_HOOKS");
  installStagedDescriptors();
  advanceRuntimeInstallPhase("INSTALL_REALM_NETWORK_GUARDS");
  installStagedMutations();
  visitStaticMetadata(hydrateProjectionElement);
  if(reflectApply(selectorNatives.documentQuerySelector,document,[staticProjectionSelector])!==null)throw new NativeError("runtime metadata marker remained visible");
  advanceRuntimeInstallPhase("VERIFY_DESCRIPTORS_EGRESS_ABI");
  verifyRuntimeInstallation();
  if(runtimeLoadGuard)reflectApply(runtimeLoadGuard.complete,runtimeLoadGuard,[]);
  removeRuntimeBootstrap();
  commit();
  advanceRuntimeInstallPhase("READY");
  ready=true;
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
