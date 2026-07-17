export const runtimeSections = [
  { file: import.meta.url, name: "messaging_section_05", order: 5, phase: "inner" },
  { file: import.meta.url, name: "messaging_section_16", order: 16, phase: "inner" },
];

export function messaging_section_05() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  let runtimePort=null,runtimePortReady=false,runtimeCapability="",resolveRuntimeReady,rejectRuntimeReady;
  const runtimePending=new PrivateMap(),runtimeReady=new NativePromise((resolve,reject)=>{resolveRuntimeReady=resolve;rejectRuntimeReady=reject});
  void runtimeReady.catch(()=>{});
  function runtimePortFailure(message="Runtime capability unavailable"){return new NativeDOMException(message,"InvalidStateError")}
  function runtimeCommand(operation,payload,errorMessage,transfers=[]){
    const readiness=operation==="DOCUMENT_COOKIE_MUTATE"||operation==="DOCUMENT_COOKIE_SNAPSHOT"?runtimeReady:runtimeReady.then(()=>cookieBarrier);
    return readiness.then(()=>new NativePromise((resolve,reject)=>{
      const requestID=cookieOperationID(),timeout=setTimeout(()=>{
        runtimePending.delete(requestID);
        reject(runtimePortFailure(errorMessage));
      },30_000);
      runtimePending.set(requestID,{resolve,reject,timeout,errorMessage});
      try{runtimePort.postMessage({v:2,request_id:requestID,operation,payload},transfers)}
      catch{clearTimeout(timeout);runtimePending.delete(requestID);reject(runtimePortFailure(errorMessage))}
    }));
  }
  function runtimeStreamCommand(operation,payload,port,errorMessage){
    return runtimeReady.then(()=>cookieBarrier).then(()=>{
      try{runtimePort.postMessage({v:2,request_id:cookieOperationID(),operation,payload},[port])}
      catch{throw runtimePortFailure(errorMessage)}
    });
  }
  function handleRuntimePortMessage(event){
    const message=event.data;
    if(message?.v===2&&message.operation==="RUNTIME_PORT_READY"){runtimePortReady=true;resolveRuntimeReady();return}
    const pending=runtimePending.get(message?.request_id);
    if(!pending)return;
    runtimePending.delete(message.request_id);clearTimeout(pending.timeout);
    if(message?.v===2&&message.ok===true)pending.resolve(message.result);
    else pending.reject(runtimePortFailure(pending.errorMessage));
  }
  function bindRuntimeCapability(){
    if(cookieRouteID===""){rejectRuntimeReady(runtimePortFailure());return}
    if(runtimeCapability===""||!serviceWorkerController||!NativeMessageChannel)throw runtimePortFailure();
    const channel=new NativeMessageChannel(),port=channel.port1;
    stageMutation(()=>{
      runtimePort=port;
      runtimePort.onmessage=handleRuntimePortMessage;
      runtimePort.onmessageerror=()=>rejectRuntimeReady(runtimePortFailure());
      runtimePort.start?.();
      try{
        serviceWorkerController.postMessage({v:2,command_id:cookieOperationID(),operation:"BIND_RUNTIME_PORT",payload:{runtime_capability:runtimeCapability}},[channel.port2]);
      }catch(error){
        try{runtimePort.close()}catch{}
        try{channel.port2.close()}catch{}
        runtimePort=null;
        throw error;
      }
      return()=>{
        runtimePortReady=false;
        try{runtimePort.onmessage=null;runtimePort.onmessageerror=null;runtimePort.close()}catch{}
        runtimePort=null;
        rejectRuntimeReady(runtimePortFailure());
      };
    });
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}

export function messaging_section_16() {/*__ZERO_PROXY_RUNTIME_SOURCE_START__*/
  function translatedMessageTargetOrigin(value){
    const targetOrigin=value===undefined?"/":`${value}`;
    if(targetOrigin==="*")return"*";
    if(targetOrigin==="/")return rawWindow.location.origin;
    let virtualOrigin;
    try{virtualOrigin=urlProperty(new NativeURL(targetOrigin,visibleBase()),"origin")}
    catch{throw new NativeDOMException("Message target origin is invalid","SecurityError")}
    const translated=virtualToSyntheticOrigins.get(virtualOrigin);
    if(typeof translated!=="string")throw new NativeDOMException("Cross-origin message target is not mapped","SecurityError");
    return translated;
  }
  function controlledPostMessage(message,targetOriginOrOptions,transfer){
    let targetOrigin=targetOriginOrOptions,transferList=transfer;
    if(targetOriginOrOptions!==null&&typeof targetOriginOrOptions==="object"){
      targetOrigin=targetOriginOrOptions.targetOrigin;
      transferList=targetOriginOrOptions.transfer;
    }
    const translated=translatedMessageTargetOrigin(targetOrigin);
    const arguments_=transferList===undefined?[message,translated]:[message,translated,transferList],receiver=rawWindowByFacade.get(this)??this;
    return reflectApply(messageNatives.postMessage,receiver,arguments_);
  }
/*__ZERO_PROXY_RUNTIME_SOURCE_END__*/}
