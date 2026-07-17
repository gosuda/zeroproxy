export const runtimeSections = [
  { file: import.meta.url, name: "transaction_section_02", order: 2, phase: "outer" },
];

export function transaction_section_02() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
const runtimeInstallPhases=objectFreeze([
  "CAPTURE_NATIVES",
  "READ_AND_CLEAR_BOOT",
  "INSTANTIATE_DYNAMIC_COMPILER",
  "BUILD_FACADES",
  "INSTALL_REQUIRED_HOOKS",
  "INSTALL_REALM_NETWORK_GUARDS",
  "VERIFY_DESCRIPTORS_EGRESS_ABI",
  "READY",
]);
let runtimeInstallPhaseIndex=0,ready=false,installFailed=false;
function runtimeInstallPhase(){return runtimeInstallPhases[runtimeInstallPhaseIndex]}
function advanceRuntimeInstallPhase(next){
  if(runtimeInstallPhases[runtimeInstallPhaseIndex+1]!==next)throw new NativeError(`invalid runtime installation transition: ${runtimeInstallPhase()} -> ${next}`);
  runtimeInstallPhaseIndex+=1;
}
if(captureNativesComplete!==true)throw new NativeError("native capture incomplete");
advanceRuntimeInstallPhase("READ_AND_CLEAR_BOOT");
const bootstrap=readRuntimeBootstrap(),runtimeScript=bootstrap.runtimeScript,runtimeURL=bootstrap.runtimeURL,runtimeLoadGuard=bootstrap.runtimeLoadGuard,abiName=bootstrap.abiName,cookieRouteID=bootstrap.cookieRouteID,cookieBootstrapSource=bootstrap.cookieBootstrapSource,stringCompilationSetting=bootstrap.stringCompilationSetting,stringCompilationPolicy=stringCompilationSetting==="1",approvedPorts=bootstrap.approvedPorts;
let parsedInitialTarget=bootstrap.parsedInitialTarget;
const functionToString=Function.prototype.toString,functionSources=new PrivateWeakMap(),rollback=[],staged=[],stagedMutations=[],latestStages=new PrivateWeakMap();let protectedEvalStage=null,descriptorsInstalled=false,mutationsInstalled=false;
function captureNativeDescriptors(prototype){const descriptors=new PrivateMap;if(!prototype)return descriptors;for(const key of reflectOwnKeys(prototype)){const descriptor=natives.getOwnPropertyDescriptor(prototype,key);if(descriptor)descriptors.set(key,descriptor)}return descriptors}
const computedStyleDescriptorSets=new PrivateWeakMap(),performanceEntryDescriptorSets=new PrivateWeakMap();
function captureDescriptorSet(sets,prototype){if(prototype)sets.set(prototype,captureNativeDescriptors(prototype))}
function capturePerformanceDescriptorSets(){
  captureDescriptorSet(computedStyleDescriptorSets,CSSStyleDeclaration.prototype);
  captureDescriptorSet(computedStyleDescriptorSets,globalThis.CSSStyleProperties?.prototype);
  for(const prototype of[PerformanceEntry.prototype,globalThis.PerformanceResourceTiming?.prototype,globalThis.PerformanceNavigationTiming?.prototype])captureDescriptorSet(performanceEntryDescriptorSets,prototype);
}
capturePerformanceDescriptorSets();
function capturedDescriptor(value,key,sets){for(let prototype=objectGetPrototypeOf(value);prototype;prototype=objectGetPrototypeOf(prototype)){const descriptor=sets.get(prototype)?.get(key);if(descriptor)return descriptor}return null}
function capturedValue(value,key,sets){const descriptor=capturedDescriptor(value,key,sets);if(!descriptor)return;return descriptor.get?reflectApply(descriptor.get,value,[]):descriptor.value}
function failInstall(error){
  if(!installFailed){
    installFailed=true;
    for(const undo of reflectApply(arrayReverse,rollback,[])){try{undo()}catch{}}
    try{scrubRuntimeScript(runtimeScript)}catch{}
  }
  try{
    const body=emergencyApply(emergencyCreateElement,document,["body"]);
    emergencyApply(emergencyTextContent.set,body,["ZeroProxy blocked this document because its privacy runtime could not be installed."]);
    emergencyApply(emergencyReplaceChildren,document.documentElement,[body]);
  }catch{}
  throw error;
}
function stage(object,key,descriptor){
  if(runtimeInstallPhase()!=="BUILD_FACADES"&&runtimeInstallPhase()!=="INSTANTIATE_DYNAMIC_COMPILER")throw new NativeError(`descriptor staged during ${runtimeInstallPhase()}`);
  const previous=natives.getOwnPropertyDescriptor(object,key);
  if(previous&&!previous.configurable)throw new NativeError(`required property ${NativeString(key)} is not configurable`);
  const installed={...descriptor};
  for(const field of["value","get","set"])if(typeof installed[field]==="function"&&typeof previous?.[field]==="function")installed[field]=mirrorFunction(installed[field],previous[field]);
  const record={object,key,descriptor:installed,previous,prototype:objectGetPrototypeOf(object)};
  let objectStages=latestStages.get(object);
  if(!objectStages){objectStages=new PrivateMap();latestStages.set(object,objectStages)}
  objectStages.set(key,record);
  reflectApply(arrayPush,staged,[record]);
}
function stageProtectedEval(object,key,descriptor){if(protectedEvalStage!==null)throw new NativeError("eval hardening staged twice");stage(object,key,descriptor);protectedEvalStage=staged[staged.length-1]}
function stageMutation(install,undo){
  if(typeof install!=="function"||undo!==undefined&&typeof undo!=="function")throw new NativeError("invalid staged runtime mutation");
  reflectApply(arrayPush,stagedMutations,[{install,undo}]);
}
function stageListener(target,type,listener,options){
  stageMutation(
    ()=>reflectApply(eventNatives.addEventListener,target,[type,listener,options]),
    ()=>reflectApply(eventNatives.removeEventListener,target,[type,listener,options]),
  );
}
function restoreDescriptor(record){if(record.previous)natives.defineProperty(record.object,record.key,record.previous);else reflectDeleteProperty(record.object,record.key)}
function isLatestStage(record){return latestStages.get(record.object)?.get(record.key)===record}
function installStagedDescriptors(){
  if(runtimeInstallPhase()!=="INSTALL_REQUIRED_HOOKS"||descriptorsInstalled)throw new NativeError("required hooks installed out of phase");
  if(protectedEvalStage===null)throw new NativeError("eval hardening unavailable");
  for(const record of staged){
    if(record===protectedEvalStage||!isLatestStage(record))continue;
    natives.defineProperty(record.object,record.key,{...record.descriptor,configurable:true});
    reflectApply(arrayPush,rollback,[()=>restoreDescriptor(record)]);
  }
  natives.defineProperty(protectedEvalStage.object,protectedEvalStage.key,{...protectedEvalStage.descriptor,configurable:true});
  reflectApply(arrayPush,rollback,[()=>restoreDescriptor(protectedEvalStage)]);
  descriptorsInstalled=true;
}
function installStagedMutations(){
  if(runtimeInstallPhase()!=="INSTALL_REALM_NETWORK_GUARDS"||mutationsInstalled)throw new NativeError("realm guards installed out of phase");
  for(const mutation of stagedMutations){
    const installedUndo=mutation.install();
    const undo=typeof installedUndo==="function"?installedUndo:mutation.undo;
    if(typeof undo!=="function")throw new NativeError("runtime mutation is not reversible");
    reflectApply(arrayPush,rollback,[undo]);
  }
  mutationsInstalled=true;
}
function normalizedDescriptor(descriptor){
  if(!descriptor)return null;
  const normalized={configurable:descriptor.configurable===true,enumerable:descriptor.enumerable===true};
  if("value"in descriptor||"writable"in descriptor){normalized.value=descriptor.value;normalized.writable=descriptor.writable===true}
  else{normalized.get=descriptor.get;normalized.set=descriptor.set}
  return normalized;
}
function descriptorsEqual(left,right){
  if(left===null||right===null)return left===right;
  const leftKeys=reflectOwnKeys(left),rightKeys=reflectOwnKeys(right);
  if(leftKeys.length!==rightKeys.length)return false;
  for(const key of leftKeys)if(!reflectApply(arrayIncludes,rightKeys,[key])||left[key]!==right[key])return false;
  return true;
}
function verifyStagedDescriptors(){
  if(!descriptorsInstalled)throw new NativeError("required hooks unavailable");
  for(const record of staged){
    if(!isLatestStage(record))continue;
    const expected=normalizedDescriptor({...record.descriptor,configurable:true});
    const actual=normalizedDescriptor(natives.getOwnPropertyDescriptor(record.object,record.key));
    if(!descriptorsEqual(actual,expected)||objectGetPrototypeOf(record.object)!==record.prototype)throw new NativeError(`required hook verification failed: ${NativeString(record.key)}`);
  }
}
function commit(){
  if(runtimeInstallPhase()!=="VERIFY_DESCRIPTORS_EGRESS_ABI"||!descriptorsInstalled||!mutationsInstalled)throw new NativeError("runtime committed out of phase");
  for(const record of staged)if(record!==protectedEvalStage&&isLatestStage(record))natives.defineProperty(record.object,record.key,record.descriptor);
  natives.defineProperty(protectedEvalStage.object,protectedEvalStage.key,protectedEvalStage.descriptor);
  rollback.length=0;
  stagedMutations.length=0;
}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
