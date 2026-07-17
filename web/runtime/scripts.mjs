export const runtimeSections = [
  { file: import.meta.url, name: "scripts_section_10", order: 10, phase: "inner" },
  { file: import.meta.url, name: "scripts_section_18", order: 18, phase: "inner" },
  { file: import.meta.url, name: "scripts_section_20", order: 20, phase: "inner" },
];

export function scripts_section_10() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function isMarkupScriptElement(node){return isElementNode(node)&&nativeLocalName(node)==="script"&&(nativeNamespaceURI(node)==="http://www.w3.org/1999/xhtml"||nativeNamespaceURI(node)==="http://www.w3.org/2000/svg")}
  function scriptNodesIn(node){
    if(isMarkupScriptElement(node))return[node];
    let found;
    if(isElementNode(node))found=nativeNodeListArray(reflectApply(selectorNatives.elementQuerySelectorAll,node,["script"]));
    else if(isDocumentFragmentNode(node))found=nativeNodeListArray(reflectApply(selectorNatives.fragmentQuerySelectorAll,node,["script"]));
    else if(isDocumentNode(node))found=nativeNodeListArray(reflectApply(selectorNatives.documentQuerySelectorAll,node,["script"]));
    else return[];
    return reflectApply(arrayFilter,found,[isMarkupScriptElement]);
  }
  function guardExecutableNodes(nodes){
    const scripts=new PrivateSet;
    for(let nodeIndex=0;nodeIndex<nodes.length;nodeIndex+=1){
      const node=nodes[nodeIndex];
      if(!isNode(node))continue;
      const found=scriptNodesIn(node);
      for(let scriptIndex=0;scriptIndex<found.length;scriptIndex+=1){
        const script=found[scriptIndex];
        scripts.add(script);
        prepareExecutableScript(script);
      }
      trustedExecutableNodes.add(node);
    }
    return scripts;
  }
  function settleExecutableInsertion(scripts,succeeded){
    for(const script of scripts){
      const record=nodeMetadata.get(script),ledger=record?.internal_route_values.get(scriptLedgerKey);
      if(!record||!ledger)continue;
      if(record.script_state==="ACTIVATING"){
        if(succeeded&&nativeIsConnected(script)){
          activatedScripts.add(script);
          if(record.source_kind==="ModuleScript")installScriptLifecycleListeners(script);
          else setNodeScriptState(script,"EXECUTED",record.source_kind,ledger.context);
        }else{
          record.internal_route_values.delete(activatedScriptKey);
          ledger.already_started=false;
          setNodeScriptState(script,"COMPILED",record.source_kind,ledger.context);
        }
      }else if(record.script_state==="PREPARED"&&succeeded&&nativeIsConnected(script)&&scriptHasNativeSource(script)){
        installScriptLifecycleListeners(script);
        setNodeScriptState(script,"FETCHING",record.source_kind,ledger.context);
      }else if(record.script_state==="INERT"&&succeeded&&nativeIsConnected(script))ledger.already_started=true;
      if(record.script_state==="EXECUTED"||record.script_state==="REMOVED"||!succeeded)removeInternalNonce(script);
    }
  }
  function guardedInsertion(native,receiver,args,nodes=args){
    validatePreconnectionInsertion(nodes);
    guardDynamicStyleInsertion(receiver,nodes);
    const scripts=guardExecutableNodes(nodes),styleOwner=styleMutationOwner(receiver);
    let succeeded=false;
    try{
      const result=reflectApply(native,receiver,args);
      succeeded=true;
      if(styleOwner)styleSourceMetadata.delete(styleOwner);
      return result;
    }finally{settleExecutableInsertion(scripts,succeeded)}
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function scripts_section_18() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  const dynamicModuleActivations=new PrivateMap,documentWriteStates=new PrivateWeakMap;let writtenModuleSequence=0;
  function scriptAttributeValue(script,name){
    const visible=nodeMetadata.get(script)?.visible_attributes.get(name);
    return visible?visible.attribute:reflectApply(attributeNatives.getAttribute,script,[name]);
  }
  function scriptTypeEssence(script){const value=scriptAttributeValue(script,"type")??"";return lower(reflectApply(stringTrim,reflectApply(stringSplit,value,[";"])[0],[]))}
  function scriptExecutableKind(script,external,strict=true){
    const essence=scriptTypeEssence(script);
    if(essence==="module")return"ModuleScript";
    if(essence==="importmap"||essence==="speculationrules"){
      if(strict)throw new NativeDOMException("Dynamic script kind requires parser-time registration","SecurityError");
      return null;
    }
    if(essence===""||includesValue(["text/javascript","application/javascript","text/ecmascript","application/ecmascript","text/jscript","text/livescript"],essence))return external?"ClassicScriptExternal":"ClassicScriptInline";
    return null;
  }
  function scriptHasVisibleSource(script){const visible=nodeMetadata.get(script)?.visible_attributes.get("src");return visible?visible.attribute!==null:reflectApply(attributeNatives.hasAttribute,script,["src"])}
  function scriptHasNativeSource(script){return reflectApply(attributeNatives.hasAttribute,script,["src"])}
  function scriptHasExternalSource(script){return scriptHasVisibleSource(script)||scriptHasNativeSource(script)}
  function installScriptLifecycleListeners(script){
    const ledger=scriptLedgerRecord(script);
    if(ledger.listeners_installed)return;
    ledger.listeners_installed=true;
    const cleanup=()=>{
      reflectApply(eventNatives.removeEventListener,script,["load",loaded]);
      reflectApply(eventNatives.removeEventListener,script,["error",failed]);
      ledger.listeners_installed=false;
    };
    const loaded=()=>{
      cleanup();
      const record=nodeMetadata.get(script);
      if(!record||record.script_state==="EXECUTED"||record.script_state==="BLOCKED"||record.script_state==="CANCELED"||record.script_state==="INERT")return;
      if(record.script_state==="FETCHING"||record.script_state==="PREPARED")setNodeScriptState(script,"COMPILED",record.source_kind,ledger.context);
      activatedScripts.add(script);
      setNodeScriptState(script,"EXECUTED",record.source_kind,ledger.context);
      removeInternalNonce(script);
    };
    const failed=()=>{
      cleanup();
      const record=nodeMetadata.get(script);
      if(!record||record.script_state==="BLOCKED"||record.script_state==="CANCELED"||record.script_state==="INERT")return;
      setNodeScriptState(script,"FAILED",record.source_kind,ledger.context);
      removeInternalNonce(script);
    };
    reflectApply(eventNatives.addEventListener,script,["load",loaded]);
    reflectApply(eventNatives.addEventListener,script,["error",failed]);
  }
  function initializeParserScriptLedger(script){
    const record=ensureNodeMetadata(script),ledger=scriptLedgerRecord(script,"parser");
    if(ledger.already_started||record.script_state==="EXECUTED")return;
    const external=scriptHasExternalSource(script),kind=scriptExecutableKind(script,external,false);
    if(kind===null){
      setNodeScriptState(script,"INERT",null,"parser");
      ledger.already_started=true;
      return;
    }
    trustedExecutableNodes.add(script);
    setNodeScriptState(script,external&&nativeIsConnected(script)?"FETCHING":"PREPARED",kind,"parser");
    if(external)installScriptLifecycleListeners(script);
  }
  function dynamicRouteSourceKind(routeKind){return routeKind==="Module"?"ModuleScript":"ClassicScriptExternal"}
  function beginDynamicScriptRoute(script,routeKind){
    if(!isHTMLScriptElement(script)||inertScripts.has(script))return;
    const ledger=scriptLedgerRecord(script,"dynamic");
    if(ledger.already_started)return;
    ledger.route_pending=true;
    trustedExecutableNodes.add(script);
    installScriptLifecycleListeners(script);
    setNodeScriptState(script,"PREPARED",dynamicRouteSourceKind(routeKind),ledger.context);
  }
  function completeDynamicScriptRoute(script,routeKind){
    if(!isHTMLScriptElement(script))return;
    const ledger=scriptLedgerRecord(script,"dynamic");
    ledger.route_pending=false;
    if(ledger.already_started||inertScripts.has(script))return;
    const kind=dynamicRouteSourceKind(routeKind);
    setNodeScriptState(script,nativeIsConnected(script)?"FETCHING":"PREPARED",kind,ledger.context);
    installScriptLifecycleListeners(script);
  }
  function blockDynamicScriptRoute(script,routeKind){
    if(!isHTMLScriptElement(script))return;
    const ledger=scriptLedgerRecord(script,"dynamic");
    ledger.route_pending=false;
    if(ledger.already_started||inertScripts.has(script))return;
    setNodeScriptState(script,"BLOCKED",dynamicRouteSourceKind(routeKind),ledger.context);
    ledger.already_started=true;
    installScriptLifecycleListeners(script);
  }
  function cancelDynamicScriptRoute(script){
    if(!isHTMLScriptElement(script))return;
    const record=nodeMetadata.get(script),ledger=record?.internal_route_values.get(scriptLedgerKey);
    if(!record||!ledger?.route_pending||ledger.already_started)return;
    ledger.route_pending=false;
    setNodeScriptState(script,"CANCELED",record.source_kind,ledger.context);
  }
  function pruneDynamicModuleActivations(){
    for(const entry of dynamicModuleActivations)if(reflectApply(weakRefDeref,entry[1],[])===undefined)dynamicModuleActivations.delete(entry[0]);
  }
  function dynamicModuleActivationID(){
    pruneDynamicModuleActivations();
    if(dynamicModuleActivations.size>=128)throw new NativeDOMException("Dynamic module activation limit exceeded","QuotaExceededError");
    const bytes=new NativeUint8Array(16);
    reflectApply(cryptoGetRandomValues,nativeCrypto,[bytes]);
    return reflectApply(arrayJoin,arrayFrom(bytes,byte=>reflectApply(stringPadStart,reflectApply(numberToString,byte,[16]),[2,"0"])),[""]);
  }
  function registerDynamicModuleActivation(script){
    const ledger=scriptLedgerRecord(script,"dynamic");
    if(ledger.activation_id!==null)dynamicModuleActivations.delete(ledger.activation_id);
    const identifier=dynamicModuleActivationID();
    ledger.activation_id=identifier;
    dynamicModuleActivations.set(identifier,new NativeWeakRef(script));
    return identifier;
  }
  function activateDynamicModule(identifier){
    if(typeof identifier!=="string")throw new NativeDOMException("Invalid dynamic module activation","SecurityError");
    const reference=dynamicModuleActivations.get(identifier),script=reference&&reflectApply(weakRefDeref,reference,[]);
    dynamicModuleActivations.delete(identifier);
    if(!isHTMLScriptElement(script)||!trustedExecutableNodes.has(script))throw new NativeDOMException("Invalid dynamic module activation","SecurityError");
    const record=ensureNodeMetadata(script),ledger=scriptLedgerRecord(script,"dynamic");
    if(ledger.activation_id!==identifier)throw new NativeDOMException("Stale dynamic module activation","SecurityError");
    ledger.activation_id=null;
    activatedScripts.add(script);
    setNodeScriptState(script,"EXECUTED","ModuleScript",ledger.context);
    removeInternalNonce(script);
    return undefined;
  }
  function registerScript(node,source){
    if(!isHTMLScriptElement(node)||!nativeIsConnected(node)||typeof source!=="string")throw new NativeDOMException("Invalid script metadata","SecurityError");
    hydrateMetadata(node);
    trustedExecutableNodes.add(node);
    scriptSourceMetadata.set(node,source);
    activatedScripts.add(node);
    setNodeScriptState(node,"EXECUTED",scriptHasExternalSource(node)?"ClassicScriptExternal":"ClassicScriptInline","parser");
    removeInternalNonce(node);
  }
  function registerModuleScript(identifier,source){
    if(typeof identifier!=="string"||typeof source!=="string")throw new NativeDOMException("Invalid module metadata","SecurityError");
    const prefix=`${abiName}.registerModuleScript(${jsonStringify(identifier)},`,scripts=reflectApply(selectorNatives.documentQuerySelectorAll,document,["script:not([src])"]);
    for(const script of nativeNodeListArray(scripts)){
      if(!reflectApply(stringStartsWith,reflectApply(natives.textContent.get,script,[]),[prefix]))continue;
      hydrateMetadata(script);
      trustedExecutableNodes.add(script);
      scriptSourceMetadata.set(script,source);
      activatedScripts.add(script);
      setNodeScriptState(script,"EXECUTED","ModuleScript","parser");
      removeInternalNonce(script);
      return;
    }
    throw new NativeDOMException("Module metadata target missing","SecurityError");
  }
  function scriptTextSource(node){const parent=nativeParentNode(node);if(isHTMLScriptElement(parent)&&scriptSourceMetadata.has(parent))return scriptSourceMetadata.get(parent);return detachedScriptText.get(node)}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function scripts_section_20() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function setVirtualBase(node,value){const visible=NativeString(value),canonical=canonicalBase(visible);baseMetadata.set(node,canonical);setDynamicAttributeMetadata(node,"href",visible,canonical);reflectApply(natives.baseHref.set,node,[safeBaseURL()]);return canonical}
  function dynamicScriptKind(script,external=false){return scriptExecutableKind(script,external,true)}
  function htmlSpaceCode(code){return code===9||code===10||code===12||code===13||code===32}
  function asciiAlphaCode(code){return code>=65&&code<=90||code>=97&&code<=122}
  function writtenTagName(source,start){
    let index=start+1;
    if(source[index]==="/")index+=1;
    if(!asciiAlphaCode(reflectApply(nativeStringCharCodeAt,source,[index])))return null;
    const nameStart=index;
    while(index<source.length){
      const code=reflectApply(nativeStringCharCodeAt,source,[index]);
      if(htmlSpaceCode(code)||source[index]==="/"||source[index]===">")break;
      index+=1;
    }
    return{name:lower(reflectApply(stringSlice,source,[nameStart,index])),nameEnd:index};
  }
  function writtenMarkupEnd(source,start){
    let quote=null;
    for(let index=start+1;index<source.length;index+=1){
      const character=source[index];
      if(quote!==null){if(character===quote)quote=null;continue}
      if(character==="\""||character==="'"){quote=character;continue}
      if(character===">")return index+1;
    }
    return -1;
  }
  function writtenEndBoundary(character){if(character===undefined)return null;const code=reflectApply(nativeStringCharCodeAt,character,[0]);return character===">"||character==="/"||htmlSpaceCode(code)}
  function writtenRawEnd(source,name){
    const lowered=lower(source),needle=`</${name}`;
    let offset=0;
    while(offset<source.length){
      const start=reflectApply(stringIndexOf,lowered,[needle,offset]);
      if(start<0)return null;
      const boundary=writtenEndBoundary(source[start+needle.length]);
      if(boundary===null)return{pending:true};
      if(boundary){
        const end=writtenMarkupEnd(source,start);
        return end<0?{pending:true}:{start,end};
      }
      offset=start+needle.length;
    }
    return null;
  }
  function escapeWrittenAttribute(value){let result=NativeString(value);result=reflectApply(stringReplaceAll,result,["&","&amp;"]);result=reflectApply(stringReplaceAll,result,["\"","&quot;"]);return reflectApply(stringReplaceAll,result,["<","&lt;"])}
  function parsedWrittenContext(parent,markup){
    const context=inertContextElement(parent);
    reflectApply(parserNatives.elementInnerHTML.set,context,[runtimeHTML(markup)]);
    validateDynamicMarkupTree(context);
    return context;
  }
  function validateWrittenStartTag(parent,token,name){
    if(name==="svg"||name==="math")throw new NativeDOMException("Foreign document writes require a namespace-aware controlled rewrite","SecurityError");
    parsedWrittenContext(parent,token);
  }
  function writtenScriptMetadata(script){
    const nonce=reflectApply(attributeNatives.getAttribute,script,["nonce"]),names=reflectApply(attributeNatives.getAttributeNames,script,[]),index=reflectApply(arrayIndexOf,names,["nonce"]),order=index<0?names.length:index;
    return jsonStringify({nonce:{attribute:nonce,idl:nonce??"",url:null,order}});
  }
  function rewriteWrittenScript(parent,startToken,source,closingToken){
    if(includesValue(source,"<!--"))throw new NativeDOMException("Written script escaped states are unsupported","SecurityError");
    const context=parsedWrittenContext(parent,`${startToken}${source}${closingToken}`),scripts=scriptNodesIn(context),script=scripts[0];
    if(!isHTMLScriptElement(script))throw new NativeDOMException("Written script parse failed","SecurityError");
    if(scriptHasExternalSource(script))throw new NativeDOMException("Written external scripts require an asynchronous controlled route","SecurityError");
    const kind=dynamicScriptKind(script,false);
    if(kind===null)return`${startToken}${source}${closingToken}`;
    const authored=reflectApply(natives.textContent.get,script,[]),result=compileResult(authored,kind);
    if(kind==="ModuleScript"&&result.module_specifiers.length>0)throw new NativeDOMException("Written module imports require a controlled graph","SecurityError");
    let prefix;
    if(kind==="ModuleScript"){
      const identifier=`written:${writtenModuleSequence}`;
      writtenModuleSequence+=1;
      prefix=`${abiName}.registerModuleScript(${jsonStringify(identifier)},${jsonStringify(authored)});`;
    }else prefix=`${abiName}.registerScript(document.currentScript,${jsonStringify(authored)});`;
    const compiled=executableResultWithMap(authored,result,prefix,parsedInitialTarget.href);
    if(includesValue(compiled,"<!--"))throw new NativeDOMException("Written script escaped states are unsupported","SecurityError");
    if(includesValue(lower(compiled),"</script"))throw new NativeDOMException("Written script serialization is unsafe","SecurityError");
    const tag=writtenTagName(startToken,0),metadata=escapeWrittenAttribute(encodeStaticMetadataText(writtenScriptMetadata(script))),nonce=escapeWrittenAttribute(runtimeScript.nonce),rewrittenStart=`${reflectApply(stringSlice,startToken,[0,tag.nameEnd])} nonce="${nonce}" data-zp-m-v2="${metadata}"${reflectApply(stringSlice,startToken,[tag.nameEnd])}`;
    return`${rewrittenStart}${compiled}${closingToken}`;
  }
  function documentWriteState(receiver){
    let state=documentWriteStates.get(receiver);
    if(!state){state=objectCreate(null);state.pending="";state.raw_name=null;state.plaintext=false;state.template_depth=0;documentWriteStates.set(receiver,state)}
    return state;
  }
  function documentWriteStep(input,parent,state){
    if(state.plaintext)return{output:input,pending:"",rest:""};
    if(state.raw_name!==null){
      const closing=writtenRawEnd(input,state.raw_name);
      if(!closing)return{output:"",pending:input,rest:""};
      if(closing.pending)return{output:"",pending:input,rest:""};
      const output=reflectApply(stringSlice,input,[0,closing.end]),rest=reflectApply(stringSlice,input,[closing.end]);
      state.raw_name=null;
      return{output,pending:"",rest};
    }
    const start=reflectApply(stringIndexOf,input,["<"]);
    if(start<0)return{output:input,pending:"",rest:""};
    const prefix=reflectApply(stringSlice,input,[0,start]),remaining=reflectApply(stringSlice,input,[start]);
    if(remaining.length<4&&reflectApply(stringStartsWith,"<!--",[remaining]))return{output:prefix,pending:remaining,rest:""};
    if(reflectApply(stringStartsWith,remaining,["<!--"])){
      const close=reflectApply(stringIndexOf,remaining,["-->"]);
      if(close<0)return{output:prefix,pending:remaining,rest:""};
      const end=close+3;
      return{output:`${prefix}${reflectApply(stringSlice,remaining,[0,end])}`,pending:"",rest:reflectApply(stringSlice,remaining,[end])};
    }
    if(remaining.length===1)return{output:prefix,pending:remaining,rest:""};
    const marker=remaining[1];
    if(marker==="!"||marker==="?"){
      const end=writtenMarkupEnd(remaining,0);
      if(end<0)return{output:prefix,pending:remaining,rest:""};
      return{output:`${prefix}${reflectApply(stringSlice,remaining,[0,end])}`,pending:"",rest:reflectApply(stringSlice,remaining,[end])};
    }
    const tag=writtenTagName(remaining,0);
    if(tag===null)return{output:`${prefix}<`,pending:"",rest:reflectApply(stringSlice,remaining,[1])};
    const end=writtenMarkupEnd(remaining,0);
    if(end<0)return{output:prefix,pending:remaining,rest:""};
    const token=reflectApply(stringSlice,remaining,[0,end]),after=reflectApply(stringSlice,remaining,[end]),isEnd=remaining[1]==="/";
    if(isEnd){
      if(tag.name==="template"&&state.template_depth>0)state.template_depth-=1;
      return{output:`${prefix}${token}`,pending:"",rest:after};
    }
    validateWrittenStartTag(parent,token,tag.name);
    if(tag.name==="template")state.template_depth+=1;
    if(tag.name==="plaintext"){state.plaintext=true;return{output:`${prefix}${token}`,pending:"",rest:after}}
    if(includesValue(["title","textarea","xmp","iframe","noembed","noframes","noscript"],tag.name)){
      state.raw_name=tag.name;
      return{output:`${prefix}${token}`,pending:"",rest:after};
    }
    if(tag.name!=="script")return{output:`${prefix}${token}`,pending:"",rest:after};
    const closing=writtenRawEnd(after,"script");
    if(!closing||closing.pending)return{output:prefix,pending:remaining,rest:""};
    const authored=reflectApply(stringSlice,after,[0,closing.start]),closingToken=reflectApply(stringSlice,after,[closing.start,closing.end]);
    const rewritten=state.template_depth>0?`${token}${authored}${closingToken}`:rewriteWrittenScript(parent,token,authored,closingToken);
    return{output:`${prefix}${rewritten}`,pending:"",rest:reflectApply(stringSlice,after,[closing.end])};
  }
  function validateDocumentWriteTrust(inputs,parent){
    if(!trustedHTMLToString)return;
    const probe=inertContextElement(parent);
    for(let index=0;index<inputs.nativeValues.length;index+=1)reflectApply(parserNatives.elementInnerHTML.set,probe,[inputs.nativeValues[index]]);
  }
  function controlledDocumentWrite(receiver,chunks,writeln=false){
    const inputs=markupInputs(chunks);
    if(receiver!==document)throw new NativeDOMException("Document write blocked","SecurityError");
    const current=reflectApply(bootstrapNatives.currentScript.get,receiver,[]),ledger=current&&nodeMetadata.get(current)?.internal_route_values.get(scriptLedgerKey);
    if(!isHTMLScriptElement(current)||ledger?.parser_inserted!==true)throw new NativeDOMException("Document write requires a parser-inserted script","InvalidStateError");
    const parent=nativeParentElement(current)??nativeDocumentBody(document)??nativeDocumentElement(document);
    if(nativeNamespaceURI(parent)!=="http://www.w3.org/1999/xhtml")throw new NativeDOMException("Foreign document writes require a controlled rewrite","SecurityError");
    validateDocumentWriteTrust(inputs,parent);
    const state=documentWriteState(receiver),suffix=writeln?"\n":"",source=`${state.pending}${inputs.source}${suffix}`;
    state.pending="";
    if(source.length>1<<20)throw new NativeDOMException("Document write limit exceeded","QuotaExceededError");
    let remaining=source;
    while(remaining!==""){
      const step=documentWriteStep(remaining,parent,state);
      if(step.output!=="")reflectApply(parserNatives.write,receiver,[runtimeHTML(step.output)]);
      const nestedPending=state.pending;
      state.pending="";
      if(step.pending!==""){state.pending=`${nestedPending}${step.pending}`;break}
      if(nestedPending===""&&step.rest===remaining)throw new NativeDOMException("Document write tokenizer stalled","SecurityError");
      remaining=`${nestedPending}${step.rest}`;
    }
    return undefined;
  }
  function exposeDynamicNonce(script){const current=hydrateMetadata(script)??new PrivateMap;if(!elementMetadata.has(script))elementMetadata.set(script,current);if(!metadataElements.has(script)){metadataElements.add(script);metadataElementCount+=1}if(!current.has("nonce"))current.set("nonce",{attribute:reflectApply(attributeNatives.getAttribute,script,["nonce"]),idl:reflectApply(reflectedNatives.nonce.get,script,[]),url:null,order:visibleAttributeNodes(script).length});ensureNodeMetadata(script).original_nonce=current.get("nonce")?.attribute??null;queueInternalNonceLifecycle(script);reflectApply(natives.setAttribute,script,["nonce",runtimeScript.nonce])}
  function compileDynamicScript(script){
    const kind=dynamicScriptKind(script,false),source=scriptSourceMetadata.has(script)?scriptSourceMetadata.get(script):reflectApply(natives.textContent.get,script,[]),record=ensureNodeMetadata(script),ledger=scriptLedgerRecord(script,"dynamic");
    scriptSourceMetadata.set(script,source);
    if(kind===null){
      reflectApply(natives.textContent.set,script,[source]);
      setNodeScriptState(script,"PREPARED",null,ledger.context);
      return false;
    }
    trustedExecutableNodes.add(script);
    setNodeScriptState(script,"PREPARED",kind,ledger.context);
    setNodeScriptState(script,"COMPILING_INLINE",kind,ledger.context);
    try{
      if(ledger.activation_id!==null){dynamicModuleActivations.delete(ledger.activation_id);ledger.activation_id=null}
      const result=compileResult(source,kind);
      if(kind==="ModuleScript"&&result.module_specifiers.length>0)throw new NativeDOMException("Dynamic module imports require a controlled graph","SecurityError");
      const activationSuffix=kind==="ModuleScript"?`\n;${abiName}.activateDynamicModule(${jsonStringify(registerDynamicModuleActivation(script))});`:"";
      const compiled=executableResultWithMap(source,result,"",parsedInitialTarget.href,activationSuffix);
      reflectApply(natives.textContent.set,script,[compiled]);
      setNodeScriptState(script,"COMPILED",kind,ledger.context);
      return true;
    }catch(error){
      if(ledger.activation_id!==null){dynamicModuleActivations.delete(ledger.activation_id);ledger.activation_id=null}
      reflectApply(natives.textContent.set,script,[source]);
      setNodeScriptState(script,"FAILED",kind,ledger.context);
      throw error;
    }
  }
  function setDynamicScriptSource(script,value){
    const source=NativeString(value),previous=scriptSourceMetadata.get(script),record=ensureNodeMetadata(script),ledger=scriptLedgerRecord(script,"dynamic");
    if(previous!==undefined)for(let node=nativeFirstChild(script);node;node=nativeNextSibling(node))if(isCharacterDataNode(node))detachedScriptText.set(node,previous);
    scriptSourceMetadata.set(script,source);
    if(ledger.context==="markup"||ledger.already_started){
      reflectApply(natives.textContent.set,script,[source]);
      return;
    }
    compileDynamicScript(script);
  }
  function prepareExecutableScript(script){
    const record=ensureNodeMetadata(script),ledger=scriptLedgerRecord(script,"dynamic");
    if(ledger.context==="markup"||ledger.already_started)return;
    if(!isHTMLScriptElement(script))throw new NativeDOMException("Dynamic SVG scripts require a controlled rewrite","SecurityError");
    const external=scriptHasExternalSource(script),kind=dynamicScriptKind(script,external);
    if(kind===null){
      setNodeScriptState(script,"INERT",null,ledger.context);
      return;
    }
    trustedExecutableNodes.add(script);
    if(external){
      setNodeScriptState(script,"PREPARED",kind,ledger.context);
      installScriptLifecycleListeners(script);
      return;
    }
    if(record.script_state!=="COMPILED"||record.source_kind!==kind||kind==="ModuleScript"&&ledger.activation_id===null)compileDynamicScript(script);
    exposeDynamicNonce(script);
    setNodeScriptState(script,"ACTIVATING",kind,ledger.context);
  }
  function prepareExecutableNodes(node){const scripts=scriptNodesIn(node);for(let index=0;index<scripts.length;index+=1)prepareExecutableScript(scripts[index]);trustedExecutableNodes.add(node)}
  function sanitizeBaseAttribute(node,attribute){const visible=reflectApply(natives.attrValue.get,attribute,[]),canonical=canonicalBase(visible);baseMetadata.set(node,canonical);setDynamicAttributeMetadata(node,"href",visible,canonical);reflectApply(natives.attrValue.set,attribute,[safeBaseURL()])}
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
