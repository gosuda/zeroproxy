export const runtimeSections = [
  { file: import.meta.url, name: "stealth_section_12", order: 12, phase: "inner" },
];

export function stealth_section_12() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function nativePerformanceEntryName(entry){return reflectApply(performanceNatives.name.get,entry,[])}
  function nativePerformanceEntryType(entry){return reflectApply(performanceNatives.entryType.get,entry,[])}
  function visiblePerformanceName(entry){const type=nativePerformanceEntryType(entry),name=nativePerformanceEntryName(entry);if(type==="navigation")return parsedInitialTarget.href;if(type!=="resource")return;try{const visible=visibleResourceURL(name,"target");if(visible!==name)return visible;const url=new NativeURL(name);if(urlProperty(url,"origin")===syntheticDocumentOrigin&&reflectApply(stringStartsWith,urlProperty(url,"pathname"),["/_zp/"]))return null}catch{return null}}
  function visiblePerformanceJSON(entry,visibleName){return {...reflectApply(performanceNatives.toJSON,entry,[]),name:visibleName}}
  function inertFacadeTarget(value){return objectCreate(objectGetPrototypeOf(value))}
  function performanceEntryFacade(entry,visibleName){let facade=performanceEntryFacades.get(entry);if(facade)return facade;const toJSON=()=>visiblePerformanceJSON(entry,visibleName);facade=new NativeProxy(inertFacadeTarget(entry),{get(_target,key){if(key==="name")return visibleName;if(key==="entryType")return nativePerformanceEntryType(entry);if(key==="toJSON")return toJSON;const value=capturedValue(entry,key,performanceEntryDescriptorSets);return typeof value==="function"?bindFunction(value,entry):value},set(){return false},defineProperty(){return false},deleteProperty(){return false}});performanceEntryFacades.set(entry,facade);return facade}
  function virtualPerformanceEntry(entry){const visibleName=visiblePerformanceName(entry);if(visibleName===null)return null;return visibleName?performanceEntryFacade(entry,visibleName):entry}
  function virtualPerformanceEntries(entries){return reflectApply(arrayFilter,arrayFrom(entries,virtualPerformanceEntry),[NativeBoolean])}
  function virtualPerformanceEntriesByName(entries,name,type){const visible=[];for(const entry of entries){const visibleName=visiblePerformanceName(entry),entryName=visibleName??nativePerformanceEntryName(entry);if(visibleName!==null&&entryName===name&&(type===undefined||nativePerformanceEntryType(entry)===type))reflectApply(arrayPush,visible,[visibleName?performanceEntryFacade(entry,visibleName):entry])}return visible}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
