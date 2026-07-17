export const runtimeSections = [
  { file: import.meta.url, name: "metadata_section_11", order: 11, phase: "inner" },
  { file: import.meta.url, name: "metadata_section_13", order: 13, phase: "inner" },
  { file: import.meta.url, name: "metadata_section_19", order: 19, phase: "inner" },
  { file: import.meta.url, name: "metadata_section_28", order: 28, phase: "inner" },
  { file: import.meta.url, name: "metadata_section_31", order: 31, phase: "inner" },
  { file: import.meta.url, name: "metadata_section_32", order: 32, phase: "inner" },
];

export function metadata_section_11() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const nodeMetadata=new PrivateWeakMap(),attributeOwners=new PrivateWeakMap(),nodeListOwners=new PrivateWeakMap(),performanceEntryFacades=new PrivateWeakMap(),resourceURLMappings=new PrivateMap(),attributeValueHistory=new PrivateWeakMap(),mutationObserverRegistrations=new PrivateWeakMap(),observerAttributeMutationQueues=new PrivateWeakMap(),activeMutationObserverRefs=new PrivateSet(),observerReferences=new PrivateWeakMap(),observerFinalizer=new NativeFinalizationRegistry(reference=>activeMutationObserverRefs.delete(reference));
  const parserValidatedMetadataKey=objectFreeze({}),metadataCountedKey=objectFreeze({}),baseRouteMetadataKey=objectFreeze({}),scriptSourceMetadataKey=objectFreeze({}),styleSourceMetadataKey=objectFreeze({}),styleValidatedMetadataKey=objectFreeze({}),detachedScriptTextKey=objectFreeze({}),trustedExecutableKey=objectFreeze({}),activatedScriptKey=objectFreeze({}),scriptLedgerKey=objectFreeze({});
  let metadataElementCount=0,fallbackBase=parsedInitialTarget.href;
  function createNodeMetadataRecord(visibleAttributes=new PrivateMap()){
    const record=objectCreate(null);
    record.visible_attributes=visibleAttributes;
    record.internal_route_values=new PrivateMap();
    record.source_kind=null;
    record.script_state=null;
    record.original_nonce=null;
    record.original_integrity=null;
    record.target_srcdoc=null;
    record.policy_revision=runtimePolicyContext.policy_version;
    record.generation=0;
    record.abort_controller=null;
    return record;
  }
  function ensureNodeMetadata(node){
    let record=nodeMetadata.get(node);
    if(!record){record=createNodeMetadataRecord();nodeMetadata.set(node,record)}
    return record;
  }
  function nodeInternalValueMap(key){
    const adapter=objectFreeze({
      get(node){return nodeMetadata.get(node)?.internal_route_values.get(key)},
      set(node,value){ensureNodeMetadata(node).internal_route_values.set(key,value);return adapter},
      has(node){return nodeMetadata.get(node)?.internal_route_values.has(key)===true},
      delete(node){return nodeMetadata.get(node)?.internal_route_values.delete(key)===true},
    });
    return adapter;
  }
  const elementMetadata=objectFreeze({
    get(node){return nodeMetadata.get(node)?.visible_attributes},
    set(node,value){ensureNodeMetadata(node).visible_attributes=value;return elementMetadata},
    has(node){return nodeMetadata.has(node)},
    delete(node){const record=nodeMetadata.get(node);if(!record)return false;record.visible_attributes=new PrivateMap();return true},
  });
  const baseMetadata=nodeInternalValueMap(baseRouteMetadataKey),scriptSourceMetadata=nodeInternalValueMap(scriptSourceMetadataKey),styleSourceMetadata=nodeInternalValueMap(styleSourceMetadataKey),detachedScriptText=nodeInternalValueMap(detachedScriptTextKey);
  function scriptLedgerRecord(node,context="dynamic"){
    const record=ensureNodeMetadata(node);
    let ledger=record.internal_route_values.get(scriptLedgerKey);
    if(!ledger){
      ledger=objectCreate(null);
      ledger.context=context;
      ledger.parser_inserted=context==="parser";
      ledger.already_started=false;
      ledger.listeners_installed=false;
      ledger.route_pending=false;
      ledger.activation_id=null;
      record.internal_route_values.set(scriptLedgerKey,ledger);
    }
    return ledger;
  }
  function validScriptState(state){switch(state){case"INERT":case"PREPARED":case"FETCHING":case"COMPILING_INLINE":case"COMPILED":case"ACTIVATING":case"EXECUTED":case"BLOCKED":case"FAILED":case"REMOVED":case"CANCELED":return true;default:return false}}
  function setNodeScriptState(node,state,sourceKind,context){
    if(!validScriptState(state))throw new NativeDOMException("Invalid script activation state","SecurityError");
    const record=ensureNodeMetadata(node),ledger=scriptLedgerRecord(node,context);
    record.script_state=state;
    if(sourceKind!==undefined)record.source_kind=sourceKind;
    if(state==="FETCHING"||state==="ACTIVATING"||state==="EXECUTED")ledger.already_started=true;
    return record;
  }
  const metadataElements=objectFreeze({
    has(node){return nodeMetadata.get(node)?.internal_route_values.has(metadataCountedKey)===true},
    add(node){ensureNodeMetadata(node).internal_route_values.set(metadataCountedKey,true);return metadataElements},
    delete(node){return nodeMetadata.get(node)?.internal_route_values.delete(metadataCountedKey)===true},
  });
  const trustedExecutableNodes=objectFreeze({
    has(node){return nodeMetadata.get(node)?.internal_route_values.get(trustedExecutableKey)===true},
    add(node){if(!isMarkupScriptElement(node))return trustedExecutableNodes;const record=ensureNodeMetadata(node);record.internal_route_values.set(trustedExecutableKey,true);scriptLedgerRecord(node);if(record.script_state===null)setNodeScriptState(node,"PREPARED");return trustedExecutableNodes},
    delete(node){return nodeMetadata.get(node)?.internal_route_values.delete(trustedExecutableKey)===true},
  });
  const activatedScripts=objectFreeze({
    has(node){return nodeMetadata.get(node)?.internal_route_values.get(scriptLedgerKey)?.already_started===true},
    add(node){const record=ensureNodeMetadata(node),ledger=scriptLedgerRecord(node);record.internal_route_values.set(activatedScriptKey,true);ledger.already_started=true;if(record.script_state!=="EXECUTED")setNodeScriptState(node,"ACTIVATING");return activatedScripts},
    delete(node){const record=nodeMetadata.get(node),ledger=record?.internal_route_values.get(scriptLedgerKey);if(!record||!ledger)return false;const removed=record.internal_route_values.delete(activatedScriptKey);ledger.already_started=false;if(removed&&record.script_state!=="INERT")record.script_state=trustedExecutableNodes.has(node)?"PREPARED":null;return removed},
  });
  const inertScripts=objectFreeze({
    has(node){return nodeMetadata.get(node)?.script_state==="INERT"},
    add(node){const ledger=scriptLedgerRecord(node,"markup");setNodeScriptState(node,"INERT",undefined,"markup");ledger.already_started=true;return inertScripts},
    delete(node){const record=nodeMetadata.get(node);if(record?.script_state!=="INERT")return false;record.script_state=null;const ledger=record.internal_route_values.get(scriptLedgerKey);if(ledger)ledger.already_started=false;return true},
  });
  function nullableMetadataString(value){return value===null||typeof value==="string"}
  function nodeMetadataShape(record){return record!==undefined&&reflectOwnKeys(record).length===10&&record.visible_attributes instanceof PrivateMap&&record.internal_route_values instanceof PrivateMap&&nullableMetadataString(record.source_kind)&&nullableMetadataString(record.script_state)&&nullableMetadataString(record.original_nonce)&&nullableMetadataString(record.original_integrity)&&nullableMetadataString(record.target_srcdoc)&&numberIsInteger(record.policy_revision)&&record.policy_revision===runtimePolicyContext.policy_version&&numberIsInteger(record.generation)&&record.generation>=0&&(record.abort_controller===null||record.abort_controller instanceof NativeAbortController)}
  function isInternalMetadataAttribute(name){return name==="data-zp-m-v2"||name==="data-zp-style-v2"}
  function decodeStaticMetadataText(encoded,label){
    if(typeof encoded!=="string"||encoded.length>2<<20||!reflectApply(regexpTest,/^[A-Za-z0-9_-]*$/,[encoded]))throw new NativeDOMException(`${label} rejected`,"SecurityError");
    let padded=reflectApply(stringReplaceAll,reflectApply(stringReplaceAll,encoded,["-","+"]),["_","/"]);const padding=(4-encoded.length%4)%4;for(let index=0;index<padding;index+=1)padded+="=";
    try{
      const binary=reflectApply(nativeAtob,globalThis,[padded]),bytes=reflectApply(uint8ArrayFrom,NativeUint8Array,[binary,character=>reflectApply(nativeStringCharCodeAt,character,[0])]),source=decodedText(new NativeTextDecoder("utf-8",{fatal:true}),bytes);
      if(encodedText(source).byteLength>1<<20)throw new NativeError("oversized");
      return source;
    }catch{throw new NativeDOMException(`${label} rejected`,"SecurityError")}
  }
  function encodeStaticMetadataText(value){
    const bytes=encodedText(NativeString(value));if(bytes.byteLength>1<<20)throw new NativeDOMException("Static metadata rejected","SecurityError");
    let binary="";for(let index=0;index<bytes.length;index+=1)binary+=reflectApply(nativeStringFromCharCode,NativeString,[bytes[index]]);
    return reflectApply(stringReplaceAll,reflectApply(stringReplaceAll,reflectApply(stringReplaceAll,reflectApply(nativeBtoa,globalThis,[binary]),["+","-"]),["/","_"]),["=",""]);
  }
  const safeBaseURL=()=>urlProperty(new NativeURL("/_zp/vbase/runtime/",rawWindow.location.origin),"href");
  function visibleBase(){const nodes=nativeNodeListArray(reflectApply(selectorNatives.documentQuerySelectorAll,document,["base[href]"]));for(let index=0;index<nodes.length;index+=1){const value=baseMetadata.get(nodes[index]);if(value)return value}return fallbackBase}
  function validStaticURLMap(value){return value===undefined||!!value&&!arrayIsArray(value)&&typeof value==="object"&&!reflectApply(arraySome,objectEntries(value),[entry=>typeof entry[0]!=="string"||typeof entry[1]!=="string"])}
  function parseStaticMetadata(encoded){let parsed;try{parsed=jsonParse(decodeStaticMetadataText(encoded,"Static metadata"))}catch{throw new NativeDOMException("Invalid static metadata","SecurityError")}if(!parsed||arrayIsArray(parsed)||typeof parsed!=="object")throw new NativeDOMException("Invalid static metadata","SecurityError");const metadata=new PrivateMap;for(const [name,record] of objectEntries(parsed)){const normalized=lower(name),cssURLs=record?.css_urls,resourceURLs=record?.resource_urls;if(name!==normalized||metadata.has(normalized)||!record||arrayIsArray(record)||typeof record!=="object"||!(typeof record.attribute==="string"||record.attribute===null)||!(typeof record.url==="string"||record.url===null)||record.attribute===null&&normalized!=="nonce"||record.order!==undefined&&(!numberIsInteger(record.order)||record.order<0)||!validStaticURLMap(cssURLs)||!validStaticURLMap(resourceURLs))throw new NativeDOMException("Invalid static metadata","SecurityError");metadata.set(normalized,record)}return metadata}
  function validateStyleMetadata(element){
    const encoded=reflectApply(attributeNatives.getAttribute,element,["data-zp-style-v2"]);
    if(encoded===null)return;
    if(!isMarkupStyleElement(element))throw new NativeDOMException("Invalid style metadata","SecurityError");
    const record=ensureNodeMetadata(element);
    if(record.internal_route_values.has(styleValidatedMetadataKey))return styleSourceMetadata.get(element);
    const source=decodeStaticMetadataText(encoded,"Style metadata");
    styleSourceMetadata.set(element,source);
    record.internal_route_values.set(styleValidatedMetadataKey,true);
    return source;
  }
  function hydrateStyleMetadata(element){
    const marker=reflectApply(attributeNatives.getAttribute,element,["data-zp-style-v2"]);
    if(marker===null)return styleSourceMetadata.get(element);
    const source=validateStyleMetadata(element),record=ensureNodeMetadata(element);
    indexCSSProjectionValue(reflectApply(natives.textContent.get,element,[]));
    record.internal_route_values.delete(styleValidatedMetadataKey);
    reflectApply(attributeNatives.removeAttribute,element,["data-zp-style-v2"]);
    return source;
  }
  function validateMetadata(element){
    const encoded=reflectApply(attributeNatives.getAttribute,element,["data-zp-m-v2"]);
    if(encoded===null)return;
    const existing=nodeMetadata.get(element);
    if(existing?.internal_route_values.has(parserValidatedMetadataKey))return existing.visible_attributes;
    const metadata=parseStaticMetadata(encoded),record=existing??createNodeMetadataRecord(metadata);
    record.visible_attributes=metadata;
    record.original_nonce=metadata.get("nonce")?.attribute??null;
    record.original_integrity=metadata.get("integrity")?.attribute??null;
    record.target_srcdoc=metadata.get("srcdoc")?.attribute??null;
    record.internal_route_values.set(parserValidatedMetadataKey,true);
    nodeMetadata.set(element,record);
    return metadata;
  }
  function rememberAttributeView(element,name){const normalized=attributeLookupName(element,name),raw=reflectApply(attributeNatives.getAttribute,element,[normalized]),record=elementMetadata.get(element)?.get(normalized);if(!record||record.attribute===raw)return;let attributes=attributeValueHistory.get(element);if(!attributes){attributes=new PrivateMap;attributeValueHistory.set(element,attributes)}let values=attributes.get(normalized);if(!values){values=new PrivateMap;attributes.set(normalized,values)}values.set(raw,record.attribute)}
  function recordResourceMapping(internal,target){if(typeof target!=="string"||internal===null)return;try{const url=new NativeURL(internal,`${syntheticDocumentOrigin}/`),href=urlProperty(url,"href");resourceURLMappings.set(href,target);const hash=urlProperty(url,"hash");if(reflectApply(stringStartsWith,hash,["#zp-css-v2="])){reflectApply(urlNatives.hash.set,url,[""]);resourceURLMappings.set(urlProperty(url,"href"),target)}}catch{}}
  function indexResourceMap(mapping){if(mapping&&typeof mapping==="object")for(const [internal,target] of objectEntries(mapping))recordResourceMapping(internal,target)}
  function indexResourceMapMetadata(record){indexResourceMap(record.css_urls);indexResourceMap(record.resource_urls)}
  function indexResourceMetadata(element,record){for(const [name,view] of record.visible_attributes){const internal=reflectApply(attributeNatives.getAttribute,element,[name]);rememberAttributeView(element,name);record.internal_route_values.set(name,internal);recordResourceMapping(internal,view.url);indexResourceMapMetadata(view)}}
  function trackMetadataElement(element,metadata){if(!metadata.size||metadataElements.has(element))return;metadataElements.add(element);metadataElementCount+=1}
  function installElementMetadata(element,record){if(!nodeMetadataShape(record))throw new NativeDOMException("Invalid node metadata","SecurityError");indexResourceMetadata(element,record);record.internal_route_values.delete(parserValidatedMetadataKey);trackMetadataElement(element,record.visible_attributes);if(isHTMLScriptElement(element))initializeParserScriptLedger(element);reflectApply(attributeNatives.removeAttribute,element,["data-zp-m-v2"])}
  function hydrateMetadata(element){
    let record=nodeMetadata.get(element);
    const marker=reflectApply(attributeNatives.getAttribute,element,["data-zp-m-v2"]);
    if(!record&&marker!==null){validateMetadata(element);record=nodeMetadata.get(element)}
    if(!record)return;
    if(marker!==null)installElementMetadata(element,record);
    else trackMetadataElement(element,record.visible_attributes);
    return record.visible_attributes;
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function metadata_section_13() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function htmlAttributeCaseInsensitive(element){if(nativeNamespaceURI(element)!=="http://www.w3.org/1999/xhtml")return false;const owner=nativeOwnerDocument(element);return owner!==null&&reflectApply(documentNatives.contentType.get,owner,[])==="text/html"}
  function attributeLookupName(element,name){const converted=NativeString(name);return htmlAttributeCaseInsensitive(element)?lower(converted):converted}
  function visibleAttributeRecord(element,name){return hydrateMetadata(element)?.get(attributeLookupName(element,name))}
  function visibleAttributeValue(element,name,fallback){const record=visibleAttributeRecord(element,name);return record?record.attribute??"":fallback()}
  function visibleAttribute(element,name,field="attribute"){return visibleAttributeRecord(element,name)?.[field]}
  function reflectedAttributeValue(element,name,descriptor){const record=visibleAttributeRecord(element,name);return record&&typeof record.idl==="string"?record.idl:record?record.attribute??"":reflectApply(descriptor.get, element, [])}
  const syntheticAttributeOwners=new PrivateWeakMap(),syntheticAttributes=new PrivateWeakMap(),attributeMapFacades=new PrivateWeakMap();
  function attributeOwner(attribute){return syntheticAttributeOwners.get(attribute)?.element??reflectApply(attributeNodeNatives.ownerElement.get,attribute,[])}
  function syntheticAttribute(element,name,record){
    let attributes=syntheticAttributes.get(element);
    if(!attributes){attributes=new PrivateMap;syntheticAttributes.set(element,attributes)}
    let attribute=attributes.get(name);
    if(!attribute){
      const owner=nativeOwnerDocument(element)??document;
      attribute=reflectApply(stringStartsWith,name,["xlink:"])?reflectApply(markupNatives.createAttributeNS,owner,["http://www.w3.org/1999/xlink",name]):reflectApply(markupNatives.createAttribute,owner,[name]);
      attributes.set(name,attribute);
      syntheticAttributeOwners.set(attribute,{element,name});
    }
    reflectApply(natives.attrValue.set,attribute,[record.attribute??""]);
    return attribute;
  }
  function visibleAttributeNode(element,name){const normalized=attributeLookupName(element,name),record=visibleAttributeRecord(element,normalized);if(record)return record.attribute===null?null:syntheticAttribute(element,normalized,record);return reflectApply(attributeNodeNatives.getAttributeNode,element,[name])}
  function visibleAttributeNodes(element){
    const metadata=hydrateMetadata(element),nativeMap=reflectApply(natives.attributes.get,element,[]),entries=[],seen=new PrivateSet;
    let sequence=0,nativeLength=reflectApply(attributeNodeNatives.length.get,nativeMap,[]);
    for(let index=0;index<nativeLength;index+=1){
      const nativeAttribute=reflectApply(attributeNodeNatives.item,nativeMap,[index]);
      if(!nativeAttribute)continue;
      const nativeName=nativeAttrName(nativeAttribute),normalized=attributeLookupName(element,nativeName);
      if(isInternalMetadataAttribute(normalized))continue;
      const record=metadata?.get(normalized);
      if(record){
        seen.add(normalized);
        if(record.attribute===null)continue;
        reflectApply(arrayPush,entries,[{node:syntheticAttribute(element,normalized,record),order:numberIsInteger(record.order)?record.order:index,sequence:sequence++}]);
      }else reflectApply(arrayPush,entries,[{node:nativeAttribute,order:index,sequence:sequence++}]);
    }
    if(metadata)for(const entry of metadata){const name=entry[0],record=entry[1];if(!seen.has(name)&&record.attribute!==null)reflectApply(arrayPush,entries,[{node:syntheticAttribute(element,name,record),order:numberIsInteger(record.order)?record.order:nativeLength+sequence,sequence:sequence++}])}
    reflectApply(arraySort,entries,[(left,right)=>left.order-right.order||left.sequence-right.sequence]);
    return reflectApply(arrayMap,entries,[entry=>entry.node]);
  }
  function prototypeDefines(prototype,key){for(let current=prototype;current;current=objectGetPrototypeOf(current))if(reflectGetOwnPropertyDescriptor(current,key))return true;return false}
  function collectionOwnKeys(target,nodes,named){
    const keys=[],seen=new PrivateSet;
    for(let index=0;index<nodes.length;index+=1){const key=NativeString(index);seen.add(key);reflectApply(arrayPush,keys,[key])}
    if(named)for(let index=0;index<nodes.length;index+=1){const key=nativeAttrName(nodes[index]);if(!seen.has(key)){seen.add(key);reflectApply(arrayPush,keys,[key])}}
    const ownKeys=reflectOwnKeys(target);for(let index=0;index<ownKeys.length;index+=1){const key=ownKeys[index];if(!seen.has(key)){seen.add(key);reflectApply(arrayPush,keys,[key])}}
    return keys;
  }
  function collectionItemDescriptor(value,enumerable){return{value,writable:false,enumerable,configurable:true}}
  function attributeMapValue(element,target,facade,key){
    const nodes=visibleAttributeNodes(element);
    if(key==="length")return nodes.length;
    if(prototypeDefines(NamedNodeMap.prototype,key))return reflectGet(target,key,facade);
    if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key))return nodes[NativeNumber(key)];
    if(typeof key==="string"){const attribute=visibleAttributeNode(element,key);if(attribute)return attribute}
    return reflectGet(target,key,facade);
  }
  function attributeMapHas(element,target,key){
    if(key==="length"||prototypeDefines(NamedNodeMap.prototype,key))return true;
    const nodes=visibleAttributeNodes(element);
    if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key))return NativeNumber(key)<nodes.length;
    return typeof key==="string"&&visibleAttributeNode(element,key)!==null||reflectGetOwnPropertyDescriptor(target,key)!==undefined;
  }
  function attributeMapDescriptor(element,target,key){
    const own=reflectGetOwnPropertyDescriptor(target,key);
    if(own)return own;
    const nodes=visibleAttributeNodes(element);
    if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key)){const value=nodes[NativeNumber(key)];return value===undefined?undefined:collectionItemDescriptor(value,true)}
    if(typeof key!=="string"||prototypeDefines(NamedNodeMap.prototype,key))return;
    const value=visibleAttributeNode(element,key);
    return value===null?undefined:collectionItemDescriptor(value,false);
  }
  function attributeMapFacade(element){
    let facade=attributeMapFacades.get(element);
    if(facade)return facade;
    const target=objectCreate(NamedNodeMap.prototype);
    facade=new NativeProxy(target,{
      get(_target,key){return attributeMapValue(element,target,facade,key)},
      has(_target,key){return attributeMapHas(element,target,key)},
      ownKeys(){return collectionOwnKeys(target,visibleAttributeNodes(element),true)},
      getOwnPropertyDescriptor(_target,key){return attributeMapDescriptor(element,target,key)},
      preventExtensions(){return false},
    });
    attributeMapFacades.set(element,facade);
    attributeOwners.set(facade,element);
    return facade;
  }
  function clearVisibleAttribute(element,name){const normalized=attributeLookupName(element,name);if(isHTMLScriptElement(element))cancelDynamicScriptRoute(element);cancelNodeMetadataOperation(element,normalized);if(isHTMLBaseElement(element)&&normalized==="href")baseMetadata.delete(element);const nodeRecord=nodeMetadata.get(element);nodeRecord?.internal_route_values.delete(normalized);rememberAttributeView(element,normalized);const attributes=syntheticAttributes.get(element),attribute=attributes?.get(normalized),metadata=hydrateMetadata(element);if(attribute){syntheticAttributeOwners.delete(attribute);attributes.delete(normalized)}metadata?.delete(normalized);if(normalized==="nonce"&&nodeRecord)nodeRecord.original_nonce=null;if(normalized==="integrity"&&nodeRecord)nodeRecord.original_integrity=null;if(normalized==="srcdoc"&&nodeRecord)nodeRecord.target_srcdoc=null;if(metadata?.size===0&&metadataElements.delete(element))metadataElementCount-=1}
  function isInertSVGType(element,name,namespace){return inertScripts.has(element)&&nativeNamespaceURI(element)==="http://www.w3.org/2000/svg"&&nativeLocalName(element)==="script"&&(namespace===undefined||namespace===null||namespace==="")&&NativeString(name)==="type"}
  function setInertSVGVisibleType(element,value){let metadata=elementMetadata.get(element);if(!metadata){metadata=new PrivateMap;elementMetadata.set(element,metadata)}const visible=value===null?null:NativeString(value),attributes=syntheticAttributes.get(element),attribute=attributes?.get("type"),existing=metadata.get("type");if(visible===null&&attribute){syntheticAttributeOwners.delete(attribute);attributes.delete("type")}else if(attribute)reflectApply(natives.attrValue.set,attribute,[visible]);metadata.set("type",{attribute:visible,url:null,order:numberIsInteger(existing?.order)?existing.order:visibleAttributeNodes(element).length});if(!metadataElements.has(element)){metadataElements.add(element);metadataElementCount+=1}reflectApply(natives.setAttribute,element,["type","application/x-zeroproxy-inert"])}
  function setInertSVGTypeAttribute(element,attribute){const state=syntheticAttributeOwners.get(attribute),nativeOwner=reflectApply(attributeNodeNatives.ownerElement.get,attribute,[]);if(state&&state.element!==element||nativeOwner&&nativeOwner!==element)throw new NativeDOMException("The attribute is in use","InUseAttributeError");const previous=visibleAttributeNode(element,"type"),value=reflectApply(natives.attrValue.get,attribute,[]);setInertSVGVisibleType(element,value);let attributes=syntheticAttributes.get(element);if(!attributes){attributes=new PrivateMap;syntheticAttributes.set(element,attributes)}const replaced=attributes.get("type");if(replaced&&replaced!==attribute)syntheticAttributeOwners.delete(replaced);attributes.set("type",attribute);syntheticAttributeOwners.set(attribute,{element,name:"type"});return previous}
  function setSyntheticAttributeValue(attribute,value,nativeDescriptor){const state=syntheticAttributeOwners.get(attribute);if(!state)return false;reflectApply(elementPrototype.setAttribute,state.element,[state.name,value]);reflectApply(nativeDescriptor.set, attribute, [NativeString(value)]);return true}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function metadata_section_19() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function observerOptionsView(options,captured){
    if(!options||(typeof options!=="object"&&typeof options!=="function"))return options;
    return new NativeProxy(options,{get(value,key,receiver){
      const result=reflectGet(value,key,value);
      if(key!=="attributeFilter"||result==null){captured.set(key,result);return result}
      const converted=[];captured.set(key,converted);
      return{*[Symbol.iterator](){
        for(const item of result){
          if(typeof item==="string"){reflectApply(arrayPush, converted, [item]);yield item;continue}
          let complete=false,text;
          yield{[Symbol.toPrimitive](){if(!complete){text=`${item}`;reflectApply(arrayPush, converted, [text]);complete=true}return text}};
        }
      }};
    }});
  }
  function ensureActiveMutationObserver(observer){if(observerReferences.has(observer))return;for(const reference of activeMutationObserverRefs)if(!reference.deref())activeMutationObserverRefs.delete(reference);const reference=new NativeWeakRef(observer);observerReferences.set(observer,reference);activeMutationObserverRefs.add(reference);observerFinalizer.register(observer,reference,reference)}
  function deactivateMutationObserver(observer){const reference=observerReferences.get(observer);if(!reference)return;observerReferences.delete(observer);activeMutationObserverRefs.delete(reference);observerFinalizer.unregister(reference)}
  function observerContains(target,node,subtree){if(target===node)return true;if(!subtree)return false;for(let current=node?nativeParentNode(node):null;current;current=nativeParentNode(current))if(current===target)return true;return false}
  function observesAttribute(options,name){return options.attributes&&(!options.attributeFilter||includesValue(options.attributeFilter,name))}
  function observerSeesAttribute(observer,element,name){const registrations=mutationObserverRegistrations.get(observer);if(!registrations)return false;for(const entry of registrations)if(observerContains(entry[0],element,entry[1].subtree)&&observesAttribute(entry[1],name))return true;return false}
  function observerAttributeQueue(observer,element,name,create){let elements=observerAttributeMutationQueues.get(observer);if(!elements&&create){elements=new PrivateWeakMap;observerAttributeMutationQueues.set(observer,elements)}let attributes=elements?.get(element);if(!attributes&&create){attributes=new PrivateMap;elements.set(element,attributes)}let queue=attributes?.get(name);if(!queue&&create){queue=[];attributes.set(name,queue)}return queue}
  function queueNonceMutation(script,hidden){for(const reference of activeMutationObserverRefs){const observer=reference.deref();if(!observer){activeMutationObserverRefs.delete(reference);continue}if(observerSeesAttribute(observer,script,"nonce"))reflectApply(arrayPush, observerAttributeQueue(observer,script,"nonce",true), [hidden])}}
  function queueInternalNonceLifecycle(script){
    // Chromium reports the CSP nonce write and its insertion-time hiding/removal separately.
    queueNonceMutation(script,true);
    queueNonceMutation(script,true);
  }
  function queueVisibleNonceMutation(element,name,willSet){if(isHTMLScriptElement(element)&&lower(NativeString(name))==="nonce"&&(willSet||reflectApply(attributeNatives.hasAttribute,element,["nonce"])))queueNonceMutation(element,false)}
  const mutationRecordKeys=new PrivateSet(["target","type","attributeName","oldValue","addedNodes","removedNodes"]);
  function visibleMutationRecords(records,observer){const visible=[];for(const record of records){const type=nativeMutationValue(record,"type"),target=nativeMutationValue(record,"target"),name=nativeMutationValue(record,"attributeName");if(type==="attributes"&&isHTMLScriptElement(target)&&name==="nonce"){const queue=observerAttributeQueue(observer,target,"nonce",false),hidden=queue?.length?reflectApply(arrayShift, queue, []):elementMetadata.get(target)?.has("nonce");if(hidden)continue}reflectApply(arrayPush, visible, [visibleMutationRecord(record,observer)])}observerAttributeMutationQueues.set(observer,new PrivateWeakMap);return visible}
  function registrationRequestsOldValue(options,record){const type=nativeMutationValue(record,"type");if(type==="attributes")return observesAttribute(options,nativeMutationValue(record,"attributeName"))&&options.attributeOldValue;if(type==="characterData")return options.characterData&&options.characterDataOldValue;return false}
  function observerRequestsOldValue(observer,record){const registrations=mutationObserverRegistrations.get(observer);if(!registrations)return false;const target=nativeMutationValue(record,"target");for(const entry of registrations)if(observerContains(entry[0],target,entry[1].subtree)&&registrationRequestsOldValue(entry[1],record))return true;return false}
  function visibleAttributeOldValue(record,_observer){const oldValue=nativeMutationValue(record,"oldValue");if(oldValue===null)return null;const name=nativeMutationValue(record,"attributeName"),normalized=name===null?undefined:lower(name),target=nativeMutationValue(record,"target"),values=attributeValueHistory.get(target)?.get(normalized);if(values?.has(oldValue))return values.get(oldValue);if(typeof oldValue==="string")try{return resourceURLMappings.get(urlProperty(new NativeURL(oldValue,rawWindow.location.href),"href"))??oldValue}catch{}return oldValue}
  function visibleScriptMutationNodes(record,key){const target=nativeMutationValue(record,"target"),source=scriptSourceMetadata.get(target),nodes=nativeMutationValue(record,key),array=nativeNodeListArray(nodes);for(let index=0;index<array.length;index+=1){const node=array[index];if(isCharacterDataNode(node)&&!detachedScriptText.has(node))detachedScriptText.set(node,source)}return nodes}
  function visibleMutationProperty(record,key,observer){const target=nativeMutationValue(record,"target"),type=nativeMutationValue(record,"type");if((key==="addedNodes"||key==="removedNodes")&&isHTMLScriptElement(target)&&scriptSourceMetadata.has(target))return visibleScriptMutationNodes(record,key);if(key==="oldValue"&&type==="attributes"&&isElementNode(target))return visibleAttributeOldValue(record,observer);return mutationRecordKeys.has(key)?nativeMutationValue(record,key):reflectGet(record,key,record)}
  function visibleMutationRecord(record,observer){return new NativeProxy(record,{get(target,key){return visibleMutationProperty(target,key,observer)}})}
  function MutationObserverFacade(callback){if(!new.target)throw new NativeTypeError("Failed to construct 'MutationObserver': Please use the 'new' operator");if(typeof callback!=="function")throw new NativeTypeError("MutationObserver callback must be a function");let observer;observer=new mutationNatives.MutationObserver(records=>reflectApply(callback,observer,[visibleMutationRecords(records,observer),observer]));mutationObserverRegistrations.set(observer,new PrivateMap);observerAttributeMutationQueues.set(observer,new PrivateWeakMap);return observer}
  MutationObserverFacade.prototype=mutationNatives.MutationObserver.prototype;objectSetPrototypeOf(MutationObserverFacade,mutationNatives.MutationObserver);
  mirrorFunction(MutationObserverFacade,mutationNatives.MutationObserver);
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function metadata_section_28() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function stageDocumentTruthSurfaces(){
  if(documentNatives.URL?.configurable)stage(Document.prototype,"URL",{...documentNatives.URL,get(){reflectApply(documentNatives.URL.get,this,[]);return parsedInitialTarget.href},configurable:false});
  if(documentNatives.documentURI?.configurable)stage(Document.prototype,"documentURI",{...documentNatives.documentURI,get(){reflectApply(documentNatives.documentURI.get,this,[]);return parsedInitialTarget.href},configurable:false});
  if(documentNatives.referrer?.configurable)stage(Document.prototype,"referrer",{...documentNatives.referrer,get(){reflectApply(documentNatives.referrer.get,this,[]);return runtimePolicyContext.referrer_url??""},configurable:false});
  if(documentNatives.domain?.configurable)stage(Document.prototype,"domain",{...documentNatives.domain,get(){reflectApply(documentNatives.domain.get,this,[]);return parsedInitialTarget.hostname},set(value){reflectApply(documentNatives.domain.get,this,[]);if(lower(reflectApply(stringTrim,NativeString(value),[]))===parsedInitialTarget.hostname)return;throw new NativeDOMException("Setting document.domain is blocked","SecurityError")},configurable:false});
  if(!documentNatives.cookie?.get||!documentNatives.cookie?.set||!documentNatives.cookie.configurable)throw new Error("cookie descriptor unavailable");
  stage(Document.prototype,"cookie",{...documentNatives.cookie,get(){return cookieString()},set(value){setDocumentCookie(value)},configurable:false});
  }
  stageDocumentTruthSurfaces();
  function stageObservationSurfaces(){
  stage(History.prototype,"pushState",{value:function(state,title,url){if(arguments.length<2)return reflectApply(navigationNatives.pushState,this,arrayFrom(arguments));return updateHistoryEntry(this,state,title,url,arguments.length>2,false)},writable:false,enumerable:true,configurable:false});
  stage(History.prototype,"replaceState",{value:function(state,title,url){if(arguments.length<2)return reflectApply(navigationNatives.replaceState,this,arrayFrom(arguments));return updateHistoryEntry(this,state,title,url,arguments.length>2,true)},writable:false,enumerable:true,configurable:false});
  stage(Performance.prototype,"getEntries",{value:function(){return virtualPerformanceEntries(reflectApply(performanceNatives.getEntries,this,[]))},writable:false,enumerable:true,configurable:false});
  stage(Performance.prototype,"getEntriesByType",{value:function(type){return virtualPerformanceEntries(reflectApply(performanceNatives.getEntriesByType,this,[type]))},writable:false,enumerable:true,configurable:false});
  stage(Performance.prototype,"getEntriesByName",{value:function(name,type){const visibleName=NativeString(name),visibleType=type===undefined?undefined:NativeString(type);return virtualPerformanceEntriesByName(reflectApply(performanceNatives.getEntries,this,[]),visibleName,visibleType)},writable:false,enumerable:true,configurable:false});
  stage(PerformanceObserverEntryList.prototype,"getEntries",{value:function(){return virtualPerformanceEntries(reflectApply(performanceNatives.observerGetEntries,this,[]))},writable:false,enumerable:true,configurable:false});
  stage(PerformanceObserverEntryList.prototype,"getEntriesByType",{value:function(type){return virtualPerformanceEntries(reflectApply(performanceNatives.observerGetEntriesByType,this,[type]))},writable:false,enumerable:true,configurable:false});
  stage(PerformanceObserverEntryList.prototype,"getEntriesByName",{value:function(name,type){const visibleName=NativeString(name),visibleType=type===undefined?undefined:NativeString(type);return virtualPerformanceEntriesByName(reflectApply(performanceNatives.observerGetEntries,this,[]),visibleName,visibleType)},writable:false,enumerable:true,configurable:false});
  stage(MutationObserver.prototype,"observe",{value:function(target,options){const captured=new PrivateMap,result=reflectApply(mutationNatives.observe,this,[target,observerOptionsView(options,captured)]),registrations=mutationObserverRegistrations.get(this);if(registrations){const attributeFilter=captured.get("attributeFilter"),attributeOldValue=NativeBoolean(captured.get("attributeOldValue")),characterDataOldValue=NativeBoolean(captured.get("characterDataOldValue"));(registrations.set(target, {subtree:NativeBoolean(captured.get("subtree")),attributes:captured.get("attributes")===undefined?attributeOldValue||attributeFilter!==undefined:NativeBoolean(captured.get("attributes")),characterData:captured.get("characterData")===undefined?characterDataOldValue:NativeBoolean(captured.get("characterData")),attributeOldValue,characterDataOldValue,attributeFilter}), ensureActiveMutationObserver(this))}return result},writable:false,enumerable:true,configurable:false});
  stage(MutationObserver.prototype,"disconnect",{value:function(){mutationObserverRegistrations.get(this)?.clear();observerAttributeMutationQueues.set(this,new PrivateWeakMap);deactivateMutationObserver(this);return reflectApply(mutationNatives.disconnect,this,[])},writable:false,enumerable:true,configurable:false});
  stage(MutationObserver.prototype,"takeRecords",{value:function(){return visibleMutationRecords(reflectApply(mutationNatives.takeRecords,this,[]),this)},writable:false,enumerable:true,configurable:false});
  stage(History.prototype,"back",{value:blockedHistoryBack,writable:false,enumerable:true,configurable:false});
  stage(History.prototype,"forward",{value:blockedHistoryForward,writable:false,enumerable:true,configurable:false});
  stage(History.prototype,"go",{value:blockedHistoryGo,writable:false,enumerable:true,configurable:false});
  }
  stageObservationSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function metadata_section_31() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function attributeNamespace(value){return value==null?null:NativeString(value)}
  function isHTMLAttributeNamespace(value){return value===null||value===""}
  function isMediatedAttributeNamespace(value){return isHTMLAttributeNamespace(value)||value==="http://www.w3.org/1999/xlink"}
  function metadataAttributeName(element,namespace,name){const normalized=isHTMLAttributeNamespace(namespace)?attributeLookupName(element,name):NativeString(name);return namespace==="http://www.w3.org/1999/xlink"&&!reflectApply(stringStartsWith,normalized,["xlink:"])?`xlink:${normalized}`:normalized}
  function toggleRemovesAttribute(force,present){return force===false||force===undefined&&present}
  function addToggledAttribute(element,name,normalized){if(isHTMLBaseElement(element)&&normalized==="href"){setVirtualBase(element,"");return true}element.setAttribute(name,"");return true}
  function setNamespacedAttribute(element,namespace,name,value){
    const convertedNamespace=attributeNamespace(namespace),convertedName=NativeString(name),convertedValue=NativeString(value),normalized=metadataAttributeName(element,convertedNamespace,convertedName);
    if(isInternalMetadataAttribute(lower(convertedName))||isInternalMetadataAttribute(lower(normalized)))throw new NativeDOMException("Internal metadata is reserved","SecurityError");
    if(isInertSVGType(element,convertedName,convertedNamespace)){setInertSVGVisibleType(element,convertedValue);return}
    if(isHTMLBaseElement(element)&&isHTMLAttributeNamespace(convertedNamespace)&&normalized==="href"){setVirtualBase(element,convertedValue);return}
    if(isMediatedAttributeNamespace(convertedNamespace)){
      if(isHTMLAttributeNamespace(convertedNamespace))queueVisibleNonceMutation(element,normalized,true);
      if(setControlledDynamicAttribute(element,normalized,convertedValue,internal=>reflectApply(natives.setAttributeNS,element,[convertedNamespace,convertedName,internal])))return;
      if(!inertActivationAttribute(element,normalized))enforceDynamicAttribute(element,normalized,convertedValue);
      clearVisibleAttribute(element,normalized);
    }
    return reflectApply(natives.setAttributeNS,element,[convertedNamespace,convertedName,convertedValue]);
  }
  function stageAttributeSurfaces(){
  stage(Element.prototype,"getAttribute",{value:function(name){const converted=NativeString(name),normalized=attributeLookupName(this,converted);if(isInternalMetadataAttribute(normalized))return null;const visible=visibleAttribute(this,normalized);return visible===undefined?reflectApply(attributeNatives.getAttribute,this,[converted]):visible},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"getAttributeNS",{value:function(namespace,name){const convertedNamespace=attributeNamespace(namespace),convertedName=NativeString(name),normalized=metadataAttributeName(this,convertedNamespace,convertedName);if(isInternalMetadataAttribute(normalized))return null;const visible=isMediatedAttributeNamespace(convertedNamespace)?visibleAttribute(this,normalized):undefined;return visible===undefined?reflectApply(attributeNatives.getAttributeNS,this,[convertedNamespace,convertedName]):visible},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"hasAttribute",{value:function(name){const converted=NativeString(name),normalized=attributeLookupName(this,converted);if(isInternalMetadataAttribute(normalized))return false;const record=visibleAttributeRecord(this,normalized);return record?record.attribute!==null:reflectApply(attributeNatives.hasAttribute,this,[converted])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"hasAttributeNS",{value:function(namespace,name){const convertedNamespace=attributeNamespace(namespace),convertedName=NativeString(name);if(isMediatedAttributeNamespace(convertedNamespace)){const normalized=metadataAttributeName(this,convertedNamespace,convertedName);if(isInternalMetadataAttribute(normalized))return false;const record=visibleAttributeRecord(this,normalized);return record?record.attribute!==null:reflectApply(attributeNatives.hasAttributeNS,this,[convertedNamespace,convertedName])}return reflectApply(attributeNatives.hasAttributeNS,this,[convertedNamespace,convertedName])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"getAttributeNames",{value:function(){return reflectApply(arrayMap, visibleAttributeNodes(this), [attribute=>nativeAttrName(attribute)])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"removeAttribute",{value:function(name){const converted=NativeString(name),normalized=attributeLookupName(this,converted);sealedFormActionRemoval(this,normalized);if(isInertSVGType(this,converted)){setInertSVGVisibleType(this,null);return}queueVisibleNonceMutation(this,normalized,false);clearVisibleAttribute(this,normalized);return reflectApply(attributeNatives.removeAttribute,this,[converted])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"removeAttributeNS",{value:function(namespace,name){const convertedNamespace=attributeNamespace(namespace),convertedName=NativeString(name),normalized=metadataAttributeName(this,convertedNamespace,convertedName);if(isHTMLAttributeNamespace(convertedNamespace))sealedFormActionRemoval(this,normalized);if(isInertSVGType(this,convertedName,convertedNamespace)){setInertSVGVisibleType(this,null);return}if(isMediatedAttributeNamespace(convertedNamespace)){if(isHTMLAttributeNamespace(convertedNamespace))queueVisibleNonceMutation(this,normalized,false);clearVisibleAttribute(this,normalized)}return reflectApply(attributeNatives.removeAttributeNS,this,[convertedNamespace,convertedName])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"setAttribute",{value:function(name,value){
    const convertedName=NativeString(name),convertedValue=NativeString(value),normalized=attributeLookupName(this,convertedName);
    if(isInertSVGType(this,convertedName)){setInertSVGVisibleType(this,convertedValue);return}
    if(isHTMLBaseElement(this)&&normalized==="href"){setVirtualBase(this,convertedValue);return}
    queueVisibleNonceMutation(this,normalized,true);
    if(setControlledDynamicAttribute(this,normalized,convertedValue,internal=>reflectApply(natives.setAttribute,this,[convertedName,internal])))return;
    if(!inertActivationAttribute(this,normalized))enforceDynamicAttribute(this,normalized,convertedValue);clearVisibleAttribute(this,normalized);
    return reflectApply(natives.setAttribute,this,[convertedName,convertedValue]);
  },writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"setAttributeNS",{value:function(namespace,name,value){
    return setNamespacedAttribute(this,namespace,name,value);
  },writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"getAttributeNode",{value:function(name){return visibleAttributeNode(this,NativeString(name))},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"getAttributeNodeNS",{value:function(namespace,name){const convertedNamespace=attributeNamespace(namespace),convertedName=NativeString(name),normalized=metadataAttributeName(this,convertedNamespace,convertedName);if(isInternalMetadataAttribute(lower(normalized)))return null;return isMediatedAttributeNamespace(convertedNamespace)?visibleAttributeNode(this,normalized):reflectApply(attributeNodeNatives.getAttributeNodeNS,this,[convertedNamespace,convertedName])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"removeAttributeNode",{value:function(attribute){const state=syntheticAttributeOwners.get(attribute);if(state?.element!==this){if(state)throw new NativeDOMException("Attribute not found","NotFoundError");const owner=reflectApply(attributeNodeNatives.ownerElement.get,attribute,[]),name=nativeAttrName(attribute);if(owner===this){sealedFormActionRemoval(this,attributeLookupName(this,name));if(isHTMLBaseElement(this)&&lower(name)==="href")baseMetadata.delete(this);cancelNodeMetadataOperation(this,attributeLookupName(this,name))}return reflectApply(attributeNatives.removeAttributeNode,this,[attribute])}sealedFormActionRemoval(this,state.name);if(isInertSVGType(this,state.name)){setInertSVGVisibleType(this,null);return attribute}clearVisibleAttribute(this,state.name);reflectApply(attributeNatives.removeAttribute,this,[state.name]);return attribute},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"attributes",{...natives.attributes,get(){return attributeMapFacade(this)},configurable:false});
  function attrDescriptorValue(attribute,descriptor){const owner=attributeOwner(attribute),name=nativeAttrName(attribute);if(isHTMLBaseElement(owner)&&lower(name)==="href")return baseMetadata.get(owner)??fallbackBase;return owner?visibleAttributeValue(owner,name,()=>reflectApply(descriptor.get,attribute,[])):reflectApply(descriptor.get,attribute,[])}
  function setOwnedAttrDescriptorValue(owner,attribute,name,converted,descriptor){
    if(isHTMLBaseElement(owner)&&lower(name)==="href"){setVirtualBase(owner,converted);return true}
    queueVisibleNonceMutation(owner,name,true);
    if(setControlledDynamicAttribute(owner,name,converted,internal=>reflectApply(descriptor.set,attribute,[internal])))return true;
    enforceDynamicAttribute(owner,name,converted);
    clearVisibleAttribute(owner,name);
    return false;
  }
  function setAttrDescriptorValue(attribute,value,descriptor){
    const converted=descriptor===natives.attrValue||value!==null?NativeString(value):"";
    if(setSyntheticAttributeValue(attribute,converted,descriptor))return;
    const owner=attributeOwner(attribute),name=nativeAttrName(attribute);
    if(owner&&setOwnedAttrDescriptorValue(owner,attribute,name,converted,descriptor))return;
    reflectApply(descriptor.set,attribute,[converted]);
  }
  if(!attributeNodeNatives.ownerElement?.get||!attributeNodeNatives.ownerElement.configurable)throw new Error("Attr owner descriptor unavailable");
  stage(Attr.prototype,"ownerElement",{...attributeNodeNatives.ownerElement,get(){return syntheticAttributeOwners.get(this)?.element??reflectApply(attributeNodeNatives.ownerElement.get, this, [])},configurable:false});
  stage(Attr.prototype,"value",{...natives.attrValue,get(){return attrDescriptorValue(this,natives.attrValue)},set(value){setAttrDescriptorValue(this,value,natives.attrValue)},configurable:false});
  stage(Attr.prototype,"nodeValue",{get(){return attrDescriptorValue(this,natives.nodeValue)},set(value){setAttrDescriptorValue(this,value,natives.nodeValue)},enumerable:natives.nodeValue.enumerable,configurable:false});
  stage(Attr.prototype,"textContent",{get(){return attrDescriptorValue(this,natives.textContent)},set(value){setAttrDescriptorValue(this,value,natives.textContent)},enumerable:natives.textContent.enumerable,configurable:false});
  stage(Element.prototype,"setAttributeNode",{value:function(attribute){if(!(isAttrNode(attribute)))return reflectApply(natives.setAttributeNode,this,[attribute]);const name=nativeAttrName(attribute);if(isInertSVGType(this,name,nativeAttrNamespaceURI(attribute)))return setInertSVGTypeAttribute(this,attribute);const previous=visibleAttributeNode(this,name);if(isHTMLBaseElement(this)&&lower(name)==="href"){sanitizeBaseAttribute(this,attribute);queueVisibleNonceMutation(this,name,true);reflectApply(natives.setAttributeNode,this,[attribute]);return previous}enforceDynamicAttribute(this,name,reflectApply(natives.attrValue.get,attribute,[]));queueVisibleNonceMutation(this,name,true);clearVisibleAttribute(this,name);reflectApply(natives.setAttributeNode,this,[attribute]);return previous},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"setAttributeNodeNS",{value:function(attribute){if(!(isAttrNode(attribute)))return reflectApply(natives.setAttributeNodeNS,this,[attribute]);const name=nativeAttrName(attribute);if(isInertSVGType(this,name,nativeAttrNamespaceURI(attribute)))return setInertSVGTypeAttribute(this,attribute);const previous=visibleAttributeNode(this,name);if(isHTMLBaseElement(this)&&lower(name)==="href"){sanitizeBaseAttribute(this,attribute);queueVisibleNonceMutation(this,name,true);reflectApply(natives.setAttributeNodeNS,this,[attribute]);return previous}enforceDynamicAttribute(this,name,reflectApply(natives.attrValue.get,attribute,[]));queueVisibleNonceMutation(this,name,true);clearVisibleAttribute(this,name);reflectApply(natives.setAttributeNodeNS,this,[attribute]);return previous},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"toggleAttribute",{value:function(name,force){const convertedName=NativeString(name),normalized=attributeLookupName(this,convertedName),convertedForce=force===undefined?undefined:NativeBoolean(force),present=this.hasAttribute(convertedName);if(toggleRemovesAttribute(convertedForce,present)){if(present)this.removeAttribute(convertedName);return false}if(present)return true;return addToggledAttribute(this,convertedName,normalized)},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"length",{...attributeNodeNatives.length,get(){const owner=attributeOwners.get(this);return owner?visibleAttributeNodes(owner).length:reflectApply(attributeNodeNatives.length.get,this,[])},configurable:false});
  stage(NamedNodeMap.prototype,"item",{value:function(index){const owner=attributeOwners.get(this);return owner?visibleAttributeNodes(owner)[NativeNumber(index)]??null:reflectApply(attributeNodeNatives.item,this,[index])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"getNamedItem",{value:function(name){const owner=attributeOwners.get(this);return owner?visibleAttributeNode(owner,name):reflectApply(attributeNodeNatives.getNamedItem,this,[name])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"getNamedItemNS",{value:function(namespace,name){const owner=attributeOwners.get(this);return owner?owner.getAttributeNodeNS(namespace,name):reflectApply(attributeNodeNatives.getNamedItemNS,this,[namespace,name])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"setNamedItem",{value:function(attribute){const owner=attributeOwners.get(this);return owner?owner.setAttributeNode(attribute):reflectApply(natives.setNamedItem,this,[attribute])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"setNamedItemNS",{value:function(attribute){const owner=attributeOwners.get(this);return owner?owner.setAttributeNodeNS(attribute):reflectApply(natives.setNamedItemNS,this,[attribute])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"removeNamedItem",{value:function(name){const owner=attributeOwners.get(this);if(!owner)return reflectApply(attributeNodeNatives.removeNamedItem,this,[name]);const attribute=visibleAttributeNode(owner,name);if(!attribute)throw new NativeDOMException("Attribute not found","NotFoundError");owner.removeAttribute(name);return attribute},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"removeNamedItemNS",{value:function(namespace,name){const owner=attributeOwners.get(this);if(!owner)return reflectApply(attributeNodeNatives.removeNamedItemNS,this,[namespace,name]);const attribute=owner.getAttributeNodeNS(namespace,name);if(!attribute)throw new NativeDOMException("Attribute not found","NotFoundError");owner.removeAttributeNS(namespace,name);return attribute},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,Symbol.iterator,{value:function*(){const owner=attributeOwners.get(this);if(owner){yield* visibleAttributeNodes(owner);return}yield* reflectApply(attributeNodeNatives.iterator,this,[])},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"values",{value:function*(){yield* this},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"keys",{value:function*(){let index=0;for(const _attribute of this)yield index++},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"entries",{value:function*(){let index=0;for(const attribute of this)yield [index++,attribute]},writable:false,enumerable:false,configurable:false});
  stage(NamedNodeMap.prototype,"forEach",{value:function(callback,thisArg){let index=0;for(const attribute of this)reflectApply(callback,thisArg,[attribute,index++,this])},writable:false,enumerable:false,configurable:false});
  }
  stageAttributeSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function metadata_section_32() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function nativeNodeListArray(list){const nodes=[];for(let index=0;index<reflectApply(selectorNatives.nodeListLength.get,list,[]);index+=1)reflectApply(arrayPush,nodes,[reflectApply(selectorNatives.nodeListItem,list,[index])]);return nodes}
  function nativeDescendants(root){if(isDocumentNode(root))return nativeNodeListArray(reflectApply(selectorNatives.documentQuerySelectorAll,root,["*"]));if(isDocumentFragmentNode(root))return nativeNodeListArray(reflectApply(selectorNatives.fragmentQuerySelectorAll,root,["*"]));if(isElementNode(root))return nativeNodeListArray(reflectApply(selectorNatives.elementQuerySelectorAll,root,["*"]));return[]}
  function serializationDocumentFor(root){const rootDocument=isDocumentNode(root)?root:nativeOwnerDocument(root);if(rootDocument&&reflectApply(documentNatives.contentType.get,rootDocument,[])!=="text/html")return rootDocument;const template=reflectApply(markupNatives.createElement,document,["template"]);return nativeOwnerDocument(reflectApply(markupNatives.templateContent.get,template,[]))}
  function applyVisibleAttributes(original,copy){
    const nativeMap=reflectApply(natives.attributes.get,copy,[]);
    for(let index=reflectApply(attributeNodeNatives.length.get,nativeMap,[])-1;index>=0;index-=1){const attribute=reflectApply(attributeNodeNatives.item,nativeMap,[index]);if(attribute)reflectApply(attributeNatives.removeAttributeNode,copy,[attribute])}
    const attributes=visibleAttributeNodes(original);
    for(let index=0;index<attributes.length;index+=1){
      const attribute=attributes[index],namespace=nativeAttrNamespaceURI(attribute),name=nativeAttrName(attribute),value=reflectApply(natives.attrValue.get,attribute,[]);
      if(namespace===null)reflectApply(natives.setAttribute,copy,[name,value]);else reflectApply(natives.setAttributeNS,copy,[namespace,name,value]);
    }
  }
  function applyVisibleSerializationMetadata(original,copy){
    if(!(isElementNode(original))||!(isElementNode(copy)))return;
    applyVisibleAttributes(original,copy);
    if(isHTMLBaseElement(original)&&baseMetadata.has(original))reflectApply(natives.setAttribute,copy,["href",baseMetadata.get(original)]);
    if(isHTMLScriptElement(original)&&isHTMLScriptElement(copy)&&scriptSourceMetadata.has(original))reflectApply(natives.textContent.set,copy,[scriptSourceMetadata.get(original)]);
    if(isMarkupStyleElement(original)&&isMarkupStyleElement(copy)&&styleSourceMetadata.has(original))reflectApply(natives.textContent.set,copy,[styleSourceMetadata.get(original)]);
  }
  function visibleShadowClone(root){
    const template=reflectApply(markupNatives.createElement,document,["template"]),fragment=reflectApply(markupNatives.templateContent.get,template,[]),children=metadataChildren(root);
    for(let index=0;index<children.length;index+=1)reflectApply(insertionNatives.appendChild,fragment,[reflectApply(selectorNatives.importNode,nativeOwnerDocument(fragment),[children[index],true])]);
    return fragment;
  }
  function visibleSerializationClone(root){
    const originals=arrayWithFirst(root,nativeDescendants(root));
    for(let index=0;index<originals.length;index+=1)if(isElementNode(originals[index])){hydrateMetadata(originals[index]);hydrateStyleMetadata(originals[index])}
    const clone=isShadowRootNode(root)?visibleShadowClone(root):reflectApply(selectorNatives.importNode,serializationDocumentFor(root),[root,true]),copies=arrayWithFirst(clone,nativeDescendants(clone));
    for(let index=0;index<originals.length&&index<copies.length;index+=1)applyVisibleSerializationMetadata(originals[index],copies[index]);
    return clone;
  }
  function nodeListValue(nodes,target,facade,key){if(key==="length")return nodes.length;if(prototypeDefines(NodeList.prototype,key))return reflectGet(target,key,facade);if(typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key))return nodes[NativeNumber(key)];return reflectGet(target,key,facade)}
  function nodeListHas(nodes,target,key){if(key==="length"||prototypeDefines(NodeList.prototype,key))return true;return typeof key==="string"&&/^(?:0|[1-9]\d*)$/u.test(key)&&NativeNumber(key)<nodes.length||reflectGetOwnPropertyDescriptor(target,key)!==undefined}
  function nodeListDescriptor(nodes,target,key){const own=reflectGetOwnPropertyDescriptor(target,key);if(own)return own;if(typeof key!=="string"||!reflectApply(regexpTest,/^(?:0|[1-9]\d*)$/u,[key]))return;const value=nodes[NativeNumber(key)];return value===undefined?undefined:collectionItemDescriptor(value,true)}
  function nodeListFacade(nodes){
    const target=objectCreate(NodeList.prototype);
    let facade;
    facade=new NativeProxy(target,{
      get(_target,key){return nodeListValue(nodes,target,facade,key)},
      has(_target,key){return nodeListHas(nodes,target,key)},
      ownKeys(){return collectionOwnKeys(target,nodes,false)},
      getOwnPropertyDescriptor(_target,key){return nodeListDescriptor(nodes,target,key)},
      preventExtensions(){return false},
    });
    nodeListOwners.set(facade,nodes);
    return facade;
  }
  function listNodes(value){return nodeListOwners.get(value)??nativeNodeListArray(value)}
  function selectorTree(root){const treeRoot=isDocumentNode(root)?root.documentElement:root,originals=arrayWithFirst(treeRoot,nativeDescendants(treeRoot)),clone=visibleSerializationClone(treeRoot),copies=arrayWithFirst(clone,nativeDescendants(clone)),copyToOriginal=new PrivateMap;for(let index=0;index<copies.length&&index<originals.length;index+=1)copyToOriginal.set(copies[index],originals[index]);return{treeRoot,originals,clone,copies,copyToOriginal}}
  function selectorNeedsFacade(selector){return metadataElementCount>0&&includesValue(NativeString(selector),"[")}
  function selectorNative(root,all){if(isDocumentNode(root))return all?selectorNatives.documentQuerySelectorAll:selectorNatives.documentQuerySelector;if(isDocumentFragmentNode(root))return all?selectorNatives.fragmentQuerySelectorAll:selectorNatives.fragmentQuerySelector;return all?selectorNatives.elementQuerySelectorAll:selectorNatives.elementQuerySelector}
  function selectorQueryRoot(root,tree){if(!(isDocumentNode(root)))return tree.clone;const fragment=reflectApply(markupNatives.templateContent.get,reflectApply(markupNatives.createElement,document,["template"]),[]);reflectApply(insertionNatives.appendChild,fragment,[tree.clone]);return fragment}
  function mapSelectorResult(tree,matched,all){if(!all)return matched?tree.copyToOriginal.get(matched)??null:null;const mapped=reflectApply(arrayMap,nativeNodeListArray(matched),[node=>tree.copyToOriginal.get(node)]);return nodeListFacade(reflectApply(arrayFilter,mapped,[NativeBoolean]))}
  function queryVisible(root,selector,all){const source=NativeString(selector),native=selectorNative(root,all),nativeResult=reflectApply(native,root,[source]);if(!selectorNeedsFacade(source))return nativeResult;const tree=selectorTree(root),queryRoot=selectorQueryRoot(root,tree),matched=reflectApply(selectorNative(queryRoot,all),queryRoot,[source]);return mapSelectorResult(tree,matched,all)}
  function selectorCopyFor(element){const root=nativeRootNode(element);let tree;if(isDocumentNode(root)||isDocumentFragmentNode(root))tree=selectorTree(root);else{let top=element,parent;while((parent=nativeParentElement(top)))top=parent;tree=selectorTree(top)}const index=reflectApply(arrayIndexOf,tree.originals,[element]);return index<0?null:{tree,copy:tree.copies[index]}}
  function stageSelectorSurfaces(){
  stage(Document.prototype,"querySelector",{value:function(selector){return queryVisible(this,selector,false)},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"querySelectorAll",{value:function(selector){return queryVisible(this,selector,true)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"querySelector",{value:function(selector){return queryVisible(this,selector,false)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"querySelectorAll",{value:function(selector){return queryVisible(this,selector,true)},writable:false,enumerable:false,configurable:false});
  stage(DocumentFragment.prototype,"querySelector",{value:function(selector){return queryVisible(this,selector,false)},writable:false,enumerable:false,configurable:false});
  stage(DocumentFragment.prototype,"querySelectorAll",{value:function(selector){return queryVisible(this,selector,true)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"matches",{value:function(selector){const source=NativeString(selector),nativeResult=reflectApply(selectorNatives.matches,this,[source]);if(!selectorNeedsFacade(source))return nativeResult;const mapped=selectorCopyFor(this);return mapped?reflectApply(selectorNatives.matches,mapped.copy,[source]):false},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"closest",{value:function(selector){const source=NativeString(selector),nativeResult=reflectApply(selectorNatives.closest,this,[source]);if(!selectorNeedsFacade(source))return nativeResult;const mapped=selectorCopyFor(this),match=mapped&&reflectApply(selectorNatives.closest,mapped.copy,[source]);return match?mapped.tree.copyToOriginal.get(match)??null:null},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,"length",{...selectorNatives.nodeListLength,get(){const nodes=nodeListOwners.get(this);return nodes?nodes.length:reflectApply(selectorNatives.nodeListLength.get,this,[])},configurable:false});
  stage(NodeList.prototype,"item",{value:function(index){return listNodes(this)[NativeNumber(index)]??null},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,Symbol.iterator,{value:function(){return indexedValues(listNodes(this))},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,"values",{value:function(){return indexedValues(listNodes(this))},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,"keys",{value:function(){return indexedKeys(listNodes(this))},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,"entries",{value:function(){return indexedEntries(listNodes(this))},writable:false,enumerable:false,configurable:false});
  }
  stageSelectorSurfaces();
  function cloneElementMetadata(metadata){const cloned=new PrivateMap;for(const entry of metadata)cloned.set(entry[0],{...entry[1]});return cloned}
  function cloneScriptLedger(source){
    const clone=objectCreate(null);
    clone.context="clone";
    clone.parser_inserted=false;
    clone.already_started=source.already_started;
    clone.listeners_installed=false;
    clone.route_pending=false;
    clone.activation_id=null;
    return clone;
  }
  function cloneNodeMetadataRecord(source){
    const clone=createNodeMetadataRecord(cloneElementMetadata(source.visible_attributes));
    for(const entry of source.internal_route_values){const key=entry[0];if(key===metadataCountedKey||key===parserValidatedMetadataKey||key===styleValidatedMetadataKey)continue;clone.internal_route_values.set(key,key===scriptLedgerKey?cloneScriptLedger(entry[1]):entry[1])}
    clone.source_kind=source.source_kind;
    clone.script_state=source.script_state;
    clone.original_nonce=source.original_nonce;
    clone.original_integrity=source.original_integrity;
    clone.target_srcdoc=source.target_srcdoc;
    clone.policy_revision=source.policy_revision;
    return clone;
  }
  function propagateMetadataPair(source,target){
    if(isElementNode(source)){hydrateMetadata(source);hydrateStyleMetadata(source)}
    const sourceRecord=nodeMetadata.get(source);
    if(!sourceRecord)return;
    const targetRecord=cloneNodeMetadataRecord(sourceRecord);
    nodeMetadata.set(target,targetRecord);
    trackMetadataElement(target,targetRecord.visible_attributes);
  }
  function metadataChildren(node){return nativeNodeListArray(reflectApply(markupNatives.childNodes.get,node,[]))}
  function appendPairedMetadataBoundaries(pairs,source,target){
    if(!(isElementNode(source))||!(isElementNode(target)))return;
    if(isHTMLTemplateElement(source)&&isHTMLTemplateElement(target))pairs[pairs.length]=[reflectApply(markupNatives.templateContent.get,source,[]),reflectApply(markupNatives.templateContent.get,target,[])];
    const sourceShadow=reflectApply(markupNatives.shadowRoot.get,source,[]),targetShadow=reflectApply(markupNatives.shadowRoot.get,target,[]);
    if(sourceShadow&&targetShadow)pairs[pairs.length]=[sourceShadow,targetShadow];
  }
  function propagationPairs(original,copy,deep){
    const pairs=[[original,copy]];
    if(!deep)return pairs;
    for(let pairIndex=0;pairIndex<pairs.length;pairIndex+=1){
      const source=pairs[pairIndex][0],target=pairs[pairIndex][1],sourceChildren=metadataChildren(source),targetChildren=metadataChildren(target),length=sourceChildren.length<targetChildren.length?sourceChildren.length:targetChildren.length;
      appendPairedMetadataBoundaries(pairs,source,target);
      for(let index=0;index<length;index+=1)pairs[pairs.length]=[sourceChildren[index],targetChildren[index]];
    }
    return pairs;
  }
  function propagateNodeMetadata(original,copy,deep){const pairs=propagationPairs(original,copy,deep);for(let index=0;index<pairs.length;index+=1)propagateMetadataPair(pairs[index][0],pairs[index][1]);return copy}
  function appendNodeMetadataBoundaries(nodes,node){
    if(!isElementNode(node))return;
    if(isHTMLTemplateElement(node))nodes[nodes.length]=reflectApply(markupNatives.templateContent.get,node,[]);
    const shadow=reflectApply(markupNatives.shadowRoot.get,node,[]);
    if(shadow)nodes[nodes.length]=shadow;
  }
  function nodeMetadataTree(node){
    const nodes=[node];
    for(let index=0;index<nodes.length;index+=1){
      const current=nodes[index],children=metadataChildren(current);
      appendNodeMetadataBoundaries(nodes,current);
      for(let childIndex=0;childIndex<children.length;childIndex+=1)nodes[nodes.length]=children[childIndex];
    }
    return nodes;
  }
  function revokeNodeMetadataTree(node){
    const nodes=nodeMetadataTree(node);
    for(let index=0;index<nodes.length;index+=1){
      revokeAllNodeRoutes(nodes[index]);
      const record=nodeMetadata.get(nodes[index]);
      if(!record)continue;
      const ledger=record.internal_route_values.get(scriptLedgerKey),operationPending=record.abort_controller!==null;
      if(operationPending)abortController(record.abort_controller);
      record.abort_controller=null;
      record.generation+=1;
      if(ledger&&operationPending)ledger.route_pending=false;
      const keys=arrayFrom(record.internal_route_values.keys());
      if(!ledger?.already_started)for(let keyIndex=0;keyIndex<keys.length;keyIndex+=1)if(typeof keys[keyIndex]==="string")record.internal_route_values.delete(keys[keyIndex]);
      if(ledger&&record.script_state!=="INERT"&&!(record.script_state==="FETCHING"&&!operationPending))record.script_state="REMOVED";
    }
  }
  function propagateInertScripts(_original,copy,_deep){return copy}
  function adoptionCrossesRealm(node){const owner=isDocumentNode(node)?node:nativeOwnerDocument(node);try{const view=reflectApply(documentNatives.defaultView.get,owner,[]);return view!==null&&view!==rawWindow}catch{return true}}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
