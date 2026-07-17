export const runtimeSections = [
  { file: import.meta.url, name: "dom_section_15", order: 15, phase: "inner" },
  { file: import.meta.url, name: "dom_section_17", order: 17, phase: "inner" },
  { file: import.meta.url, name: "dom_section_26", order: 26, phase: "inner" },
  { file: import.meta.url, name: "dom_section_33", order: 33, phase: "inner" },
];

export function dom_section_15() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function policyInventoryNamespace(element){switch(nativeNamespaceURI(element)){case"http://www.w3.org/1999/xhtml":return"html";case"http://www.w3.org/2000/svg":return"svg";case"http://www.w3.org/1998/Math/MathML":return"mathml";default:return null}}
  function attributeKind(element,name){try{const namespace=policyInventoryNamespace(element);if(namespace===null)return null;const localName=nativeLocalName(element),rel=localName==="link"?reflectApply(attributeNatives.getAttribute,element,["rel"]):undefined,httpEquiv=localName==="meta"?reflectApply(attributeNatives.getAttribute,element,["http-equiv"]):undefined,type=localName==="script"?reflectApply(attributeNatives.getAttribute,element,["type"]):undefined;return jsonParse(wasm_bindgen.policy_attribute_kind_json(namespace,localName,lower(NativeString(name)),rel,httpEquiv,type))}catch{throw new NativeDOMException("Attribute policy unavailable","SecurityError")}}
  function policyDecision(element,name,value,kind=attributeKind(element,name),effectiveBase=visibleBase()){if(!kind)return null;try{return jsonParse(wasm_bindgen.policy_decide_json(jsonStringify({...runtimePolicyContext,effective_base_url:effectiveBase}),jsonStringify({source_boundary:"dynamic-dom",element_namespace:nativeNamespaceURI(element),element_name:nativeLocalName(element),attribute_name:lower(NativeString(name)),resource_kind:kind,raw_value:NativeString(value),parser_inserted:nodeMetadata.get(element)?.internal_route_values.get(scriptLedgerKey)?.parser_inserted===true,integrity:reflectApply(attributeNatives.getAttribute,element,["integrity"]),nonce:reflectApply(attributeNatives.getAttribute,element,["nonce"])})))}catch{throw new NativeDOMException("Dynamic URL blocked","SecurityError")}}
  function isMetaRefreshPair(element,name,value){if(!(isHTMLMetaElement(element)))return false;const httpEquiv=name==="http-equiv"?NativeString(value):reflectApply(attributeNatives.getAttribute,element,["http-equiv"]),content=name==="content"?NativeString(value):reflectApply(attributeNatives.getAttribute,element,["content"]);return content!==null&&lower(reflectApply(stringTrim,httpEquiv??"",[]))==="refresh"}
  function inertActivationAttribute(element,name){return((isHTMLElementNamed(element,"a")||isHTMLElementNamed(element,"area"))&&(name==="href"||name==="ping"))||(isHTMLElementNamed(element,"form")&&name==="action")||((isHTMLElementNamed(element,"button")||isHTMLElementNamed(element,"input"))&&name==="formaction")}
  function enforceDynamicAttribute(element,name,value){const normalized=lower(NativeString(name));if(isInternalMetadataAttribute(normalized))throw new NativeDOMException("Internal metadata is reserved","SecurityError");if(normalized==="srcdoc"&&NativeString(value)==="")return;if(normalized==="style"||reflectApply(stringStartsWith,normalized,["on"])||isMetaRefreshPair(element,normalized,value))throw new NativeDOMException("Dynamic executable attribute is blocked","SecurityError");const decision=policyDecision(element,normalized,value);if(decision===null||decision==="Pass")return;throw new NativeDOMException("Dynamic URL requires an unavailable controlled route","SecurityError")}
  const virtualToSyntheticOrigins=new PrivateMap,syntheticToVirtualOrigins=new PrivateMap,crossWindowFacades=new PrivateWeakMap,containedWindowFacades=new PrivateWeakMap,containedDocuments=new PrivateWeakMap,upgradedContainedWindows=new PrivateWeakMap,rawWindowByFacade=new PrivateWeakMap;
  virtualToSyntheticOrigins.set(parsedInitialTarget.origin,rawWindow.location.origin);
  syntheticToVirtualOrigins.set(rawWindow.location.origin,parsedInitialTarget.origin);
  function recordMappedOrigin(targetURL,result){
    if(!result||typeof result.synthetic_origin!=="string"||typeof result.virtual_origin!=="string")return;
    const virtualOrigin=urlProperty(new NativeURL(targetURL),"origin"),synthetic=urlProperty(new NativeURL(result.synthetic_origin),"origin");
    if(result.virtual_origin!==virtualOrigin)throw new NativeDOMException("Origin mapping mismatch","SecurityError");
    const host=urlProperty(new NativeURL(synthetic),"hostname");
    if(synthetic!==rawWindow.location.origin&&!/^o-[a-z2-7]{32}\.browse\./.test(host))throw new NativeDOMException("Origin mapping rejected","SecurityError");
    virtualToSyntheticOrigins.set(virtualOrigin,synthetic);
    syntheticToVirtualOrigins.set(synthetic,virtualOrigin);
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dom_section_17() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const nodeRouteAllocationIDs=new PrivateWeakMap;
  function allocatedRouteIDs(element){let routes=nodeRouteAllocationIDs.get(element);if(!routes){routes=new PrivateMap;nodeRouteAllocationIDs.set(element,routes)}return routes}
  function revokeAllocatedResourceRoute(routeID){void runtimeCommand("REVOKE_RESOURCE_ROUTE",{route_id:routeID},"Resource route revocation unavailable").catch(()=>{})}
  function revokeNodeRoute(element,name){const routes=nodeRouteAllocationIDs.get(element),routeID=routes?.get(name);if(routeID===undefined)return;routes.delete(name);if(routes.size===0)nodeRouteAllocationIDs.delete(element);revokeAllocatedResourceRoute(routeID)}
  function revokeAllNodeRoutes(element){const routes=nodeRouteAllocationIDs.get(element);if(!routes)return;nodeRouteAllocationIDs.delete(element);for(const routeID of routes.values())revokeAllocatedResourceRoute(routeID)}
  function beginNodeMetadataOperation(element,name){
    const record=ensureNodeMetadata(element);
    revokeNodeRoute(element,name);
    if(record.abort_controller!==null)abortController(record.abort_controller);
    record.generation+=1;
    record.abort_controller=new NativeAbortController();
    return record.generation;
  }
  function cancelNodeMetadataOperation(element,name){
    const record=nodeMetadata.get(element);
    if(name===undefined)revokeAllNodeRoutes(element);else revokeNodeRoute(element,name);
    if(!record)return;
    if(record.abort_controller!==null)abortController(record.abort_controller);
    record.abort_controller=null;
    record.generation+=1;
  }
  function currentNodeMetadataGeneration(element,generation){
    const record=nodeMetadata.get(element);
    return record?.generation===generation&&record.abort_controller!==null&&!signalAborted(controllerSignal(record.abort_controller));
  }
  function controlledRouteDecision(decision){
    if(decision?.Navigate&&typeof decision.Navigate.canonical_target==="string")return{target:decision.Navigate.canonical_target,kind:"Document"};
    if(decision?.Script&&typeof decision.Script.canonical_target==="string")return{target:decision.Script.canonical_target,kind:decision.Script.module?"Module":"Script"};
    if(decision?.Fetch&&typeof decision.Fetch.canonical_target==="string"&&typeof decision.Fetch.route_kind==="string")return{target:decision.Fetch.canonical_target,kind:decision.Fetch.route_kind};
    return null;
  }
  function setDynamicAttributeMetadata(element,name,visible,target){
    let metadata=hydrateMetadata(element);
    if(!metadata){metadata=new PrivateMap;elementMetadata.set(element,metadata)}
    const existing=metadata.get(name),order=numberIsInteger(existing?.order)?existing.order:visibleAttributeNodes(element).length;
    metadata.set(name,{attribute:visible,idl:target,url:target,order});
    const nodeRecord=ensureNodeMetadata(element);nodeRecord.internal_route_values.set(name,target);if(name==="nonce")nodeRecord.original_nonce=visible;if(name==="integrity")nodeRecord.original_integrity=visible;if(name==="srcdoc")nodeRecord.target_srcdoc=visible;
    trackMetadataElement(element,metadata);
  }
  function rejectControlledDynamicAttribute(element,normalized,visible){
    if(isInternalMetadataAttribute(normalized))throw new NativeDOMException("Internal metadata is reserved","SecurityError");
    if(normalized==="style"||reflectApply(stringStartsWith,normalized,["on"])||isMetaRefreshPair(element,normalized,visible))throw new NativeDOMException("Dynamic executable attribute is blocked","SecurityError");
  }
  function isDeferredNavigationAttribute(element,normalized){return((isHTMLElementNamed(element,"a")||isHTMLElementNamed(element,"area"))&&normalized==="href")||(isHTMLElementNamed(element,"form")&&normalized==="action")||((isHTMLElementNamed(element,"button")||isHTMLElementNamed(element,"input"))&&normalized==="formaction")}
  function isInertControlledAttribute(element,normalized){return isDeferredNavigationAttribute(element,normalized)||((isHTMLElementNamed(element,"a")||isHTMLElementNamed(element,"area"))&&normalized==="ping")}
  function deferredNavigationTarget(visible){try{return urlProperty(new NativeURL(visible,visibleBase()),"href")}catch{return visible}}
  function deferredNavigationPlan(element,normalized,visible){
    const fallbackTarget=deferredNavigationTarget(visible);
    try{
      if(normalized==="href"){const navigation=sealedNavigationRoute(visible);return{route:navigation.route,target:navigation.target}}
      const target=formActionTarget(visible),route=sealedOpaqueRoute("form",target);
      if(route!==null)return{route,target};
    }catch{}
    return{route:"/_zp/blocked/navigation",target:fallbackTarget};
  }
  function commitDeferredNavigationRoute(element,normalized,visible,target,route,applyNative){
    rememberAttributeView(element,normalized);
    const generation=beginNodeMetadataOperation(element,normalized);
    setDynamicAttributeMetadata(element,normalized,visible,target);
    try{applyNative(route);if(route!=="/_zp/blocked/navigation")recordResourceMapping(route,target);const record=nodeMetadata.get(element);if(record?.generation===generation)record.internal_route_values.set(normalized,route)}
    finally{const record=nodeMetadata.get(element);if(record?.generation===generation)record.abort_controller=null}
  }
  function prepareDeferredNavigationAttribute(element,normalized,visible,applyNative){
    const plan=deferredNavigationPlan(element,normalized,visible);
    commitDeferredNavigationRoute(element,normalized,visible,plan.target,plan.route,applyNative);
  }
  function queueDeferredNavigationAttribute(element,normalized,visible,applyNative){
    const plan=deferredNavigationPlan(element,normalized,visible);
    rememberAttributeView(element,normalized);
    const generation=beginNodeMetadataOperation(element,normalized);
    setDynamicAttributeMetadata(element,normalized,visible,plan.target);
    reflectApply(timerNatives.setTimeout,rawWindow,[()=>{
      if(!currentNodeMetadataGeneration(element,generation))return;
      try{applyNative(plan.route);if(plan.route!=="/_zp/blocked/navigation")recordResourceMapping(plan.route,plan.target);const record=nodeMetadata.get(element);if(record?.generation===generation)record.internal_route_values.set(normalized,plan.route)}
      finally{const record=nodeMetadata.get(element);if(record?.generation===generation)record.abort_controller=null}
    },0]);
  }
  function allocateDynamicAttributeRoute(element,normalized,route,generation,applyNative){
    const integrity=reflectApply(attributeNatives.getAttribute,element,["integrity"]);
    const crossorigin=reflectApply(attributeNatives.getAttribute,element,["crossorigin"]);
    const corsMode=crossorigin===null?null:lower(reflectApply(stringTrim,crossorigin,[]))==="use-credentials"?"use-credentials":"anonymous";
    let allocatedRouteID=null;
    void cookieBarrier.catch(()=>{}).then(()=>runtimeCommand("ALLOCATE_RESOURCE_ROUTE",{target_url:route.target,resource_kind:route.kind,integrity,cors_mode:corsMode},"Resource route unavailable")).then(result=>{
      allocatedRouteID=typeof result?.route_id==="string"?result.route_id:null;
      if(!result||typeof result.path!=="string"||allocatedRouteID===null||result.policy_revision!==runtimePolicyContext.policy_version||result.client_bound!==true)throw new NativeDOMException("Resource route unavailable","SecurityError");
      if(!currentNodeMetadataGeneration(element,generation)){revokeAllocatedResourceRoute(allocatedRouteID);allocatedRouteID=null;return}
      recordMappedOrigin(route.target,result);
      if(isHTMLScriptElement(element)&&normalized==="src")completeDynamicScriptRoute(element,route.kind);
      applyNative(result.path);
      recordResourceMapping(result.path,route.target);
      allocatedRouteIDs(element).set(normalized,allocatedRouteID);
      allocatedRouteID=null;
      const record=nodeMetadata.get(element);if(record?.generation===generation){record.internal_route_values.set(normalized,result.path);record.abort_controller=null}
    }).catch(()=>{if(allocatedRouteID!==null)revokeAllocatedResourceRoute(allocatedRouteID);if(currentNodeMetadataGeneration(element,generation)){const record=nodeMetadata.get(element);record.abort_controller=null;if(isHTMLScriptElement(element)&&normalized==="src")blockDynamicScriptRoute(element,route.kind);applyNative("/_zp/blocked/dynamic-resource")}});
  }
  function setControlledDynamicAttribute(element,name,value,applyNative){
    const normalized=lower(NativeString(name)),visible=NativeString(value);
    if(replaceSealedNavigation(element,normalized,visible,applyNative))return true;
    if(replaceSealedFormAction(element,normalized,visible,applyNative))return true;
    rejectControlledDynamicAttribute(element,normalized,visible);
    if(isDeferredNavigationAttribute(element,normalized)){prepareDeferredNavigationAttribute(element,normalized,visible,applyNative);return true}
    if(isInertControlledAttribute(element,normalized)){cancelNodeMetadataOperation(element,normalized);ensureNodeMetadata(element).internal_route_values.delete(normalized);return false}
    const decision=policyDecision(element,normalized,visible);
    if(decision===null||decision==="Pass"){cancelNodeMetadataOperation(element,normalized);ensureNodeMetadata(element).internal_route_values.delete(normalized);return false}
    const route=controlledRouteDecision(decision);
    if(!route)throw new NativeDOMException("Dynamic URL blocked","SecurityError");
    const generation=beginNodeMetadataOperation(element,normalized);
    reflectApply(attributeNatives.removeAttribute,element,[normalized]);
    setDynamicAttributeMetadata(element,normalized,visible,route.target);
    if(isHTMLScriptElement(element)&&normalized==="src")beginDynamicScriptRoute(element,route.kind);
    allocateDynamicAttributeRoute(element,normalized,route,generation,applyNative);
    return true;
  }
  const inertTemplate=reflectApply(markupNatives.createElement,document,["template"]),inertDocument=nativeOwnerDocument(reflectApply(markupNatives.templateContent.get,inertTemplate,[]));
  function appendNestedMarkupRoots(roots,element){if(isHTMLTemplateElement(element))roots[roots.length]=reflectApply(markupNatives.templateContent.get,element,[]);const shadow=reflectApply(markupNatives.shadowRoot.get,element,[]);if(shadow)roots[roots.length]=shadow}
  function isMarkupStyleElement(node){return isElementNode(node)&&nativeLocalName(node)==="style"&&(nativeNamespaceURI(node)==="http://www.w3.org/1999/xhtml"||nativeNamespaceURI(node)==="http://www.w3.org/2000/svg")}
  function blockDynamicStyleTree(root){
    const roots=[root];
    for(let rootIndex=0;rootIndex<roots.length;rootIndex+=1){
      const current=roots[rootIndex];
      if(isMarkupStyleElement(current))blockDynamicCSS(reflectApply(natives.textContent.get,current,[]));
      if(!(isElementNode(current)||isDocumentNode(current)||isDocumentFragmentNode(current)))continue;
      const elements=nativeDescendants(current);
      for(let elementIndex=0;elementIndex<elements.length;elementIndex+=1){
        const element=elements[elementIndex];
        if(isMarkupStyleElement(element))blockDynamicCSS(reflectApply(natives.textContent.get,element,[]));
        appendNestedMarkupRoots(roots,element);
      }
    }
  }
  function styleMutationOwner(receiver){if(isMarkupStyleElement(receiver))return receiver;if(isNode(receiver)){const parent=nativeParentNode(receiver);if(isMarkupStyleElement(parent))return parent}return null}
  function guardDynamicStyleInsertion(receiver,nodes){
    const owner=styleMutationOwner(receiver);
    if(owner)for(let index=0;index<nodes.length;index+=1){
      const node=nodes[index],text=isNode(node)?reflectApply(natives.textContent.get,node,[]):NativeString(node);
      blockDynamicCSS(text);
    }
    for(let index=0;index<nodes.length;index+=1)if(isNode(nodes[index]))blockDynamicStyleTree(nodes[index]);
  }
  function validatePreconnectionElement(element){
    const names=reflectApply(attributeNatives.getAttributeNames,element,[]),record=nodeMetadata.get(element);
    for(let index=0;index<names.length;index+=1){
      const name=names[index],normalized=lower(name),value=reflectApply(attributeNatives.getAttribute,element,[name]);
      if(isHTMLBaseElement(element)&&normalized==="href"&&baseMetadata.has(element))continue;
      if(record?.internal_route_values.has(normalized)&&record.internal_route_values.get(normalized)===value)continue;
      if(isDeferredNavigationAttribute(element,normalized)){prepareDeferredNavigationAttribute(element,normalized,value,internal=>reflectApply(natives.setAttribute,element,[name,internal]));continue}
      if(!inertActivationAttribute(element,normalized))enforceDynamicAttribute(element,normalized,value);
    }
  }
  function validatePreconnectionRoot(root){
    const roots=[root];
    for(let rootIndex=0;rootIndex<roots.length;rootIndex+=1){
      const current=roots[rootIndex];
      if(isElementNode(current))validatePreconnectionElement(current);
      if(!(isElementNode(current)||isDocumentNode(current)||isDocumentFragmentNode(current)))continue;
      const elements=nativeDescendants(current);
      for(let elementIndex=0;elementIndex<elements.length;elementIndex+=1){
        validatePreconnectionElement(elements[elementIndex]);
        appendNestedMarkupRoots(roots,elements[elementIndex]);
      }
    }
  }
  function validatePreconnectionInsertion(nodes){for(let index=0;index<nodes.length;index+=1)if(isNode(nodes[index]))validatePreconnectionRoot(nodes[index])}
  function validateDynamicMarkupElement(element){
    const namespace=nativeNamespaceURI(element);
    if(nativeLocalName(element)==="style"&&(namespace==="http://www.w3.org/1999/xhtml"||namespace==="http://www.w3.org/2000/svg"))throw new NativeDOMException("Dynamic style elements require a controlled rewrite","SecurityError");
    const names=reflectApply(attributeNatives.getAttributeNames,element,[]);
    for(let nameIndex=0;nameIndex<names.length;nameIndex+=1){
      const name=names[nameIndex],normalized=lower(name),value=reflectApply(attributeNatives.getAttribute,element,[name]);
      if(isDeferredNavigationAttribute(element,normalized)){prepareDeferredNavigationAttribute(element,normalized,value,internal=>reflectApply(natives.setAttribute,element,[name,internal]));continue}
      if(!inertActivationAttribute(element,normalized))enforceDynamicAttribute(element,name,value);
    }
  }
  function validateDynamicMarkupTree(root){const roots=[root];for(let rootIndex=0;rootIndex<roots.length;rootIndex+=1){const elements=nativeDescendants(roots[rootIndex]);for(let elementIndex=0;elementIndex<elements.length;elementIndex+=1){const element=elements[elementIndex];validateDynamicMarkupElement(element);appendNestedMarkupRoots(roots,element)}}}
  function markInertMarkupScript(element){if(inertScripts.has(element))return;inertScripts.add(element);if(nativeNamespaceURI(element)==="http://www.w3.org/2000/svg")setInertSVGVisibleType(element,reflectApply(attributeNatives.getAttribute,element,["type"]))}
  function markInertMarkupScripts(root){const roots=[root];for(let rootIndex=0;rootIndex<roots.length;rootIndex+=1){const elements=nativeDescendants(roots[rootIndex]);for(let elementIndex=0;elementIndex<elements.length;elementIndex+=1){const element=elements[elementIndex];if(isMarkupScriptElement(element))markInertMarkupScript(element);appendNestedMarkupRoots(roots,element)}}}
  function inertContextElement(target){return nativeNamespaceURI(target)==="http://www.w3.org/1999/xhtml"?reflectApply(markupNatives.createElement,inertDocument,[nativeLocalName(target)]):reflectApply(markupNatives.createElementNS,inertDocument,[nativeNamespaceURI(target),nativeLocalName(target)])}
  function parsedElementChildren(target,value){const input=markupInput(value),context=inertContextElement(target);reflectApply(parserNatives.elementInnerHTML.set,context,[input.nativeValue]);const root=isHTMLTemplateElement(context)?reflectApply(markupNatives.templateContent.get,context,[]):context;validateDynamicMarkupTree(root);markInertMarkupScripts(root);return nativeNodeListArray(reflectApply(markupNatives.childNodes.get,root,[]))}
  function replaceChildrenWithMetadataRevocation(native,receiver,nodes){
    const removed=metadataChildren(receiver),result=reflectApply(native,receiver,nodes);
    if(isMarkupStyleElement(receiver))styleSourceMetadata.delete(receiver);
    for(let index=0;index<removed.length;index+=1)revokeNodeMetadataTree(removed[index]);
    return result;
  }
  function replaceNodeWithMetadataRevocation(native,receiver,args,node=receiver){
    const parent=nativeParentNode(node),result=reflectApply(native,receiver,args);
    if(styleMutationOwner(node))styleSourceMetadata.delete(styleMutationOwner(node));
    if(parent)revokeNodeMetadataTree(node);
    return result;
  }
  function replaceElementMarkup(target,value){const nodes=parsedElementChildren(target,value),receiver=isHTMLTemplateElement(target)?reflectApply(markupNatives.templateContent.get,target,[]):target,native=isHTMLTemplateElement(target)?insertionNatives.fragmentReplaceChildren:insertionNatives.elementReplaceChildren;return replaceChildrenWithMetadataRevocation(native,receiver,nodes)}
  function replaceShadowMarkup(shadow,value){const input=markupInput(value),host=reflectApply(markupNatives.shadowHost.get,shadow,[]),contextHost=inertContextElement(host),contextShadow=reflectApply(markupNatives.attachShadow,contextHost,[{mode:"open"}]);reflectApply(parserNatives.shadowInnerHTML.set,contextShadow,[input.nativeValue]);validateDynamicMarkupTree(contextShadow);markInertMarkupScripts(contextShadow);const nodes=nativeNodeListArray(reflectApply(markupNatives.childNodes.get,contextShadow,[]));return replaceChildrenWithMetadataRevocation(insertionNatives.fragmentReplaceChildren,shadow,nodes)}
  function validateParsedMarkup(root,input,unsafe){if(unsafe)prevalidateHTMLMarkup(input.nativeValue);else prevalidateClosedShadowMarkup(input.nativeValue);validateDynamicMarkupTree(root);markInertMarkupScripts(root)}
  function parsedElementMethodChildren(target,markup,native,options,unsafe){const input=markupInput(markup),context=inertContextElement(target);reflectApply(native,context,arrayWithFirst(input.nativeValue,options));const root=isHTMLTemplateElement(context)?reflectApply(markupNatives.templateContent.get,context,[]):context;validateParsedMarkup(root,input,unsafe);return nativeNodeListArray(reflectApply(markupNatives.childNodes.get,root,[]))}
  function replaceElementMethodMarkup(target,markup,native,options,unsafe){const nodes=parsedElementMethodChildren(target,markup,native,options,unsafe),receiver=isHTMLTemplateElement(target)?reflectApply(markupNatives.templateContent.get,target,[]):target,replace=isHTMLTemplateElement(target)?insertionNatives.fragmentReplaceChildren:insertionNatives.elementReplaceChildren;return replaceChildrenWithMetadataRevocation(replace,receiver,nodes)}
  function replaceShadowMethodMarkup(shadow,markup,native,options,unsafe){const input=markupInput(markup),host=reflectApply(markupNatives.shadowHost.get,shadow,[]),contextHost=inertContextElement(host),contextShadow=reflectApply(markupNatives.attachShadow,contextHost,[{mode:"open"}]);reflectApply(native,contextShadow,arrayWithFirst(input.nativeValue,options));validateParsedMarkup(contextShadow,input,unsafe);const nodes=nativeNodeListArray(reflectApply(markupNatives.childNodes.get,contextShadow,[]));return replaceChildrenWithMetadataRevocation(insertionNatives.fragmentReplaceChildren,shadow,nodes)}
  function parseDocumentMarkup(receiver,markup,native,options,unsafe){const input=markupInput(markup),parsed=reflectApply(native,receiver,arrayWithFirst(input.nativeValue,options));validateParsedMarkup(parsed,input,unsafe);return parsed}
  function parsedContextualFragment(target,value){const input=markupInput(value),context=inertContextElement(target),range=reflectApply(markupNatives.createRange,inertDocument,[]);reflectApply(markupNatives.selectNodeContents,range,[context]);const fragment=reflectApply(parserNatives.contextualFragment,range,[input.nativeValue]);validateDynamicMarkupTree(fragment);markInertMarkupScripts(fragment);return fragment}
  function contextualTarget(node){if(isElementNode(node))return node;const parent=nativeParentElement(node);if(parent)return parent;return nativeDocumentBody(document)??nativeDocumentElement(document)}
  function replaceOuterMarkup(target,value){const parent=reflectApply(markupNatives.parentNode.get,target,[]);if(parent===null)return reflectApply(parserNatives.elementOuterHTML.set,target,[value]);if(isDocumentNode(parent))return replaceNodeWithMetadataRevocation(parserNatives.elementOuterHTML.set,target,[value]);const context=isShadowRootNode(parent)?reflectApply(markupNatives.shadowHost.get,parent,[]):contextualTarget(parent),fragment=parsedContextualFragment(context,value),nodes=nativeNodeListArray(reflectApply(markupNatives.childNodes.get,fragment,[]));return replaceNodeWithMetadataRevocation(insertionNatives.elementReplaceWith,target,nodes)}
  function adjacentInsertionNative(position){switch(position){case"beforebegin":return insertionNatives.elementBefore;case"afterend":return insertionNatives.elementAfter;case"afterbegin":return insertionNatives.elementPrepend;default:return insertionNatives.elementAppend}}
  function adjacentMarkupContext(target,outside,parent){if(!outside)return target;return isShadowRootNode(parent)?reflectApply(markupNatives.shadowHost.get,parent,[]):contextualTarget(parent)}
  function insertAdjacentMarkup(target,position,value){const normalized=lower(NativeString(position));if(!includesValue(["beforebegin","afterbegin","beforeend","afterend"],normalized))return reflectApply(parserNatives.insertAdjacentHTML,target,[position,""]);const outside=normalized==="beforebegin"||normalized==="afterend",parent=outside?reflectApply(markupNatives.parentNode.get,target,[]):null;if(outside&&(parent===null||isDocumentNode(parent)))return reflectApply(parserNatives.insertAdjacentHTML,target,[position,""]);const fragment=parsedContextualFragment(adjacentMarkupContext(target,outside,parent),value),nodes=nativeNodeListArray(reflectApply(markupNatives.childNodes.get,fragment,[]));return guardedInsertion(adjacentInsertionNative(normalized),target,nodes)}
  function contextualFragmentForRange(range,value){const start=reflectApply(markupNatives.rangeStartContainer.get,range,[]),context=contextualTarget(start),fragment=parsedContextualFragment(context,value),targetDocument=isDocumentNode(start)?start:reflectApply(markupNatives.ownerDocument.get,start,[]);return reflectApply(selectorNatives.importNode,targetDocument,[fragment,true])}
  function prevalidateHTMLMarkup(value){const template=reflectApply(markupNatives.createElement,inertDocument,["template"]);reflectApply(parserNatives.elementInnerHTML.set,template,[value]);validateDynamicMarkupTree(reflectApply(markupNatives.templateContent.get,template,[]))}
  function prevalidateClosedShadowMarkup(value){const template=reflectApply(markupNatives.createElement,inertDocument,["template"]);reflectApply(parserNatives.elementInnerHTML.set,template,[value]);const roots=[reflectApply(markupNatives.templateContent.get,template,[])];for(let rootIndex=0;rootIndex<roots.length;rootIndex+=1){const elements=nativeDescendants(roots[rootIndex]);for(let elementIndex=0;elementIndex<elements.length;elementIndex+=1){const element=elements[elementIndex];if(!(isHTMLTemplateElement(element)))continue;const content=reflectApply(markupNatives.templateContent.get,element,[]),mode=reflectApply(attributeNatives.getAttribute,element,["shadowrootmode"]);if(mode!==null&&lower(mode)==="closed")validateDynamicMarkupTree(content);roots[roots.length]=content}}}
  function canonicalBase(value){const decision=policyDecision(reflectApply(markupNatives.createElement,document,["base"]),"href",value,"Document",fallbackBase),canonical=decision?.VirtualBase?.canonical_target;if(typeof canonical!=="string")throw new NativeDOMException("Base URL blocked","SecurityError");return canonical}
  function registerBase(node,value){if(!(isHTMLBaseElement(node))||!nativeIsConnected(node))throw new NativeDOMException("Invalid base metadata","SecurityError");const canonical=canonicalBase(value);baseMetadata.set(node,canonical);return canonical}
  function removeInternalNonce(node){if(reflectApply(attributeNatives.hasAttribute,node,["nonce"]))reflectApply(attributeNatives.removeAttribute,node,["nonce"])}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dom_section_26() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const stagedURLDescriptors=new PrivateWeakMap();
  function stageURLProperty(prototype,property,attribute){
    let owner=prototype,descriptor;
    while(owner&&!(descriptor=natives.getOwnPropertyDescriptor(owner,property)))owner=objectGetPrototypeOf(owner);
    if(!owner||!descriptor?.get||!descriptor?.set||!descriptor.configurable)throw new Error(`URL descriptor unavailable: ${property}`);
    let properties=stagedURLDescriptors.get(owner);
    if(!properties){properties=new PrivateSet;stagedURLDescriptors.set(owner,properties)}
    if(properties.has(property))return;
    properties.add(property);
    stage(owner,property,{...descriptor,get(){return visibleAttribute(this,attribute,"url")??reflectApply(descriptor.get,this,[])},set(value){
      const converted=NativeString(value),apply=internal=>reflectApply(descriptor.set,this,[internal]);
      if(setControlledDynamicAttribute(this,attribute,converted,apply))return;
      clearVisibleAttribute(this,attribute);apply(converted);
    },configurable:false});
  }
  function stageReflectedProperty(prototype,property,attribute,descriptor,mediate=false){
    if(!descriptor?.get||!descriptor?.set||!descriptor.configurable)throw new Error(`reflected descriptor unavailable: ${property}`);
    stage(prototype,property,{...descriptor,get(){return reflectedAttributeValue(this,attribute,descriptor)},set(value){
      const converted=mediate?NativeString(value):value;
      queueVisibleNonceMutation(this,attribute,true);
      if(mediate&&setControlledDynamicAttribute(this,attribute,converted,internal=>reflectApply(descriptor.set,this,[internal])))return;
      clearVisibleAttribute(this,attribute);reflectApply(descriptor.set,this,[converted]);
    },configurable:false});
  }
  function stageDocumentSurfaces(){
  stage(Node.prototype,"baseURI",{...natives.nodeBaseURI,get(){return nativeOwnerDocument(this)===document||this===document?visibleBase():reflectApply(natives.nodeBaseURI.get, this, [])},configurable:false});
  stage(HTMLBaseElement.prototype,"href",{...natives.baseHref,get(){return baseMetadata.get(this)??fallbackBase},set(value){setVirtualBase(this,value)},configurable:false});
  if(documentNatives.location?.configurable)stage(Document.prototype,"location",{...documentNatives.location,get(){return locationFacade},set(value){requestNavigation(value)},configurable:false});
  if(!documentNatives.defaultView?.get||!documentNatives.defaultView.configurable)throw new Error("defaultView descriptor unavailable");
  stage(Document.prototype,"defaultView",{...documentNatives.defaultView,get(){return facadeValue(reflectApply(documentNatives.defaultView.get, this, []))},configurable:false});
  }
  stageDocumentSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function dom_section_33() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function insertionContainsNode(nodes,node){for(let index=0;index<nodes.length;index+=1)if(nodes[index]===node)return true;return false}
  function removeNodeWithMetadata(native,node){
    const parent=nativeParentNode(node),styleOwner=styleMutationOwner(node),result=reflectApply(native,node,[]);
    if(styleOwner)styleSourceMetadata.delete(styleOwner);
    if(parent)revokeNodeMetadataTree(node);
    return result;
  }
  function replaceChildWithMetadata(parent,node,child){
    const result=guardedInsertion(insertionNatives.replaceChild,parent,[node,child],[node]);
    if(node!==child)revokeNodeMetadataTree(child);
    return result;
  }
  function replaceNodeWithGuardedMetadata(native,node,nodes){
    const parent=nativeParentNode(node),retained=insertionContainsNode(nodes,node),result=guardedInsertion(native,node,nodes);
    if(parent&&!retained)revokeNodeMetadataTree(node);
    return result;
  }
  function replaceChildrenWithGuardedMetadata(native,receiver,nodes){
    const previous=metadataChildren(receiver),result=guardedInsertion(native,receiver,nodes);
    for(let index=0;index<previous.length;index+=1)if(!insertionContainsNode(nodes,previous[index]))revokeNodeMetadataTree(previous[index]);
    return result;
  }
  function stageChildNodeInsertionSurfaces(prototype,before,after,replaceWith){
    for(const entry of [["before",before],["after",after],["replaceWith",replaceWith]]){
      const name=entry[0],native=entry[1],descriptor=natives.getOwnPropertyDescriptor(prototype,name);
      if(typeof native!=="function"||!descriptor?.configurable)throw new Error(`ChildNode surface unavailable: ${prototype.constructor.name}.${name}`);
      const value=name==="replaceWith"?function(...nodes){return replaceNodeWithGuardedMetadata(native,this,nodes)}:function(...nodes){return guardedInsertion(native,this,nodes)};
      stage(prototype,name,{...descriptor,value,writable:false,configurable:false});
    }
  }
  function stageMoveBefore(prototype,native){
    if(typeof native!=="function")return;
    const descriptor=natives.getOwnPropertyDescriptor(prototype,"moveBefore");
    if(!descriptor?.configurable)throw new Error(`moveBefore surface unavailable: ${prototype.constructor.name}`);
    stage(prototype,"moveBefore",{...descriptor,value:function(node,child){return guardedInsertion(native,this,[node,child],[node])},writable:false,configurable:false});
  }
  function rangeInsertionReceiver(range){const start=reflectApply(markupNatives.rangeStartContainer.get,range,[]);return isCharacterDataNode(start)?nativeParentNode(start):start}
  function guardedRangeInsertion(native,range,node){const receiver=rangeInsertionReceiver(range),owner=styleMutationOwner(receiver);guardDynamicStyleInsertion(receiver,[node]);const result=guardedInsertion(native,range,[node],[node]);if(owner)styleSourceMetadata.delete(owner);return result}
  function guardedRangeSurround(range,node){if(isMarkupScriptElement(node)||isMarkupStyleElement(node))throw new NativeDOMException("Executable Range wrapper is blocked","SecurityError");return guardedRangeInsertion(insertionNatives.rangeSurroundContents,range,node)}
  function visibleDocumentSerializationClone(source){
    const implementation=reflectApply(projectionNatives.documentImplementation.get,source,[]),clone=reflectApply(projectionNatives.createDocument,implementation,[null,null]),children=metadataChildren(source);
    for(let index=0;index<children.length;index+=1){
      const child=children[index],visible=isElementNode(child)?visibleSerializationClone(child):child,copy=reflectApply(selectorNatives.importNode,clone,[visible,true]);
      reflectApply(insertionNatives.appendChild,clone,[copy]);
    }
    return clone;
  }
  function visibleShadowHTML(source){
    const host=reflectApply(markupNatives.createElement,inertDocument,["div"]),shadow=reflectApply(markupNatives.attachShadow,host,[{mode:"open"}]),clone=visibleSerializationClone(source);
    reflectApply(insertionNatives.appendChild,shadow,[clone]);
    return reflectApply(parserNatives.shadowInnerHTML.get,shadow,[]);
  }
  function stageNodeSurfaces(){
  stage(Document.prototype,"open",{value:function(){throw new NativeDOMException("Document replacement is blocked","SecurityError")},writable:false,enumerable:true,configurable:false});
  stage(Node.prototype,"cloneNode",{value:function(deep=false){const copy=reflectApply(insertionNatives.cloneNode,this,[deep]);propagateNodeMetadata(this,copy,NativeBoolean(deep));return propagateInertScripts(this,copy,NativeBoolean(deep))},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"importNode",{value:function(node,deep=false){const copy=reflectApply(selectorNatives.importNode,this,[node,deep]);propagateNodeMetadata(node,copy,NativeBoolean(deep));return propagateInertScripts(node,copy,NativeBoolean(deep))},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"adoptNode",{value:function(node){if(adoptionCrossesRealm(node))throw new NativeDOMException("Cross-realm node adoption requires an authenticated handoff","SecurityError");return reflectApply(adoptionNatives.adoptNode,this,[node])},writable:false,enumerable:false,configurable:false});
  stage(Node.prototype,"removeChild",{...natives.getOwnPropertyDescriptor(Node.prototype,"removeChild"),value:function(child){const owner=isMarkupStyleElement(this)?this:null,removed=reflectApply(childNodeNatives.removeChild,this,[child]);if(owner)styleSourceMetadata.delete(owner);revokeNodeMetadataTree(removed);return removed},configurable:false});
  stage(XMLSerializer.prototype,"serializeToString",{value:function(node){if(isElementNode(node)||isDocumentFragmentNode(node))return reflectApply(selectorNatives.serializeToString,this,[visibleSerializationClone(node)]);if(isDocumentNode(node))return reflectApply(selectorNatives.serializeToString,this,[visibleDocumentSerializationClone(node)]);return reflectApply(selectorNatives.serializeToString,this,[node])},writable:false,enumerable:false,configurable:false});
  stage(NodeList.prototype,"forEach",{value:function(callback,thisArg){const nodes=listNodes(this);reflectApply(arrayForEach, nodes, [(node,index)=>reflectApply(callback,thisArg,[node,index,this])])},writable:false,enumerable:false,configurable:false});
  function scriptCharacterOwner(node){if(!isCharacterDataNode(node))return null;const parent=nativeParentNode(node);return isHTMLScriptElement(parent)&&scriptSourceMetadata.has(parent)?parent:null}
  function styleCharacterOwner(node){if(!isCharacterDataNode(node))return null;const parent=nativeParentNode(node);return isMarkupStyleElement(parent)?parent:null}
  function projectedStyleSource(node){if(isMarkupStyleElement(node)&&styleSourceMetadata.has(node))return styleSourceMetadata.get(node);const owner=styleCharacterOwner(node);return owner&&styleSourceMetadata.has(owner)?styleSourceMetadata.get(owner):undefined}
  function clearProjectedStyleSource(node){const owner=styleMutationOwner(node);if(owner)styleSourceMetadata.delete(owner)}
  stage(Node.prototype,"textContent",{...natives.textContent,get(){if(isHTMLScriptElement(this)&&scriptSourceMetadata.has(this))return scriptSourceMetadata.get(this);const source=isCharacterDataNode(this)?scriptTextSource(this)??projectedStyleSource(this):projectedStyleSource(this);return source??reflectApply(natives.textContent.get,this,[])},set(value){if(isHTMLScriptElement(this)){setDynamicScriptSource(this,value);return}const scriptOwner=scriptCharacterOwner(this);if(scriptOwner){setDynamicScriptSource(scriptOwner,value);return}if(isMarkupStyleElement(this)||styleCharacterOwner(this)){const converted=value===null?"":NativeString(value);blockDynamicCSS(converted);clearProjectedStyleSource(this);reflectApply(natives.textContent.set,this,[converted]);return}reflectApply(natives.textContent.set,this,[value])},configurable:false});
  stage(Node.prototype,"nodeValue",{...natives.nodeValue,get(){const source=isCharacterDataNode(this)?scriptTextSource(this)??projectedStyleSource(this):undefined;return source??reflectApply(natives.nodeValue.get,this,[])},set(value){const scriptOwner=scriptCharacterOwner(this);if(scriptOwner){setDynamicScriptSource(scriptOwner,value??"");return}if(styleCharacterOwner(this)){const converted=value===null?"":NativeString(value);blockDynamicCSS(converted);clearProjectedStyleSource(this);reflectApply(natives.nodeValue.set,this,[converted]);return}reflectApply(natives.nodeValue.set,this,[value])},configurable:false});
  if(!mutationNatives.data?.get||!mutationNatives.data?.set||!mutationNatives.data.configurable)throw new Error("CharacterData descriptor unavailable");
  stage(CharacterData.prototype,"data",{...mutationNatives.data,get(){return scriptTextSource(this)??projectedStyleSource(this)??reflectApply(mutationNatives.data.get,this,[])},set(value){const scriptOwner=scriptCharacterOwner(this);if(scriptOwner){setDynamicScriptSource(scriptOwner,value);return}if(styleCharacterOwner(this)){const converted=NativeString(value);blockDynamicCSS(converted);clearProjectedStyleSource(this);reflectApply(mutationNatives.data.set,this,[converted]);return}reflectApply(mutationNatives.data.set,this,[value])},configurable:false});
  if(scriptNatives.innerText?.get&&scriptNatives.innerText?.set&&scriptNatives.innerText.configurable)stage(HTMLElement.prototype,"innerText",{...scriptNatives.innerText,get(){return projectedStyleSource(this)??reflectApply(scriptNatives.innerText.get,this,[])},set(value){if(isMarkupStyleElement(this)){const converted=NativeString(value);blockDynamicCSS(converted);clearProjectedStyleSource(this);reflectApply(scriptNatives.innerText.set,this,[converted]);return}reflectApply(scriptNatives.innerText.set,this,[value])},configurable:false});
  if(!scriptNatives.text?.get||!scriptNatives.text?.set||!scriptNatives.text.configurable)throw new Error("script text descriptor unavailable");
  stage(HTMLScriptElement.prototype,"text",{...scriptNatives.text,get(){return scriptSourceMetadata.has(this)?scriptSourceMetadata.get(this):reflectApply(scriptNatives.text.get, this, [])},set(value){setDynamicScriptSource(this,value)},configurable:false});
  if(scriptNatives.textContent?.get&&scriptNatives.textContent?.set&&scriptNatives.textContent.configurable)stage(HTMLScriptElement.prototype,"textContent",{...scriptNatives.textContent,get(){return scriptSourceMetadata.has(this)?scriptSourceMetadata.get(this):reflectApply(scriptNatives.textContent.get, this, [])},set(value){setDynamicScriptSource(this,value)},configurable:false});
  if(scriptNatives.innerText?.get&&scriptNatives.innerText?.set&&scriptNatives.innerText.configurable)stage(HTMLScriptElement.prototype,"innerText",{...scriptNatives.innerText,get(){return scriptSourceMetadata.has(this)?scriptSourceMetadata.get(this):reflectApply(scriptNatives.innerText.get, this, [])},set(value){setDynamicScriptSource(this,value)},configurable:false});
  stageChildNodeInsertionSurfaces(Element.prototype,insertionNatives.elementBefore,insertionNatives.elementAfter,insertionNatives.elementReplaceWith);
  stageChildNodeInsertionSurfaces(CharacterData.prototype,childNodeNatives.characterDataBefore,childNodeNatives.characterDataAfter,childNodeNatives.characterDataReplaceWith);
  stageChildNodeInsertionSurfaces(DocumentType.prototype,childNodeNatives.documentTypeBefore,childNodeNatives.documentTypeAfter,childNodeNatives.documentTypeReplaceWith);
  stage(Element.prototype,"remove",{...natives.getOwnPropertyDescriptor(Element.prototype,"remove"),value:function(){return removeNodeWithMetadata(childNodeNatives.elementRemove,this)},configurable:false});
  stage(CharacterData.prototype,"remove",{...natives.getOwnPropertyDescriptor(CharacterData.prototype,"remove"),value:function(){return removeNodeWithMetadata(childNodeNatives.characterDataRemove,this)},configurable:false});
  stage(DocumentType.prototype,"remove",{...natives.getOwnPropertyDescriptor(DocumentType.prototype,"remove"),value:function(){return removeNodeWithMetadata(childNodeNatives.documentTypeRemove,this)},configurable:false});
  }
  stageNodeSurfaces();
  function controlledXSLTFragment(processor,source,outputDocument){
    if(!isDocumentNode(outputDocument))throw new NativeTypeError("XSLT output document is invalid");
    const transformed=reflectApply(xsltNatives.transformToFragment,processor,[source,inertDocument]);
    validateDynamicMarkupTree(transformed);
    markInertMarkupScripts(transformed);
    const copy=reflectApply(selectorNatives.importNode,outputDocument,[transformed,true]);
    return propagateNodeMetadata(transformed,copy,true);
  }
  function controlledXSLTDocument(processor,source){
    const transformed=reflectApply(xsltNatives.transformToDocument,processor,[source]);
    validateDynamicMarkupTree(transformed);
    markInertMarkupScripts(transformed);
    return transformed;
  }
  function stageMarkupSurfaces(){
  stage(Element.prototype,"innerHTML",{...parserNatives.elementInnerHTML,get(){return reflectApply(parserNatives.elementInnerHTML.get, visibleSerializationClone(this), [])},set(value){replaceElementMarkup(this,value)},configurable:false});
  stage(Element.prototype,"outerHTML",{...parserNatives.elementOuterHTML,get(){return reflectApply(parserNatives.elementOuterHTML.get, visibleSerializationClone(this), [])},set(value){replaceOuterMarkup(this,value)},configurable:false});
  stage(ShadowRoot.prototype,"innerHTML",{...parserNatives.shadowInnerHTML,get(){return visibleShadowHTML(this)},set(value){replaceShadowMarkup(this,value)},configurable:false});
  stage(HTMLIFrameElement.prototype,"srcdoc",{...parserNatives.srcdoc,get(){const record=nodeMetadata.get(this);return record?.target_srcdoc??visibleAttributeValue(this,"srcdoc",()=>reflectApply(parserNatives.srcdoc.get,this,[]))},set(value){const input=markupInput(value);if(input.source!=="")throw new NativeDOMException("Dynamic srcdoc requires a controlled document rewrite","SecurityError");clearVisibleAttribute(this,"srcdoc");reflectApply(parserNatives.srcdoc.set,this,[input.nativeValue])},configurable:false});
  stage(Element.prototype,"insertAdjacentHTML",{value:function(position,markup){return insertAdjacentMarkup(this,position,markup)},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"write",{value:function(...chunks){return controlledDocumentWrite(this,chunks,false)},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"writeln",{value:function(...chunks){return controlledDocumentWrite(this,chunks,true)},writable:false,enumerable:false,configurable:false});
  stage(Range.prototype,"createContextualFragment",{value:function(markup){return contextualFragmentForRange(this,markup)},writable:false,enumerable:false,configurable:false});
  stage(DOMParser.prototype,"parseFromString",{value:function(markup,type){const input=markupInput(markup),normalized=lower(NativeString(type));if(normalized==="text/html"){prevalidateHTMLMarkup(input.nativeValue);const parsed=reflectApply(parserNatives.parseFromString,this,[input.nativeValue,type]);markInertMarkupScripts(parsed);return parsed}const parsed=reflectApply(parserNatives.parseFromString,this,[input.nativeValue,type]);validateDynamicMarkupTree(parsed);markInertMarkupScripts(parsed);return parsed},writable:false,enumerable:false,configurable:false});
  if(xsltNatives){
    stage(XSLTProcessor.prototype,"transformToFragment",{...natives.getOwnPropertyDescriptor(XSLTProcessor.prototype,"transformToFragment"),value:function(source,outputDocument){return controlledXSLTFragment(this,source,outputDocument)},writable:false,configurable:false});
    stage(XSLTProcessor.prototype,"transformToDocument",{...natives.getOwnPropertyDescriptor(XSLTProcessor.prototype,"transformToDocument"),value:function(source){return controlledXSLTDocument(this,source)},writable:false,configurable:false});
  }
  stage(Node.prototype,"appendChild",{value:function(node){return guardedInsertion(insertionNatives.appendChild,this,[node],[node])},writable:false,enumerable:false,configurable:false});
  stage(Node.prototype,"insertBefore",{value:function(node,reference){return guardedInsertion(insertionNatives.insertBefore,this,[node,reference],[node])},writable:false,enumerable:false,configurable:false});
  stage(Node.prototype,"replaceChild",{value:function(node,child){return replaceChildWithMetadata(this,node,child)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"append",{value:function(...nodes){return guardedInsertion(insertionNatives.elementAppend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"prepend",{value:function(...nodes){return guardedInsertion(insertionNatives.elementPrepend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"insertAdjacentElement",{value:function(position,element){return guardedInsertion(insertionNatives.insertAdjacentElement,this,[position,element],[element])},writable:false,enumerable:false,configurable:false});
  stage(Element.prototype,"insertAdjacentText",{...natives.getOwnPropertyDescriptor(Element.prototype,"insertAdjacentText"),value:function(position,data){
    const normalized=lower(NativeString(position)),converted=NativeString(data),inside=normalized==="afterbegin"||normalized==="beforeend",parent=inside?null:nativeParentNode(this),owner=inside&&isMarkupStyleElement(this)?this:isMarkupStyleElement(parent)?parent:null;
    if(owner)blockDynamicCSS(converted);
    const result=reflectApply(insertionNatives.insertAdjacentText,this,[normalized,converted]);
    if(owner)styleSourceMetadata.delete(owner);
    return result;
  },writable:false,configurable:false});
  stage(Element.prototype,"replaceChildren",{value:function(...nodes){return replaceChildrenWithGuardedMetadata(insertionNatives.elementReplaceChildren,this,nodes)},writable:false,enumerable:false,configurable:false});
  stageMoveBefore(Element.prototype,insertionNatives.elementMoveBefore);
  stage(Document.prototype,"append",{value:function(...nodes){return guardedInsertion(insertionNatives.documentAppend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"prepend",{value:function(...nodes){return guardedInsertion(insertionNatives.documentPrepend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(Document.prototype,"replaceChildren",{value:function(...nodes){return replaceChildrenWithGuardedMetadata(insertionNatives.documentReplaceChildren,this,nodes)},writable:false,enumerable:false,configurable:false});
  stageMoveBefore(Document.prototype,insertionNatives.documentMoveBefore);
  stage(DocumentFragment.prototype,"append",{value:function(...nodes){return guardedInsertion(insertionNatives.fragmentAppend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(DocumentFragment.prototype,"prepend",{value:function(...nodes){return guardedInsertion(insertionNatives.fragmentPrepend,this,nodes)},writable:false,enumerable:false,configurable:false});
  stage(DocumentFragment.prototype,"replaceChildren",{value:function(...nodes){return replaceChildrenWithGuardedMetadata(insertionNatives.fragmentReplaceChildren,this,nodes)},writable:false,enumerable:false,configurable:false});
  stageMoveBefore(DocumentFragment.prototype,insertionNatives.fragmentMoveBefore);
  stage(Range.prototype,"insertNode",{...natives.getOwnPropertyDescriptor(Range.prototype,"insertNode"),value:function(node){return guardedRangeInsertion(insertionNatives.rangeInsertNode,this,node)},writable:false,configurable:false});
  stage(Range.prototype,"surroundContents",{...natives.getOwnPropertyDescriptor(Range.prototype,"surroundContents"),value:function(node){return guardedRangeSurround(this,node)},writable:false,configurable:false});
  if(parserNatives.setHTML)stage(Element.prototype,"setHTML",{value:function(markup,...options){return replaceElementMethodMarkup(this,markup,parserNatives.setHTML,options,false)},writable:false,enumerable:true,configurable:false});
  if(parserNatives.setHTMLUnsafe)stage(Element.prototype,"setHTMLUnsafe",{value:function(markup,...options){return replaceElementMethodMarkup(this,markup,parserNatives.setHTMLUnsafe,options,true)},writable:false,enumerable:true,configurable:false});
  if(parserNatives.shadowSetHTML)stage(ShadowRoot.prototype,"setHTML",{value:function(markup,...options){return replaceShadowMethodMarkup(this,markup,parserNatives.shadowSetHTML,options,false)},writable:false,enumerable:true,configurable:false});
  if(parserNatives.shadowSetHTMLUnsafe)stage(ShadowRoot.prototype,"setHTMLUnsafe",{value:function(markup,...options){return replaceShadowMethodMarkup(this,markup,parserNatives.shadowSetHTMLUnsafe,options,true)},writable:false,enumerable:true,configurable:false});
  if(parserNatives.documentParseHTML)stage(Document,"parseHTML",{value:function(markup,...options){return parseDocumentMarkup(this,markup,parserNatives.documentParseHTML,options,false)},writable:false,enumerable:true,configurable:false});
  if(parserNatives.documentParseHTMLUnsafe)stage(Document,"parseHTMLUnsafe",{value:function(markup,...options){return parseDocumentMarkup(this,markup,parserNatives.documentParseHTMLUnsafe,options,true)},writable:false,enumerable:true,configurable:false});
  }
  stageMarkupSurfaces();
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
