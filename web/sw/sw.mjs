import { createBoundedRewriteCache } from "../compiler-cache.mjs";
import { decodeCompilerResult, validateCompilerResult } from "../compiler-result.mjs";
import { createPublicError, ERROR_CODES, errorSpecification, normalizeInternalError } from "../generated/errors.mjs";
import { canonicalTarget, classifyRequest, POLICY_VERSION } from "../generated/policy.mjs";
import { decodeHTML } from "./decode.mjs";
import { crossOriginResourcePolicyAllows, documentTrustedTypesPolicyName, generateDocumentCSP, responseIsolationHeaders, xFrameOptionsAllows } from "./document-csp.mjs";
import { createContentAddressedModuleGraph, createTargetServiceWorkerModuleWrapper, createWorkletModuleWrapper } from "./executable-routes.mjs";
import { beginKernelTransaction, exactFrame, validStreamCode, validStreamSequence } from "./kernel-transaction.mjs";
import { createLifecycleAuthority } from "./lifecycle.mjs";
import { createNavigationFailureResponse } from "./navigation-failure.mjs";
import { anchorPingRequestMetadata, formContentTypeMatches, nextSealedOperationRecord, normalizeBeaconBody, normalizeDownloadFilename, normalizePingBody, preserveAttachmentDisposition, serializeRequestOrigin } from "./network-plan-contract.mjs";
import { createRequestLifecycle } from "./request-lifecycle.mjs";
import { createCommandJournal } from "./restart.mjs";
import { ABI_TEMPLATE_IDENTIFIER, compileClassicTemplate, renderClassicTemplate } from "./script-rewrite.mjs";
import { verifyIntegrity } from "./sri.mjs";
import { createTargetWorkerBroker, createTargetWorkerExecutionHost } from "./target-worker/index.mjs";
import { moduleImportRecordMatches, normalizeModuleImport } from "./target-worker/validation.mjs";

const VERSION="2.0.0",DB_NAME="zeroproxy-v2-origin",DB_VERSION=6,TRANSPORT_PERSONA="chrome-149-darwin";
let coordinatorPort=null,originState=null,policyReady=false,kernelReady=false,kernelHandle=null,kernelBindingKey=null,kernelBindingPromise=null,kernelRelayConfigs=null,assetVersion=null,rewriters=null,historyCrypto=null,cookieContext=null,cookieTopLevelSite=null,cookieSequence=0,targetWorkerBroker=null,targetWorkerExecutionHost=null,targetWorkerHostAttachment=null,targetWorkerHostLastAckAt=0;
const encoder=new TextEncoder();
const workerABIIdentifier=/^__zp_abi_[a-f0-9]{48}$/u,workerGatewayID=/^[A-Za-z0-9_-]{32}$/u,workerGatewayToken=/^[A-Za-z0-9_-]{1,16384}$/u;
const TARGET_WORKER_HOST_PATH="/_zp/target-worker-host";
const targetWorkerHostWaiters=new Set();
const workerGatewayLoads=new Map();
const runtimePorts=new Map();
function compilerCacheVersions(){
  const compiler=rewriters?.compiler;
  if(typeof compiler?.compiler_versions_json!=="function")throw new DOMException("Compiler cache ABI unavailable","InvalidStateError");
  const value=JSON.parse(compiler.compiler_versions_json());
  if(!value||value.cache_schema_version!==1||value.result_schema_version!==1||value.abi_version!==1||typeof value.compiler_version!=="string"||typeof value.parser_version!=="string"||!Array.isArray(value.browser_versions)||value.browser_versions.length!==2||value.browser_versions.some(version=>typeof version!=="string"||version.length===0))throw new DOMException("Compiler cache version mismatch","InvalidStateError");
  return value;
}
function staticScriptCacheEntryValid(entry){
  try{
    const versions=compilerCacheVersions();
    const template=validateCompilerResult(entry?.template);
    return entry?.cache_schema_version===versions.cache_schema_version
      &&entry.compiler_version===versions.compiler_version
      &&entry.parser_version===versions.parser_version
      &&entry.result_schema_version===versions.result_schema_version
      &&entry.abi_version===versions.abi_version
      &&entry.browser_grammar_versions===JSON.stringify(versions.browser_versions)
      &&entry.browser_version===(globalThis.__zeroproxyCompatibility?.hash??VERSION)
      &&entry.policy_version===POLICY_VERSION
      &&entry.rewrite_artifact_version===VERSION
      &&entry.abi_template_identifier===ABI_TEMPLATE_IDENTIFIER
      &&template.schema_version===versions.result_schema_version
      &&template.ok===true
      &&Array.isArray(template.abi_identifiers)
      &&Array.isArray(template.abi_slots);
  }catch{return false}
}
const staticScriptRewriteCache=createBoundedRewriteCache({maxEntries:64,maxBytes:16<<20,maxAgeMs:5*60_000,epoch:()=>`${originState?.capability_epoch??0}\0${globalThis.__zeroproxyCompatibility?.hash??VERSION}`,sizeOf:entry=>encoder.encode(JSON.stringify(entry)).byteLength,validate:staticScriptCacheEntryValid});
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});}
function complete(tx){return new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error)});}
function ensureObjectStore(db,name,keyPath){
  if(!db.objectStoreNames.contains(name))return db.createObjectStore(name,{keyPath});
  return null;
}
async function database(){
  const opening=indexedDB.open(DB_NAME,DB_VERSION);
  opening.onupgradeneeded=()=>{
    const db=opening.result;
    for(const [name,keyPath] of [
      ["routes","id"],
      ["clients","client_id"],
      ["history_keys","entry_id"],
      ["meta","key"],
      ["target_worker_journal","key"],
      ["target_worker_cache_index","id"],
      ["coordinator_inbox","id"],
    ])ensureObjectStore(db,name,keyPath);
    const commands=ensureObjectStore(db,"command_journal","id");
    if(commands){
      commands.createIndex("by_state","state",{unique:false});
      commands.createIndex("by_updated","updated_at",{unique:false});
    }
    const requests=ensureObjectStore(db,"request_journal","id");
    if(requests){
      requests.createIndex("by_state","state",{unique:false});
      requests.createIndex("by_updated","updated_at",{unique:false});
    }
  };
  return request(opening);
}
async function readLifecycleMeta(key){
  const db=await database(),tx=db.transaction("meta","readonly"),value=await request(tx.objectStore("meta").get(key));
  await complete(tx);
  return value;
}
async function writeLifecycleMeta(value){
  const db=await database(),tx=db.transaction("meta","readwrite",{durability:"strict"});
  tx.objectStore("meta").put(value);
  await complete(tx);
}
let lifecycleAuthority=null;
function lifecycle(){
  if(lifecycleAuthority)return lifecycleAuthority;
  const compatibility=globalThis.__zeroproxyCompatibility;
  if(!compatibility||typeof compatibility.hash!=="string"||!compatibility.tuple)throw coordinatorFailure("VERSION_MISMATCH");
  lifecycleAuthority=createLifecycleAuthority({
    compatibilityHash:compatibility.hash,
    compatibilityTuple:compatibility.tuple,
    readMeta:readLifecycleMeta,
    writeMeta:writeLifecycleMeta,
    controlledWindowClients:()=>self.clients.matchAll({type:"window",includeUncontrolled:false}),
    claimClients:()=>self.clients.claim(),
  });
  return lifecycleAuthority;
}
async function readCommandRecord(id){
  const db=await database(),tx=db.transaction("command_journal","readonly"),value=await request(tx.objectStore("command_journal").get(id));
  await complete(tx);
  return value;
}
async function writeCommandRecord(value){
  const db=await database(),tx=db.transaction("command_journal","readwrite",{durability:"strict"});
  tx.objectStore("command_journal").put(value);
  await complete(tx);
}
async function trimCommandRecords(){
  const db=await database(),tx=db.transaction("command_journal","readwrite",{durability:"strict"}),store=tx.objectStore("command_journal"),records=await request(store.index("by_updated").getAll());
  const excess=records.length-1024;
  if(excess>0){
    let removed=0;
    for(const record of records){
      if(removed>=excess)break;
      if(record.state==="REPLIED"||record.state==="ROLLED_BACK"){
        store.delete(record.id);
        removed++;
      }
    }
  }
  await complete(tx);
}
let restartCommandJournal=null;
function commandJournal(){
  restartCommandJournal??=createCommandJournal({
    read:readCommandRecord,
    write:writeCommandRecord,
    trim:trimCommandRecords,
  });
  return restartCommandJournal;
}
const requestTerminalStates=new Set(["COMPLETE","POLICY_BLOCKED","ABORTED","TIMED_OUT","TRANSPORT_FAILED","REWRITE_FAILED","CLIENT_GONE","VERSION_MISMATCH"]);
async function trimRequestJournal(store,records){
  let excess=records.length-256;
  if(excess<=0)return;
  for(const record of records){
    if(excess<=0)break;
    if(requestTerminalStates.has(record.state)){store.delete(record.id);excess-=1}
  }
}
async function writeRequestCheckpoint(record){
  const db=await database(),tx=db.transaction("request_journal","readwrite",{durability:"strict"}),store=tx.objectStore("request_journal");
  store.put(record);
  if(requestTerminalStates.has(record.state))await trimRequestJournal(store,await request(store.index("by_updated").getAll()));
  await complete(tx);
}
function recoverDurableRequestResources(record,routeStore,clientStore,historyStore){
  if(!Array.isArray(record.resources))return;
  for(const resource of record.resources){
    if(resource?.type==="route_ids"&&Array.isArray(resource.ids)&&resource.ids.length<=128&&resource.ids.every(id=>workerGatewayID.test(id))){
      for(const id of resource.ids)routeStore.delete(id);
      continue;
    }
    if(resource?.type==="document_binding"&&typeof resource.client_id==="string"&&resource.client_id.length>0&&resource.client_id.length<=256&&workerGatewayID.test(resource.entry_id)){
      clientStore.delete(resource.client_id);
      historyStore.delete(resource.entry_id);
      continue;
    }
    throw coordinatorFailure("DURABLE_REQUEST_RESOURCE_REJECTED");
  }
}
let requestRecoveryPromise=null;
function recoverAbandonedRequests(){
  requestRecoveryPromise??=(async()=>{
    const db=await database(),tx=db.transaction(["request_journal","routes","clients","history_keys"],"readwrite",{durability:"strict"}),store=tx.objectStore("request_journal"),routeStore=tx.objectStore("routes"),clientStore=tx.objectStore("clients"),historyStore=tx.objectStore("history_keys"),records=await request(store.getAll()),updatedAt=Date.now();
    for(const record of records){
      if(requestTerminalStates.has(record.state))continue;
      recoverDurableRequestResources(record,routeStore,clientStore,historyStore);
      const revision=(record.revision??0)+1,checkpoint={state:"CLIENT_GONE",revision,at:updatedAt};
      store.put({...record,state:"CLIENT_GONE",revision,error_code:"SERVICE_WORKER_RESTART",resource_count:0,resources:[],updated_at:updatedAt,checkpoints:[...(record.checkpoints??[]),checkpoint].slice(-16)});
    }
    await trimRequestJournal(store,records);
    await complete(tx);
  })();
  return requestRecoveryPromise;
}
const formHandoffReferrerPolicies=new Set(["","no-referrer","no-referrer-when-downgrade","origin","origin-when-cross-origin","same-origin","strict-origin","strict-origin-when-cross-origin","unsafe-url"]);
function attachedFormSubmission(value){
  if(value===null)return null;
  const fields=["method","content_type","body","body_length","body_sha256","source_url","referrer_policy"];
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(field=>!(field in value))||
    value.method!=="POST"||typeof value.content_type!=="string"||value.content_type.length===0||value.content_type.length>1_024||/[\r\n]/u.test(value.content_type)||
    !["application/x-www-form-urlencoded","multipart/form-data","text/plain"].some(enctype=>formContentTypeMatches(enctype,value.content_type))||
    !(value.body instanceof Uint8Array)||value.body.byteLength>16<<20||value.body_length!==value.body.byteLength||
    typeof value.body_sha256!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(value.body_sha256)||!formHandoffReferrerPolicies.has(value.referrer_policy))throw coordinatorFailure("COMMAND_PAYLOAD_REJECTED");
  let source;
  try{source=new URL(value.source_url)}catch{throw coordinatorFailure("COMMAND_PAYLOAD_REJECTED")}
  if(!["http:","https:"].includes(source.protocol)||source.username||source.password)throw coordinatorFailure("COMMAND_PAYLOAD_REJECTED");
  return value;
}
async function commandPayloadDigest(payload,operation){
  let digestPayload=payload;
  if(operation==="ATTACH_COORDINATOR"){
    const form=attachedFormSubmission(payload?.form_submission);
    if(form!==null){
      const bodyDigest=new Uint8Array(await crypto.subtle.digest("SHA-256",form.body));
      if(encodeBase64URL(bodyDigest)!==form.body_sha256)throw coordinatorFailure("COMMAND_PAYLOAD_REJECTED");
      digestPayload={...payload,form_submission:{...form,body:`sha256:${form.body_sha256}`}};
    }
  }
  const serialized=JSON.stringify(digestPayload),bytes=encoder.encode(serialized);
  if(typeof serialized!=="string"||bytes.byteLength>64<<10)throw coordinatorFailure("COMMAND_PAYLOAD_REJECTED");
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return [...digest].map(value=>value.toString(16).padStart(2,"0")).join("");
}
function randomID(){const bytes=crypto.getRandomValues(new Uint8Array(24));return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}
function randomABI(){return "__zp_abi_"+[...crypto.getRandomValues(new Uint8Array(24))].map(value=>value.toString(16).padStart(2,"0")).join("")}
function failureCode(error,fallback="BOOTSTRAP_FAILED"){return ERROR_CODES.includes(error?.code)?error.code:error?.name==="SecurityError"?"CAPABILITY_REJECTED":error?.name==="NotSupportedError"?"UNKNOWN_OPERATION":error?.name==="TypeError"?"MESSAGE_SCHEMA":fallback}
function reply(port,requestID,ok,result,error){port?.postMessage(ok?{v:2,request_id:requestID,ok:true,result}:{v:2,request_id:requestID,ok:false,error:createPublicError(failureCode(error),requestID)})}
function decodeBase64URL(value){const padded=value.replaceAll("-","+").replaceAll("_","/")+"=".repeat((4-value.length%4)%4);return Uint8Array.from(atob(padded),character=>character.charCodeAt(0))}
function encodeBase64URL(value){const chunks=[];for(let offset=0;offset<value.byteLength;offset+=32<<10)chunks.push(String.fromCharCode(...value.subarray(offset,offset+(32<<10))));return btoa(chunks.join("")).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}
function cssProjectionRoute(route,raw,target){
  if(typeof route!=="string"||route.includes("#")||typeof raw!=="string"||typeof target!=="string")throw new DOMException("CSS projection route rejected","SecurityError");
  const payload=encodeBase64URL(encoder.encode(JSON.stringify({raw,target})));
  return `${route}#zp-css-v2=${payload}`;
}
async function relayAuthKey(capability){const secret=await crypto.subtle.importKey("raw",decodeBase64URL(capability.capability_secret),"HKDF",false,["deriveBits"]),bits=await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:decodeBase64URL(capability.deployment_salt),info:encoder.encode("zeroproxy-carrier-v2")},secret,256);return new Uint8Array(bits)}
async function versionManifest(){if(assetVersion)return assetVersion;assetVersion=await fetch("/_zp/version.json",{cache:"no-store"}).then(response=>{if(!response.ok)throw new DOMException("Version manifest unavailable","NetworkError");return response.json()});const compatibility=globalThis.__zeroproxyCompatibility;if(assetVersion.version!==2||assetVersion.compatibility_hash!==compatibility?.hash||JSON.stringify(assetVersion.compatibility_tuple)!==JSON.stringify(compatibility?.tuple))throw coordinatorFailure("VERSION_MISMATCH");return assetVersion}
async function loadRustModule(name){const version=await versionManifest(),moduleURL=version.selectors?.[`${name}.js`],wasmURL=version.selectors?.[`${name}.wasm`],record=globalThis.__zeroproxyStaticRustModules?.[name];if(!record||record.module_url!==moduleURL||record.wasm_url!==wasmURL||typeof record.module?.default!=="function")throw new DOMException("Rewriter asset missing","InvalidStateError");await record.module.default(record.wasm_url);return record.module}
const coordinatorRequests=new Map();
let coordinatorRevision=null;
function coordinatorFailure(code="COORDINATOR_FAILED"){
  const error=new DOMException(code,"InvalidStateError");
  Object.defineProperty(error,"code",{configurable:true,value:code});
  return error;
}
function coordinatorCall(operation,payload){
  if(!coordinatorPort)return Promise.reject(coordinatorFailure("COORDINATOR_UNAVAILABLE"));
  const requestID=randomID();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{
      coordinatorRequests.delete(requestID);
      reject(coordinatorFailure("COORDINATOR_TIMEOUT"));
    },operation==="CREATE_HANDOFF"&&payload?.form_submission?30_000:10_000);
    coordinatorRequests.set(requestID,{resolve,reject,timeout});
    try{coordinatorPort.postMessage({v:2,request_id:requestID,operation,expected_revision:coordinatorRevision,payload})}
    catch{
      clearTimeout(timeout);
      coordinatorRequests.delete(requestID);
      reject(coordinatorFailure("COORDINATOR_UNAVAILABLE"));
    }
  });
}
async function broadcastCookieCommit(message){
  if(!originState||message.profile_id!==originState.profile_id)return;
  if(message.cookie_seq>cookieSequence)cookieSequence=message.cookie_seq;
  await persistRuntimeProgress();
  const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const client of clients)client.postMessage({v:2,operation:"COOKIE_COMMIT",cookie_seq:message.cookie_seq,op_id:message.op_id,accepted:message.accepted,reason:message.reason,visible_delta:message.visible_delta});
}
function handleCoordinatorMessage(event){
  const message=event.data;
  if(!message||message.v!==2)return;
  if(Number.isSafeInteger(message.revision)&&message.revision>=0){
    coordinatorRevision=Math.max(coordinatorRevision??0,message.revision);
    void persistRuntimeProgress();
  }
  if(typeof message.request_id==="string"){
    const pending=coordinatorRequests.get(message.request_id);
    if(!pending)return;
    coordinatorRequests.delete(message.request_id);
    clearTimeout(pending.timeout);
    if(message.ok===true)pending.resolve(message.result);
    else pending.reject(coordinatorFailure(message.error?.code));
    return;
  }
  if(message.operation==="COOKIE_COMMIT")void broadcastCookieCommit(message);
}
function cookieTargetContext(targetURL,method="GET",isTopLevelNavigation=false){
  const target=new URL(targetURL),top=new URL(cookieTopLevelSite);
  if(target.protocol==="ws:")target.protocol="http:";
  else if(target.protocol==="wss:")target.protocol="https:";
  top.pathname="/";top.search="";top.hash="";
  target.hash="";
  return {request_url:target.href,top_level_site:top.href,is_top_level_navigation:isTopLevelNavigation,method};
}
function cookiePayload(projection,targetURL,knownSeq=cookieSequence,method="GET",isTopLevelNavigation=false){
  if(!cookieContext)throw coordinatorFailure("COOKIE_CONTEXT_UNAVAILABLE");
  return {...cookieContext,known_seq:knownSeq,projection,canonical_target_context:cookieTargetContext(targetURL,method,isTopLevelNavigation)};
}
async function cookieSnapshot(projection,targetURL,knownSeq=cookieSequence,method="GET",isTopLevelNavigation=false){
  const snapshot=await coordinatorCall("COOKIE_SNAPSHOT_REQUEST",cookiePayload(projection,targetURL,knownSeq,method,isTopLevelNavigation));
  if(!snapshot||!Number.isSafeInteger(snapshot.cookie_seq)||snapshot.cookie_seq<knownSeq||!snapshot.jar_or_delta)throw coordinatorFailure("COOKIE_STATE_CORRUPT");
  cookieSequence=snapshot.cookie_seq;
  return snapshot;
}

function closeInactiveRuntimePorts(active) {
  for (const [clientID, port] of runtimePorts) {
    if (active.has(clientID)) continue;
    runtimePorts.delete(clientID);
    try { port.close(); } catch {}
  }
}

function deleteInactiveClients(clientStore, clients, active) {
  for (const client of clients)
    if (!active.has(client.client_id)) clientStore.delete(client.client_id);
}

function revokeInactiveGateways(routeStore, routes, active) {
  for (const route of routes) {
    if (active.has(route?.source_client_id)) continue;
    if (route?.kind === "api" || route?.kind === "sealed-use") {
      routeStore.delete(route.id);
      continue;
    }
    if (route?.kind !== "worker-gateway" || route.lease_active !== true) continue;
    routeStore.put({
      ...route,
      lease_active: false,
      lease_generation: (Number.isSafeInteger(route.lease_generation) ? route.lease_generation : 0) + 1,
    });
  }
}

async function purgeInactiveClientBindings() {
  const active = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .map(client => client.id));
  closeInactiveRuntimePorts(active);
  const db = await database();
  const tx = db.transaction(["clients", "routes"], "readwrite", { durability: "strict" });
  const clientStore = tx.objectStore("clients");
  const routeStore = tx.objectStore("routes");
  const [clients, routes] = await Promise.all([request(clientStore.getAll()), request(routeStore.getAll())]);
  deleteInactiveClients(clientStore, clients, active);
  revokeInactiveGateways(routeStore, routes, active);
  await complete(tx);
}
self.addEventListener("install",event=>{event.waitUntil(lifecycle().install())});
self.addEventListener("activate",event=>{event.waitUntil((async()=>{await lifecycle().activate();await purgeInactiveClientBindings();const db=await database(),tx=db.transaction("meta","readwrite",{durability:"strict"});tx.objectStore("meta").put({key:"compatibility",version:VERSION,policy_version:POLICY_VERSION,compatibility_hash:globalThis.__zeroproxyCompatibility.hash});await complete(tx)})())});

function deleteStaleEpochClients(store, clients) {
  for (const client of clients) {
    if (client.profile_id === originState.profile_id
      && client.origin_id === originState.destination_origin_id
      && client.capability_epoch !== originState.capability_epoch) store.delete(client.client_id);
  }
}

function revokeStaleEpochRoutes(store, routes) {
  for (const route of routes) {
    const routeEpoch=route?.kind==="target-worker-exec"?route.client_epoch:route?.capability_epoch;
    if (route?.profile_id !== originState.profile_id
      || route.origin_id !== originState.destination_origin_id
      || routeEpoch === undefined
      || routeEpoch === originState.capability_epoch) continue;
    store.delete(route.id);
  }
}

function deleteStaleEpochCache(store, records) {
  const prefix = `${originState.profile_id}\0${self.location.origin}\0`;
  const currentEpoch = `\0${originState.capability_epoch}\0`;
  for (const record of records) {
    if (typeof record?.id === "string" && record.id.startsWith(prefix) && !record.id.includes(currentEpoch))
      store.delete(record.id);
  }
}

async function revokeStaleCapabilityEpoch() {
  if (!originState) return;
  targetWorkerExecutionHost?.close();
  targetWorkerExecutionHost = null;
  targetWorkerBroker = null;
  const db = await database();
  const tx = db.transaction(["clients", "routes", "target_worker_cache_index"], "readwrite", { durability: "strict" });
  const clientStore = tx.objectStore("clients");
  const routeStore = tx.objectStore("routes");
  const cacheStore = tx.objectStore("target_worker_cache_index");
  const [clients, routes, cacheRecords] = await Promise.all([
    request(clientStore.getAll()),
    request(routeStore.getAll()),
    request(cacheStore.getAll()),
  ]);
  deleteStaleEpochClients(clientStore, clients);
  revokeStaleEpochRoutes(routeStore, routes);
  deleteStaleEpochCache(cacheStore, cacheRecords);
  await complete(tx);
}
function coordinatorAttachment(event,message){
  if(!event.source?.id||event.ports.length<2)throw new DOMException("Missing capability ports","SecurityError");
  const transferred=event.ports.find(port=>port!==message.replyPort)??event.ports[1],payload=message.payload;
  if(!transferred)throw new DOMException("Missing coordinator port","SecurityError");
  const hostID=self.location.hostname.match(/^o-([a-z2-7]{32})\.browse\./)?.[1];
  if(!payload||!hostID||hostID!==payload.destination_origin_id)throw new DOMException("Host binding mismatch","SecurityError");
  if(!Number.isSafeInteger(payload.coordinator_revision)||payload.coordinator_revision<0)throw new DOMException("Coordinator revision missing","SecurityError");
  return {payload,transferred};
}
async function persistCoordinatorAttachment(clientID){
  const db=await database(),tx=db.transaction(["clients","meta","coordinator_inbox","routes","target_worker_cache_index"],"readwrite",{durability:"strict"}),meta=tx.objectStore("meta"),clientStore=tx.objectStore("clients"),routeStore=tx.objectStore("routes"),cacheStore=tx.objectStore("target_worker_cache_index");
  const [previous,clients,routes,cacheRecords]=await Promise.all([
    request(meta.get("origin_state")),
    request(clientStore.getAll()),
    request(routeStore.getAll()),
    request(cacheStore.getAll()),
  ]);
  const staleEpoch=previous?.profile_id===originState.profile_id&&previous?.origin_id===originState.destination_origin_id&&previous?.capability_epoch!==originState.capability_epoch;
  if(staleEpoch){
    deleteStaleEpochClients(clientStore,clients);
    revokeStaleEpochRoutes(routeStore,routes);
    deleteStaleEpochCache(cacheStore,cacheRecords);
    staticScriptRewriteCache.clear();
  }
  clientStore.put({client_id:clientID,profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,capability_epoch:originState.capability_epoch});
  meta.put({key:"origin_state",...originState});
  meta.put({
    key:"runtime_snapshot",
    profile_id:originState.profile_id,
    origin_id:originState.destination_origin_id,
    capability_epoch:originState.capability_epoch,
    coordinator_revision:coordinatorRevision,
    cookie_context:cookieContext,
    cookie_top_level_site:cookieTopLevelSite,
    cookie_seq:cookieSequence,
    compatibility_hash:globalThis.__zeroproxyCompatibility.hash,
  });
  tx.objectStore("coordinator_inbox").delete("reattach");
  await complete(tx);
  return staleEpoch;
}
function restoreCoordinatorRuntime(previousRuntime,transferred){
  if(coordinatorPort===transferred)try{transferred.close()}catch{}
  coordinatorPort=previousRuntime.coordinatorPort;
  coordinatorRevision=previousRuntime.coordinatorRevision;
  originState=previousRuntime.originState;
  cookieContext=previousRuntime.cookieContext;
  cookieTopLevelSite=previousRuntime.cookieTopLevelSite;
  cookieSequence=previousRuntime.cookieSequence;
}
async function attachCoordinator(event,message){
  const {payload,transferred}=coordinatorAttachment(event,message),previousRuntime={coordinatorPort,coordinatorRevision,originState,cookieContext,cookieTopLevelSite,cookieSequence};
  try{
    await lifecycle().coldStart();
    await lifecycle().beginHydration(payload);
    coordinatorPort=transferred;
    coordinatorRevision=payload.coordinator_revision;
    coordinatorPort.onmessage=handleCoordinatorMessage;
    coordinatorPort.start();
    originState=Object.freeze({...payload,bootstrap_client_id:event.source.id});
    const createdCookieContext=await coordinatorCall("CREATE_COOKIE_CONTEXT",{
      profile_id:originState.profile_id,
      origin_id:originState.destination_origin_id,
      tab_id:originState.tab_id,
      capability_epoch:originState.capability_epoch,
    });
    if(typeof createdCookieContext?.top_level_site!=="string"||createdCookieContext.top_level_site.length===0)throw coordinatorFailure("COOKIE_CONTEXT_UNAVAILABLE");
    cookieTopLevelSite=createdCookieContext.top_level_site;
    cookieContext=Object.freeze({
      profile_id:createdCookieContext.profile_id,
      origin_id:createdCookieContext.origin_id,
      tab_id:createdCookieContext.tab_id,
      capability_epoch:createdCookieContext.capability_epoch,
      cookie_capability:createdCookieContext.cookie_capability,
    });
    cookieSequence=0;
    if(await persistCoordinatorAttachment(event.source.id))await revokeStaleCapabilityEpoch();
    if(previousRuntime.coordinatorPort&&previousRuntime.coordinatorPort!==transferred)try{previousRuntime.coordinatorPort.close()}catch{}
    return {attached:true};
  }catch(error){
    restoreCoordinatorRuntime(previousRuntime,transferred);
    throw error;
  }
}
function targetWorkerBinding(){
  const capability=relayProfileBindings()[0].capability;
  if(!originState||typeof originState.profile_id!=="string"||!Number.isSafeInteger(originState.capability_epoch)||originState.capability_epoch<1||typeof capability.capability_id!=="string")throw new DOMException("Target worker capability unavailable","SecurityError");
  return Object.freeze({profile_id:originState.profile_id,synthetic_origin:self.location.origin,client_epoch:originState.capability_epoch,capability:capability.capability_id});
}
function targetWorkerBindingMatches(left,right){
  return left?.profile_id===right.profile_id&&left?.synthetic_origin===right.synthetic_origin&&left?.client_epoch===right.client_epoch&&left?.capability===right.capability;
}
function targetWorkerVersionBinding(message){
  const binding=message?.binding,registrationID=message?.registration_id??binding?.registration_id,workerVersion=message?.worker_version??binding?.worker_version;
  if(!targetWorkerBindingMatches(binding,targetWorkerBinding())||typeof registrationID!=="string"||registrationID.length===0||typeof workerVersion!=="string"||workerVersion.length===0)throw new DOMException("Target worker binding rejected","SecurityError");
  return Object.freeze({...targetWorkerBinding(),registration_id:registrationID,worker_version:workerVersion});
}
function targetWorkerJournalPayload(binding,fields={}){
  if(!cookieContext||!targetWorkerBindingMatches(binding,targetWorkerBinding()))throw new DOMException("Target worker coordinator context unavailable","SecurityError");
  return {...cookieContext,binding,...fields};
}
async function targetWorkerMirror(result){
  if(!Number.isSafeInteger(result?.revision)||result.revision<0||!targetWorkerBindingMatches(result?.state?.binding,targetWorkerBinding()))throw new DOMException("Target worker coordinator journal corrupt","SecurityError");
  const db=await database(),tx=db.transaction("target_worker_journal","readwrite",{durability:"strict"});
  tx.objectStore("target_worker_journal").put({key:"broker",revision:result.revision,state:result.state});
  await complete(tx);
  return result;
}
async function targetWorkerJournalLoad(message){
  const binding=message?.binding;
  if(!targetWorkerBindingMatches(binding,targetWorkerBinding()))throw new DOMException("Target worker journal binding rejected","SecurityError");
  if(!coordinatorPort&&durableTargetWorkerState){
    const local={revision:durableTargetWorkerState.revision,state:structuredClone(durableTargetWorkerState.state)};
    if(!Number.isSafeInteger(local.revision)||!targetWorkerBindingMatches(local.state?.binding,targetWorkerBinding()))throw new DOMException("Target worker mirror corrupt","SecurityError");
    return local;
  }
  const result=await coordinatorCall("TARGET_WORKER_JOURNAL_LOAD",targetWorkerJournalPayload(binding));
  return targetWorkerMirror(result);
}
async function targetWorkerJournalCompareAndSwap(message){
  const binding=message?.binding;
  if(!targetWorkerBindingMatches(binding,targetWorkerBinding())||!Number.isSafeInteger(message.expected_revision)||message.expected_revision<0||typeof message.operation_id!=="string"||message.operation_id.length===0||!targetWorkerBindingMatches(message.operation_binding,targetWorkerBinding())||!targetWorkerBindingMatches(message.state?.binding,targetWorkerBinding()))throw new DOMException("Target worker journal write rejected","SecurityError");
  const result=await coordinatorCall("TARGET_WORKER_JOURNAL_CAS",targetWorkerJournalPayload(binding,{
    expected_revision:message.expected_revision,
    operation_id:message.operation_id,
    operation_binding:message.operation_binding,
    state:message.state,
  }));
  return targetWorkerMirror(result);
}
async function targetWorkerJournalHydrate(message){
  const binding=targetWorkerVersionBinding(message),loaded=await targetWorkerJournalLoad({binding}),registration=loaded.state.registrations?.find(value=>value.registration_id===binding.registration_id),version=registration?.versions?.find(value=>value.worker_version===binding.worker_version);
  if(!version||version.graph?.graph_hash!==message.graph_hash)throw new DOMException("Target worker graph unavailable","SecurityError");
  return {binding,graph_hash:version.graph.graph_hash};
}
function targetWorkerExecutableURL(hash){return buildPolicyExecutableRoute("target-worker",hash)}
async function persistTargetWorkerExecutable(record){
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"});
  tx.objectStore("routes").put(record);
  await complete(tx);
}
async function readTargetWorkerExecutable(hash){
  if(!/^[a-f0-9]{64}$/u.test(hash))return null;
  const db=await database(),tx=db.transaction("routes","readonly"),record=await request(tx.objectStore("routes").get(`target-worker-exec:${hash}`));
  await complete(tx);
  if(!record||record.kind!=="target-worker-exec"||record.expires_at<=Date.now()||record.profile_id!==originState?.profile_id||record.tab_id!==originState?.tab_id||record.entry_id!==originState?.entry_id||record.origin_id!==originState?.destination_origin_id||record.capability!==targetWorkerBinding().capability||record.client_epoch!==targetWorkerBinding().client_epoch||record.graph_hash!==hash||typeof record.source!=="string")return null;
  return record;
}
async function serveTargetWorkerExecutable(hash,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("TARGET_WORKER_EXECUTABLE_METHOD",400);
  const record=await readTargetWorkerExecutable(hash);
  if(!record)return blocked("TARGET_WORKER_EXECUTABLE_UNAVAILABLE",410);
  return new Response(record.source,{status:200,headers:{"Cache-Control":"no-store","Content-Type":"text/javascript;charset=utf-8","Cross-Origin-Resource-Policy":"same-origin"}});
}
function targetWorkerClassicGatewayRecordMatches(value,gateway){
  return workerRouteBound(gateway)&&gateway.kind==="worker-gateway"&&gateway.lease_active===true&&gateway.gateway_key===value.key&&gateway.lease_generation===value.lease_generation&&gateway.expires_at===value.expires_at&&gateway.source_kind==="TargetServiceWorkerClassic"&&Array.isArray(gateway.certified_imports)&&gateway.certified_imports.length<=64;
}
function targetWorkerCertificateURL(value,origin){
  let parsed;
  try{parsed=new URL(value)}catch{return false}
  return parsed.origin===origin&&!parsed.username&&!parsed.password&&!parsed.hash;
}
function targetWorkerClassicCertificatesMatch(gateway,updateResources){
  if(!Array.isArray(updateResources))return false;
  const resources=new Set(),importResources=[];
  for(const resource of updateResources){
    if(!resource||typeof resource.url!=="string"||typeof resource.hash!=="string"||!/^[a-f0-9]{64}$/u.test(resource.hash))return false;
    resources.add(`${resource.url}\0${resource.hash}`);
    if(resource.role==="import")importResources.push(resource);
  }
  const requests=new Set(),certifiedResources=new Set();
  for(const certificate of gateway.certified_imports){
    const valid=certificate&&typeof certificate.request_url==="string"&&typeof certificate.final_url==="string"&&typeof certificate.source_hash==="string"&&typeof certificate.compiled_hash==="string"&&/^[a-f0-9]{64}$/u.test(certificate.source_hash)&&/^[a-f0-9]{64}$/u.test(certificate.compiled_hash);
    if(!valid||requests.has(certificate.request_url)||!resources.has(`${certificate.final_url}\0${certificate.source_hash}`)||!targetWorkerCertificateURL(certificate.request_url,gateway.target_origin)||!targetWorkerCertificateURL(certificate.final_url,gateway.target_origin))return false;
    requests.add(certificate.request_url);
    certifiedResources.add(`${certificate.final_url}\0${certificate.source_hash}`);
  }
  return !importResources.some(resource=>!certifiedResources.has(`${resource.url}\0${resource.hash}`));
}
async function readTargetWorkerClassicGateway(value,updateResources){
  if(!value||typeof value!=="object"||!workerGatewayID.test(value.id)||!workerGatewayID.test(value.key)||!Number.isSafeInteger(value.lease_generation)||value.lease_generation<1||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Date.now())return null;
  const db=await database(),tx=db.transaction("routes","readonly"),gateway=await request(tx.objectStore("routes").get(value.id));
  await complete(tx);
  return targetWorkerClassicGatewayRecordMatches(value,gateway)&&targetWorkerClassicCertificatesMatch(gateway,updateResources)?gateway:null;
}
async function targetWorkerRewriteGraph(message){
  const binding=targetWorkerVersionBinding(message),graph=message?.graph;
  if(!graph||!["classic","module"].includes(graph.type)||typeof graph.graph_hash!=="string"||!/^[a-f0-9]{64}$/u.test(graph.graph_hash)||!Array.isArray(graph.resources)||graph.resources.length!==1)throw new DOMException("Target worker graph invalid","SecurityError");
  const resource=graph.resources[0],expectedURL=targetWorkerExecutableURL(graph.graph_hash);
  if(!resource||resource.hash!==graph.graph_hash||resource.module_url!==expectedURL||typeof resource.url!=="string")throw new DOMException("Target worker graph resource invalid","SecurityError");
  const executable=await readTargetWorkerExecutable(graph.graph_hash);
  if(!executable||executable.script_url!==resource.url)throw new DOMException("Target worker executable unavailable","SecurityError");
  if(graph.type==="module"){
    if(!workerGatewayID.test(graph.module_graph_id)||!workerABIIdentifier.test(graph.abi_identifier)||graph.abi_identifier!==executable.abi_identifier||typeof graph.module_referrer!=="string")throw new DOMException("Target worker module graph invalid","SecurityError");
    return {binding,abi_identifier:graph.abi_identifier,graph_hash:graph.graph_hash,module_graph_id:graph.module_graph_id,module_referrer:graph.module_referrer,resources:[{hash:graph.graph_hash,module_url:expectedURL,url:resource.url}],type:"module"};
  }
  const gateway=await readTargetWorkerClassicGateway(graph.classic_gateway,graph.update_resources);
  if(!gateway||gateway.abi_identifier!==executable.abi_identifier)throw new DOMException("Target worker executable unavailable","SecurityError");
  return {binding,classic_gateway:{expires_at:gateway.expires_at,id:gateway.id,key:gateway.gateway_key,lease_generation:gateway.lease_generation},graph_hash:graph.graph_hash,resources:[{hash:graph.graph_hash,module_url:expectedURL,url:resource.url}],type:"classic"};
}
async function controlledTargetWorkerFallback(input){
  const fallback=targetWorkerFallbacks.get(input?.event_id);
  if(!fallback)throw new DOMException("Target worker fallback unavailable","NetworkError");
  return fallback(input);
}
const targetWorkerFallbacks=new Map();
const targetWorkerNativeFetchFailures=new WeakSet();
const targetWorkerNavigationHandoffs=new WeakSet();
function exactTargetWorkerHostSource(source){
  if(!source?.id||source.type!=="window"||typeof source.url!=="string")return false;
  try{
    const url=new URL(source.url);
    return url.origin===self.location.origin&&url.pathname===TARGET_WORKER_HOST_PATH&&!url.search&&!url.hash;
  }catch{return false}
}
function targetWorkerHostBinding(event,payload){
  const expected=targetWorkerBinding();
  if(!exactTargetWorkerHostSource(event.source)||!payload||typeof payload!=="object"||Array.isArray(payload)
    ||Object.keys(payload).length!==4||payload.profile_id!==expected.profile_id
    ||payload.synthetic_origin!==expected.synthetic_origin||payload.client_epoch!==expected.client_epoch
    ||typeof payload.capability!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(payload.capability)){
    throw new DOMException("Target worker host capability rejected","SecurityError");
  }
  return Object.freeze({
    profile_id:payload.profile_id,
    synthetic_origin:payload.synthetic_origin,
    client_epoch:payload.client_epoch,
    capability:payload.capability,
    source_client_id:event.source.id,
  });
}
function targetWorkerHostReady(){
  if(!targetWorkerExecutionHost||!targetWorkerBroker||!targetWorkerHostAttachment)return false;
  let expected;
  try{expected=targetWorkerBinding()}catch{return false}
  return targetWorkerHostAttachment.profile_id===expected.profile_id
    &&targetWorkerHostAttachment.synthetic_origin===expected.synthetic_origin
    &&targetWorkerHostAttachment.client_epoch===expected.client_epoch
    &&targetWorkerBindingMatches(targetWorkerExecutionHost.binding,expected)
    &&Number.isSafeInteger(targetWorkerHostLastAckAt)&&targetWorkerHostLastAckAt>0;
}
function invalidateTargetWorkerHost(executionHost=targetWorkerExecutionHost){
  if(executionHost!==targetWorkerExecutionHost)return;
  try{executionHost?.close()}catch{}
  targetWorkerExecutionHost=null;
  targetWorkerBroker=null;
  targetWorkerHostAttachment=null;
  targetWorkerHostLastAckAt=0;
}
async function confirmTargetWorkerHost(){
  if(!targetWorkerHostReady())return false;
  const executionHost=targetWorkerExecutionHost,attachment=targetWorkerHostAttachment;
  try{
    await executionHost.ping();
    if(executionHost!==targetWorkerExecutionHost||attachment!==targetWorkerHostAttachment)return false;
    targetWorkerHostLastAckAt=Date.now();
    return true;
  }catch{
    invalidateTargetWorkerHost(executionHost);
    return false;
  }
}
function resolveTargetWorkerHostWaiters(){
  if(!targetWorkerHostReady())return;
  for(const waiter of targetWorkerHostWaiters){
    clearTimeout(waiter.timer);
    waiter.resolve({attached:true,client_epoch:targetWorkerHostAttachment.client_epoch});
  }
  targetWorkerHostWaiters.clear();
}
async function waitTargetWorkerHost(){
  if(await confirmTargetWorkerHost())return {attached:true,client_epoch:targetWorkerHostAttachment.client_epoch};
  return new Promise((resolve,reject)=>{
    const waiter={resolve,reject,timer:null};
    waiter.timer=setTimeout(()=>{
      targetWorkerHostWaiters.delete(waiter);
      reject(new DOMException("Target worker host unavailable","TimeoutError"));
    },12_000);
    targetWorkerHostWaiters.add(waiter);
  });
}
async function probeTargetWorkerHost(event,message){
  const hostBinding=targetWorkerHostBinding(event,message.payload);
  if(!targetWorkerHostReady()
    ||targetWorkerHostAttachment.source_client_id!==hostBinding.source_client_id
    ||targetWorkerHostAttachment.capability!==hostBinding.capability)return {attached:false};
  return {attached:await confirmTargetWorkerHost()};
}
async function attachTargetWorkerHost(event,message){
  if(event.ports.length<2)throw new DOMException("Missing target worker capability port","SecurityError");
  const hostBinding=targetWorkerHostBinding(event,message.payload);
  if(targetWorkerHostReady()&&(targetWorkerHostAttachment.source_client_id!==hostBinding.source_client_id
    ||targetWorkerHostAttachment.capability!==hostBinding.capability)
    &&await confirmTargetWorkerHost()){
    throw new DOMException("Target worker host already attached","InvalidStateError");
  }
  const privatePort=event.ports.find(port=>port!==message.replyPort);
  if(!privatePort)throw new DOMException("Missing target worker capability port","SecurityError");
  const binding=targetWorkerBinding();
  let executionHost=null;
  try{
    await targetWorkerJournalLoad({binding});
    executionHost=createTargetWorkerExecutionHost({
      binding,
      capabilities:{dispatch:targetWorkerHostCapability},
      privatePort,
      journal:{hydrateVersion:targetWorkerJournalHydrate},
      compiler:{rewriteGraph:targetWorkerRewriteGraph},
    });
    await executionHost.ping();
    const broker=createTargetWorkerBroker({
      binding,
      targetOrigin:new URL(originState.target_url).origin,
      journal:{load:targetWorkerJournalLoad,compareAndSwap:targetWorkerJournalCompareAndSwap},
      host:executionHost.host,
      clientCommands:{command:targetWorkerClientCommand},
      controlledFetch:controlledTargetWorkerFallback,
    });
    executionHost.attachBroker(broker);
    invalidateTargetWorkerHost();
    targetWorkerExecutionHost=executionHost;
    targetWorkerBroker=broker;
    targetWorkerHostAttachment=hostBinding;
    targetWorkerHostLastAckAt=Date.now();
    resolveTargetWorkerHostWaiters();
    return {attached:true,client_epoch:binding.client_epoch};
  }catch(error){
    try{executionHost?.close()}catch{}
    try{privatePort.close()}catch{}
    throw error;
  }
}
async function dispatchTargetWorkerLifecycle(payload){
  if(!await confirmTargetWorkerHost()||!payload||typeof payload!=="object"||typeof payload.event_type!=="string")throw new DOMException("Target worker host unavailable","InvalidStateError");
  return targetWorkerExecutionHost.dispatchRootEvent({event_type:payload.event_type,dispatch:payload});
}
function targetServiceWorkerOperationID(value){
  if(typeof value!=="string"||value.length<16||value.length>240)throw new DOMException("Invalid target service worker operation id","SecurityError");
  return value;
}
function targetServiceWorkerURL(value,label){
  if(typeof value!=="string"||value.length===0||value.length>16_384)throw new DOMException(`Invalid ${label}`,"SecurityError");
  const target=new URL(value,originState.target_url),origin=new URL(originState.target_url).origin;
  if(target.origin!==origin||target.username||target.password||target.hash)throw new DOMException(`Target service worker ${label} rejected`,"SecurityError");
  return target;
}
async function targetServiceWorkerDigest(value){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",typeof value==="string"?encoder.encode(value):value));
  return [...digest].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
async function targetServiceWorkerUpdateDigest(type,resources){
  const canonical=resources.map(resource=>({hash:resource.hash,module_type:resource.module_type??"javascript",url:resource.url})).sort((left,right)=>left.url.localeCompare(right.url)||left.module_type.localeCompare(right.module_type)||left.hash.localeCompare(right.hash));
  return targetServiceWorkerDigest(JSON.stringify({resources:canonical,type}));
}
function targetServiceWorkerConditionalHeaders(payload,scriptURL){
  const headers=[["Accept","text/javascript,application/javascript,*/*;q=0.8"]],root=payload?.previous_graph?.update_resources?.find(resource=>resource?.role==="root"&&resource.url===scriptURL);
  if(typeof root?.etag==="string"&&root.etag.length<=8192&&!/[\r\n]/u.test(root.etag))headers.push(["If-None-Match",root.etag]);
  if(typeof root?.last_modified==="string"&&root.last_modified.length<=8192&&!/[\r\n]/u.test(root.last_modified))headers.push(["If-Modified-Since",root.last_modified]);
  return headers;
}
async function fetchTargetServiceWorkerScript(route){
  const responseChainID=`target-sw:${randomID()}`;
  let current=route;
  for(let hop=0;hop<20;hop+=1){
    const result=await kernelFetch(current,null);
    await applyResponseCookies(current,result,responseChainID);
    if(result.redirect?.is_redirect!==true)return {result,route:current};
    const location=result.redirect.location;
    await discardKernelBody(result);
    if(typeof location!=="string"||location===""||hop===19)throw new DOMException("Target service worker redirect rejected","NetworkError");
    const target=targetServiceWorkerURL(new URL(location,current.target_url).href,"redirect URL");
    current={...current,request_headers:current.request_headers.filter(([name])=>!["if-none-match","if-modified-since"].includes(name.toLowerCase())),source_url:current.target_url,target_url:target.href};
  }
  throw new DOMException("Target service worker redirect rejected","NetworkError");
}
async function targetServiceWorkerClassicContent({abiIdentifier,forceBypass,loaded,resources,rootRoute,target,updateViaCache}){
  const requestRoute={...rootRoute,id:randomID(),target_url:target.href,source_url:rootRoute.target_url,request_headers:[["Accept","text/javascript,application/javascript,*/*;q=0.8"]],cache:forceBypass||updateViaCache==="none"?"no-cache":"default"},fetched=await fetchTargetServiceWorkerScript(requestRoute),materialized=await materializeKernelResult(fetched.result);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Target service worker importScripts unavailable","NetworkError");
  const source=workerJavaScriptSource(fetched.route,materialized),sourceHash=await targetServiceWorkerDigest(source),existing=loaded.get(fetched.route.target_url);
  if(existing){
    if(existing.source_hash!==sourceHash)throw new DOMException("Target service worker importScripts changed during update","NetworkError");
    return existing;
  }
  let imported;
  try{imported=decodeCompilerResult(rewriters.compiler.compile_json(source,"TargetServiceWorkerClassic",abiIdentifier))}catch{throw new DOMException("Target service worker importScripts compilation failed","SecurityError")}
  if(imported.ok!==true||imported.code.length===0||encoder.encode(imported.code).byteLength>1<<20)throw new DOMException("Target service worker importScripts compilation rejected","SecurityError");
  const content={compiled:imported,compiled_hash:await targetServiceWorkerDigest(imported.code),final_url:fetched.route.target_url,source_hash:sourceHash},etag=headerValue(materialized.headers,"etag"),lastModified=headerValue(materialized.headers,"last-modified");
  loaded.set(fetched.route.target_url,content);
  resources.push({hash:sourceHash,module_type:"javascript",role:"import",url:fetched.route.target_url,...(etag?{etag}:{}),...(lastModified?{last_modified:lastModified}:{})});
  return content;
}
async function targetServiceWorkerClassicUpdateResources({abiIdentifier,compiled,forceBypass,rootResource,rootRoute,updateViaCache}){
  const resources=[rootResource],imports=[],requested=new Set(),loaded=new Map([[rootResource.url,{compiled,compiled_hash:await targetServiceWorkerDigest(compiled.code),final_url:rootResource.url,source_hash:rootResource.hash}]]),pending=compiled.module_specifiers.map(specifier=>({depth:1,specifier:specifier.specifier}));
  while(pending.length){
    const next=pending.shift();
    if(next.depth>16||imports.length>=64)throw new DOMException("Target service worker importScripts graph rejected","QuotaExceededError");
    const target=targetServiceWorkerURL(new URL(next.specifier,rootRoute.target_url).href,"importScripts URL");
    if(requested.has(target.href))continue;
    requested.add(target.href);
    const content=await targetServiceWorkerClassicContent({abiIdentifier,forceBypass,loaded,resources,rootRoute,target,updateViaCache});
    imports.push({compiled_hash:content.compiled_hash,final_url:content.final_url,request_url:target.href,source:content.compiled.code,source_hash:content.source_hash});
    for(const specifier of content.compiled.module_specifiers)pending.push({depth:next.depth+1,specifier:specifier.specifier});
  }
  return {imports,resources};
}
async function persistTargetServiceWorkerClassicImports({abiIdentifier,expiresAt,gateway,imports,rootRoute}){
  for(const imported of imports){
    await persistWorkerExecutable({id:await workerGatewayResolutionID(gateway,"classic",imported.request_url),kind:"worker-gateway-classic",profile_id:rootRoute.profile_id,tab_id:rootRoute.tab_id,entry_id:rootRoute.entry_id,origin_id:rootRoute.origin_id,source_client_id:rootRoute.source_client_id,capability_epoch:originState.capability_epoch,abi_identifier:abiIdentifier,gateway_id:gateway.id,lease_generation:gateway.lease_generation,compiled_hash:imported.compiled_hash,source_hash:imported.source_hash,final_url:imported.final_url,source:imported.source,target_url:imported.request_url,expires_at:expiresAt});
  }
}
async function createTargetServiceWorkerModuleGraph({abiIdentifier,binding,etag,expiresAt,fetched,forceBypass,lastModified,script,source,updateViaCache}){
  const graphID=randomID(),moduleRoute={...fetched.route,abi_identifier:abiIdentifier,cache:forceBypass||updateViaCache==="none"?"no-cache":"default",expires_at:expiresAt},root=await createTargetServiceWorkerModuleRoutes(moduleRoute,source,fetched.route.target_url,graphID),updateResources=root.update_resources.map(resource=>resource.role==="root"?{...resource,...(etag?{etag}:{}),...(lastModified?{last_modified:lastModified}:{})}:resource),updateHash=await targetServiceWorkerUpdateDigest("module",updateResources),executable=createTargetServiceWorkerModuleWrapper(abiIdentifier,root.url),hash=await targetServiceWorkerDigest(executable);
  await persistTargetWorkerExecutable({id:`target-worker-exec:${hash}`,kind:"target-worker-exec",profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,capability:binding.capability,client_epoch:binding.client_epoch,abi_identifier:abiIdentifier,graph_hash:hash,module_type:"javascript",script_url:fetched.route.target_url,source:executable,expires_at:expiresAt});
  return {script_url:script.href,graph:{abi_identifier:abiIdentifier,graph_hash:hash,module_graph_id:graphID,module_referrer:fetched.route.target_url,type:"module",update_hash:updateHash,update_resources:updateResources,resources:[{url:fetched.route.target_url,hash,module_url:targetWorkerExecutableURL(hash)}]}};
}
async function createTargetServiceWorkerClassicGraph({abiIdentifier,binding,etag,expiresAt,fetched,forceBypass,lastModified,script,source,sourceClient,updateViaCache}){
  let compiled;
  try{compiled=decodeCompilerResult(rewriters.compiler.compile_json(source,"TargetServiceWorkerClassic",abiIdentifier))}catch{throw new DOMException("Target service worker compilation failed","SecurityError")}
  if(compiled.ok!==true||compiled.code.length===0||encoder.encode(compiled.code).byteLength>1<<20||/\bimport\s*\(/u.test(compiled.code))throw new DOMException("Target service worker compilation rejected","SecurityError");
  const sourceHash=await targetServiceWorkerDigest(source),rootResource={hash:sourceHash,module_type:"javascript",role:"root",url:fetched.route.target_url,...(etag?{etag}:{}),...(lastModified?{last_modified:lastModified}:{})},gateway=Object.freeze({id:randomID(),key:randomID(),lease_generation:1,expires_at:expiresAt}),classicGraph=await targetServiceWorkerClassicUpdateResources({abiIdentifier,compiled,forceBypass,rootResource,rootRoute:fetched.route,updateViaCache}),updateResources=classicGraph.resources,updateHash=await targetServiceWorkerUpdateDigest("classic",updateResources),executable=`export async function install(scope){const ${abiIdentifier}=Object.freeze({scope});Object.defineProperty(globalThis,${JSON.stringify(abiIdentifier)},{configurable:false,enumerable:false,writable:false,value:${abiIdentifier}});\n${compiled.code}\n}`,hash=await targetServiceWorkerDigest(executable);
  await persistTargetWorkerExecutable({id:`target-worker-exec:${hash}`,kind:"target-worker-exec",profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,capability:binding.capability,client_epoch:binding.client_epoch,abi_identifier:abiIdentifier,gateway_id:gateway.id,graph_hash:hash,module_type:"javascript",script_url:fetched.route.target_url,source:executable,expires_at:expiresAt});
  await persistWorkerExecutable({id:gateway.id,kind:"worker-gateway",profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,source_client_id:sourceClient.client_id,capability_epoch:originState.capability_epoch,abi_identifier:abiIdentifier,gateway_key:gateway.key,lease_active:true,lease_generation:gateway.lease_generation,target_origin:script.origin,target_url:fetched.route.target_url,source_url:originState.target_url,source_kind:"TargetServiceWorkerClassic",credentials:"include",cache:forceBypass||updateViaCache==="none"?"no-cache":"default",certified_imports:classicGraph.imports.map(({compiled_hash,final_url,request_url,source_hash})=>({compiled_hash,final_url,request_url,source_hash})),expires_at:expiresAt});
  await persistTargetServiceWorkerClassicImports({abiIdentifier,expiresAt,gateway,imports:classicGraph.imports,rootRoute:fetched.route});
  return {script_url:script.href,graph:{classic_gateway:gateway,graph_hash:hash,type:"classic",update_hash:updateHash,update_resources:updateResources,resources:[{url:fetched.route.target_url,hash,module_url:targetWorkerExecutableURL(hash)}]}};
}
async function targetServiceWorkerGraph(payload,sourceClientID){
  const type=payload?.type??"classic",updateViaCache=payload?.update_via_cache??"imports";
  if(!["classic","module"].includes(type))throw new DOMException("Target service worker type rejected","NotSupportedError");
  if(!["all","imports","none"].includes(updateViaCache))throw new DOMException("Target service worker updateViaCache rejected","TypeError");
  const sourceClient=await authorizeDocumentClient(sourceClientID),script=targetServiceWorkerURL(payload?.script_url,"script URL"),forceBypass=payload?.force_bypass===true,route={
    profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,source_client_id:sourceClient.client_id,
    target_url:script.href,source_url:originState.target_url,kind:"worker",method:"GET",request_headers:targetServiceWorkerConditionalHeaders(payload,script.href),
    body_expected:false,credentials:"include",redirect:"manual",integrity:null,cors_mode:null,cache:forceBypass||updateViaCache!=="all"?"no-cache":"default",causal_after_seq:cookieSequence,
  };
  await warmRewriters();
  const fetched=await fetchTargetServiceWorkerScript(route);
  if(fetched.result.status===304){
    await discardKernelBody(fetched.result);
    const previous=payload?.previous_graph;
    if(!previous||previous.type!==type||typeof previous.update_hash!=="string"||!Array.isArray(previous.update_resources))throw new DOMException("Target service worker validator state rejected","SecurityError");
    return {graph:structuredClone(previous),not_modified:true,script_url:script.href};
  }
  const materialized=await materializeKernelResult(fetched.result);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Target service worker unavailable","NetworkError");
  const context={abiIdentifier:randomABI(),binding:targetWorkerBinding(),etag:headerValue(materialized.headers,"etag"),expiresAt:Date.now()+30*24*60*60*1000,fetched,forceBypass,lastModified:headerValue(materialized.headers,"last-modified"),script,source:workerJavaScriptSource(fetched.route,materialized),sourceClient,updateViaCache};
  return type==="module"?createTargetServiceWorkerModuleGraph(context):createTargetServiceWorkerClassicGraph(context);
}
const publicTargetWorkerStates=Object.freeze({
  INSTALLING:"installing",
  INSTALLED_WAITING:"installed",
  ACTIVATING:"activating",
  ACTIVE:"activated",
  REDUNDANT:"redundant",
});
function publicTargetServiceWorkerVersion(version){
  return version?{id:version.worker_version,scriptURL:version.script_url,state:publicTargetWorkerStates[version.state],state_revision:version.state_revision}:null;
}
function publicTargetServiceWorker(registration){
  if(!registration)return null;
  const version=id=>id?registration.versions.find(candidate=>candidate.worker_version===id):null;
  return {
    id:registration.registration_id,
    scope:registration.scope_url,
    scriptURL:registration.script_url,
    updateViaCache:registration.update_via_cache,
    type:registration.type,
    installing:publicTargetServiceWorkerVersion(version(registration.installing_version)),
    waiting:publicTargetServiceWorkerVersion(version(registration.waiting_version)),
    active:publicTargetServiceWorkerVersion(version(registration.active_version)),
  };
}
async function broadcastTargetServiceWorkerLifecycle(eventType,registrationID,workerVersion){
  if(!["updatefound","statechange","unregistered"].includes(eventType)||typeof registrationID!=="string"||typeof workerVersion!=="string")throw new DOMException("Target service worker lifecycle notification rejected","SecurityError");
  const registration=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===registrationID)??null;
  const registrationView=publicTargetServiceWorker(registration),worker=publicTargetServiceWorkerVersion(registration?.versions.find(candidate=>candidate.worker_version===workerVersion)??null);
  const clients=await targetWorkerBroker.matchAll({include_uncontrolled:true,type:"window"});
  for(const targetClient of clients){
    const client=await self.clients.get(targetClient.client_id);
    if(!client)continue;
    let documentClient;
    try{documentClient=await authorizeDocumentClient(targetClient.client_id)}catch{continue}
    client.postMessage({
      v:1,
      type:"TARGET_SERVICE_WORKER_LIFECYCLE",
      event_type:eventType,
      registration_id:registrationID,
      worker_version:workerVersion,
      worker,
      registration:registrationView,
      runtime_capability:documentClient.runtime_capability,
    });
  }
}
async function dispatchTargetServiceWorkerActivation(registrationID,workerVersion,operationID,incumbent){
  try{
    await dispatchTargetWorkerLifecycle({event_type:"activate",event_id:randomID(),operation_id:`${operationID}:activate`,registration_id:registrationID,worker_version:workerVersion});
  }finally{
    await broadcastTargetServiceWorkerLifecycle("statechange",registrationID,workerVersion);
    const committed=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===registrationID),previous=committed?.versions.find(value=>value.worker_version===incumbent);
    if(previous?.state==="REDUNDANT")await broadcastTargetServiceWorkerLifecycle("statechange",registrationID,incumbent);
  }
}
async function activateReleasedTargetWorkerCandidate(candidate){
  const registration=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===candidate.registration_id),incumbent=registration?.active_version??null,operationID=`client-activation:${randomID()}`;
  await broadcastTargetServiceWorkerLifecycle("statechange",candidate.registration_id,candidate.worker_version);
  await dispatchTargetServiceWorkerActivation(candidate.registration_id,candidate.worker_version,operationID,incumbent);
}
async function releaseMissingTargetWorkerClient(clientID){
  let released;
  try{released=await targetWorkerBroker.releaseClient({operation_id:`client-release:${randomID()}`,client_id:clientID})}catch(error){if(error?.name==="NotFoundError")return;throw error}
  for(const candidate of released.activation_required)await activateReleasedTargetWorkerCandidate(candidate);
}
async function reconcileTargetWorkerClientsNow(){
  if(!targetWorkerBroker)return;
  const [durable,native]=await Promise.all([
    targetWorkerBroker.matchAll({include_uncontrolled:true,type:"window"}),
    self.clients.matchAll({includeUncontrolled:true,type:"window"}),
  ]),live=new Set(native.map(client=>client.id));
  for(const client of durable)if(!live.has(client.client_id))await releaseMissingTargetWorkerClient(client.client_id);
}
let targetWorkerClientReconciliation=Promise.resolve();
function reconcileTargetWorkerClients(){
  targetWorkerClientReconciliation=targetWorkerClientReconciliation.then(reconcileTargetWorkerClientsNow,reconcileTargetWorkerClientsNow);
  return targetWorkerClientReconciliation;
}
async function targetServiceWorkerActivate(registrationID,workerVersion,operationID){
  let install;
  try{
    install=await dispatchTargetWorkerLifecycle({event_type:"install",event_id:randomID(),operation_id:`${operationID}:install`,registration_id:registrationID,worker_version:workerVersion});
  }finally{
    await broadcastTargetServiceWorkerLifecycle("statechange",registrationID,workerVersion);
  }
  if(install.activation_eligible===true){
    const incumbent=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===registrationID)?.active_version??null;
    await targetWorkerBroker.beginActivation({operation_id:`${operationID}:begin`,registration_id:registrationID,worker_version:workerVersion});
    await broadcastTargetServiceWorkerLifecycle("statechange",registrationID,workerVersion);
    await dispatchTargetServiceWorkerActivation(registrationID,workerVersion,operationID,incumbent);
  }
  return install;
}
const targetServiceWorkerUpdateJobs=new Map();
function coalesceTargetServiceWorkerUpdate(key,run){
  const existing=targetServiceWorkerUpdateJobs.get(key);
  if(existing)return existing;
  const job=run();
  targetServiceWorkerUpdateJobs.set(key,job);
  void job.then(()=>{if(targetServiceWorkerUpdateJobs.get(key)===job)targetServiceWorkerUpdateJobs.delete(key)},()=>{if(targetServiceWorkerUpdateJobs.get(key)===job)targetServiceWorkerUpdateJobs.delete(key)});
  return job;
}
async function targetServiceWorkerRegistration(registrationID){
  return (await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===registrationID)??null;
}
function targetServiceWorkerRegistrationVersion(registration,workerVersion){
  return registration?.versions.find(version=>version.worker_version===workerVersion)??null;
}
async function runTargetServiceWorkerUpdate(registration,clientID,operationID,{forceBypass=false,scriptURL=registration.script_url,type=registration.type,updateViaCache=registration.update_via_cache}={}){
  return coalesceTargetServiceWorkerUpdate(`registration:${registration.registration_id}`,async()=>{
    const current=await targetServiceWorkerRegistration(registration.registration_id);
    if(!current)throw new DOMException("Target service worker registration unavailable","InvalidStateError");
    const active=targetServiceWorkerRegistrationVersion(current,current.active_version),workerVersion=randomID(),graph=await targetServiceWorkerGraph({force_bypass:forceBypass,previous_graph:active?.graph,script_url:scriptURL,type,update_via_cache:updateViaCache},clientID);
    const updated=await targetWorkerBroker.update({operation_id:operationID,registration_id:current.registration_id,worker_version:workerVersion,script_url:graph.script_url,type,update_via_cache:updateViaCache,graph:graph.graph});
    if(!updated.unchanged){
      await broadcastTargetServiceWorkerLifecycle("updatefound",current.registration_id,workerVersion);
      await targetServiceWorkerActivate(current.registration_id,workerVersion,operationID);
    }
    return publicTargetServiceWorker(await targetServiceWorkerRegistration(current.registration_id));
  });
}
async function targetServiceWorkerSoftUpdate(url,clientID){
  if(typeof clientID!=="string"||clientID==="")return null;
  const registration=await targetWorkerBroker.getRegistration(targetServiceWorkerURL(url,"soft update URL").href);
  if(!registration?.active_version||!await targetWorkerBroker.shouldSoftUpdate(registration.registration_id))return publicTargetServiceWorker(registration);
  return runTargetServiceWorkerUpdate(registration,clientID,`soft-update:${randomID()}`,{forceBypass:true});
}
async function targetServiceWorkerRegister(payload,clientID){
  if(!targetWorkerBroker||!targetWorkerExecutionHost)throw new DOMException("Target service worker host unavailable","InvalidStateError");
  const operationID=targetServiceWorkerOperationID(payload?.operation_id),script=targetServiceWorkerURL(payload?.script_url,"script URL"),scope=payload?.scope_url===undefined?new URL(".",script):targetServiceWorkerURL(payload.scope_url,"scope URL"),type=payload?.type??"classic",updateViaCache=payload?.update_via_cache??"imports";
  if(scope.search||!["classic","module"].includes(type)||!["all","imports","none"].includes(updateViaCache))throw new DOMException("Target service worker registration options rejected","TypeError");
  const existing=(await targetWorkerBroker.getRegistrations()).find(registration=>registration.scope_url===scope.href)??null;
  if(existing){
    const due=await targetWorkerBroker.shouldSoftUpdate(existing.registration_id);
    return runTargetServiceWorkerUpdate(existing,clientID,operationID,{forceBypass:due,scriptURL:script.href,type,updateViaCache});
  }
  return coalesceTargetServiceWorkerUpdate(`scope:${scope.href}`,async()=>{
    const concurrent=(await targetWorkerBroker.getRegistrations()).find(registration=>registration.scope_url===scope.href)??null;
    if(concurrent)return publicTargetServiceWorker(concurrent);
    const registrationID=randomID(),workerVersion=randomID(),graph=await targetServiceWorkerGraph({script_url:script.href,type,update_via_cache:updateViaCache},clientID);
    await targetWorkerBroker.register({operation_id:operationID,registration_id:registrationID,worker_version:workerVersion,scope_url:scope.href,script_url:graph.script_url,type,update_via_cache:updateViaCache,graph:graph.graph});
    await broadcastTargetServiceWorkerLifecycle("updatefound",registrationID,workerVersion);
    await targetServiceWorkerActivate(registrationID,workerVersion,operationID);
    return publicTargetServiceWorker(await targetServiceWorkerRegistration(registrationID));
  });
}
async function targetServiceWorkerUpdate(payload,clientID){
  if(!targetWorkerBroker)throw new DOMException("Target service worker host unavailable","InvalidStateError");
  const operationID=targetServiceWorkerOperationID(payload?.operation_id),registrationID=typeof payload.registration_id==="string"?payload.registration_id:"";
  if(!registrationID)throw new DOMException("Target service worker registration id missing","SecurityError");
  const registration=await targetServiceWorkerRegistration(registrationID);
  if(!registration)throw new DOMException("Target service worker registration unavailable","InvalidStateError");
  return runTargetServiceWorkerUpdate(registration,clientID,operationID,{forceBypass:await targetWorkerBroker.shouldSoftUpdate(registrationID)});
}
function targetWorkerTransferList(value){
  if(value===undefined)return[];
  if(!Array.isArray(value)||value.length>32)throw new DOMException("Target worker transfer list rejected","DataCloneError");
  const seen=new Set;
  for(const entry of value){
    if((typeof entry!=="object"&&typeof entry!=="function")||entry===null||seen.has(entry))throw new DOMException("Target worker transfer list rejected","DataCloneError");
    seen.add(entry);
  }
  return value;
}

async function targetServiceWorkerPostMessage(clientID, payload) {
  const registrationID = typeof payload?.registration_id === "string" ? payload.registration_id : "";
  const workerVersion = typeof payload?.worker_version === "string" ? payload.worker_version : "";
  if (!registrationID || !workerVersion || !("message" in payload))
    throw new DOMException("Target service worker message rejected", "SecurityError");
  const transfer=targetWorkerTransferList(payload.transfer);
  await dispatchTargetWorkerLifecycle({
    event_type: "message",
    event_id: randomID(),
    operation_id: targetServiceWorkerOperationID(payload.operation_id),
    registration_id: registrationID,
    worker_version: workerVersion,
    client_id: clientID,
    payload:{message:payload.message,origin:new URL(originState.target_url).origin},
    transfer,
  });
  const registration=await targetServiceWorkerRegistration(registrationID);
  if(registration?.active_version===workerVersion)
    await targetServiceWorkerSoftUpdate(registration.scope_url,clientID).catch(()=>null);
  return true;
}

async function targetServiceWorkerUnregister(payload) {
  const registrationID = typeof payload?.registration_id === "string" ? payload.registration_id : "";
  const registration=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===registrationID)??null;
  const workerVersion=registration?.active_version??registration?.waiting_version??registration?.installing_version??registrationID;
  const result=await targetWorkerBroker.unregister({
    operation_id: targetServiceWorkerOperationID(payload?.operation_id),
    registration_id: registrationID,
  });
  if(result.unregistered)await broadcastTargetServiceWorkerLifecycle("unregistered",registrationID,workerVersion);
  return result.unregistered;
}

async function targetServiceWorkerNavigationPreload(operation, payload) {
  const registrationID=typeof payload?.registration_id==="string"?payload.registration_id:"";
  if(!registrationID)throw new DOMException("Target service worker registration missing","SecurityError");
  if(operation==="TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_GET")
    return targetWorkerBroker.getNavigationPreloadState(registrationID);
  const operationID=targetServiceWorkerOperationID(payload?.operation_id);
  if(operation==="TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_ENABLE")
    return targetWorkerBroker.configureNavigationPreload({operation_id:operationID,registration_id:registrationID,enabled:true});
  if(operation==="TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_DISABLE")
    return targetWorkerBroker.configureNavigationPreload({operation_id:operationID,registration_id:registrationID,enabled:false});
  if(operation==="TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_SET_HEADER")
    return targetWorkerBroker.configureNavigationPreload({operation_id:operationID,registration_id:registrationID,header_value:payload?.value});
  throw new DOMException("Unknown target service worker navigation preload command","NotSupportedError");
}

async function targetServiceWorkerCommand(clientID, operation, payload) {
  if (!targetWorkerBroker)
    throw new DOMException("Target service worker host unavailable", "InvalidStateError");
  switch (operation) {
    case "TARGET_SERVICE_WORKER_REGISTER":
      return targetServiceWorkerRegister(payload, clientID);
    case "TARGET_SERVICE_WORKER_UPDATE":
      return targetServiceWorkerUpdate(payload, clientID);
    case "TARGET_SERVICE_WORKER_GET_REGISTRATION":
      return publicTargetServiceWorker(await targetWorkerBroker.getRegistration(
        targetServiceWorkerURL(payload?.scope_url ?? payload?.url, "scope URL").href,
      ));
    case "TARGET_SERVICE_WORKER_GET_REGISTRATIONS":
      return (await targetWorkerBroker.getRegistrations()).map(publicTargetServiceWorker);
    case "TARGET_SERVICE_WORKER_READY":
      return publicTargetServiceWorker(await targetWorkerBroker.ready(clientID));
    case "TARGET_SERVICE_WORKER_POST_MESSAGE":
      return targetServiceWorkerPostMessage(clientID, payload);
    case "TARGET_SERVICE_WORKER_UNREGISTER":
      return targetServiceWorkerUnregister(payload);
    case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_GET":
    case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_ENABLE":
    case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_DISABLE":
    case "TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_SET_HEADER":
      return targetServiceWorkerNavigationPreload(operation,payload);
    default:
      throw new DOMException("Unknown target service worker command", "NotSupportedError");
  }
}
async function warmRewriters(){
  if(rewriters)return {policy_version:POLICY_VERSION};
  const [policy,html,compiler,css,importMap]=await Promise.all([
    loadRustModule("policy_core"),
    loadRustModule("html_rewriter"),
    loadRustModule("js_compiler"),
    loadRustModule("css_rewriter"),
    loadRustModule("import_map"),
  ]);
  rewriters=Object.freeze({policy,html,compiler,css,importMap});
  policyReady=true;
  return {policy_version:POLICY_VERSION};
}
function policyRouteResult(method,...args){
  try{return JSON.parse(rewriters?.policy?.[method](...args)??"")}catch{throw new DOMException("Route rejected by policy","SecurityError")}
}
function buildPolicyRoute(kind,id){
  const result=policyRouteResult("route_path_result_json",kind,id);
  if(result?.ok!==true||typeof result.path!=="string")throw new DOMException("Route rejected by policy","SecurityError");
  return result.path;
}
function buildPolicyExecutableRoute(kind,id,contentID=null){
  const result=policyRouteResult("executable_route_path_result_json",kind,id,contentID);
  if(result?.ok!==true||typeof result.path!=="string")throw new DOMException("Route rejected by policy","SecurityError");
  return result.path;
}
function parsePolicyRoute(path){
  const result=policyRouteResult("parse_route_result_json",path);
  if(result?.ok!==true||!result.route||typeof result.route.family!=="string"||typeof result.route.id!=="string")throw new DOMException("Route rejected by policy","SecurityError");
  return result.route;
}
async function targetWorkerNavigationRoute(clientID,targetURL){
  const target=targetServiceWorkerURL(targetURL,"navigation URL"),id=randomID(),route={
    id,kind:"navigation",profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,
    target_url:target.href,source_url:originState.target_url,source_client_id:clientID,expires_at:Date.now()+60_000,consumed:false,
  };
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"});
  tx.objectStore("routes").add(route);
  await complete(tx);
  return buildPolicyRoute("navigation",id);
}
function requireTargetWorkerClient(client) {
  if (!client) throw new DOMException("Target worker client unavailable", "NotFoundError");
  return client;
}

async function targetWorkerClientCommand(message) {
  const binding = targetWorkerBinding();
  if (!message
    || !targetWorkerBindingMatches(message.binding, binding)
    || message.capability !== binding.capability
    || typeof message.type !== "string")
    throw new DOMException("Target worker client capability rejected", "SecurityError");
  const clientID = typeof message.client_id === "string" ? message.client_id : "";
  const client = clientID ? await self.clients.get(clientID) : null;
  switch (message.type) {
    case "CLIENT_FOCUS": {
      const focused=await requireTargetWorkerClient(client).focus();
      return {binding:message.binding,client_id:requireTargetWorkerClient(focused).id};
    }
    case "CLIENT_POST_MESSAGE": {
      const documentClient=await authorizeDocumentClient(clientID),transfer=targetWorkerTransferList(message.transfer);
      requireTargetWorkerClient(client).postMessage({
        v:1,
        type:"TARGET_SERVICE_WORKER_MESSAGE",
        message:message.message,
        runtime_capability:documentClient.runtime_capability,
      },transfer);
      break;
    }
    case "CONTROLLER_CHANGE": {
      const documentClient=await authorizeDocumentClient(clientID);
      const registration=message.controller
        ?(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===message.controller.registration_id)??null
        :null;
      if(message.controller&&!registration)throw new DOMException("Target worker controller registration unavailable","InvalidStateError");
      requireTargetWorkerClient(client).postMessage({
        v:1,
        type:"TARGET_SERVICE_WORKER_CONTROLLER_CHANGE",
        controller:publicTargetServiceWorker(registration),
        controller_revision:message.controller_revision,
        runtime_capability:documentClient.runtime_capability,
      });
      break;
    }
    case "CLIENT_NAVIGATE": {
      const navigated=await requireTargetWorkerClient(client).navigate(await targetWorkerNavigationRoute(clientID,message.url));
      return {binding:message.binding,client_id:navigated?.id??null};
    }
    case "CLIENT_OPEN_WINDOW": {
      const opened=await self.clients.openWindow(await targetWorkerNavigationRoute(clientID,message.url));
      return {binding:message.binding,client_id:opened?.id??null};
    }
    default:
      throw new DOMException("Unsupported target worker client command", "NotSupportedError");
  }
  return { binding: message.binding };
}
function targetWorkerCommandError(message,name="SecurityError"){throw new DOMException(message,name)}
function targetWorkerHostRequest(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["body","credentials","headers","method","mode","redirect","url"].includes(key)))targetWorkerCommandError("Target worker request rejected");
  const target=targetServiceWorkerURL(value.url,"fetch URL"),method=typeof value.method==="string"?value.method.toUpperCase():"";
  if(!/^[A-Z]{1,32}$/.test(method)||method==="CONNECT"||method==="TRACE"||!["omit","same-origin","include"].includes(value.credentials)||!["cors","same-origin","no-cors"].includes(value.mode)||!["follow","error","manual"].includes(value.redirect))targetWorkerCommandError("Target worker request rejected");
  const body=value.body===null?null:value.body instanceof Uint8Array?value.body:null;
  if((value.body!==null&&!(value.body instanceof Uint8Array))||body?.byteLength>256<<10||(body!==null&&(method==="GET"||method==="HEAD")))targetWorkerCommandError("Target worker request body rejected","QuotaExceededError");
  return {body,credentials:value.credentials,headers:apiHeaderPairs(value.headers),method,mode:value.mode,redirect:value.redirect,target};
}
function targetWorkerHostNativeRequest(requestRecord){
  const init={headers:requestRecord.headers,method:requestRecord.method};
  if(requestRecord.body!==null)init.body=requestRecord.body;
  return new Request(requestRecord.target.href,init);
}
function targetWorkerHostResponseRecord(result){
  if(!result||!Number.isInteger(result.status)||result.status<200||result.status>599||!Array.isArray(result.headers)||!(result.body instanceof Uint8Array)||result.body.byteLength>256<<10)targetWorkerCommandError("Target worker response rejected","NetworkError");
  return {body:result.body,headers:[...responseHeaders(result)],status:result.status,status_text:typeof result.statusText==="string"?result.statusText:""};
}
async function materializeTargetWorkerHostResult(result){
  if(!result?.body?.getReader)targetWorkerCommandError("Target worker response unavailable","NetworkError");
  const reader=result.body.getReader(),chunks=[];let length=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))targetWorkerCommandError("Target worker response rejected","NetworkError");
      length+=value.byteLength;
      if(length>256<<10)targetWorkerCommandError("Target worker response exceeds limit","QuotaExceededError");
      chunks.push(value);
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error}
  const body=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
  return {...result,body};
}
function targetWorkerCacheIndexID(binding,name){return `${binding.profile_id}\0${binding.synthetic_origin}\0${binding.client_epoch}\0${binding.capability}\0${binding.registration_id}\0${binding.worker_version}\0${name}`}
async function targetWorkerCachePartition(binding,name){
  if(typeof name!=="string"||name.length===0||name.length>256||name.includes("\0"))targetWorkerCommandError("Target worker cache name rejected");
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(targetWorkerCacheIndexID(binding,name))));
  return {id:targetWorkerCacheIndexID(binding,name),name,partition:`__zp_target_worker_${[...digest].map(value=>value.toString(16).padStart(2,"0")).join("")}`};
}
async function targetWorkerCacheRemember(partition){
  const db=await database(),tx=db.transaction("target_worker_cache_index","readwrite",{durability:"strict"});
  tx.objectStore("target_worker_cache_index").put({id:partition.id,name:partition.name,partition:partition.partition});
  await complete(tx);
}
async function targetWorkerCacheForget(partition){
  const db=await database(),tx=db.transaction("target_worker_cache_index","readwrite",{durability:"strict"});
  tx.objectStore("target_worker_cache_index").delete(partition.id);
  await complete(tx);
}
async function targetWorkerCacheKnown(partition){
  const db=await database(),tx=db.transaction("target_worker_cache_index","readonly"),record=await request(tx.objectStore("target_worker_cache_index").get(partition.id));
  await complete(tx);
  return record?.partition===partition.partition;
}
async function targetWorkerCacheNames(binding){
  const prefix=`${binding.profile_id}\0${binding.synthetic_origin}\0${binding.client_epoch}\0${binding.capability}\0${binding.registration_id}\0${binding.worker_version}\0`,db=await database(),tx=db.transaction("target_worker_cache_index","readonly"),records=await request(tx.objectStore("target_worker_cache_index").getAll());
  await complete(tx);
  return records.filter(record=>typeof record?.id==="string"&&record.id.startsWith(prefix)&&typeof record.name==="string"&&typeof record.partition==="string").map(record=>record.name).sort();
}
async function targetWorkerHostFetch(binding,messageID,payload){
  const requestRecord=targetWorkerHostRequest(payload?.request),requestRoute={
    id:`target-worker-fetch:${messageID}`,kind:"target-worker-fetch",profile_id:binding.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,
    target_url:requestRecord.target.href,source_url:originState.target_url,method:requestRecord.method,request_headers:requestRecord.headers,body_expected:requestRecord.body!==null,credentials:requestRecord.credentials,redirect:requestRecord.redirect,causal_after_seq:cookieSequence,
  };
  const result=await kernelFetch(requestRoute,null,requestRecord.body===null?null:replayUpload(requestRecord.body)),materialized=await materializeTargetWorkerHostResult(result);
  await applyResponseCookies(requestRoute,materialized,`target-worker-fetch:${messageID}`);
  return {response:targetWorkerHostResponseRecord(materialized)};
}
async function targetWorkerCacheMatch(cache, payload) {
  const requestRecord = targetWorkerHostRequest(payload.request);
  const response = await cache.match(targetWorkerHostNativeRequest(requestRecord));
  if (!response) return { response: null };
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 256 << 10)
    targetWorkerCommandError("Target worker cache response exceeds limit", "QuotaExceededError");
  return { response: { body, headers: [...response.headers], status: response.status, status_text: response.statusText } };
}

async function targetWorkerCachePut(cache, payload) {
  const requestRecord = targetWorkerHostRequest(payload.request);
  const response = payload.response;
  if (requestRecord.method !== "GET"
    || !response
    || typeof response !== "object"
    || !(response.body instanceof Uint8Array)
    || response.body.byteLength > 256 << 10
    || !Number.isInteger(response.status)
    || response.status < 200
    || response.status > 599
    || !Array.isArray(response.headers))
    targetWorkerCommandError("Target worker cache put rejected");
  await cache.put(targetWorkerHostNativeRequest(requestRecord), new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: typeof response.status_text === "string" ? response.status_text : "",
  }));
  return {};
}

async function targetWorkerCacheKeys(cache, payload) {
  const requestRecord = payload.request === null ? null : targetWorkerHostRequest(payload.request);
  const keys = await cache.keys(requestRecord === null ? undefined : targetWorkerHostNativeRequest(requestRecord));
  return { keys: keys.map(key => ({ headers: [...key.headers], method: key.method, url: key.url })) };
}

async function targetWorkerHostCache(binding, command, payload) {
  if (command === "CACHE_STORAGE_KEYS") return { keys: await targetWorkerCacheNames(binding) };
  const partition = await targetWorkerCachePartition(binding, payload?.cache_name);
  if (command === "CACHE_STORAGE_HAS") return { value: await targetWorkerCacheKnown(partition) };
  if (command === "CACHE_STORAGE_DELETE") {
    const deleted = await caches.delete(partition.partition);
    await targetWorkerCacheForget(partition);
    return { value: deleted };
  }
  if (command === "CACHE_OPEN") {
    await caches.open(partition.partition);
    await targetWorkerCacheRemember(partition);
    return {};
  }
  const cache = await caches.open(partition.partition);
  await targetWorkerCacheRemember(partition);
  switch (command) {
    case "CACHE_MATCH":
      return targetWorkerCacheMatch(cache, payload);
    case "CACHE_PUT":
      return targetWorkerCachePut(cache, payload);
    case "CACHE_DELETE": {
      const requestRecord = targetWorkerHostRequest(payload.request);
      return { value: await cache.delete(targetWorkerHostNativeRequest(requestRecord)) };
    }
    case "CACHE_KEYS":
      return targetWorkerCacheKeys(cache, payload);
    default:
      targetWorkerCommandError("Target worker cache command rejected", "NotSupportedError");
  }
}
async function targetWorkerRegistrationUpdate(binding, messageID) {
  const registration = (await targetWorkerBroker.getRegistrations())
    .find(value => value.registration_id === binding.registration_id);
  if (!registration) targetWorkerCommandError("Target worker registration unavailable", "NotFoundError");
  const sourceClient = (await targetWorkerBroker.matchAll({ include_uncontrolled: false, type: "window" }))
    .find(client =>
      client.controller?.registration_id === binding.registration_id
      && client.controller?.worker_version === binding.worker_version)?.client_id;
  if (!sourceClient) targetWorkerCommandError("Target worker update client unavailable", "InvalidStateError");
  await runTargetServiceWorkerUpdate(registration,sourceClient,messageID,{forceBypass:await targetWorkerBroker.shouldSoftUpdate(registration.registration_id)});
  return {};
}

async function targetWorkerPostMessageToClients(binding, messageID, payload) {
  if (!("message" in payload)) targetWorkerCommandError("Target worker message rejected");
  const clients = await targetWorkerBroker.matchAll({ include_uncontrolled: false, type: "all" });
  for (const client of clients) {
    if (client.controller?.registration_id !== binding.registration_id
      || client.controller?.worker_version !== binding.worker_version) continue;
    await targetWorkerBroker.postMessage({
      operation_id: `${messageID}:${client.client_id}`,
      client_id: client.client_id,
      message: payload.message,
    });
  }
  return {};
}

async function targetWorkerModuleImport(binding,payload){
  const normalized=normalizeModuleImport(payload);
  const registration=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===binding.registration_id);
  const version=registration?.versions?.find(value=>value.worker_version===binding.worker_version);
  const graph=version?.graph;
  if(!graph||graph.type!=="module"||!workerGatewayID.test(graph.module_graph_id)||!workerABIIdentifier.test(graph.abi_identifier)||typeof graph.module_referrer!=="string")targetWorkerCommandError("Target worker module graph unavailable","InvalidStateError");
  const referrer=executableModuleTarget(normalized.referrerURL).target_url;
  const db=await database(),tx=db.transaction("routes","readonly"),record=await request(tx.objectStore("routes").get(`${graph.module_graph_id}:${normalized.moduleID}`));
  await complete(tx);
  if(!moduleImportRecordMatches(record,{
    abiIdentifier:graph.abi_identifier,
    capability:binding.capability,
    clientEpoch:binding.client_epoch,
    entryID:originState.entry_id,
    graphID:graph.module_graph_id,
    moduleID:normalized.moduleID,
    now:Date.now(),
    originID:originState.destination_origin_id,
    profileID:originState.profile_id,
    referrerURL:referrer,
    tabID:originState.tab_id,
  }))targetWorkerCommandError("Target worker module referrer rejected");
  const target=executableModuleTarget(new URL(normalized.specifier,referrer).href);
  if(target.network.origin!==new URL(originState.target_url).origin)targetWorkerCommandError("Target worker module import rejected");
  const executable=await readTargetWorkerExecutable(graph.graph_hash);
  if(!executable)targetWorkerCommandError("Target worker module graph unavailable","InvalidStateError");
  const route={profile_id:originState.profile_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,target_url:target.target_url,source_url:record.target_url,kind:"worker",method:"GET",request_headers:[["Accept","text/javascript,application/javascript,application/json,*/*;q=0.1"]],body_expected:false,credentials:"include",redirect:"error",integrity:null,cors_mode:null,causal_after_seq:cookieSequence,abi_identifier:graph.abi_identifier,expires_at:executable.expires_at};
  const loaded=await fetchDynamicWorkerModuleRoot(route,target.target_url),root=await createTargetServiceWorkerModuleRoutes(route,loaded.source,loaded.target_url,graph.module_graph_id,loaded.module_type);
  return {module_type:loaded.module_type,target_url:loaded.target_url,url:root.url};
}

async function targetWorkerHostCapability(message) {
  const binding = targetWorkerVersionBinding(message);
  const command = typeof message?.command === "string" ? message.command : "";
  const messageID = targetServiceWorkerOperationID(message?.message_id);
  const payload = message?.payload;
  if (!targetWorkerBroker
    || !targetWorkerBindingMatches(binding, targetWorkerBinding())
    || !payload
    || typeof payload !== "object"
    || Array.isArray(payload))
    targetWorkerCommandError("Target worker capability rejected");
  if (command === "MODULE_IMPORT") return targetWorkerModuleImport(binding, payload);
  if (command === "FETCH") return targetWorkerHostFetch(binding, messageID, payload);
  if (command.startsWith("CACHE_")) return targetWorkerHostCache(binding, command, payload);
  if(command==="REGISTRATION_SKIP_WAITING"){
    const result=await targetWorkerBroker.skipWaiting({operation_id:messageID,registration_id:binding.registration_id,worker_version:binding.worker_version});
    if(result.state==="ACTIVATING"){
      const registration=(await targetWorkerBroker.getRegistrations()).find(value=>value.registration_id===binding.registration_id),incumbent=registration?.active_version??null;
      await broadcastTargetServiceWorkerLifecycle("statechange",binding.registration_id,binding.worker_version);
      await dispatchTargetServiceWorkerActivation(binding.registration_id,binding.worker_version,messageID,incumbent);
    }
    return {};
  }
  if(command==="REGISTRATION_UNREGISTER"){
    return {value:await targetServiceWorkerUnregister({operation_id:messageID,registration_id:binding.registration_id})};
  }
  if (command === "REGISTRATION_UPDATE")
    return targetWorkerRegistrationUpdate(binding, messageID);
  if (command === "POST_MESSAGE")
    return targetWorkerPostMessageToClients(binding, messageID, payload);
  targetWorkerCommandError("Target worker capability unavailable", "NotSupportedError");
}
function relayProfileBindings(state=originState){
  const profiles=state?.relay_profiles,capabilities=state?.relay_capabilities,digests=state?.relay_profile_digests;
  if(!Array.isArray(profiles)||!Array.isArray(capabilities)||!Array.isArray(digests)
    ||profiles.length<1||profiles.length>8||capabilities.length!==profiles.length||digests.length!==profiles.length)throw new DOMException("Relay profile binding mismatch","SecurityError");
  return profiles.map((profile,index)=>{
    const capability=capabilities[index],digest=digests[index];
    if(!profile||!capability||typeof digest!=="string"||digest!==capability.relay_profile_digest
      ||digests.indexOf(digest)!==index||capability.relay_url!==profile.relay_wss_origin+profile.carrier_path
      ||Date.parse(profile.expires_at)<=Date.now()||Date.parse(capability.expires_at)<=Date.now()||Object.hasOwn(profile,"revoked_at")
      ||!Array.isArray(profile.allowed_target_ports)||!Array.isArray(capability.allowed_target_ports)
      ||profile.allowed_target_ports.length!==capability.allowed_target_ports.length
      ||profile.allowed_target_ports.some((port,portIndex)=>port!==capability.allowed_target_ports[portIndex]))
      throw new DOMException("Relay profile binding mismatch","SecurityError");
    return Object.freeze({profile,capability,digest});
  });
}
function primaryRelayCapability(){return relayProfileBindings()[0].capability}
function commonRelayPorts(){
  const bindings=relayProfileBindings(),ports=new Set(bindings[0].capability.allowed_target_ports);
  for(const {capability} of bindings.slice(1))for(const port of ports)if(!capability.allowed_target_ports.includes(port))ports.delete(port);
  if(ports.size===0)throw new DOMException("Relay target policy mismatch","SecurityError");
  return [...ports].sort((left,right)=>left-right);
}

function currentKernelBinding() {
  if (!originState || typeof originState.profile_id !== "string"
    || typeof originState.session_id !== "string" || typeof originState.tab_id !== "string"
    || typeof originState.destination_origin_id !== "string" || typeof originState.entry_id !== "string"
    || typeof originState.bootstrap_client_id !== "string" || typeof originState.document_capability !== "string"
    || !Number.isSafeInteger(originState.capability_epoch) || originState.capability_epoch < 1
    || typeof originState.isolation_username !== "string" || typeof originState.isolation_password !== "string")
    throw new DOMException("Kernel binding unavailable","SecurityError");
  return Object.freeze({
    profileID: originState.profile_id,
    sessionID: originState.session_id,
    tabID: originState.tab_id,
    originID: originState.destination_origin_id,
    entryID: originState.entry_id,
    sourceClientID: originState.bootstrap_client_id,
    documentID: originState.document_capability,
    policyEpoch: POLICY_VERSION,
    capabilityEpoch: originState.capability_epoch,
    cookieSequence,
    isolationKeyRef: originState.document_capability,
    isolationUsername: originState.isolation_username,
    isolationPassword: originState.isolation_password,
    persona: TRANSPORT_PERSONA,
  });
}

function currentKernelBindingKey(binding) {
  return JSON.stringify({
    profileID: binding.profileID,
    sessionID: binding.sessionID,
    tabID: binding.tabID,
    originID: binding.originID,
    policyEpoch: binding.policyEpoch,
    capabilityEpoch: binding.capabilityEpoch,
    isolationKeyRef: binding.isolationKeyRef,
    isolationUsername: binding.isolationUsername,
    isolationPassword: binding.isolationPassword,
    persona: binding.persona,
  });
}

async function ensureKernelBinding() {
  const binding=currentKernelBinding(),key=currentKernelBindingKey(binding);
  if(kernelReady&&kernelHandle&&kernelBindingKey===key)return;
  if(kernelBindingPromise)return kernelBindingPromise;
  if(!Array.isArray(kernelRelayConfigs))throw new DOMException("Kernel relay binding unavailable","InvalidStateError");
  kernelBindingPromise=(async()=>{
    if(kernelHandle&&typeof self.__zeroproxyKernelCloseV2==="function"){
      await self.__zeroproxyKernelCloseV2(kernelHandle);
      kernelHandle=null;
      kernelReady=false;
    }
    kernelHandle=await self.__zeroproxyKernelCreateV2({relays:kernelRelayConfigs,...binding});
    kernelBindingKey=key;
    kernelReady=true;
  })();
  try{await kernelBindingPromise}finally{kernelBindingPromise=null}
}
async function provisionKernelDocument(route) {
  const binding=currentKernelBinding();
  const require=(field,expected)=>{
    if(route[field]!==undefined&&route[field]!==expected)
      throw new DOMException("Transport plan binding mismatch","SecurityError");
    return expected;
  };
  const sourceClientID=route.source_client_id ?? binding.sourceClientID;
  const documentID=route.document_id ?? binding.documentID;
  const entryID=route.entry_id ?? binding.entryID;
  if(typeof sourceClientID!=="string"||typeof documentID!=="string"||typeof entryID!=="string")
    throw new DOMException("Document binding unavailable","SecurityError");
  await self.__zeroproxyKernelBindDocumentV2(kernelHandle,{
    profile_id:require("profile_id",binding.profileID),
    session_id:require("session_id",binding.sessionID),
    tab_id:require("tab_id",binding.tabID),
    origin_id:require("origin_id",binding.originID),
    policy_epoch:require("policy_epoch",binding.policyEpoch),
    capability_epoch:require("capability_epoch",binding.capabilityEpoch),
    isolation_key_ref:require("isolation_key_ref",binding.isolationKeyRef),
    persona:require("persona",binding.persona),
    source_client_id:sourceClientID,
    document_id:documentID,
    entry_id:entryID,
  });
  return Object.freeze({sourceClientID,documentID,entryID});
}

async function warmKernel(){
  if(kernelReady){
    await ensureKernelBinding();
    await lifecycle().readyHot();
    return {kernel_version:VERSION};
  }
  const relays=relayProfileBindings();
  if(typeof self.__zeroproxyKernelCreateV2!=="function"){
    const version=await versionManifest(),record=globalThis.__zeroproxyStaticKernel;
    if(!record||version.selectors?.["kernel.wasm"]!==record.kernel_wasm_url||version.selectors?.["wasm_exec.js"]!==record.wasm_exec_url||typeof Go!=="function")throw new DOMException("Version mismatch","InvalidStateError");
    const go=new Go(),result=await WebAssembly.instantiateStreaming(fetch(record.kernel_wasm_url,{cache:"force-cache"}),go.importObject);
    void go.run(result.instance);
    for(let attempt=0;attempt<100&&(typeof self.__zeroproxyKernelCreateV2!=="function"||typeof self.__zeroproxyKernelTransactionFrameV2!=="function"||typeof self.__zeroproxyKernelBindDocumentV2!=="function");attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(typeof self.__zeroproxyKernelCreateV2!=="function"||typeof self.__zeroproxyKernelTransactionFrameV2!=="function"||typeof self.__zeroproxyKernelBindDocumentV2!=="function")throw new DOMException("Kernel startup failed","InvalidStateError");
  kernelRelayConfigs=await Promise.all(relays.map(async({profile,capability,digest})=>({relayURL:capability.relay_url,relayProfileDigest:decodeBase64URL(digest),relayProfileID:profile.profile_id,relayDeploymentID:profile.deployment_id,capabilityID:capability.capability_id,verifierKey:await relayAuthKey(capability),claimsDigest:decodeBase64URL(capability.claims_digest),capabilityEpoch:capability.capability_epoch,allowedTargetPorts:capability.allowed_target_ports,profileLimits:profile.limits})));
  await ensureKernelBinding();
  await lifecycle().readyHot();
  return {kernel_version:VERSION};
}
let localHydrationPromise=null,durableTargetWorkerState=null;
async function durableOriginState(){
  const db=await database(),tx=db.transaction(["meta","routes","target_worker_journal"],"readonly");
  const meta=tx.objectStore("meta");
  const [state,runtime,compatibility,routes,targetWorkers]=await Promise.all([
    request(meta.get("origin_state")),
    request(meta.get("runtime_snapshot")),
    request(meta.get("compatibility")),
    request(tx.objectStore("routes").getAll()),
    request(tx.objectStore("target_worker_journal").get("broker")),
  ]);
  await complete(tx);
  return {state,runtime,compatibility,routes,targetWorkers};
}
function validDurableOrigin(snapshot){
  const {state,runtime,compatibility,routes,targetWorkers}=snapshot,hostID=self.location.hostname.match(/^o-([a-z2-7]{32})\.browse\./)?.[1];
  let relays;
  try{relays=relayProfileBindings(state)}catch{throw coordinatorFailure("DURABLE_STATE_REJECTED")}
  if(!state||hostID!==state.destination_origin_id||state.destination_host!==self.location.host||
    !/^[A-Za-z0-9_-]{43}$/.test(state.isolation_username)||
    !/^[A-Za-z0-9_-]{43}$/.test(state.isolation_password)||
    !runtime||runtime.profile_id!==state.profile_id||runtime.origin_id!==state.destination_origin_id||
    runtime.capability_epoch!==state.capability_epoch||runtime.compatibility_hash!==globalThis.__zeroproxyCompatibility.hash||
    compatibility?.compatibility_hash!==globalThis.__zeroproxyCompatibility.hash||
    !runtime.cookie_context||typeof runtime.cookie_top_level_site!=="string"||runtime.cookie_top_level_site.length===0||!Number.isSafeInteger(runtime.cookie_seq)||runtime.cookie_seq<0||
    relays.some(({profile,capability})=>Date.parse(capability.expires_at)<=Date.now()||Date.parse(profile.expires_at)<=Date.now())||
    !Array.isArray(routes))throw coordinatorFailure("DURABLE_STATE_REJECTED");
  for(const route of routes){
    if(route?.profile_id===state.profile_id&&route.origin_id===state.destination_origin_id&&
      route.capability_epoch!==undefined&&route.capability_epoch!==state.capability_epoch)throw coordinatorFailure("DURABLE_STATE_REJECTED");
  }
  if(targetWorkers&&targetWorkers.state?.binding?.profile_id!==state.profile_id)throw coordinatorFailure("DURABLE_STATE_REJECTED");
  return snapshot;
}
async function journalCoordinatorWake(reason){
  const db=await database(),tx=db.transaction("coordinator_inbox","readwrite",{durability:"strict"});
  tx.objectStore("coordinator_inbox").put({
    id:"reattach",
    state:"PENDING",
    reason,
    profile_id:originState?.profile_id??null,
    origin_id:originState?.destination_origin_id??null,
    capability_epoch:originState?.capability_epoch??null,
    updated_at:Date.now(),
  });
  await complete(tx);
  const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const client of clients)client.postMessage({v:2,operation:"COORDINATOR_REATTACH_REQUIRED"});
}
async function restoreLocalState(){
  if(originState&&cookieContext&&policyReady&&kernelReady)return;
  await lifecycle().coldStart();
  const snapshot=validDurableOrigin(await durableOriginState());
  await canonicalTarget(snapshot.state.target_url);
  const restoredState={...snapshot.state};
  delete restoredState.key;
  originState=Object.freeze(restoredState);
  coordinatorRevision=snapshot.runtime.coordinator_revision;
  cookieContext=Object.freeze(snapshot.runtime.cookie_context);
  cookieTopLevelSite=snapshot.runtime.cookie_top_level_site;
  cookieSequence=snapshot.runtime.cookie_seq;
  durableTargetWorkerState=snapshot.targetWorkers??null;
  await lifecycle().beginHydration(originState);
  await warmRewriters();
  await warmKernel();
}
async function hydrateForEvent(requireCoordinator=false){
  if(!originState||!cookieContext||!policyReady||!kernelReady){
    localHydrationPromise??=restoreLocalState().catch(error=>{localHydrationPromise=null;throw error});
    await localHydrationPromise;
  }
  if(requireCoordinator&&!coordinatorPort){
    await journalCoordinatorWake("NATIVE_EVENT");
    throw coordinatorFailure("COORDINATOR_REATTACH_REQUIRED");
  }
}
async function persistRuntimeProgress(){
  if(!originState)return;
  const db=await database(),tx=db.transaction("meta","readwrite",{durability:"strict"}),store=tx.objectStore("meta"),current=await request(store.get("runtime_snapshot"));
  if(current){
    current.cookie_seq=cookieSequence;
    current.coordinator_revision=coordinatorRevision;
    store.put(current);
  }
  await complete(tx);
}
async function assertDocumentRouteAllocationReady(payload){
  const lifecycleState=await lifecycle().snapshot();
  if(!originState||payload.profile_id!==originState.profile_id||payload.tab_id!==originState.tab_id||
    payload.entry_id!==originState.entry_id||payload.destination_origin_id!==originState.destination_origin_id||
    !policyReady||lifecycleState?.state!=="READY_HOT"||!kernelReady)throw new DOMException("Origin not ready","InvalidStateError");
}
function documentRouteReplayMatches(existing,route){
  return existing.kind==="document"&&existing.profile_id===route.profile_id&&existing.tab_id===route.tab_id&&
    existing.entry_id===route.entry_id&&existing.origin_id===route.origin_id&&existing.target_url===route.target_url&&
    existing.source_url===route.source_url&&existing.fetch_destination===route.fetch_destination&&JSON.stringify(existing.ancestor_urls)===JSON.stringify(route.ancestor_urls)&&
    existing.source_client_id===route.source_client_id&&existing.bootstrap_submission===route.bootstrap_submission&&existing.body_sha256===route.body_sha256&&
    !existing.consumed&&existing.expires_at>Date.now();
}
async function allocateRoute(event,payload,commandID){
  await assertDocumentRouteAllocationReady(payload);
  const form=attachedFormSubmission(payload.form_submission),ancestorURLs=[...(payload.ancestor_urls??originState.ancestor_urls??[])],sourceURL=form?.source_url??ancestorURLs.at(-1);
  const route={
    id:commandID,
    kind:"document",
    profile_id:payload.profile_id,
    tab_id:payload.tab_id,
    entry_id:payload.entry_id,
    origin_id:payload.destination_origin_id,
    target_url:payload.target_url,
    ancestor_urls:ancestorURLs,
    source_url:sourceURL,
    fetch_destination:ancestorURLs.length?"iframe":"document",
    abi_identifier:randomABI(),
    source_client_id:event.source.id,
    expires_at:Date.now()+60_000,
    consumed:false,
    ...(form===null?{}:{
      bootstrap_submission:true,
      method:"POST",
      enctype:sealedFormEnctype(form.content_type),
      request_headers:[["Accept","text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],["Content-Type",form.content_type]],
      body_expected:true,
      body:form.body.slice(),
      body_sha256:form.body_sha256,
      credentials:"include",
      redirect:"follow",
      request_mode:"navigate",
      cors_cross_origin:new URL(payload.target_url).origin!==new URL(form.source_url).origin,
      cors_origin:serializeRequestOrigin(form.source_url,payload.target_url,form.referrer_policy,"POST"),
      cors_request_headers:[],
      referrer_policy:form.referrer_policy,
      referrer_source:form.source_url,
      referrer:referrerForRequest(form.source_url,payload.target_url,form.referrer_policy),
    }),
  };
  const db=await database(),tx=db.transaction(["routes","meta"],"readwrite",{durability:"strict"}),store=tx.objectStore("routes"),existing=await request(store.get(route.id));
  if(existing){
    if(!documentRouteReplayMatches(existing,route)){tx.abort();throw new DOMException("Document route replay rejected","SecurityError")}
  }else store.add(route);
  if(form!==null){
    const meta=tx.objectStore("meta"),current=await request(meta.get("origin_state"));
    if(!current||current.profile_id!==route.profile_id||current.entry_id!==route.entry_id||current.destination_origin_id!==route.origin_id){
      tx.abort();
      throw new DOMException("Form handoff state unavailable","SecurityError");
    }
    meta.put({...current,form_submission:null});
  }
  await complete(tx);
  if(form!==null)originState=Object.freeze({...originState,form_submission:null});
  return {path:buildPolicyRoute("document",route.id)};
}

const apiForbiddenHeader=/^(?:x-zp-|host$|cookie$|connection$|proxy-connection$|proxy-authorization$|keep-alive$|transfer-encoding$|trailer$|upgrade$|content-length$|origin$|referer$|sec-)/i;
const apiBodyHandlePattern=/^[a-f0-9]{48}$/u;
const apiKinds=new Set(["fetch","xhr","eventsource","websocket"]),corsSafeRequestHeaders=new Set(["accept","accept-language","content-language","content-type","range"]);
function apiPlanError(message){throw new DOMException(message,"SecurityError")}
function apiHeaderPairs(value){
  if(!Array.isArray(value)||value.length>128)apiPlanError("Invalid API request headers");
  const headers=[],seen=new Set;
  for(const pair of value){
    if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=="string"||typeof pair[1]!=="string"||
       pair[0].length===0||pair[0].length>256||pair[1].length>8192||!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(pair[0])||/[\r\n]/.test(pair[1]))apiPlanError("Invalid API request header");
    const name=pair[0],key=name.toLowerCase();
    if(apiForbiddenHeader.test(key)||seen.has(`${key}\0${pair[1]}`))apiPlanError("Reserved API request header");
    seen.add(`${key}\0${pair[1]}`);
    headers.push([name,pair[1]]);
  }
  return headers;
}
function comparableOrigin(target){
  const scheme=target.protocol==="ws:"?"http:":target.protocol==="wss:"?"https:":target.protocol;
  return `${scheme}//${target.host}`;
}
function apiTarget(value,protocols=["http:","https:"]){
  if(typeof value!=="string"||value.length===0||value.length>16384)apiPlanError("Invalid API target");
  let target;
  try{target=new URL(value)}catch{apiPlanError("Invalid API target")}
  if(!protocols.includes(target.protocol)||target.username||target.password||target.hash)apiPlanError("Unsupported API target");
  const port=target.port===""?(target.protocol==="https:"||target.protocol==="wss:"?443:80):Number(target.port);
  if(!Number.isSafeInteger(port)||!commonRelayPorts().includes(port))apiPlanError("Target port denied");
  return target;
}
function documentAPITarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    apiPlanError("Invalid API document target");
  }
  target.hash = "";
  return apiTarget(target.href);
}
function executableModuleTarget(value){
  let identity;
  try{identity=new URL(value)}catch{apiPlanError("Invalid executable target")}
  const fragment=identity.hash;
  identity.hash="";
  const network=apiTarget(identity.href);
  return Object.freeze({network,target_url:`${network.href}${fragment}`});
}
function corsUnsafeRequestHeaderByte(byte){
  return byte<0x20&&byte!==0x09||byte===0x22||byte===0x28||byte===0x29||byte===0x3a||
    byte===0x3c||byte===0x3e||byte===0x3f||byte===0x40||
    byte===0x5b||byte===0x5c||byte===0x5d||byte===0x7b||byte===0x7d||byte===0x7f;
}
function corsValueHasUnsafeByte(value){
  for(let index=0;index<value.length;index++)if(corsUnsafeRequestHeaderByte(value.charCodeAt(index)))return true;
  return false;
}
function corsLanguageValue(value){
  for(let index=0;index<value.length;index++){
    const byte=value.charCodeAt(index);
    if(!(byte>=0x30&&byte<=0x39||byte>=0x41&&byte<=0x5a||byte>=0x61&&byte<=0x7a||
      byte===0x20||byte===0x2a||byte===0x2c||byte===0x2d||byte===0x2e||byte===0x3b||byte===0x3d))return false;
  }
  return true;
}
function corsSafelistedRequestHeader(name,value){
  if(!corsSafeRequestHeaders.has(name))return false;
  if(value.length>128)return false;
  if(name==="accept")return !corsValueHasUnsafeByte(value);
  if(name==="accept-language"||name==="content-language")return corsLanguageValue(value);
  if(name==="range")return /^bytes=[0-9]+-[0-9]*$/.test(value);
  const essence=value.split(";",1)[0].trim().toLowerCase();
  return !corsValueHasUnsafeByte(value)&&
    (essence==="application/x-www-form-urlencoded"||essence==="multipart/form-data"||essence==="text/plain");
}
function corsRequestHeaders(headers){
  const names=[];
  for(const [name,value] of headers){
    const lower=name.toLowerCase();
    if(!corsSafelistedRequestHeader(lower,value))names.push(lower);
  }
  return [...new Set(names)].sort();
}
function validSocketProtocols(value){
  if(!Array.isArray(value)||value.length>32)return null;
  const seen=new Set;
  for(const protocol of value)if(typeof protocol!=="string"||protocol.length===0||protocol.length>123||!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)||seen.has(protocol))return null;else seen.add(protocol);
  return value.slice();
}
function apiMethod(payload, kind, socket) {
  const method = socket ? "GET" : typeof payload.method === "string" ? payload.method.toUpperCase() : "";
  if (!/^[A-Z]{1,32}$/.test(method) || method === "CONNECT" || method === "TRACE")
    apiPlanError("Unsupported API method");
  if ((kind === "eventsource" && method !== "GET")
    || typeof payload.body_expected !== "boolean"
    || payload.body_expected && (method === "GET" || method === "HEAD"))
    apiPlanError("Invalid API body mode");
  return method;
}
function apiBodyHandle(payload) {
  if (payload.body_expected === true) {
    if (typeof payload.body_handle !== "string" || !apiBodyHandlePattern.test(payload.body_handle))
      apiPlanError("Invalid API body handle");
    return payload.body_handle;
  }
  if (payload.body_handle !== "") apiPlanError("Unexpected API body handle");
  return "";
}

const supportedReferrerPolicies = new Set([
  "", "no-referrer", "no-referrer-when-downgrade", "origin",
  "origin-when-cross-origin", "same-origin", "strict-origin",
  "strict-origin-when-cross-origin", "unsafe-url",
]);

function referrerForRequest(sourceValue, targetValue, policyValue) {
  if (sourceValue === "" || policyValue === "no-referrer") return "";
  let source;
  let target;
  try {
    source = new URL(sourceValue);
    target = new URL(targetValue);
  } catch {
    apiPlanError("Invalid API referrer");
  }
  source.username = "";
  source.password = "";
  source.hash = "";
  const policy = policyValue === "" ? "strict-origin-when-cross-origin" : policyValue;
  const sameOrigin = comparableOrigin(source) === comparableOrigin(target);
  const downgrade = source.protocol === "https:" && target.protocol === "http:";
  const origin = `${source.origin}/`;
  switch (policy) {
    case "unsafe-url": return source.href;
    case "origin": return origin;
    case "same-origin": return sameOrigin ? source.href : "";
    case "origin-when-cross-origin": return sameOrigin ? source.href : origin;
    case "strict-origin": return downgrade ? "" : origin;
    case "no-referrer-when-downgrade": return downgrade ? "" : source.href;
    case "strict-origin-when-cross-origin":
      return sameOrigin ? source.href : downgrade ? "" : origin;
    default: return "";
  }
}

function redirectedReferrerPolicy(headers, current) {
  let policy = current;
  for (const pair of headers) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string"
      || pair[0].toLowerCase() !== "referrer-policy" || typeof pair[1] !== "string") continue;
    for (const token of pair[1].split(",")) {
      const candidate = token.trim().toLowerCase();
      if (candidate !== "" && supportedReferrerPolicies.has(candidate)) policy = candidate;
    }
  }
  return policy;
}

function validateAPIOptions(payload, crossOrigin) {
  if (!["omit", "same-origin", "include"].includes(payload.credentials))
    apiPlanError("Unsupported credentials mode");
  if (typeof payload.integrity !== "string" || payload.integrity.length > 8192)
    apiPlanError("Invalid integrity metadata");
  if (!["cors", "no-cors", "same-origin"].includes(payload.mode)
    || !["follow", "error", "manual"].includes(payload.redirect))
    apiPlanError("Unsupported API request mode");
  if (crossOrigin && payload.mode === "same-origin")
    apiPlanError("Cross-origin API request denied");
  if (!["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"].includes(payload.cache)
    || typeof payload.referrer_policy !== "string"
    || !supportedReferrerPolicies.has(payload.referrer_policy)
    || typeof payload.referrer !== "string")
    apiPlanError("Unsupported API cache or referrer mode");
  if (typeof payload.keepalive !== "boolean" || !["high", "low", "auto"].includes(payload.priority))
    apiPlanError("Unsupported API scheduling mode");
}

function apiHeaders(payload, kind, socket) {
  const headers = socket ? [] : apiHeaderPairs(payload.headers);
  const hasAccept = headers.some(([name]) => name.toLowerCase() === "accept");
  if (!hasAccept && !socket)
    headers.push(["Accept", kind === "eventsource" ? "text/event-stream" : "*/*"]);
  return headers;
}

function normalizeAPIPlanPayload(payload, documentTarget) {
  if (!payload || typeof payload !== "object" || !apiKinds.has(payload.request_kind))
    apiPlanError("Unsupported API surface");
  const kind = payload.request_kind;
  const socket = kind === "websocket";
  const target = apiTarget(payload.target_url, socket ? ["ws:", "wss:"] : ["http:", "https:"]);
  const crossOrigin = comparableOrigin(target) !== comparableOrigin(documentTarget);
  const method = apiMethod(payload, kind, socket);
  const bodyHandle = apiBodyHandle(payload);
  validateAPIOptions(payload, crossOrigin);
  const headers = apiHeaders(payload, kind, socket);
  const referrer = payload.referrer === "" || payload.referrer_policy === "no-referrer"
    ? ""
    : apiTarget(payload.referrer).href;
  if(referrer!==""&&comparableOrigin(new URL(referrer))!==comparableOrigin(documentTarget))
    apiPlanError("Cross-origin API referrer denied");
  const protocols = socket ? validSocketProtocols(payload.protocols) : [];
  if (socket && !protocols) apiPlanError("Invalid WebSocket protocols");
  return {
    bodyHandle, crossOrigin, documentTarget, headers, kind, method, protocols,
    referrerSource: referrer, referrer: referrerForRequest(referrer, target, payload.referrer_policy), target,
  };
}
function apiSurfaceMetadata(normalized, payload) {
  const xhrNativeContentType = normalized.kind === "xhr"
    && payload.body_expected
    && !normalized.headers.some(([name]) => name.toLowerCase() === "content-type");
  if ((normalized.kind === "xhr" && payload.xhr_native_content_type !== xhrNativeContentType)
    || (normalized.kind !== "xhr" && Object.hasOwn(payload, "xhr_native_content_type")))
    apiPlanError("Invalid XHR body metadata");
  const eventSourceInstance = normalized.kind === "eventsource" ? payload.instance_id : "";
  if ((normalized.kind === "eventsource" && (typeof eventSourceInstance !== "string" || !apiBodyHandlePattern.test(eventSourceInstance)))
    || (normalized.kind !== "eventsource" && Object.hasOwn(payload, "instance_id")))
    apiPlanError("Invalid EventSource instance");
  return {eventSourceInstance,xhrNativeContentType};
}

async function allocateAPIPlan(event, payload) {
  if (!originState
    || !policyReady
    || !kernelReady
    || !event.source?.id
    || typeof primaryRelayCapability().capability_id !== "string")
    throw new DOMException("Origin not ready", "InvalidStateError");
  const client = await authorizeDocumentClient(event.source.id);
  const documentTarget = documentAPITarget(client.target_url);
  const normalized = normalizeAPIPlanPayload(payload, documentTarget);
  const {eventSourceInstance,xhrNativeContentType}=apiSurfaceMetadata(normalized,payload);
  let connectAllowed;
  try {
    connectAllowed = rewriters.policy.csp_allows_connect_json(JSON.stringify(client.policy_context), normalized.target.href);
  } catch {
    apiPlanError("Target CSP decision unavailable");
  }
  if (connectAllowed !== true) apiPlanError("Target CSP blocked connection");
  const id = randomID();
  const plan = {
    id,
    kind: "api",
    api_kind: normalized.kind,
    profile_id: originState.profile_id,
    session_id: originState.session_id,
    tab_id: originState.tab_id,
    entry_id: originState.entry_id,
    origin_id: originState.destination_origin_id,
    document_id: client.runtime_capability,
    policy_epoch: POLICY_VERSION,
    isolation_key_ref: originState.document_capability,
    persona: TRANSPORT_PERSONA,
    source_url: normalized.documentTarget.href,
    document_security_policy:client.document_security_policy,
    body_handle: normalized.bodyHandle,
    target_url: normalized.target.href,
    method: normalized.method,
    request_headers: normalized.headers,
    body_expected: payload.body_expected,
    xhr_native_content_type: xhrNativeContentType,
    instance_id: eventSourceInstance,
    original_url: normalized.kind === "eventsource" ? normalized.target.href : "",
    credentials_mode: normalized.kind === "eventsource" ? payload.credentials : "",
    cors_referrer_policy: normalized.kind === "eventsource" ? payload.referrer_policy : "",
    redirect: payload.redirect,
    request_mode: payload.mode,
    credentials: client.document_security_policy?.coep==="credentialless"&&normalized.crossOrigin&&payload.mode==="no-cors"?"omit":payload.credentials,
    referrer_policy: payload.referrer_policy,
    referrer_source: normalized.referrerSource,
    referrer: normalized.referrer,
    cors_origin: normalized.crossOrigin ? comparableOrigin(normalized.documentTarget) : serializeRequestOrigin(normalized.documentTarget.href,normalized.target.href,payload.referrer_policy,normalized.method),
    cors_cross_origin: normalized.crossOrigin,
    cors_request_headers: corsRequestHeaders(normalized.headers),
    protocols: normalized.protocols,
    cache: payload.cache,
    integrity: payload.integrity,
    keepalive: payload.keepalive,
    priority: payload.priority,
    causal_after_seq: cookieSequence,
    capability_id: primaryRelayCapability().capability_id,
    capability_epoch: originState.capability_epoch,
    source_client_id: event.source.id,
    one_shot: normalized.kind !== "eventsource",
    revision: 0,
    expires_at: Date.now() + (normalized.kind === "eventsource" ? 86_400_000 : 60_000),
    consumed: false,
    attempt_count: 0,
    live_attempt: false,
    last_event_id: "",
    attempt_budget: normalized.kind === "eventsource" ? 1_000 : 0,
    min_attempt_interval_ms: normalized.kind === "eventsource" ? 100 : 0,
  };
  const db = await database();
  const tx = db.transaction("routes", "readwrite", { durability: "strict" });
  tx.objectStore("routes").add(plan);
  await complete(tx);
  return { path: buildPolicyRoute("api",id), id, revision: 0, body_handle: normalized.bodyHandle };
}
function validAPIPlanBinding(plan,clientID,client){
  let clientTarget;
  try {
    clientTarget = documentAPITarget(client?.target_url).href;
  } catch {
    return false;
  }
  return Boolean(plan&&originState&&clientID&&client&&plan.kind==="api"&&apiKinds.has(plan.api_kind)&&!plan.consumed&&plan.expires_at>Date.now()&&
    plan.session_id===originState.session_id&&plan.document_id===client.runtime_capability&&
    plan.policy_epoch===POLICY_VERSION&&plan.isolation_key_ref===originState.document_capability&&plan.persona===TRANSPORT_PERSONA&&
    plan.source_url===clientTarget&&
    plan.profile_id===originState.profile_id&&plan.tab_id===originState.tab_id&&
    plan.entry_id===originState.entry_id&&plan.origin_id===originState.destination_origin_id&&
    plan.capability_id===primaryRelayCapability().capability_id&&plan.capability_epoch===originState.capability_epoch&&
    plan.source_client_id===clientID&&
    (plan.api_kind!=="eventsource"||(apiBodyHandlePattern.test(plan.instance_id)&&plan.original_url===plan.target_url&&
      plan.credentials_mode===plan.credentials&&plan.cors_referrer_policy===plan.referrer_policy&&
      plan.attempt_budget===1_000&&plan.min_attempt_interval_ms===100)));
}
function validAPIRequestBinding(plan, apiRequest) {
  if (plan.api_kind === "websocket") return apiRequest === null;
  if (!apiRequest || apiRequest.method !== plan.method || Boolean(apiRequest.body) !== plan.body_expected)
    return false;
  const bodyHandle = apiRequest.headers?.get("X-ZP-Body-Handle");
  if (plan.body_expected ? bodyHandle !== plan.body_handle : bodyHandle !== null) return false;
  const contentType = plan.xhr_native_content_type ? apiRequest.headers?.get("Content-Type") : null;
  return contentType === null || contentType.length <= 8192;
}
function admittedAPIPlan(plan, apiRequest) {
  if (!plan.xhr_native_content_type) return plan;
  const contentType = apiRequest.headers.get("Content-Type");
  if (contentType === null) return plan;
  const requestHeaders = [...plan.request_headers, ["Content-Type", contentType]];
  return {...plan, request_headers: requestHeaders, cors_request_headers: corsRequestHeaders(requestHeaders)};
}
function eventSourceAttemptPlan(plan) {
  if (plan.api_kind !== "eventsource") return plan;
  const requestHeaders = plan.request_headers.filter(([name]) => name.toLowerCase() !== "last-event-id");
  if (plan.last_event_id !== "") requestHeaders.push(["Last-Event-ID", plan.last_event_id]);
  return {...plan, request_headers: requestHeaders, cors_request_headers: corsRequestHeaders(requestHeaders)};
}
async function consumeAPIPlan(id,clientID,apiRequest=null){
  if(!originState||!clientID)return null;
  let client;
  try{client=await authorizeDocumentClient(clientID)}catch{return null}
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),plan=await request(store.get(id));
  if(!validAPIPlanBinding(plan,clientID,client)||!validAPIRequestBinding(plan,apiRequest)){tx.abort();return null}
  let admittedPlan=admittedAPIPlan(plan,apiRequest);
  if(plan.api_kind==="eventsource"){
    const now=Date.now();
    if(plan.one_shot!==false||plan.live_attempt===true||!Number.isSafeInteger(plan.attempt_count)||plan.attempt_count>=plan.attempt_budget||
      (Number.isSafeInteger(plan.last_attempt_at)&&now-plan.last_attempt_at<plan.min_attempt_interval_ms)){tx.abort();return null}
    plan.live_attempt=true;plan.attempt_count+=1;plan.revision+=1;plan.last_attempt_at=now;
    store.put(plan);
    admittedPlan=eventSourceAttemptPlan(plan);
  }else{
    if(plan.one_shot!==true||plan.revision!==0){tx.abort();return null}
    store.delete(id);
  }
  await complete(tx);
  return admittedPlan;
}
async function eventSourcePlanCommand(clientID,payload,revoke){
  if(!payload||typeof payload!=="object"||Object.keys(payload).length!==1||!workerGatewayID.test(payload.id))throw new DOMException("EventSource lease rejected","SecurityError");
  const client=await authorizeDocumentClient(clientID);
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),plan=await request(store.get(payload.id));
  if(!validAPIPlanBinding(plan,clientID,client)||plan.api_kind!=="eventsource"||plan.one_shot!==false){tx.abort();throw new DOMException("EventSource lease rejected","SecurityError")}
  if(revoke){store.delete(plan.id);await complete(tx);return{}}
  if(plan.live_attempt){tx.abort();throw new DOMException("EventSource attempt still active","InvalidStateError")}
  plan.revision+=1;
  store.put(plan);
  await complete(tx);
  return{revision:plan.revision};
}
async function releaseEventSourceAttempt(plan){
  if(plan?.api_kind!=="eventsource")return;
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),current=await request(store.get(plan.id));
  if(current&&current.api_kind==="eventsource"&&current.live_attempt&&current.revision===plan.revision){
    current.live_attempt=false;
    store.put(current);
  }
  await complete(tx);
}

async function authorizeDocumentClient(clientID){
  const db=await database(),tx=db.transaction("clients","readonly"),record=await request(tx.objectStore("clients").get(clientID));
  await complete(tx);
  if(!record||!originState||record.profile_id!==originState.profile_id||record.tab_id!==originState.tab_id||record.entry_id!==originState.entry_id||record.origin_id!==originState.destination_origin_id||record.capability_epoch!==originState.capability_epoch)throw new DOMException("Document capability rejected","SecurityError");
  return record;
}
const resourceKinds = new Set(["Document", "Frame", "Script", "Module", "Style", "Image", "Font", "Media", "Manifest", "Worker", "Download"]);

function normalizeResourcePayload(payload) {
  if (!payload
    || typeof payload !== "object"
    || typeof payload.resource_kind !== "string"
    || typeof payload.target_url !== "string")
    throw new DOMException("Invalid resource plan", "SecurityError");
  if (!resourceKinds.has(payload.resource_kind))
    throw new DOMException("Unsupported resource kind", "NotSupportedError");
  let visible;
  try { visible = new URL(payload.target_url); } catch {
    throw new DOMException("Invalid resource target", "SecurityError");
  }
  const fragment = visible.hash;
  visible.hash = "";
  const target = apiTarget(visible.href);
  const kind = routeKind(payload.resource_kind);
  const integrity = payload.integrity ?? null;
  if (integrity !== null && (typeof integrity !== "string" || integrity.length > 8192))
    throw new DOMException("Invalid resource integrity", "SecurityError");
  const corsMode = payload.cors_mode ?? null;
  if (corsMode !== null && !["anonymous", "use-credentials"].includes(corsMode))
    throw new DOMException("Invalid resource CORS mode", "SecurityError");
  return {
    corsMode,
    fetchDestination: resourceFetchDestination(payload.resource_kind),
    integrity,
    kind,
    target,
    targetURL: kind === "navigation" ? `${target.href}${fragment}` : target.href,
  };
}

async function resourceSyntheticOrigin(kind, target) {
  if (kind !== "navigation" || target.origin === apiTarget(originState.target_url).origin)
    return self.location.origin;
  const canonicalTargetOrigin = (await canonicalTarget(target.href)).canonicalOrigin;
  const mapping = await coordinatorCall("MAP_ORIGIN", {
    profile_id: originState.profile_id,
    target_url: target.href,
  });
  const hostMatch = /^o-[a-z2-7]{32}(\.browse\..+)$/u.exec(self.location.hostname);
  if (!mapping
    || typeof mapping.origin_id !== "string"
    || typeof mapping.canonical_origin !== "string"
    || mapping.canonical_origin !== canonicalTargetOrigin
    || !/^[a-z2-7]{32}$/u.test(mapping.origin_id)
    || !hostMatch)
    throw new DOMException("Origin mapping failed", "SecurityError");
  return `${self.location.protocol}//o-${mapping.origin_id}${hostMatch[1]}`;
}

async function allocateResourceRoute(event, payload) {
  const client = await authorizeDocumentClient(event.source.id);
  const normalized = normalizeResourcePayload(payload);
  const id = randomID();
  const route = {
    id,
    kind: normalized.kind,
    profile_id: originState.profile_id,
    tab_id: originState.tab_id,
    entry_id: originState.entry_id,
    origin_id: originState.destination_origin_id,
    target_url: normalized.targetURL,
    source_url: client.target_url,
    ancestor_urls:normalized.fetchDestination === "iframe" ? [...(client.ancestor_urls ?? []), client.target_url] : [],
    session_id: originState.session_id,
    document_id: client.runtime_capability,
    policy_epoch: POLICY_VERSION,
    capability_epoch: originState.capability_epoch,
    isolation_key_ref: originState.document_capability,
    persona: TRANSPORT_PERSONA,
    abi_identifier: client.abi_identifier,
    integrity: normalized.integrity,
    cors_mode: normalized.corsMode,
    credentials:client.document_security_policy?.coep==="credentialless"&&normalized.target.origin!==new URL(client.target_url).origin?"omit":"include",
    document_security_policy:client.document_security_policy,
    policy_context:client.policy_context,
    fetch_destination: normalized.fetchDestination,
    source_client_id: event.source.id,
    expires_at: Date.now() + 300_000,
    consumed: false,
  };
  const syntheticOrigin=await resourceSyntheticOrigin(normalized.kind, normalized.target);
  const db = await database();
  const tx = db.transaction("routes", "readwrite", { durability: "strict" });
  tx.objectStore("routes").add(route);
  await complete(tx);
  return {
    path: buildPolicyRoute(normalized.kind,id),
    route_id:id,
    policy_revision:POLICY_VERSION,
    client_bound:true,
    target_url: normalized.targetURL,
    synthetic_origin: syntheticOrigin,
    virtual_origin: normalized.target.origin,
  };
}
async function revokeResourceRoute(event,payload){
  const client=await authorizeDocumentClient(event.source.id),id=payload?.route_id;
  if(typeof id!=="string"||!/^[A-Za-z0-9_-]{32}$/u.test(id))throw new DOMException("Invalid resource route revocation","SecurityError");
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),route=await request(store.get(id));
  const owned=route?.source_client_id===event.source.id&&route.document_id===client.runtime_capability&&route.policy_epoch===POLICY_VERSION;
  if(owned)store.delete(id);
  await complete(tx);
  return{revoked:owned};
}
function workerExecutableContext(route){
  return Object.freeze({credentials:route.credentials,referrer:route.source_url,integrity:"",cache:["default","no-cache","no-store"].includes(route.cache)?route.cache:"no-store",mode:"cors"});
}
function workerJavaScriptSource(route,result){
  const contentType=headerValue(result.headers,"content-type").split(";",1)[0].trim().toLowerCase();
  if(!["application/ecmascript","application/javascript","application/x-javascript","text/ecmascript","text/javascript"].includes(contentType))throw new DOMException("Worker MIME rejected","SecurityError");
  const source=decodeTargetSource(route,result).text;
  if(encoder.encode(source).byteLength>1<<20)throw new DOMException("Worker source exceeds limit","QuotaExceededError");
  return source;
}
async function persistWorkerExecutable(record){
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"});
  tx.objectStore("routes").put(record);
  await complete(tx);
}
async function persistModuleExecutable(record){
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),existing=await request(store.get(record.id));
  if(existing){
    const matches=existing.kind===record.kind&&existing.graph_id===record.graph_id&&existing.module_id===record.module_id&&existing.content_id===record.content_id&&existing.module_type===record.module_type&&existing.source_kind===record.source_kind&&existing.policy_version===record.policy_version&&existing.target_url===record.target_url&&existing.source_url===record.source_url&&existing.cors_mode===record.cors_mode&&existing.integrity===record.integrity&&existing.source===record.source;
    if(!matches){tx.abort();throw new DOMException("Module identity content conflict","SecurityError")}
  }else store.add(record);
  await complete(tx);
}
function workerRouteBound(route){
  return !!route&&route.expires_at>Date.now()&&route.profile_id===originState?.profile_id&&route.tab_id===originState?.tab_id&&route.entry_id===originState?.entry_id&&route.origin_id===originState?.destination_origin_id&&route.capability_epoch===originState?.capability_epoch;
}
async function workerRouteLive(route,clientID){
  if(!workerRouteBound(route)||typeof route.source_client_id!=="string"||clientID!==route.source_client_id)return false;
  try{await authorizeDocumentClient(route.source_client_id)}catch{return false}
  if(!route.gateway_id)return true;
  const db=await database(),tx=db.transaction("routes","readonly"),gateway=await request(tx.objectStore("routes").get(route.gateway_id));
  await complete(tx);
  return workerRouteBound(gateway)&&gateway.kind==="worker-gateway"&&gateway.lease_active===true&&gateway.lease_generation===route.lease_generation&&gateway.source_client_id===route.source_client_id;
}
async function fetchWorkerExecutableSource(route,targetURL,moduleType="javascript"){
  const target=executableModuleTarget(targetURL),accept=moduleType==="json"?"application/json,*/*;q=0.1":"text/javascript,application/javascript,*/*;q=0.8";
  const requestRoute={...route,id:randomID(),kind:"worker",target_url:target.network.href,method:"GET",request_headers:[["Accept",accept]],body_expected:false};
  const result=await kernelFetch(requestRoute),materialized=await materializeKernelResult(result);
  await applyResponseCookies(requestRoute,materialized,`worker:${requestRoute.id}`);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Worker target unavailable","NetworkError");
  return Object.freeze({module_type:moduleType,source:executableModuleSource(requestRoute,materialized,moduleType),target_url:target.target_url});
}
async function fetchDynamicWorkerModuleRoot(route,targetURL){
  const target=executableModuleTarget(targetURL),requestRoute={...route,id:randomID(),kind:"worker",target_url:target.network.href,method:"GET",request_headers:[["Accept","text/javascript,application/javascript,application/json,*/*;q=0.1"]],body_expected:false};
  const result=await kernelFetch(requestRoute),materialized=await materializeKernelResult(result);
  await applyResponseCookies(requestRoute,materialized,`worker:${requestRoute.id}`);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Worker target unavailable","NetworkError");
  const moduleType=targetModuleType(materialized);
  return Object.freeze({module_type:moduleType,source:executableModuleSource(requestRoute,materialized,moduleType),target_url:target.target_url});
}
function documentModuleContext(route){
  return Object.freeze({credentials:route.credentials??(route.cors_mode==="use-credentials"?"include":"same-origin"),referrer:route.source_url,integrity:route.integrity??"",cache:"no-store",mode:"cors"});
}
async function documentModuleRouteLive(route,clientID){
  if(!route||route.expires_at<=Date.now()||route.profile_id!==originState?.profile_id||route.tab_id!==originState?.tab_id||route.entry_id!==originState?.entry_id||route.origin_id!==originState?.destination_origin_id||route.capability_epoch!==originState?.capability_epoch||route.source_client_id!==clientID)return false;
  try{await authorizeDocumentClient(clientID);return true}catch{return false}
}
async function fetchDocumentModuleSource(route,targetURL,moduleType="javascript"){
  const target=executableModuleTarget(targetURL),accept=moduleType==="json"?"application/json,*/*;q=0.1":"text/javascript,application/javascript,*/*;q=0.8";
  const requestRoute={...route,id:randomID(),kind:"module",target_url:target.network.href,method:"GET",request_headers:[["Accept",accept]],body_expected:false};
  const result=await kernelFetch(requestRoute);
  if(!await documentCoepAllows(requestRoute,result)){await discardKernelBody(result);throw new DOMException("Target COEP blocked module","NetworkError")}
  const materialized=await materializeKernelResult(result);
  await applyResponseCookies(requestRoute,materialized,`module:${requestRoute.id}`);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Module target unavailable","NetworkError");
  return Object.freeze({module_type:moduleType,source:executableModuleSource(requestRoute,materialized,moduleType),target_url:target.target_url});
}
async function createDocumentModuleRoutes(route,source,targetURL,clientID,moduleType="javascript"){
  const graphID=route.module_graph_id;
  if(!workerGatewayID.test(graphID))throw new DOMException("Document module graph unavailable","SecurityError");
  const graph=createContentAddressedModuleGraph({
    moduleRoute:(_graphID,moduleID)=>buildPolicyExecutableRoute("document-module",graphID,moduleID),
    compiler:rewriters.compiler,
    graphID,
    limits:{maxDepth:16,maxModules:64,maxModuleBytes:1<<20,maxSourceBytes:8<<20,maxOutputBytes:8<<20},
    load:input=>fetchDocumentModuleSource(route,input.target_url,input.module_type),
    policyVersion:POLICY_VERSION,
    resolveSpecifier:route.import_map_handle?input=>{
      const resolved=JSON.parse(rewriters.importMap.import_map_resolve_json(route.import_map_handle,input.specifier,input.importer_url));
      if(!resolved||resolved.version!==1||typeof resolved.resolved_url!=="string")throw new DOMException("Import map resolution failed","SecurityError");
      return {module_type:input.module_type,url:resolved.resolved_url};
    }:undefined,
    requestContext:documentModuleContext(route),
  });
  const root=await graph.rewriteRoot(source,targetURL,"ModuleScript",moduleType),entries=await graph.allSources();
  for(const entry of entries){
    await persistModuleExecutable({id:`${graphID}:${entry.module_id}`,kind:"document-module",profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,source_client_id:clientID,capability_epoch:originState.capability_epoch,abi_identifier:route.abi_identifier,graph_id:graphID,module_id:entry.module_id,content_id:entry.content_id,module_type:entry.module_type,source_kind:entry.source_kind,policy_version:POLICY_VERSION,source:entry.source,target_url:entry.target_url,source_url:route.source_url,cors_mode:route.cors_mode??null,credentials:route.credentials??"same-origin",document_security_policy:route.document_security_policy,integrity:route.integrity??null,expires_at:route.expires_at});
  }
  return root;
}
function targetModuleType(result){
  const essence=headerValue(result.headers,"content-type").split(";",1)[0].trim().toLowerCase();
  if(["application/ecmascript","application/javascript","application/x-javascript","text/ecmascript","text/javascript"].includes(essence))return "javascript";
  if(essence==="application/json"||essence.endsWith("+json"))return "json";
  throw new DOMException("Module MIME rejected","SecurityError");
}
async function fetchDynamicDocumentModuleRoot(route,targetURL){
  const target=executableModuleTarget(targetURL),requestRoute={...route,id:randomID(),kind:"module",target_url:target.network.href,method:"GET",request_headers:[["Accept","text/javascript,application/javascript,application/json,*/*;q=0.1"]],body_expected:false};
  const result=await kernelFetch(requestRoute);
  if(!await documentCoepAllows(requestRoute,result)){await discardKernelBody(result);throw new DOMException("Target COEP blocked module","NetworkError")}
  const materialized=await materializeKernelResult(result);
  await applyResponseCookies(requestRoute,materialized,`module:${requestRoute.id}`);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Module target unavailable","NetworkError");
  const moduleType=targetModuleType(materialized);
  return Object.freeze({module_type:moduleType,source:executableModuleSource(requestRoute,materialized,moduleType),target_url:target.target_url});
}
async function allocateTargetModuleImport(event,payload){
  const moduleID=payload?.module_id??null;
  if(!payload||typeof payload!=="object"||Object.keys(payload).some(key=>key!=="module_id"&&key!=="referrer_url"&&key!=="specifier")||moduleID!==null&&(typeof moduleID!=="string"||!/^[a-f0-9]{64}$/u.test(moduleID))||typeof payload.referrer_url!=="string"||payload.referrer_url.length===0||payload.referrer_url.length>16_384||typeof payload.specifier!=="string"||payload.specifier.length>16_384)throw new DOMException("Dynamic module import rejected","SecurityError");
  const client=await authorizeDocumentClient(event.source.id);
  if(!workerGatewayID.test(client.module_graph_id)||typeof client.target_url!=="string"||!workerABIIdentifier.test(client.abi_identifier))throw new DOMException("Document module graph unavailable","SecurityError");
  const referrer=executableModuleTarget(payload.referrer_url).target_url;
  let sourceURL=client.target_url,corsMode=null,integrity=null,credentials=client.document_security_policy?.coep==="credentialless"?"omit":"same-origin",documentSecurityPolicy=client.document_security_policy;
  if(moduleID!==null){
    const db=await database(),tx=db.transaction("routes","readonly"),record=await request(tx.objectStore("routes").get(`${client.module_graph_id}:${moduleID}`));
    await complete(tx);
    if(!await documentModuleRouteLive(record,event.source.id)||record.kind!=="document-module"||record.module_id!==moduleID||record.target_url!==referrer||typeof record.source_url!=="string")throw new DOMException("Dynamic module referrer rejected","SecurityError");
    sourceURL=record.source_url;
    corsMode=record.cors_mode??null;
    integrity=record.integrity??null;
    credentials=record.credentials??credentials;
    documentSecurityPolicy=record.document_security_policy??documentSecurityPolicy;
  }
  let targetURL;
  if(client.import_map_handle){
    const resolved=JSON.parse(rewriters.importMap.import_map_resolve_json(client.import_map_handle,payload.specifier,referrer));
    if(!resolved||resolved.version!==1||typeof resolved.resolved_url!=="string")throw new DOMException("Import map resolution failed","SecurityError");
    targetURL=executableModuleTarget(resolved.resolved_url).target_url;
  }else{
    try{targetURL=executableModuleTarget(new URL(payload.specifier,referrer).href).target_url}catch{throw new DOMException("Module specifier resolution failed","TypeError")}
  }
  const route={profile_id:client.profile_id,tab_id:client.tab_id,entry_id:client.entry_id,origin_id:client.origin_id,source_client_id:event.source.id,abi_identifier:client.abi_identifier,module_graph_id:client.module_graph_id,import_map_handle:client.import_map_handle??null,target_url:targetURL,source_url:sourceURL,cors_mode:corsMode,credentials,document_security_policy:documentSecurityPolicy,integrity,expires_at:Date.now()+300_000};
  const loaded=await fetchDynamicDocumentModuleRoot(route,targetURL),root=await createDocumentModuleRoutes(route,loaded.source,loaded.target_url,event.source.id,loaded.module_type);
  return Object.freeze({module_type:loaded.module_type,path:root.route.url,target_url:loaded.target_url});
}
async function createWorkerModuleRoutes(route,source,sourceKind,targetURL,moduleType="javascript"){
  const graphID=randomID(),graph=createContentAddressedModuleGraph({
    moduleRoute:(_graphID,moduleID)=>buildPolicyExecutableRoute("worker-module",graphID,moduleID),
    compiler:rewriters.compiler,
    graphID,
    limits:{maxDepth:16,maxModules:64,maxModuleBytes:1<<20,maxSourceBytes:8<<20,maxOutputBytes:8<<20},
    load:input=>fetchWorkerExecutableSource(route,input.target_url,input.module_type),
    policyVersion:POLICY_VERSION,
    requestContext:workerExecutableContext(route),
  });
  const root=await graph.rewriteRoot(source,targetURL,sourceKind,moduleType),entries=await graph.allSources();
  for(const entry of entries){
    await persistModuleExecutable({id:`${graphID}:${entry.module_id}`,kind:"worker-module",profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,source_client_id:route.source_client_id,capability_epoch:originState.capability_epoch,abi_identifier:route.abi_identifier,gateway_id:route.gateway_id??null,lease_generation:route.lease_generation??null,graph_id:graphID,module_id:entry.module_id,content_id:entry.content_id,module_type:entry.module_type,source_kind:entry.source_kind,policy_version:POLICY_VERSION,source:entry.source,target_url:entry.target_url,expires_at:route.expires_at});
  }
  return Object.freeze({module_id:root.route.module_id,controlled:true,graph_id:graphID,source:root.source,url:root.route.url});
}
async function fetchTargetServiceWorkerModuleSource(route,targetURL,moduleType){
  const target=executableModuleTarget(targetURL),accept=moduleType==="json"?"application/json,*/*;q=0.1":"text/javascript,application/javascript,*/*;q=0.8",requestRoute={...route,id:randomID(),kind:"worker",target_url:target.network.href,method:"GET",request_headers:[["Accept",accept]],body_expected:false},fetched=await fetchTargetServiceWorkerScript(requestRoute),materialized=await materializeKernelResult(fetched.result);
  if(!Number.isInteger(materialized.status)||materialized.status<200||materialized.status>=300)throw new DOMException("Target service worker module unavailable","NetworkError");
  return Object.freeze({module_type:moduleType,source:executableModuleSource(fetched.route,materialized,moduleType),target_url:fetched.route.target_url});
}
async function createTargetServiceWorkerModuleRoutes(route,source,targetURL,graphID,moduleType="javascript"){
  if(!workerGatewayID.test(graphID))throw new DOMException("Target service worker module graph rejected","SecurityError");
  const rootOrigin=executableModuleTarget(targetURL).network.origin,updateResources=[{hash:await targetServiceWorkerDigest(source),module_type:moduleType,role:"root",url:targetURL}];
  const graph=createContentAddressedModuleGraph({
    moduleRoute:(_graphID,moduleID)=>buildPolicyExecutableRoute("worker-module",graphID,moduleID),
    compiler:rewriters.compiler,
    graphID,
    limits:{maxDepth:16,maxModules:64,maxModuleBytes:1<<20,maxSourceBytes:8<<20,maxOutputBytes:8<<20},
    load:async input=>{
      if(executableModuleTarget(input.target_url).network.origin!==rootOrigin)throw new DOMException("Target service worker module import rejected","SecurityError");
      const loaded=await fetchTargetServiceWorkerModuleSource(route,input.target_url,input.module_type);
      updateResources.push({hash:await targetServiceWorkerDigest(loaded.source),module_type:loaded.module_type,url:loaded.target_url});
      return loaded;
    },
    policyVersion:POLICY_VERSION,
    requestContext:workerExecutableContext(route),
  });
  const root=await graph.rewriteRoot(source,targetURL,"TargetServiceWorkerModule",moduleType),entries=await graph.allSources(),binding=targetWorkerBinding();
  for(const entry of entries){
    await persistModuleExecutable({id:`${graphID}:${entry.module_id}`,kind:"target-worker-module",profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,capability:binding.capability,client_epoch:binding.client_epoch,abi_identifier:route.abi_identifier,graph_id:graphID,module_id:entry.module_id,content_id:entry.content_id,module_type:entry.module_type,source_kind:entry.source_kind,policy_version:POLICY_VERSION,source:entry.source,target_url:entry.target_url,expires_at:route.expires_at});
  }
  return Object.freeze({module_id:root.route.module_id,source:root.source,update_resources:Object.freeze(updateResources.map(resource=>Object.freeze(resource))),url:root.route.url});
}
async function createWorkletModuleRoute(route,source,targetURL){
  const root=await createWorkerModuleRoutes(route,source,"WorkletModule",targetURL),id=randomID(),wrapper=createWorkletModuleWrapper(route.abi_identifier,root.url);
  await persistWorkerExecutable({id,kind:"worklet-wrapper",profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,source_client_id:route.source_client_id,capability_epoch:originState.capability_epoch,abi_identifier:route.abi_identifier,gateway_id:route.gateway_id??null,lease_generation:route.lease_generation??null,source:wrapper,target_url,expires_at:route.expires_at});
  return Object.freeze({controlled:true,url:buildPolicyExecutableRoute("worklet-module",id)});
}
async function workerGatewayResolutionID(gateway,kind,targetURL){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(`${kind}\0${targetURL}`))),hash=[...digest].map(value=>value.toString(16).padStart(2,"0")).join("");
  return `worker-gateway:${gateway.id}:${hash}`;
}
function workerModuleSourceKind(sourceKind){
  if(sourceKind==="ClassicWorker"||sourceKind==="ModuleWorker")return "ModuleWorker";
  if(sourceKind==="SharedClassicWorker"||sourceKind==="SharedModuleWorker")return "SharedModuleWorker";
  if(sourceKind==="WorkletModule")return "WorkletModule";
  throw new DOMException("Worker module source kind rejected","SecurityError");
}
async function readWorkerGateway(id,clientID){
  if(!workerGatewayID.test(id))return null;
  const db=await database(),tx=db.transaction("routes","readonly"),gateway=await request(tx.objectStore("routes").get(id));
  await complete(tx);
  if(!await workerRouteLive(gateway,clientID)||gateway.kind!=="worker-gateway"||gateway.lease_active!==true||!Number.isSafeInteger(gateway.lease_generation)||gateway.lease_generation<1||!workerGatewayID.test(gateway.gateway_key)||!workerABIIdentifier.test(gateway.abi_identifier)||typeof gateway.target_origin!=="string"||typeof gateway.target_url!=="string"||typeof gateway.source_url!=="string"||!["ClassicWorker","ModuleWorker","SharedClassicWorker","SharedModuleWorker","TargetServiceWorkerClassic","WorkletModule"].includes(gateway.source_kind)||!["omit","same-origin","include"].includes(gateway.credentials)||gateway.source_kind==="TargetServiceWorkerClassic"&&!Array.isArray(gateway.certified_imports))return null;
  return gateway;
}
async function openWorkerGateway(id,token,module,clientID){
  if(!workerGatewayID.test(id)||!workerGatewayToken.test(token))throw new DOMException("Worker gateway rejected","SecurityError");
  const gateway=await readWorkerGateway(id,clientID);
  if(!gateway)throw new DOMException("Worker gateway rejected","SecurityError");
  historyCrypto??=await loadRustModule("share_crypto");
  let sealedTarget;
  try{sealedTarget=historyCrypto.open_history_v2(gateway.gateway_key,gateway.id,token)}catch{throw new DOMException("Worker gateway rejected","SecurityError")}
  let parsed;
  try{parsed=new URL(sealedTarget)}catch{throw new DOMException("Worker gateway rejected","SecurityError")}
  if(parsed.username!==""||parsed.password!==""||!module&&parsed.hash!=="")throw new DOMException("Worker gateway rejected","SecurityError");
  const target=module?new URL(executableModuleTarget(parsed.href).target_url):apiTarget(parsed.href);
  if(target.origin!==gateway.target_origin)throw new DOMException("Worker gateway rejected","SecurityError");
  return Object.freeze({gateway,resolution_id:await workerGatewayResolutionID(gateway,module?"module":"classic",target.href),target});
}
async function readWorkerGatewayResolution(id,kind,clientID){
  const db=await database(),tx=db.transaction("routes","readonly"),record=await request(tx.objectStore("routes").get(id));
  await complete(tx);
  if(!await workerRouteLive(record,clientID)||record.kind!==kind||typeof record.source!=="string")return null;
  return record;
}
function workerGatewayFetchRoute(gateway,target){
  return {id:randomID(),kind:"worker",profile_id:gateway.profile_id,tab_id:gateway.tab_id,entry_id:gateway.entry_id,origin_id:gateway.origin_id,target_url:target.href,source_url:gateway.source_url,abi_identifier:gateway.abi_identifier,method:"GET",request_headers:[["Accept","text/javascript,application/javascript,*/*;q=0.8"]],body_expected:false,credentials:gateway.credentials,redirect:"error",source_client_id:gateway.source_client_id,gateway_id:gateway.id,lease_generation:gateway.lease_generation,causal_after_seq:cookieSequence,expires_at:gateway.expires_at};
}
async function materializeWorkerGateway(id,token,module,clientID){
  const opened=await openWorkerGateway(id,token,module,clientID),kind=module?"worker-gateway-module":"worker-gateway-classic",cached=await readWorkerGatewayResolution(opened.resolution_id,kind,clientID);
  if(opened.gateway.source_kind==="TargetServiceWorkerClassic"){
    const certificate=opened.gateway.certified_imports.find(value=>value?.request_url===opened.target.href);
    if(module||!cached||!certificate||cached.compiled_hash!==certificate.compiled_hash||cached.source_hash!==certificate.source_hash||cached.final_url!==certificate.final_url||cached.target_url!==certificate.request_url||await targetServiceWorkerDigest(cached.source)!==certificate.compiled_hash)throw new DOMException("Target service worker importScripts was not certified","SecurityError");
    return cached;
  }
  if(cached)return cached;
  const loadKey=`${opened.resolution_id}:${kind}`,inFlight=workerGatewayLoads.get(loadKey);
  if(inFlight)return inFlight;
  const load=(async()=>{
    const existing=await readWorkerGatewayResolution(opened.resolution_id,kind,clientID);
    if(existing)return existing;
    await Promise.all([warmRewriters(),warmKernel()]);
    const route=workerGatewayFetchRoute(opened.gateway,opened.target);
    let record;
    if(module){
      const loaded=await fetchDynamicWorkerModuleRoot(route,opened.target.href),root=await createWorkerModuleRoutes(route,loaded.source,workerModuleSourceKind(opened.gateway.source_kind),loaded.target_url,loaded.module_type);
      record={id:opened.resolution_id,kind,profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,capability_epoch:originState.capability_epoch,abi_identifier:route.abi_identifier,gateway_id:opened.gateway.id,lease_generation:opened.gateway.lease_generation,module_url:root.url,module_type:loaded.module_type,source:root.source,target_url:opened.target.href,source_client_id:route.source_client_id,expires_at:route.expires_at};
    }else{
      const source=(await fetchWorkerExecutableSource(route,opened.target.href)).source;
      let compiled;
      try{compiled=decodeCompilerResult(rewriters.compiler.compile_json(source,opened.gateway.source_kind,opened.gateway.abi_identifier))}catch{throw new DOMException("Worker compilation rejected","SecurityError")}
      if(compiled.ok!==true||encoder.encode(compiled.code).byteLength>1<<20)throw new DOMException("Worker compilation rejected","SecurityError");
      record={id:opened.resolution_id,kind,profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,capability_epoch:originState.capability_epoch,abi_identifier:route.abi_identifier,gateway_id:opened.gateway.id,lease_generation:opened.gateway.lease_generation,source:compiled.code,target_url:opened.target.href,source_client_id:route.source_client_id,expires_at:route.expires_at};
    }
    await persistWorkerExecutable(record);
    return record;
  })();
  workerGatewayLoads.set(loadKey,load);
  try{return await load}finally{if(workerGatewayLoads.get(loadKey)===load)workerGatewayLoads.delete(loadKey)}
}
function suppliedWorkerSource(value,targetURL,moduleKind){
  if(value===undefined)return null;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["bytes","kind","media_type","url"].includes(key))||!(value.bytes instanceof Uint8Array)||value.bytes.byteLength>1<<20||!["blob","data"].includes(value.kind)||typeof value.media_type!=="string"||value.media_type.length>256||typeof value.url!=="string"||value.url!==targetURL)throw new DOMException("Worker executable source rejected","SecurityError");
  const essence=value.media_type.split(";",1)[0].trim().toLowerCase();
  if(moduleKind&&!["application/ecmascript","application/javascript","application/x-javascript","text/ecmascript","text/javascript"].includes(essence)||(value.kind==="blob"&&!value.url.startsWith("blob:"))||(value.kind==="data"&&!value.url.startsWith("data:")))throw new DOMException("Worker executable source rejected","SecurityError");
  const charset=/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/iu.exec(value.media_type),label=charset?.[1]??charset?.[2]??"utf-8";
  let decoder;
  try{decoder=new TextDecoder(label||"utf-8")}catch{decoder=new TextDecoder}
  return decoder.decode(value.bytes);
}
const workerSourceKinds = new Set([
  "ClassicWorker",
  "ModuleWorker",
  "SharedClassicWorker",
  "SharedModuleWorker",
  "WorkletModule",
]);

function normalizeWorkerBootstrap(payload) {
  const allowedKeys = ["executable_source", "options", "source_kind", "target_url", "worker_abi_identifier"];
  if (!payload
    || typeof payload !== "object"
    || Object.keys(payload).some(key => !allowedKeys.includes(key))
    || typeof payload.target_url !== "string"
    || typeof payload.source_kind !== "string"
    || !workerABIIdentifier.test(payload.worker_abi_identifier)
    || !payload.options
    || typeof payload.options !== "object"
    || Array.isArray(payload.options))
    throw new DOMException("Invalid worker bootstrap request", "SecurityError");
  if (!workerSourceKinds.has(payload.source_kind))
    throw new DOMException("Unsupported worker source kind", "NotSupportedError");
  const options = payload.options;
  if (Object.keys(options).some(key => !["type", "name", "credentials"].includes(key))
    || options.type !== undefined && !["classic", "module"].includes(options.type)
    || options.name !== undefined && (typeof options.name !== "string" || options.name.length > 256)
    || options.credentials !== undefined && !["omit", "same-origin", "include"].includes(options.credentials))
    throw new DOMException("Invalid worker bootstrap options", "SecurityError");
  const moduleKind = ["ModuleWorker", "SharedModuleWorker", "WorkletModule"].includes(payload.source_kind);
  const directSource = suppliedWorkerSource(payload.executable_source, payload.target_url, moduleKind);
  if (moduleKind && options.type !== undefined && options.type !== "module"
    || !moduleKind && options.type === "module")
    throw new DOMException("Worker source type mismatch", "SecurityError");
  const documentTarget = apiTarget(originState.target_url);
  const target=directSource===null?(moduleKind?new URL(executableModuleTarget(payload.target_url).target_url):apiTarget(payload.target_url)):documentTarget;
  if (target.origin !== documentTarget.origin)
    throw new DOMException("Cross-origin worker rejected", "SecurityError");
  return { directSource, moduleKind, options, target };
}

async function createWorkerBootstrapRoot(route, source, payload, normalized, gateway) {
  const rootTargetURL = normalized.directSource === null ? normalized.target.href : payload.target_url;
  if (payload.source_kind === "WorkletModule")
    return createWorkletModuleRoute(route, source, rootTargetURL);
  if (normalized.moduleKind)
    return createWorkerModuleRoutes(route, source, payload.source_kind, rootTargetURL);
  let compiled;
  try {
    compiled = decodeCompilerResult(
      rewriters.compiler.compile_json(source, payload.source_kind, route.abi_identifier),
    );
  } catch {
    throw new DOMException("Worker compilation rejected", "SecurityError");
  }
  if (compiled.ok !== true || encoder.encode(compiled.code).byteLength > 1 << 20)
    throw new DOMException("Worker compilation rejected", "SecurityError");
  const id = randomID();
  await persistWorkerExecutable({
    id,
    kind: "worker-classic",
    profile_id: route.profile_id,
    tab_id: route.tab_id,
    entry_id: route.entry_id,
    origin_id: route.origin_id,
    source_client_id: route.source_client_id,
    capability_epoch: originState.capability_epoch,
    abi_identifier: route.abi_identifier,
    gateway_id: gateway.id,
    lease_generation: gateway.lease_generation,
    source: compiled.code,
    target_url: rootTargetURL,
    expires_at: route.expires_at,
  });
  return Object.freeze({ controlled: true, url: buildPolicyExecutableRoute("worker-classic",id) });
}

async function persistWorkerGateway(route, gateway, payload, normalized) {
  await persistWorkerExecutable({
    id: gateway.id,
    kind: "worker-gateway",
    profile_id: route.profile_id,
    tab_id: route.tab_id,
    entry_id: route.entry_id,
    origin_id: route.origin_id,
    source_client_id: route.source_client_id,
    capability_epoch: originState.capability_epoch,
    abi_identifier: route.abi_identifier,
    gateway_key: gateway.key,
    lease_active: true,
    lease_generation: gateway.lease_generation,
    target_origin: normalized.target.origin,
    target_url: payload.target_url,
    source_url: route.source_url,
    source_kind: payload.source_kind,
    credentials: route.credentials,
    expires_at: route.expires_at,
  });
}

async function allocateTargetWorkerBootstrap(event, payload) {
  await authorizeDocumentClient(event.source.id);
  const normalized = normalizeWorkerBootstrap(payload);
  await Promise.all([warmRewriters(), warmKernel()]);
  const expiresAt = Date.now() + 3_600_000;
  const gateway = Object.freeze({ id: randomID(), key: randomID(), expires_at: expiresAt, lease_generation: 1 });
  const route = {
    id: randomID(),
    kind: "worker",
    profile_id: originState.profile_id,
    tab_id: originState.tab_id,
    entry_id: originState.entry_id,
    origin_id: originState.destination_origin_id,
    target_url: normalized.target.href,
    source_url: originState.target_url,
    abi_identifier: payload.worker_abi_identifier,
    method: "GET",
    request_headers: [["Accept", "text/javascript,application/javascript,*/*;q=0.8"]],
    body_expected: false,
    credentials: normalized.options.credentials ?? "same-origin",
    redirect: "error",
    source_client_id: event.source.id,
    gateway_id: gateway.id,
    lease_generation: gateway.lease_generation,
    causal_after_seq: cookieSequence,
    expires_at: expiresAt,
  };
  const source = normalized.directSource
    ?? (await fetchWorkerExecutableSource(route, normalized.target.href)).source;
  const root = await createWorkerBootstrapRoot(route, source, payload, normalized, gateway);
  await persistWorkerGateway(route, gateway, payload, normalized);
  if (payload.source_kind === "WorkletModule") {
    return {
      abi_identifier: route.abi_identifier,
      module_url: root.url,
      root_precompiled: true,
      source_kind: payload.source_kind,
      target_origin: normalized.target.origin,
      target_url: payload.target_url,
      worker_abi_identifier: route.abi_identifier,
    };
  }
  const version = await versionManifest();
  const bootstrapURL = version.selectors?.["worker-bootstrap.mjs"];
  if (typeof bootstrapURL !== "string")
    throw new DOMException("Worker bootstrap asset unavailable", "InvalidStateError");
  const bootstrap = Object.freeze({
    abi_identifier: route.abi_identifier,
    classic_root: root,
    gateway,
    message_allowed: true,
    module_root: root,
    root_precompiled: true,
  });
  return {
    abi_identifier: route.abi_identifier,
    bootstrap,
    bootstrap_url: bootstrapURL,
    path: root.url,
    root_precompiled: true,
    source,
    source_kind: payload.source_kind,
    target_origin: normalized.target.origin,
    target_url: payload.target_url,
    worker_abi_identifier: route.abi_identifier,
  };
}
async function releaseTargetWorkerBootstrap(event,payload){
  await authorizeDocumentClient(event.source.id);
  if(!payload||typeof payload!=="object"||Object.keys(payload).some(key=>key!=="gateway_id"&&key!=="lease_generation")||!workerGatewayID.test(payload.gateway_id)||!Number.isSafeInteger(payload.lease_generation)||payload.lease_generation<1)throw new DOMException("Worker lease release rejected","SecurityError");
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),gateway=await request(store.get(payload.gateway_id));
  if(!workerRouteBound(gateway)||gateway.kind!=="worker-gateway"||gateway.source_client_id!==event.source.id||gateway.lease_active!==true||gateway.lease_generation!==payload.lease_generation){tx.abort();throw new DOMException("Worker lease release rejected","SecurityError")}
  store.put({...gateway,lease_active:false,lease_generation:gateway.lease_generation+1});
  await complete(tx);
  return {released:true};
}
function documentCookieURL(value){
  if(typeof value!=="string"||value.length===0||value.length>16_384)throw new DOMException("Invalid cookie target","SecurityError");
  const target=new URL(value,originState.target_url),documentTarget=new URL(originState.target_url);
  if(target.origin!==documentTarget.origin)throw new DOMException("Cookie origin mismatch","SecurityError");
  target.hash="";
  return target.href;
}
async function documentCookieSnapshot(payload){
  const target=documentCookieURL(payload?.target_url);
  const knownSeq=Number.isSafeInteger(payload?.known_seq)&&payload.known_seq>=0?payload.known_seq:cookieSequence;
  return cookieSnapshot("DOCUMENT",target,knownSeq,"GET",false);
}
async function documentCookieMutate(payload){
  const target=documentCookieURL(payload?.target_url);
  if(typeof payload?.raw!=="string"||payload.raw.length===0||payload.raw.length>4096||typeof payload?.op_id!=="string"||payload.op_id.length<16||payload.op_id.length>256)throw new DOMException("Invalid cookie mutation","SecurityError");
  const baseSeq=Number.isSafeInteger(payload.base_seq)&&payload.base_seq>=0?payload.base_seq:cookieSequence;
  const commit=await coordinatorCall("COOKIE_MUTATE",{
    ...cookieContext,
    op_id:payload.op_id,
    source_kind:"DOCUMENT",
    base_seq:baseSeq,
    causal_after_seq:baseSeq,
    canonical_target_context:cookieTargetContext(target,"GET",false),
    raw_set_cookie_or_document_cookie:payload.raw,
  });
  if(!commit||!Number.isSafeInteger(commit.cookie_seq))throw coordinatorFailure("COOKIE_STATE_CORRUPT");
  cookieSequence=Math.max(cookieSequence,commit.cookie_seq);
  const snapshot=await cookieSnapshot("DOCUMENT",target,0,"GET",false);
  return {commit,snapshot};
}

function runtimePortReply(port,requestID,ok,result,error){
  port.postMessage(ok?{v:2,request_id:requestID,ok:true,result}:{v:2,request_id:requestID,ok:false,error:{code:failureCode(error,"RUNTIME_COMMAND_FAILED")}});
}
function handleRuntimePort(clientID,port,event){
  const message=event.data,requestID=message?.request_id;
  const promise=(async()=>{
    if(!message||message.v!==2||typeof requestID!=="string"||requestID.length<16||requestID.length>128||typeof message.operation!=="string")throw new DOMException("Invalid runtime command","SecurityError");
    await authorizeDocumentClient(clientID);
    const runtimeEvent={source:{id:clientID}};
    if(message.operation==="OPEN_API_STREAM"){
      const streamPort=event.ports[0];
      if(!streamPort)throw new DOMException("Missing stream port","SecurityError");
      await openWebSocketPlan(runtimeEvent,message,streamPort);
      return null;
    }
    let result;
    switch(message.operation){
      case"ALLOCATE_API_PLAN":result=await allocateAPIPlan(runtimeEvent,message.payload);break;
      case"EVENTSOURCE_RECONNECT":result=await eventSourcePlanCommand(clientID,message.payload,false);break;
      case"EVENTSOURCE_REVOKE":result=await eventSourcePlanCommand(clientID,message.payload,true);break;
      case"ALLOCATE_RESOURCE_ROUTE":result=await allocateResourceRoute(runtimeEvent,message.payload);break;
      case"REVOKE_RESOURCE_ROUTE":result=await revokeResourceRoute(runtimeEvent,message.payload);break;
      case"TARGET_MODULE_IMPORT_ALLOCATE":result=await allocateTargetModuleImport(runtimeEvent,message.payload);break;
      case"TARGET_WORKER_BOOTSTRAP_ALLOCATE":result=await allocateTargetWorkerBootstrap(runtimeEvent,message.payload);break;
      case"TARGET_WORKER_BOOTSTRAP_RELEASE":result=await releaseTargetWorkerBootstrap(runtimeEvent,message.payload);break;
      case"GET_ANCHOR_PING_POLICY":result=anchorPingPolicy;break;
      case"DOCUMENT_COOKIE_SNAPSHOT":result=await documentCookieSnapshot(message.payload);break;
      case"DOCUMENT_COOKIE_MUTATE":result=await documentCookieMutate(message.payload);break;
      case"TARGET_SERVICE_WORKER_REGISTER":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_UPDATE":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_GET_REGISTRATION":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_GET_REGISTRATIONS":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_READY":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_UNREGISTER":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_POST_MESSAGE":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_GET":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_ENABLE":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_DISABLE":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      case"TARGET_SERVICE_WORKER_NAVIGATION_PRELOAD_SET_HEADER":result=await targetServiceWorkerCommand(clientID,message.operation,message.payload);break;
      default:throw new DOMException("Unknown runtime command","NotSupportedError");
    }
    runtimePortReply(port,requestID,true,result);
    return null;
  })().catch(error=>{
    if(message?.operation==="OPEN_API_STREAM"){
      try{event.ports[0]?.postMessage({v:2,type:"error",request_id:message.payload?.id,error:error?.message??"STREAM_FAILED"})}catch{}
      return;
    }
    try{runtimePortReply(port,requestID,false,null,error)}catch{}
  });
  return promise;
}
async function bindRuntimePort(event,message){
  if(event.ports.length!==1||typeof message.payload?.runtime_capability!=="string")throw new DOMException("Runtime capability missing","SecurityError");
  const clientID=event.source.id,record=await authorizeDocumentClient(clientID);
  if(record.runtime_capability!==message.payload.runtime_capability)throw new DOMException("Runtime capability rejected","SecurityError");
  const port=event.ports[0],previous=runtimePorts.get(clientID);
  if(previous&&previous!==port)try{previous.close()}catch{}
  runtimePorts.set(clientID,port);
  port.onmessage=runtimeEvent=>{void handleRuntimePort(clientID,port,runtimeEvent)};
  port.onmessageerror=()=>{runtimePorts.delete(clientID);try{port.close()}catch{}};
  port.start();
  port.postMessage({v:2,operation:"RUNTIME_PORT_READY"});
  return {bound:true};
}

const serviceCommandOperations=new Set([
  "ATTACH_COORDINATOR",
  "ATTACH_TARGET_WORKER_HOST",
  "WAIT_TARGET_WORKER_HOST",
  "TARGET_WORKER_DISPATCH_LIFECYCLE",
  "WARM_REWRITERS",
  "WARM_KERNEL",
  "ALLOCATE_DOCUMENT_ROUTE",
  "BIND_RUNTIME_PORT",
]);
const processLocalServiceCommands=new Set([
  "ATTACH_COORDINATOR",
  "ATTACH_TARGET_WORKER_HOST",
  "WAIT_TARGET_WORKER_HOST",
  "BIND_RUNTIME_PORT",
  "WARM_REWRITERS",
  "WARM_KERNEL",
]);
async function validateServiceCommand(event,message){
  if(!message||message.v!==2||!serviceCommandOperations.has(message.operation)||!event.source?.id||!event.ports[0])throw new DOMException("Invalid command","SecurityError");
  if(message.operation!=="ATTACH_COORDINATOR"&&!originState){
    await hydrateForEvent(message.operation==="BIND_RUNTIME_PORT"||message.operation==="TARGET_WORKER_DISPATCH_LIFECYCLE");
  }
  if(message.operation==="ATTACH_TARGET_WORKER_HOST"){
    if(!exactTargetWorkerHostSource(event.source))throw new DOMException("Target worker host source rejected","SecurityError");
  }else if(message.operation!=="ATTACH_COORDINATOR"&&message.operation!=="BIND_RUNTIME_PORT"&&event.source.id!==originState?.bootstrap_client_id){
    throw new DOMException("Bootstrap capability rejected","SecurityError");
  }
}
async function dispatchServiceCommand(event,message){
  switch(message.operation){
    case"ATTACH_COORDINATOR":return attachCoordinator(event,message);
    case"ATTACH_TARGET_WORKER_HOST":return attachTargetWorkerHost(event,message);
    case"WAIT_TARGET_WORKER_HOST":return waitTargetWorkerHost();
    case"TARGET_WORKER_DISPATCH_LIFECYCLE":return dispatchTargetWorkerLifecycle(message.payload);
    case"WARM_REWRITERS":return warmRewriters();
    case"WARM_KERNEL":return warmKernel();
    case"ALLOCATE_DOCUMENT_ROUTE":return allocateRoute(event,message.payload,message.command_id);
    case"BIND_RUNTIME_PORT":return bindRuntimePort(event,message);
    default:throw new DOMException("Unknown command","NotSupportedError");
  }
}
async function rollbackServiceCommand(event,message,reason){
  if(message.operation==="ALLOCATE_DOCUMENT_ROUTE"){
    const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),route=await request(store.get(message.command_id));
    if(route?.kind==="document"&&route.source_client_id===event.source.id)store.delete(route.id);
    await complete(tx);
  }
  if(reason==="failed"&&message.operation==="BIND_RUNTIME_PORT"){
    const port=runtimePorts.get(event.source.id);
    if(port===event.ports[0]){runtimePorts.delete(event.source.id);try{port.close()}catch{}}
  }
  if(reason==="failed"&&message.operation==="ATTACH_COORDINATOR"&&coordinatorPort&&event.ports.includes(coordinatorPort)){
    try{coordinatorPort.close()}catch{}
    coordinatorPort=null;
  }
}
self.addEventListener("message",event=>{
  const message=event.data,replyPort=event.ports[0];
  if(message?.operation==="PROBE_TARGET_WORKER_HOST"){
    const promise=(async()=>{
      if(message.v!==2||!workerGatewayID.test(message.command_id)||event.ports.length!==1||message.replyPort!==replyPort)throw new DOMException("Invalid target worker host probe","SecurityError");
      if(!originState)await hydrateForEvent(false);
      const result=await probeTargetWorkerHost(event,message);
      reply(replyPort,message.command_id,true,result);
      if(result?.attached===true)try{await reconcileTargetWorkerClients()}catch{}
    })().catch(error=>{try{reply(replyPort,message?.command_id,false,null,error)}catch{}});
    event.waitUntil(promise);
    return;
  }
  const promise=(async()=>{
    const payloadDigest=await commandPayloadDigest(message?.payload,message?.operation);
    const handlers={
      validate:()=>validateServiceCommand(event,message),
      run:()=>dispatchServiceCommand(event,message),
      recover:(_record,reason)=>rollbackServiceCommand(event,message,reason),
    };
    if(processLocalServiceCommands.has(message?.operation))handlers.replay=()=>dispatchServiceCommand(event,message);
    const result=await commandJournal().execute({
      id:message?.command_id,
      operation:message?.operation,
      source_client_id:event.source?.id,
      payload_digest:payloadDigest,
    },handlers);
    reply(replyPort,message.command_id,true,result);
    await commandJournal().replied(message.command_id);
  })().catch(error=>{try{reply(replyPort,message?.command_id,false,null,error)}catch{}});
  event.waitUntil(promise);
});

async function consumeRoute(id, expectedKind){
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),route=await request(store.get(id));
  if(!route||route.kind!==expectedKind||route.consumed||route.expires_at<=Date.now()){tx.abort();return null}
  store.delete(id);
  await complete(tx);
  return route;
}
const internalTerminalResponses=new WeakMap;
function internalTerminal(code,status){
  if(code.includes("VERSION"))return"VERSION_MISMATCH";
  if(code.includes("REWRITE")||code.includes("ENCODING")||code.includes("INTEGRITY"))return"REWRITE_FAILED";
  if(code.includes("ABORT"))return"ABORTED";
  if(code.includes("TIMEOUT"))return"TIMED_OUT";
  if(code.includes("CLIENT_GONE")||status===410)return"CLIENT_GONE";
  if(status===401||status===403||code.includes("POLICY")||code.includes("DENIED")||code.includes("UNKNOWN"))return"POLICY_BLOCKED";
  return"TRANSPORT_FAILED";
}
function markInternalTerminal(response,code,status){
  internalTerminalResponses.set(response,{state:internalTerminal(code,status),code});
  return response;
}
function blocked(code,status=403){
  return markInternalTerminal(new Response(`ZeroProxy blocked: ${code}`,{status,headers:{"Content-Type":"text/plain;charset=utf-8","Cache-Control":"no-store"}}),code,status);
}
function headerValue(headers,name){const pair=headers.find(([key])=>key.toLowerCase()===name.toLowerCase());return pair?.[1]??""}
function headerValues(headers,name){return headers.filter(([key,value])=>key.toLowerCase()===name.toLowerCase()&&typeof value==="string").map(([,value])=>value)}
function routeKind(kind){return ({Document:"navigation",Frame:"navigation",Script:"script",Module:"module",Style:"style",Image:"resource",Font:"resource",Media:"resource",Manifest:"resource",Worker:"worker",Download:"download"})[kind]??"resource"}
function resourceFetchDestination(kind){return ({Document:"document",Frame:"iframe",Script:"script",Module:"script",Style:"style",Image:"image",Font:"font",Media:"video",Manifest:"manifest",Worker:"worker",Download:"empty"})[kind]??"empty"}
function crossOriginMode(value){if(typeof value!=="string")return null;return value.trim().toLowerCase()==="use-credentials"?"use-credentials":"anonymous"}
function integrityContext(route,result){return {sourceURL:route.source_url??route.target_url,targetURL:route.target_url,corsMode:route.cors_mode,headers:result.headers}}
function decodeTargetSource(route,result){const contentType=headerValue(result.headers,"content-type");return decodeHTML(result.body,route.kind==="document"?contentType:`${contentType};charset=${route.encoding_used??"windows-1252"}`)}
async function storeRoutes(routes){if(!routes.length)return;const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes");for(const route of routes)store.add(route);await complete(tx)}
async function stageNavigationRetry(route){
  if(!route||!["document","navigation"].includes(route.kind))return null;
  const retry={...route,id:randomID(),consumed:false,expires_at:Date.now()+60_000};
  if(typeof retry.abi_identifier==="string")retry.abi_identifier=randomABI();
  for(const key of ["runtime_capability","module_graph_id","import_map_handle","policy_context","document_security_policy","target_service_worker_controller"])delete retry[key];
  await storeRoutes([retry]);
  return buildPolicyRoute(retry.kind,retry.id);
}
async function navigationFailure(route,event,code,status=502){
  const failure=ERROR_CODES.includes(code)?code:"INTERNAL_FAILED";
  let retryPath=new URL(event.request.url).pathname;
  try{retryPath=await stageNavigationRetry(route)??retryPath}catch{}
  const manifest=await versionManifest(),scriptPath=manifest.selectors?.["native-failure-page.mjs"];
  if(typeof scriptPath!=="string")return blocked("FAILURE_PAGE_ASSET_MISSING",503);
  return markInternalTerminal(createNavigationFailureResponse({
    code:failure,
    requestID:randomID(),
    retryPath,
    scriptPath,
    stage:errorSpecification(failure).stages[0],
    targetURL:route?.visible_target_url??route?.target_url??null,
    status,
  }),failure,status);
}
function kernelNetworkError(){return new DOMException("Target transport failed","NetworkError")}
function kernelAbortError(){return new DOMException("The operation was aborted","AbortError")}
const executableTargetResponseHeaders=new Set([
  "alt-svc","clear-site-data","content-security-policy","content-security-policy-report-only",
  "cross-origin-embedder-policy","cross-origin-opener-policy","cross-origin-resource-policy",
  "expect-ct","link","location","nel","origin-trial","permissions-policy","public-key-pins",
  "refresh","report-to","reporting-endpoints","service-worker-allowed","source-map","sourcemap",
  "strict-transport-security","x-content-security-policy","x-frame-options","x-source-map",
]);
function targetResponseHeaderIsExecutable(name){
  if(typeof name!=="string")return true;
  const lower=name.toLowerCase();
  return lower==="set-cookie"||lower==="set-cookie2"||lower.startsWith("x-zp-")||executableTargetResponseHeaders.has(lower);
}
function responseHeaders(result){
  const headers=new Headers;
  for(const [name,value] of result.headers){
    if(targetResponseHeaderIsExecutable(name))continue;
    headers.append(name,value);
  }
  return headers;
}
function targetWorkerNetworkHeaders(result){
  const headers=new Headers;
  for(const [name,value] of result.headers){
    const lower=name.toLowerCase();
    if(lower==="set-cookie"||lower==="set-cookie2"||lower.startsWith("x-zp-"))continue;
    headers.append(name,value);
  }
  return headers;
}
async function fetchTargetWorkerRouteResponse(route,event){
  let result;
  if(route.bootstrap_submission){
    const followed=await followFormPlan(route,event,route.body);
    if(followed instanceof Response){
      targetWorkerNavigationHandoffs.add(followed);
      return followed;
    }
    result=followed.result;
  }else{
    result=await kernelFetch(route,event.request.signal);
    await applyResponseCookies(route,result,`route:${route.id}`);
  }
  const nullBody=(route.method??event.request.method)==="HEAD"||result.status===204||result.status===205||result.status===304;
  if(nullBody)await discardKernelBody(result);
  return new Response(nullBody?null:result.body,{status:result.status,statusText:result.statusText,headers:targetWorkerNetworkHeaders(result)});
}
async function materializeKernelResult(result){const reader=result.body.getReader(),chunks=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||value.byteLength===0)throw kernelNetworkError();length+=value.byteLength;if(length>16<<20)throw new DOMException("Target body exceeds transform limit","NetworkError");chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}return {...result,body}}
function includesTargetCredentials(route){
  if(route.credentials==="omit")return false;
  if(route.credentials==="same-origin"&&route.cors_cross_origin)return false;
  return true;
}
async function outboundCookieContext(route){
  if(!includesTargetCredentials(route))return{header:"",sequence:cookieSequence};
  const snapshot=await cookieSnapshot("HEADER",route.target_url,Number.isSafeInteger(route.causal_after_seq)?route.causal_after_seq:cookieSequence,route.method??"GET",route.kind==="document");
  if(!Number.isSafeInteger(snapshot.cookie_seq)||snapshot.cookie_seq<0||snapshot.jar_or_delta.kind!=="HEADER"||typeof snapshot.jar_or_delta.value!=="string")throw coordinatorFailure("COOKIE_STATE_CORRUPT");
  return{header:snapshot.jar_or_delta.value,sequence:snapshot.cookie_seq};
}
function responseCookieValues(headers){
  const values=[];
  for(const pair of headers)if(Array.isArray(pair)&&typeof pair[0]==="string"&&pair[0].toLowerCase()==="set-cookie"&&typeof pair[1]==="string")values.push(pair[1]);
  return values;
}
async function applyResponseCookies(route,result,chainID,startIndex=0){
  if(!includesTargetCredentials(route))return startIndex;
  const values=responseCookieValues(result.headers);
  for(let offset=0;offset<values.length;offset+=1){
    const index=startIndex+offset;
    const commit=await coordinatorCall("COOKIE_MUTATE",{
      ...cookieContext,
      op_id:`${chainID}:${index}:${randomID()}`,
      source_kind:"HTTP_RESPONSE",
      base_seq:cookieSequence,
      causal_after_seq:cookieSequence,
      canonical_target_context:cookieTargetContext(route.target_url,route.method??"GET",route.kind==="document"),
      raw_set_cookie_or_document_cookie:values[offset],
      response_chain_id:chainID,
      header_index:index,
    });
    if(!commit||!Number.isSafeInteger(commit.cookie_seq))throw coordinatorFailure("COOKIE_STATE_CORRUPT");
    cookieSequence=commit.cookie_seq;
  }
  return startIndex+values.length;
}

function targetFetchSite(route) {
  if (!route.source_url) return "none";
  let source;
  let target;
  try {
    source = new URL(route.source_url);
    target = new URL(route.target_url);
  } catch {
    throw new DOMException("Invalid fetch metadata URL", "SecurityError");
  }
  if (source.origin === target.origin) return "same-origin";
  if (source.protocol === target.protocol && source.hostname === target.hostname) return "same-site";
  return "cross-site";
}

function targetFetchMode(route) {
  if (route.kind === "document" || route.kind === "navigation") return "navigate";
  if (route.kind === "worker") return "same-origin";
  if (["cors", "no-cors", "same-origin"].includes(route.request_mode)) return route.request_mode;
  return route.kind === "api" ? "cors" : "no-cors";
}

function targetFetchDestination(route) {
  if (["document","iframe","worker","script","style","image","font","video","manifest","empty"].includes(route.fetch_destination)) return route.fetch_destination;
  return ({
    document: "document", navigation: "document", worker: "worker",
    script: "script", module: "script", style: "style",
    image: "image", font: "font", manifest: "manifest",
  })[route.kind] ?? "empty";
}

function targetFetchMetadata(route, authoritativeSite = targetFetchSite(route)) {
  const destination = targetFetchDestination(route);
  const navigation = route.kind === "document" || route.kind === "navigation";
  const topNavigation = navigation && destination === "document";
  const priority = navigation ? "u=0, i" : route.priority === "high" ? "u=0" : route.priority === "low" ? "u=2" : "u=1";
  const headers = [
    ["Sec-Fetch-Site", authoritativeSite],
    ["Sec-Fetch-Mode", targetFetchMode(route)],
    ["Sec-Fetch-Dest", destination],
    ["Priority", priority],
  ];
  if (topNavigation) headers.splice(2, 0, ["Sec-Fetch-User", "?1"]);
  if (navigation) headers.unshift(["Upgrade-Insecure-Requests", "1"]);
  return headers;
}

function targetHeaderIsNetworkOwned(name) {
  if (typeof name !== "string") return true;
  const lower = name.toLowerCase();
  return lower.startsWith("sec-ch-") || lower.startsWith("sec-fetch-") ||
    lower.startsWith("x-zp-") || lower.startsWith("proxy-") || [
    "host", "origin", "referer", "cookie", "user-agent", "accept-encoding", "accept-language",
    "upgrade-insecure-requests", "priority", "connection", "keep-alive", "transfer-encoding",
    "content-length", "trailer", "te", "upgrade", "expect", "via", "forwarded",
  ].includes(lower);
}

function targetRequestHeaderSeed(route) {
  const headers = Array.isArray(route.request_headers)
    ? route.request_headers.filter(pair => Array.isArray(pair) && !targetHeaderIsNetworkOwned(pair[0])).map(pair => [pair[0], pair[1]])
    : [["Accept", "*/*"]];
  return headers;
}

async function authoritativeFetchSite(route) {
  if (!route.source_url) return "none";
  const [source,target]=await Promise.all([canonicalTarget(route.source_url),canonicalTarget(route.target_url)]);
  if(source.canonicalOrigin===target.canonicalOrigin)return"same-origin";
  if(source.canonicalSite===target.canonicalSite)return"same-site";
  return"cross-site";
}

async function kernelRequestContext(route) {
  const headers = targetRequestHeaderSeed(route);
  const cookie = await outboundCookieContext(route);
  let origin = "";
  if (route.integrity && route.cors_mode) {
    let sourceOrigin;
    let targetOrigin;
    try {
      sourceOrigin = new URL(route.source_url).origin;
      targetOrigin = new URL(route.target_url).origin;
    } catch {
      throw new DOMException("Invalid SRI origin", "SecurityError");
    }
    if (sourceOrigin !== targetOrigin) origin = sourceOrigin;
  }
  if (route.cors_origin) {
    if (origin && origin !== route.cors_origin)
      throw new DOMException("Conflicting request origin context","SecurityError");
    origin = route.cors_origin;
  }
  const metadata = new Map(targetFetchMetadata(route,await authoritativeFetchSite(route)).map(([name,value])=>[name.toLowerCase(),value]));
  return Object.freeze({
    headers,
    cookie_header: cookie.header,
    cookie_seq: cookie.sequence,
    origin,
    referrer: route.referrer ?? "",
    fetch_site: fetchSiteFloor(metadata.get("sec-fetch-site"),route.fetch_site_floor),
    fetch_site_floor: route.fetch_site_floor ?? "",
    fetch_mode: metadata.get("sec-fetch-mode"),
    fetch_destination: metadata.get("sec-fetch-dest"),
    fetch_user: metadata.get("sec-fetch-user") === "?1",
    priority: metadata.get("priority"),
    upgrade_insecure: metadata.get("upgrade-insecure-requests") === "1",
  });
}

function sealedTransportPlan(route,state,context,documentBinding) {
  const binding=currentKernelBinding();
  const requireBinding=(field,expected)=>{
    if(route[field]!==undefined&&route[field]!==expected)
      throw new DOMException("Transport plan binding mismatch","SecurityError");
    return expected;
  };
  const sourceURL=route.source_url?apiTarget(route.source_url).href:"";
  const referrer=context.referrer?apiTarget(context.referrer).href:"";
  return Object.freeze({
    plan_id: state.planID,
    source_client_id: documentBinding.sourceClientID,
    document_id: documentBinding.documentID,
    profile_id: requireBinding("profile_id",binding.profileID),
    session_id: requireBinding("session_id",binding.sessionID),
    tab_id: requireBinding("tab_id",binding.tabID),
    origin_id: requireBinding("origin_id",binding.originID),
    entry_id: documentBinding.entryID,
    policy_epoch: requireBinding("policy_epoch",binding.policyEpoch),
    capability_epoch: requireBinding("capability_epoch",binding.capabilityEpoch),
    target_url: apiTarget(route.target_url).href,
    source_url: sourceURL,
    referrer,
    fetch_site_floor: context.fetch_site_floor,
    fetch_site: context.fetch_site,
    fetch_mode: context.fetch_mode,
    fetch_destination: context.fetch_destination,
    fetch_user: context.fetch_user,
    priority: context.priority,
    upgrade_insecure: context.upgrade_insecure,
    origin: context.origin,
    credentials: route.credentials ?? "include",
    cookie_seq: context.cookie_seq,
    cookie_header: context.cookie_header,
    isolation_key_ref: requireBinding("isolation_key_ref",binding.isolationKeyRef),
    persona: requireBinding("persona",binding.persona),
    method: route.method ?? "GET",
    headers: context.headers,
    body_expected: state.bodyExpected,
    body_handle: state.bodyHandle,
    redirect: route.redirect ?? "manual",
  });
}

function removeKernelAbort(state) {
  state.signal?.removeEventListener("abort", state.abort);
}

function kernelFrame(state, frame) {
  if (typeof self.__zeroproxyKernelTransactionFrameV2 !== "function")
    return Promise.reject(new DOMException("Kernel stream unavailable", "InvalidStateError"));
  return self.__zeroproxyKernelTransactionFrameV2(kernelHandle, state.requestID, frame);
}

function sendKernelCancel(state, code = "CLIENT_ABORT") {
  if (!state.started) return;
  state.cancelFrame ??= { type: "CANCEL", seq: state.expectedDownloadSeq, code };
  void kernelFrame(state, state.cancelFrame).catch(() => {});
}

function releaseKernelUpload(state) {
  if (state.requestReaderResource) {
    const resource = state.requestReaderResource;
    state.requestReaderResource = null;
    void state.requestLifecycle.release(resource, false);
  }
}

function trackKernelLifecycle(state) {
  const requestLifecycle = requestSignalLifecycles.get(state.signal);
  if (!requestLifecycle) return;
  state.requestLifecycle = requestLifecycle;
  state.lifecycleResource = requestLifecycle.track("smux_stream", state.requestID, async () => {
    if (state.cancelSent) return;
    state.cancelSent = true;
    sendKernelCancel(state, "PORT_CLOSED");
    try { await state.requestBody?.cancel("REQUEST_TERMINAL"); } catch {}
  });
}

function releaseKernelLifecycle(state) {
  if (!state.requestLifecycle || !state.lifecycleResource) return;
  const resource = state.lifecycleResource;
  state.lifecycleResource = null;
  void state.requestLifecycle.release(resource, false);
}

function failKernelTransaction(state, error) {
  if (state.settled) return false;
  state.settled = true;
  state.rejectHeaders(error);
  try { state.controller?.error(error); } catch {}
  removeKernelAbort(state);
  releaseKernelUpload(state);
  releaseKernelLifecycle(state);
  if (!state.cancelSent) {
    state.cancelSent = true;
    sendKernelCancel(state, "PROTOCOL_ERROR");
  }
  return true;
}

function flushKernelTerminal(state) {
  if (!state.controller || !state.terminal || !state.headersCheckpointed) return;
  state.settled = true;
  if (state.terminal.type === "CLOSE") state.controller.close();
  else state.controller.error(kernelNetworkError());
  removeKernelAbort(state);
  releaseKernelUpload(state);
  releaseKernelLifecycle(state);
}

function abortKernelTransaction(state, code = "CLIENT_ABORT") {
  if (state.cancelSent) return;
  state.cancelSent = true;
  state.settled = true;
  sendKernelCancel(state, code);
  if (!state.headersReceived) state.rejectHeaders(kernelAbortError());
  try { state.controller?.error(kernelAbortError()); } catch {}
  removeKernelAbort(state);
  releaseKernelUpload(state);
  releaseKernelLifecycle(state);
}

function validKernelHeaderPairs(value) {
  return Array.isArray(value)
    && value.every(pair => Array.isArray(pair)
      && pair.length === 2
      && typeof pair[0] === "string"
      && typeof pair[1] === "string");
}

function validKernelInformational(value) {
  return Array.isArray(value)
    && value.length <= 16
    && value.every(response => response
      && typeof response === "object"
      && !Array.isArray(response)
      && Object.keys(response).sort().join("\0") === "headers\0status"
      && Number.isInteger(response.status)
      && response.status >= 100
      && response.status < 200
      && validKernelHeaderPairs(response.headers));
}

function acceptKernelHeaders(state, message) {
  if (!exactFrame(message, [
    "status", "status_text", "headers", "url", "redirected",
    "response_type", "request_site", "redirect", "informational",
  ])
    || state.headersReceived
    || state.terminal
    || !Number.isInteger(message.status)
    || message.status < 200
    || message.status > 599
    || !validKernelHeaderPairs(message.headers)
    || !validKernelInformational(message.informational)
    || !["none", "same-origin", "same-site", "cross-site"].includes(message.request_site)) return false;
  state.headersReceived = true;
  const result = {
    status: message.status,
    statusText: typeof message.status_text === "string" ? message.status_text : "",
    headers: message.headers,
    url: message.url,
    redirected: message.redirected,
    responseType: message.response_type,
    requestSite: message.request_site,
    redirect: message.redirect,
    informational: message.informational,
    body: state.body,
  };
  void ensureSignalRequestPhase(state.signal, "HEADERS").then(() => {
    state.headersCheckpointed = true;
    state.resolveHeaders(result);
    requestKernelDownload(state);
    flushKernelTerminal(state);
  }, error => failKernelTransaction(state, error));
  return true;
}

function requestKernelDownload(state) {
  if (state.settled
    || state.terminal
    || !state.opened
    || !state.headersCheckpointed
    || !state.pullRequested
    || state.downloadPull) return;
  state.pullRequested = false;
  state.downloadPull = {
    type: "PULL",
    seq: state.expectedDownloadSeq,
    desired_bytes: state.maxChunkBytes,
  };
  void kernelFrame(state, state.downloadPull).catch(error => failKernelTransaction(state, error));
}

function acceptKernelChunk(state, message) {
  if (!exactFrame(message, ["seq", "chunk"])
    || !state.headersReceived
    || state.terminal
    || !state.downloadPull
    || !(message.chunk instanceof ArrayBuffer)
    || message.chunk.byteLength < 1
    || message.chunk.byteLength > state.downloadPull.desired_bytes
    || !validStreamSequence(message.seq)
    || message.seq !== state.downloadPull.seq
    || message.seq !== state.expectedDownloadSeq) return false;
  state.downloadPull = null;
  state.expectedDownloadSeq += 1;
  try {
    state.controller.enqueue(new Uint8Array(message.chunk));
  } catch (error) {
    failKernelTransaction(state, error);
  }
  return true;
}

function acceptKernelClose(state, message) {
  if (!exactFrame(message, ["final_seq"])
    || !state.headersReceived
    || !validStreamSequence(message.final_seq)
    || message.final_seq !== state.expectedDownloadSeq) return false;
  if (state.terminal)
    return state.terminal.type === "CLOSE" && state.terminal.final_seq === message.final_seq;
  state.terminal = message;
  state.downloadPull = null;
  flushKernelTerminal(state);
  return true;
}

function acceptKernelError(state, message) {
  if (!exactFrame(message, ["seq", "error"])
    || !validStreamSequence(message.seq)
    || message.seq !== state.expectedDownloadSeq) return false;
  let error;
  try {
    error = normalizeInternalError(message.error);
  } catch {
    return false;
  }
  if (error.request_id !== state.requestID) return false;
  if (state.terminal)
    return state.terminal.type === "ERROR"
      && state.terminal.seq === message.seq
      && state.terminal.error.code === error.code
      && state.terminal.error.stage === error.stage
      && state.terminal.error.retryable === error.retryable;
  state.terminal = { ...message, error };
  state.downloadPull = null;
  if (!state.headersReceived) {
    state.settled = true;
    state.rejectHeaders(kernelNetworkError());
    try { state.controller?.error(kernelNetworkError()); } catch {}
    removeKernelAbort(state);
    releaseKernelUpload(state);
    releaseKernelLifecycle(state);
    return true;
  }
  flushKernelTerminal(state);
  return true;
}

async function readKernelUploadValue(state) {
  if (state.uploadRemainder) return { done: false, value: state.uploadRemainder };
  for (let emptyReads = 0; emptyReads < 16; emptyReads += 1) {
    const result = await state.requestReader.read();
    if (result.done) return result;
    if (!(result.value instanceof Uint8Array)) throw kernelNetworkError();
    if (result.value.byteLength > state.highWaterMark) throw kernelNetworkError();
    if (result.value.byteLength !== 0) return result;
  }
  throw kernelNetworkError();
}

async function satisfyKernelUploadPull(state, frame) {
  try {
    const { done, value } = await readKernelUploadValue(state);
    if (state.settled) return;
    if (done) {
      await kernelFrame(state, { type: "CLOSE", final_seq: frame.seq });
      state.uploadClosed = true;
      state.uploadPull = null;
      releaseKernelUpload(state);
      return;
    }
    const length = Math.min(value.byteLength, frame.desired_bytes);
    const chunk = value.subarray(0, length);
    state.uploadRemainder = length === value.byteLength ? null : value.subarray(length);
    const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    await kernelFrame(state, { type: "CHUNK", seq: frame.seq, chunk: buffer });
    state.uploadSeq += 1;
    state.uploadPull = null;
  } catch {
    if (state.settled) return;
    try {
      await kernelFrame(state, { type: "ERROR", seq: frame.seq, code: "UPLOAD_READ_ERROR" });
    } catch {
      failKernelTransaction(state, kernelNetworkError());
    }
  }
}

function acceptKernelPull(state, message) {
  if (!exactFrame(message, ["seq", "desired_bytes"])
    || !state.bodyExpected
    || state.uploadClosed
    || state.uploadPull
    || !validStreamSequence(message.seq)
    || message.seq !== state.uploadSeq
    || !Number.isSafeInteger(message.desired_bytes)
    || message.desired_bytes < 1
    || message.desired_bytes > state.maxChunkBytes) return false;
  state.uploadPull = message;
  void satisfyKernelUploadPull(state, message);
  return true;
}

function handleKernelEvent(state, message) {
  if (state.settled) return;
  if (!message || typeof message !== "object" || Array.isArray(message)
    || typeof message.type !== "string") {
    failKernelTransaction(state, kernelNetworkError());
    return;
  }
  let accepted = false;
  if (message.type === "HEADERS") accepted = acceptKernelHeaders(state, message);
  else if (message.type === "PULL") accepted = acceptKernelPull(state, message);
  else if (message.type === "CHUNK") accepted = acceptKernelChunk(state, message);
  else if (message.type === "CLOSE") accepted = acceptKernelClose(state, message);
  else if (message.type === "ERROR") accepted = acceptKernelError(state, message);
  if (!accepted) failKernelTransaction(state, kernelNetworkError());
}

async function startKernelTransaction(state, plan) {
  const startStatus = await beginKernelTransaction(
    state,
    () => self.__zeroproxyKernelTransactionStartV2(kernelHandle, {
      v: 2,
      request_id: state.requestID,
      plan,
      on_event: message => handleKernelEvent(state, message),
    }),
    kernelNetworkError,
    failKernelTransaction,
  );
  if (startStatus !== "accepted") {
    if (startStatus === "settled" && state.started && state.cancelSent) sendKernelCancel(state);
    return;
  }
  await ensureSignalRequestPhase(state.signal, "TRANSPORTING");
  if (state.cancelSent) sendKernelCancel(state);
  requestKernelDownload(state);
}

async function kernelFetch(route, signal, requestBody = null) {
  await ensureKernelBinding();
  if (!kernelReady || !kernelHandle)
    throw new DOMException("Kernel unavailable", "InvalidStateError");
  const bodyExpected = route.body_expected === true;
  if (bodyExpected && requestBody === null)
    throw new DOMException("Request body unavailable", "NetworkError");
  const bodyHandle=bodyExpected
    ? typeof route.body_handle==="string"&&workerGatewayID.test(route.body_handle)?route.body_handle:randomID()
    : "";
  const state = {
    bodyExpected,
    cancelSent: false,
    controller: null,
    deadlineMS: 0,
    downloadPull: null,
    expectedDownloadSeq: 0,
    headersReceived: false,
    opened: false,
    pullRequested: false,
    requestBody,
    bodyHandle,
    planID: randomID(),
    requestID: randomID(),
    settled: false,
    signal,
    started: false,
    terminal: null,
    uploadClosed: !bodyExpected,
    uploadPull: null,
    uploadRemainder: null,
    uploadSeq: 0,
  };
  trackKernelLifecycle(state);
  await ensureSignalRequestPhase(signal,"PLANNED");
  const context=await kernelRequestContext(route);
  const documentBinding=await provisionKernelDocument(route);
  const plan=sealedTransportPlan(route,state,context,documentBinding);
  if(bodyExpected){
    state.requestReader=requestBody.getReader();
    if(state.requestLifecycle)state.requestReaderResource=state.requestLifecycle.track("reader",`upload:${state.requestID}`,()=>state.requestReader.cancel("REQUEST_TERMINAL"));
  }
  await ensureSignalRequestPhase(signal,"BODY_OPEN");
  const headersReady = new Promise((resolve, reject) => {
    state.resolveHeaders = resolve;
    state.rejectHeaders = reject;
  });
  state.abort = () => abortKernelTransaction(state);
  state.body = new ReadableStream({
    start(controller) {
      state.controller = controller;
      requestKernelDownload(state);
      flushKernelTerminal(state);
    },
    pull() {
      state.pullRequested = true;
      requestKernelDownload(state);
    },
    cancel() {
      abortKernelTransaction(state, "CONSUMER_CANCEL");
    },
  }, { highWaterMark: 0 });
  if (signal) {
    signal.addEventListener("abort", state.abort, { once: true });
    if (signal.aborted) state.abort();
  }
  await ensureSignalRequestPhase(signal,"QUEUED");
  await startKernelTransaction(state,plan);
  return headersReady;
}
const documentRouteCommits=new WeakMap;
async function deleteRoutes(ids){
  if(ids.length===0)return;
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes");
  for(const id of ids)store.delete(id);
  await complete(tx);
}
async function stageDocumentRoutes(routes,event){
  if(routes.length===0)return null;
  if(routes.length>128)throw new DOMException("Document route limit exceeded","QuotaExceededError");
  const requestLifecycle=requestSignalLifecycles.get(event.request.signal);
  if(!requestLifecycle)throw new DOMException("Request lifecycle unavailable","InvalidStateError");
  const ids=routes.map(route=>route.id);
  return requestLifecycle.trackDurable("idb_entry","document-routes",()=>deleteRoutes(ids),{type:"route_ids",ids},async snapshot=>{
    const db=await database(),tx=db.transaction(["request_journal","routes"],"readwrite",{durability:"strict"}),routeStore=tx.objectStore("routes");
    tx.objectStore("request_journal").put(snapshot);
    for(const route of routes)routeStore.add(route);
    await complete(tx);
  });
}
async function documentMappedOriginIDs(routes){
  const targets=[...new Set(routes.filter(route=>route.kind==="navigation").map(route=>new URL(route.target_url).origin))];
  if(targets.length>128)throw new DOMException("Document mapped origin limit exceeded","QuotaExceededError");
  const identifiers=[];
  for(const target of targets){
    const canonical=(await canonicalTarget(target)).canonicalOrigin;
    const mapping=await coordinatorCall("MAP_ORIGIN",{profile_id:originState.profile_id,target_url:target});
    if(!mapping||mapping.canonical_origin!==canonical||typeof mapping.origin_id!=="string"||!/^[a-z2-7]{32}$/u.test(mapping.origin_id))throw new DOMException("Document origin mapping rejected","SecurityError");
    identifiers.push(mapping.origin_id);
  }
  return identifiers;
}
function documentAncestorURLs(route){
  const fallback=route.fetch_destination==="iframe"&&typeof route.source_url==="string"?[route.source_url]:[];
  const values=route.ancestor_urls??fallback;
  if(!Array.isArray(values)||values.length>32)throw new DOMException("Document ancestor chain rejected","SecurityError");
  return values.map(value=>{
    const url=new URL(value);
    if(!["http:","https:"].includes(url.protocol)||url.username!==""||url.password!=="")throw new DOMException("Document ancestor rejected","SecurityError");
    return url.href;
  });
}
async function targetRelationship(sourceURL,targetURL){
  const [source,target]=await Promise.all([canonicalTarget(sourceURL),canonicalTarget(targetURL)]);
  if(source.canonicalOrigin===target.canonicalOrigin)return"same-origin";
  if(source.canonicalSite===target.canonicalSite)return"same-site";
  return"cross-origin";
}
async function rewriteDocument(route,result,event){
  const contentType=headerValue(result.headers,"content-type").toLowerCase();
  if(!contentType.includes("text/html")&&!contentType.includes("application/xhtml+xml"))return new Response(result.body,{status:result.status,headers:{"Content-Type":contentType||"application/octet-stream","Cache-Control":"no-store"}});
  let decoded;
  try{decoded=decodeTargetSource(route,result)}catch{return navigationFailure(route,event,"DOCUMENT_ENCODING_UNSUPPORTED",502)}
  const source=decoded.text;
  const version=await versionManifest(),runtime=version.selectors["runtime-prelude.js"];
  if(typeof runtime!=="string")return navigationFailure(route,event,"RUNTIME_ASSET_MISSING",503);
  const visibleTarget=route.visible_target_url??route.target_url;
  let canonical;
  try{canonical=JSON.parse(rewriters.policy.canonicalize_json(visibleTarget))}catch{return navigationFailure(route,event,"TARGET_URL_INVALID",502)}
  let targetCSP,targetCSPHeaders,targetCSPReportOnly;
  try{
    const meta=JSON.parse(rewriters.html.extract_meta_csp_json(source));
    targetCSPHeaders=headerValues(result.headers,"content-security-policy");
    targetCSP=[...targetCSPHeaders,...meta];
    targetCSPReportOnly=headerValues(result.headers,"content-security-policy-report-only");
    if(!Array.isArray(meta)||targetCSP.length>16||targetCSPReportOnly.length>16||[...targetCSP,...targetCSPReportOnly].some(value=>typeof value!=="string"||value.length>64<<10))throw new DOMException("Target CSP collection rejected","SecurityError");
  }catch{return navigationFailure(route,event,"TARGET_CSP_INVALID",502)}
  const context={
    profile_id:route.profile_id,
    tab_id:route.tab_id,
    document_id:route.entry_id,
    virtual_origin:canonical.origin,
    virtual_site:canonical.site,
    target_url:visibleTarget,
    effective_base_url:visibleTarget,
    referrer_url:null,
    referrer_policy:"strict-origin-when-cross-origin",
    document_charset:decoded.encoding_used,
    target_csp:targetCSP,
    target_csp_report_only:targetCSPReportOnly,
    relay_profile:primaryRelayCapability().claims_digest,
    approved_target_ports:commonRelayPorts(),
    policy_version:POLICY_VERSION,
  };
  let ancestorURLs,documentPolicy,isolationPolicy;
  try{
    ancestorURLs=documentAncestorURLs(route);
    documentPolicy=JSON.parse(rewriters.policy.csp_document_policy_json(JSON.stringify(context)));
    isolationPolicy=responseIsolationHeaders({
      coopValues:headerValues(result.headers,"cross-origin-opener-policy"),
      coepValues:headerValues(result.headers,"cross-origin-embedder-policy"),
      permissionsPolicyValues:headerValues(result.headers,"permissions-policy"),
      reportToValues:headerValues(result.headers,"report-to"),
      reportingEndpointsValues:headerValues(result.headers,"reporting-endpoints"),
    });
    if(ancestorURLs.length){
      const cspAllowed=rewriters.policy.csp_allows_frame_ancestors_json(JSON.stringify(targetCSPHeaders),visibleTarget,JSON.stringify(ancestorURLs));
      const relationships=await Promise.all(ancestorURLs.map(ancestor=>targetRelationship(ancestor,visibleTarget)));
      const xFrameAllowed=xFrameOptionsAllows(headerValues(result.headers,"x-frame-options"),relationships.every(value=>value==="same-origin")?"same-origin":"cross-origin");
      if(cspAllowed!==true||!xFrameAllowed)return navigationFailure(route,event,"TARGET_FRAME_POLICY_BLOCKED",403);
    }
  }catch{return navigationFailure(route,event,"TARGET_DOCUMENT_POLICY_INVALID",502)}
  route.ancestor_urls=ancestorURLs;
  route.document_security_policy=Object.freeze({version:1,coep:isolationPolicy.coep,report_endpoint_count:documentPolicy.enforced_report_endpoint_count+documentPolicy.report_only_endpoint_count+isolationPolicy.reportEndpointHeaderCount});
  let stringCompilationAllowed;
  try{
    stringCompilationAllowed=rewriters.policy.csp_allows_eval_json(JSON.stringify(context));
    if(typeof stringCompilationAllowed!=="boolean")throw new DOMException("Target CSP eval decision rejected","SecurityError");
  }catch{return navigationFailure(route,event,"TARGET_CSP_INVALID",502)}
  const moduleGraphID=randomID();
  let importMapHandle="";
  try{
    const importMaps=JSON.parse(rewriters.html.extract_import_maps_json(source,visibleTarget));
    if(!Array.isArray(importMaps)||importMaps.length>16)throw new DOMException("Invalid import map collection","SecurityError");
    for(const importMap of importMaps){
      if(!importMap||typeof importMap!=="object"||Array.isArray(importMap)||Object.keys(importMap).length!==3||typeof importMap.source!=="string"||typeof importMap.base_url!=="string"||typeof importMap.module_graph_started!=="boolean"||new URL(importMap.base_url).href!==importMap.base_url)throw new DOMException("Invalid import map","SecurityError");
      const registration=JSON.parse(rewriters.importMap.import_map_register_json(importMapHandle,importMap.source,importMap.base_url,importMap.module_graph_started));
      if(!registration||registration.version!==1||typeof registration.registered!=="boolean"||typeof registration.handle!=="string")throw new DOMException("Invalid import map registration","SecurityError");
      importMapHandle=registration.handle;
    }
  }catch{return navigationFailure(route,event,"IMPORT_MAP_INVALID",502)}
  route.module_graph_id=moduleGraphID;
  route.import_map_handle=importMapHandle||null;
  const cookieRouteID=randomID();
  const snapshot=await cookieSnapshot("DOCUMENT",route.target_url,0,"GET",false);
  let targetServiceWorkerController=null;
  if(targetWorkerBroker){
    try{
      const registration=await targetWorkerBroker.getRegistration(visibleTarget);
      if(registration?.active_version)targetServiceWorkerController=publicTargetServiceWorker(registration);
    }catch{return navigationFailure(route,event,"TARGET_WORKER_STATE_UNAVAILABLE",503)}
  }
  const nonce=randomID();
  const cookieBootstrap=encodeBase64URL(encoder.encode(JSON.stringify({
    runtime_capability:route.runtime_capability,
    entry_id:route.entry_id,
    cookie_top_level_site:cookieTopLevelSite,
    target_service_worker_controller:targetServiceWorkerController,
    policy_context:context,
    document_policy:documentPolicy,
    snapshot,
    import_map_handle:importMapHandle||null,
    decode_metadata:{encoding_used:decoded.encoding_used,replacement:decoded.replacement,source:decoded.source},
  })));
  const pending=[],inlineModules=[];
  const virtualBase=new URL(`/_zp/vbase/${route.entry_id}/`,self.location.origin).href;
  const runtimeURL=`${runtime}#abi=${route.abi_identifier}&url=${encodeURIComponent(visibleTarget)}&ports=${encodeURIComponent(commonRelayPorts().join(","))}&strings=${stringCompilationAllowed?1:0}&tt=${documentTrustedTypesPolicyName(nonce)}&cookie=${cookieRouteID}&bootstrap=${encodeURIComponent(cookieBootstrap)}`;
  let html;
  try{
    html=rewriters.html.rewrite_html(source,JSON.stringify(context),runtimeURL,virtualBase,route.abi_identifier,nonce,(target,kind,integrity,crossorigin,moduleType,moduleReferrer)=>{
      if(moduleType!==null&&moduleType!==undefined){
        if(kind!=="Module"||!["javascript","json"].includes(moduleType)||typeof target!=="string"||typeof moduleReferrer!=="string")throw new DOMException("Inline module specifier rejected","SecurityError");
        let resolved;
        if(importMapHandle){
          const resolution=JSON.parse(rewriters.importMap.import_map_resolve_json(importMapHandle,target,moduleReferrer));
          if(!resolution||resolution.version!==1||typeof resolution.resolved_url!=="string")throw new DOMException("Import map resolution failed","SecurityError");
          resolved=executableModuleTarget(resolution.resolved_url).target_url;
        }else resolved=executableModuleTarget(new URL(target,moduleReferrer).href).target_url;
        const marker=`/_zp/inline-module/${randomID()}.mjs`;
        inlineModules.push(Object.freeze({marker,module_type:moduleType,target_url:resolved}));
        return marker;
      }
      const id=randomID(),mapped=routeKind(kind);
      pending.push({id,kind:mapped,fetch_destination:resourceFetchDestination(kind),profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,target_url:target,source_url:visibleTarget,ancestor_urls:kind === "Frame" ? [...ancestorURLs, visibleTarget] : [],abi_identifier:route.abi_identifier,integrity:typeof integrity==="string"?integrity:null,cors_mode:crossOriginMode(crossorigin),credentials:isolationPolicy.coep === "credentialless" && new URL(target).origin !== new URL(visibleTarget).origin ? "omit" : crossOriginMode(crossorigin) === "anonymous" || mapped === "module" ? "same-origin" : "include",document_security_policy:route.document_security_policy,import_map_handle:importMapHandle||null,module_graph_id:moduleGraphID,policy_context:context,policy_version:POLICY_VERSION,encoding_used:decoded.encoding_used,decode_replacement:decoded.replacement,expires_at:Date.now()+300_000,consumed:false});
      return buildPolicyRoute(mapped,id);
    });
    if(inlineModules.length){
      const clientID=event.resultingClientId;
      if(typeof clientID!=="string"||clientID.length===0)throw new DOMException("Resulting document client unavailable","SecurityError");
      const expiresAt=Date.now()+300_000,loads=new Map;
      for(const item of inlineModules){
        const key=`${item.module_type}\0${item.target_url}`;
        let load=loads.get(key);
        if(!load){
          const moduleRoute={profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,source_client_id:clientID,abi_identifier:route.abi_identifier,module_graph_id:moduleGraphID,import_map_handle:importMapHandle||null,target_url:item.target_url,source_url:visibleTarget,cors_mode:null,integrity:null,credentials:isolationPolicy.coep === "credentialless" && new URL(item.target_url).origin !== new URL(visibleTarget).origin ? "omit" : "same-origin",document_security_policy:route.document_security_policy,policy_context:context,expires_at:expiresAt};
          load=(async()=>{const loaded=await fetchDocumentModuleSource(moduleRoute,item.target_url,item.module_type);return createDocumentModuleRoutes(moduleRoute,loaded.source,loaded.target_url,clientID,loaded.module_type)})();
          loads.set(key,load);
        }
        const root=await load;
        html=html.replace(item.marker,root.route.url);
      }
    }
  }catch{return navigationFailure(route,event,"REWRITE_FAILED",502)}
  let csp;
  try{
    csp=generateDocumentCSP({
      destinationHost:originState.destination_host,
      destinationOriginID:originState.destination_origin_id,
      documentPolicy,
      mappedOriginIDs:await documentMappedOriginIDs(pending),
      nonce,
      relayURLs:relayProfileBindings().map(({capability})=>capability.relay_url),
      syntheticOrigin:self.location.origin,
    });
  }catch{return navigationFailure(route,event,"DOCUMENT_CSP_INVALID",503)}
  route.policy_context=context;
  const responseHeaderSet=new Headers({"Content-Type":"text/html;charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":csp,"X-DNS-Prefetch-Control":"off","Origin-Agent-Cluster":"?1","X-ZeroProxy-Source-Encoding":decoded.encoding_used,"X-ZeroProxy-Decode-Replacement":String(decoded.replacement)});
  if(isolationPolicy.coop!==null)responseHeaderSet.set("Cross-Origin-Opener-Policy",isolationPolicy.coop);
  if(isolationPolicy.coep!==null)responseHeaderSet.set("Cross-Origin-Embedder-Policy",isolationPolicy.coep);
  if(isolationPolicy.permissionsPolicy!=="")responseHeaderSet.set("Permissions-Policy",isolationPolicy.permissionsPolicy);
  const commitResource=await stageDocumentRoutes(pending,event),response=new Response(html,{status:result.status,headers:responseHeaderSet});
  if(commitResource)documentRouteCommits.set(response,[commitResource]);
  return response;
}
async function deleteDocumentBinding(clientID,entryID){
  const db=await database(),tx=db.transaction(["clients","history_keys"],"readwrite",{durability:"strict"});
  tx.objectStore("clients").delete(clientID);
  tx.objectStore("history_keys").delete(entryID);
  await complete(tx);
}
async function bindDocumentClient(event,route,runtimeCapability){
  const clientID=event.resultingClientId;
  if(typeof clientID!=="string"||clientID.length===0)throw new DOMException("Resulting document client unavailable","SecurityError");
  const requestLifecycle=requestSignalLifecycles.get(event.request.signal);
  if(!requestLifecycle)throw new DOMException("Request lifecycle unavailable","InvalidStateError");
  const bindingResource=await requestLifecycle.trackDurable("idb_entry",`document:${clientID}`,()=>deleteDocumentBinding(clientID,route.entry_id),{type:"document_binding",client_id:clientID,entry_id:route.entry_id},async snapshot=>{
    const db=await database(),tx=db.transaction(["request_journal","clients","history_keys"],"readwrite",{durability:"strict"});
    tx.objectStore("request_journal").put(snapshot);
    tx.objectStore("clients").put({client_id:clientID,profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,capability_epoch:originState.capability_epoch,runtime_capability:runtimeCapability,abi_identifier:route.abi_identifier,module_graph_id:route.module_graph_id,import_map_handle:route.import_map_handle??null,target_url:route.visible_target_url??route.target_url,source_url:route.source_url??originState.target_url,ancestor_urls:route.ancestor_urls??[],document_security_policy:route.document_security_policy,policy_context:route.policy_context});
    tx.objectStore("history_keys").put({entry_id:route.entry_id,profile_id:route.profile_id,tab_id:route.tab_id,origin_id:route.origin_id,capability_epoch:originState.capability_epoch,runtime_capability:runtimeCapability,abi_identifier:route.abi_identifier,expires_at:Date.now()+30*24*60*60*1000});
    await complete(tx);
  });
  const targetURL=new URL(route.visible_target_url??route.target_url);targetURL.hash="";
  if(targetWorkerBroker&&targetURL.origin===new URL(originState.target_url).origin){
    const commit=targetWorkerBroker.commitClient({operation_id:`client:${randomID()}`,client_id:clientID,type:"window",url:targetURL.href});
    event.waitUntil(commit);
    try{await commit}catch(error){await deleteDocumentBinding(clientID,route.entry_id);throw error}
    const softUpdate=targetServiceWorkerSoftUpdate(targetURL.href,clientID).catch(()=>null);
    event.waitUntil(softUpdate);
  }
  return bindingResource??null;
}
function sameOriginNavigationPlan(route){
  const visibleTarget=new URL(route.target_url),networkTarget=new URL(visibleTarget.href);networkTarget.hash="";
  const target=apiTarget(networkTarget.href),current=apiTarget(originState.target_url);
  if(target.origin!==current.origin)return null;
  const entryID=randomID(),snapshot={
    capability_epoch:originState.capability_epoch,
    expected_revision:originState.lineage_revision,
    origin_id:originState.destination_origin_id,
    profile_id:originState.profile_id,
    referrer_url:originState.target_url,
    tab_id:originState.tab_id,
  };
  return {
    documentRoute:{...route,entry_id:entryID,kind:"document",target_url:target.href,visible_target_url:visibleTarget.href},
    async finalizeNavigation(){
      const history=await coordinatorCall("UPDATE_SAME_ORIGIN_HISTORY",{
        profile_id:snapshot.profile_id,
        tab_id:snapshot.tab_id,
        entry_id:entryID,
        origin_id:snapshot.origin_id,
        capability_epoch:snapshot.capability_epoch,
        target_url:visibleTarget.href,
        expected_revision:snapshot.expected_revision,
        base_url:target.href,
        referrer_url:snapshot.referrer_url,
        state_clone:null,
        scroll_x:0,
        scroll_y:0,
      });
      if(!history||history.entry_id!==entryID||!Number.isSafeInteger(history.revision))throw new DOMException("History commit failed","SecurityError");
      originState=Object.freeze({...originState,entry_id:entryID,document_capability:history.document_capability,lineage_revision:history.revision,target_url:history.target_url});
    },
  };
}
async function serveCrossOriginNavigationHandoff(route,formSubmission=null){
  const visibleTarget=new URL(route.visible_target_url??route.target_url),mapping=await coordinatorCall("MAP_ORIGIN",{profile_id:originState.profile_id,target_url:visibleTarget.href});
  if(!mapping||typeof mapping.origin_id!=="string"||!/^[a-z2-7]{32}$/.test(mapping.origin_id))throw new DOMException("Origin mapping failed","SecurityError");
  const hostMatch=/^o-[a-z2-7]{32}(\.browse\..+)$/.exec(self.location.hostname);
  if(!hostMatch)throw new DOMException("Browsing host invalid","SecurityError");
  const destinationHost=`o-${mapping.origin_id}${hostMatch[1]}`,entryID=randomID(),destinationAuthority=self.location.port?`${destinationHost}:${self.location.port}`:destinationHost;
  const handoff=await coordinatorCall("CREATE_HANDOFF",{
    profile_id:originState.profile_id,
    tab_id:originState.tab_id,
    entry_id:entryID,
    source_origin_id:originState.destination_origin_id,
    source_entry_id:originState.entry_id,
    destination_origin_id:mapping.origin_id,
    capability_epoch:originState.capability_epoch,
    destination_host:destinationAuthority,
    ancestor_urls:route.ancestor_urls??[],
    target_url:visibleTarget.href,
    ...(formSubmission===null?{}:{form_submission:formSubmission}),
  });
  if(!handoff||typeof handoff.handoff_id!=="string"||typeof handoff.bridge_nonce!=="string")throw new DOMException("Navigation handoff failed","SecurityError");
  const destination=new URL(`https://${destinationAuthority}/`);
  destination.hash=new URLSearchParams({handoff:handoff.handoff_id,nonce:handoff.bridge_nonce}).toString();
  return new Response(null,{status:302,headers:{Location:destination.href,"Cache-Control":"no-store"}});
}
async function serveNavigationRoute(route,event){
  const plan=sameOriginNavigationPlan(route);
  if(plan){
    await plan.finalizeNavigation();
    return serveTargetRoute(plan.documentRoute,event);
  }
  return serveCrossOriginNavigationHandoff(route);
}
function targetWorkerRequestPlan(route,event){
  return {
    destination:event.request.destination,
    method:route.bootstrap_submission?route.method:event.request.method,
    mode:route.bootstrap_submission?route.request_mode:event.request.mode,
    request_headers:route.bootstrap_submission?route.request_headers.map(pair=>[...pair]):[...event.request.headers],
    request_url:route.target_url,
    route_id:route.id,
    ...(route.bootstrap_submission?{body:route.body.slice(),body_length:route.body.byteLength,body_sha256:route.body_sha256}:{}),
  };
}
function targetWorkerNavigationPreloadRoute(route,headerValue){
  const requestHeaders=(Array.isArray(route.request_headers)?route.request_headers:[]).filter(pair=>Array.isArray(pair)&&typeof pair[0]==="string"&&pair[0].toLowerCase()!=="service-worker-navigation-preload");
  requestHeaders.push(["Service-Worker-Navigation-Preload",headerValue]);
  return {...route,request_headers:requestHeaders};
}
function targetWorkerNavigationPreload(route,event,eventID){
  if(event.request.mode!=="navigate"||new URL(route.target_url).origin!==new URL(originState.target_url).origin)return undefined;
  let responsePromise=null;
  return {
    handle:`navigation-preload:${eventID}`,
    start({header_value:headerValue}){
      responsePromise??=fetchTargetWorkerRouteResponse(targetWorkerNavigationPreloadRoute(route,headerValue),event);
      return responsePromise;
    },
    async cancel(reason){
      if(responsePromise===null)return;
      let response;
      try{response=await responsePromise}catch{return}
      if(response.body!==null&&!response.body.locked){
        try{await response.body.cancel(reason)}catch{}
      }
    },
  };
}
function dispatchTargetWorkerFetch(route,event,broker=targetWorkerBroker){
  if(!broker)throw new DOMException("Target worker broker unavailable","InvalidStateError");
  const eventID=randomID(),requestLifecycle=requestSignalLifecycles.get(event.request.signal);
  targetWorkerFallbacks.set(eventID,async input=>input?.preload_response===undefined?fetchTargetWorkerRouteResponse(route,event):await input.preload_response);
  const lifecycleResource=requestLifecycle?.track("map_entry",`target-worker:${eventID}`,async()=>{targetWorkerFallbacks.delete(eventID)});
  let dispatch;
  try{
    dispatch=broker.startFetch({
      event_id:eventID,
      client_id:event.clientId||undefined,
      resulting_client_id:event.resultingClientId||undefined,
      request_plan:targetWorkerRequestPlan(route,event),
      url:route.target_url,
      preload:targetWorkerNavigationPreload(route,event,eventID),
    });
  }catch(error){
    if(lifecycleResource)void requestLifecycle.release(lifecycleResource);
    else targetWorkerFallbacks.delete(eventID);
    throw error;
  }
  const release=()=>lifecycleResource?requestLifecycle.release(lifecycleResource):targetWorkerFallbacks.delete(eventID);
  void dispatch.lifetime.then(release,release);
  return dispatch;
}
function targetRouteClassMatches(route, request) {
  if (route.kind === "document" || route.kind === "navigation")
    return request.mode === "navigate" && request.method === "GET" && request.body === null;
  if (route.kind === "download")
    return request.method === "GET" && request.body === null;
  return true;
}
function executableJavaScriptSource(route,result){
  const essence=headerValue(result.headers,"content-type").split(";",1)[0].trim().toLowerCase();
  if(!["application/ecmascript","application/javascript","application/x-javascript","text/ecmascript","text/javascript"].includes(essence))throw new DOMException("Executable MIME rejected","SecurityError");
  const source=decodeTargetSource(route,result).text;
  if(encoder.encode(source).byteLength>1<<20)throw new DOMException("Executable source exceeds limit","QuotaExceededError");
  return source;
}
function executableModuleSource(route,result,moduleType){
  if(moduleType==="javascript")return executableJavaScriptSource(route,result);
  if(moduleType!=="json")throw new DOMException("Module type rejected","SecurityError");
  const essence=headerValue(result.headers,"content-type").split(";",1)[0].trim().toLowerCase();
  if(essence!=="application/json"&&!essence.endsWith("+json"))throw new DOMException("Executable MIME rejected","SecurityError");
  const source=decodeTargetSource(route,result).text;
  if(encoder.encode(source).byteLength>1<<20)throw new DOMException("Executable source too large","QuotaExceededError");
  return source;
}
async function staticScriptCacheKey(route,source,versions){
  const canonicalTarget=new URL(route.target_url).href;
  const canonicalReferrer=new URL(route.source_url??canonicalTarget,canonicalTarget).href;
  const context=encoder.encode(JSON.stringify({
    abi_version:versions.abi_version,
    browser_version:globalThis.__zeroproxyCompatibility?.hash??VERSION,
    browser_grammar_versions:versions.browser_versions,
    compiler_version:versions.compiler_version,
    credentials:route.credentials??"include",
    import_map_context:"none",
    module_context:"none",
    parser_version:versions.parser_version,
    policy_version:POLICY_VERSION,
    referrer:canonicalReferrer,
    result_schema_version:versions.result_schema_version,
    rewrite_artifact_version:VERSION,
    source_kind:"ClassicScriptExternal",
    target_url:canonicalTarget,
  }));
  const sourceBytes=encoder.encode(source);
  const bytes=new Uint8Array(8+sourceBytes.byteLength+context.byteLength);
  const view=new DataView(bytes.buffer);
  view.setUint32(0,sourceBytes.byteLength);
  bytes.set(sourceBytes,4);
  view.setUint32(4+sourceBytes.byteLength,context.byteLength);
  bytes.set(context,8+sourceBytes.byteLength);
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return [...digest].map(value=>value.toString(16).padStart(2,"0")).join("");
}
async function rewriteScript(route,result,event){
  let source,code,moduleURL;
  try{
    source=executableJavaScriptSource(route,result);
    if(route.kind==="script"){
      const versions=compilerCacheVersions();
      const key=await staticScriptCacheKey(route,source,versions);
      const entry=await staticScriptRewriteCache.getOrCreate(key,async()=>Object.freeze({
        abi_template_identifier:ABI_TEMPLATE_IDENTIFIER,
        browser_grammar_versions:JSON.stringify(versions.browser_versions),
        abi_version:versions.abi_version,
        browser_version:globalThis.__zeroproxyCompatibility?.hash??VERSION,
        cache_schema_version:versions.cache_schema_version,
        compiler_version:versions.compiler_version,
        parser_version:versions.parser_version,
        policy_version:POLICY_VERSION,
        result_schema_version:versions.result_schema_version,
        rewrite_artifact_version:VERSION,
        template:compileClassicTemplate(source,rewriters.compiler),
      }));
      code=renderClassicTemplate(source,route.target_url,route.abi_identifier,rewriters.compiler,entry.template);
    }
    else{
      const clientID=event?.clientId;
      if(typeof clientID!=="string"||clientID.length===0)throw new DOMException("Document client unavailable","SecurityError");
      const root=await createDocumentModuleRoutes(route,source,route.target_url,clientID);
      moduleURL=root.route.url;
    }
  }catch{return blocked("REWRITE_SCRIPT_FAILED",502)}
  if(moduleURL)return new Response(null,{status:302,headers:{"Location":moduleURL,"Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin"}});
  return new Response(code,{status:result.status,headers:{"Content-Type":"text/javascript;charset=utf-8","Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin"}});
}


async function serveExecutableTargetRoute(route, result, event) {
  const materialized=await materializeKernelResult(result);
  if(!await verifyIntegrity(materialized.body,route.integrity,integrityContext(route,materialized)))return blocked("SRI_MISMATCH",502);
  if(route.kind==="style")return rewriteStyle(route,materialized);
  if(route.kind==="module")return rewriteScript(route,materialized,event);
  return blocked("UNSUPPORTED_EXECUTABLE_BOUNDARY",501);
}

async function serveMaterializedTargetRoute(route, result, event) {
  const materialized = await materializeKernelResult(result);
  if (!await verifyIntegrity(materialized.body, route.integrity, integrityContext(route, materialized)))
    return blocked("SRI_MISMATCH", 502);
  if (route.kind === "script" || route.kind === "module") return rewriteScript(route, materialized, event);
  return new Response(materialized.body, {
    status: materialized.status,
    headers: {
      "Content-Type": headerValue(materialized.headers, "content-type") || "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

function targetWorkerResponseResult(response){
  if(!(response instanceof Response))throw new DOMException("Target worker response invalid","NetworkError");
  const body=response.body??new ReadableStream({start(controller){controller.close()}});
  return {body,headers:[...response.headers],status:response.status,statusText:response.statusText};
}
async function documentCoepAllows(route,result){
  if(typeof route.source_url!=="string")return true;
  const relationship=await targetRelationship(route.source_url,route.target_url);
  if(relationship==="same-origin")return true;
  const corsRequest=route.cors_mode!==null&&route.cors_mode!==undefined||["module","worker"].includes(route.kind)||route.fetch_destination==="font";
  if(corsRequest&&corsOriginAllowed(result.headers,{credentials:route.credentials??"same-origin",cors_origin:new URL(route.source_url).origin}))return true;
  const policies=headerValues(result.headers,"cross-origin-resource-policy");
  if(policies.length>16||policies.some(value=>!crossOriginResourcePolicyAllows(value,relationship)))return false;
  const coep=route.document_security_policy?.coep;
  if(coep===undefined||coep===null||coep==="unsafe-none")return true;
  if(coep==="credentialless"&&route.credentials==="omit"&&!corsRequest)return true;
  return policies.length>0;
}

async function serveTargetResult(route,result,event){
  await ensureSignalRequestPhase(event.request.signal,"TRANSFORMING_IF_REQUIRED");
  if(!await documentCoepAllows(route,result)){await discardKernelBody(result);return route.kind==="document"?navigationFailure(route,event,"TARGET_COEP_BLOCKED",403):blocked("TARGET_COEP_BLOCKED",403)}
  if (route.kind === "document") {
    route.runtime_capability = route.history_runtime_capability ?? randomID();
    const response=await rewriteDocument(route,await materializeKernelResult(result),event);
    if(internalTerminalResponses.has(response))return response;
    const bindingResource=await bindDocumentClient(event,route,route.runtime_capability),commitResources=documentRouteCommits.get(response)??[];
    if(bindingResource)commitResources.push(bindingResource);
    if(commitResources.length)documentRouteCommits.set(response,commitResources);
    return response;
  }
  if (route.kind === "download") {
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: responseHeaders(result),
    });
  }
  if (route.kind === "style" || route.kind === "module" || route.kind === "worker")
    return serveExecutableTargetRoute(route, result, event);
  return serveMaterializedTargetRoute(route, result, event);
}
async function serveTargetWorkerResponse(route,response,event){
  if(!targetRouteClassMatches(route,event.request))return blocked("ROUTE_CLASS_MISMATCH");
  if(targetWorkerNavigationHandoffs.has(response))return response;
  const result=targetWorkerResponseResult(response);
  if(route.kind==="navigation"){
    const plan=sameOriginNavigationPlan(route);
    if(!plan)throw new DOMException("Target worker navigation crossed its origin","SecurityError");
    await plan.finalizeNavigation();
    return serveTargetResult(plan.documentRoute,result,event);
  }
  return serveTargetResult(route,result,event);
}
async function serveTargetRoute(route,event){
  if(!targetRouteClassMatches(route,event.request))return blocked("ROUTE_CLASS_MISMATCH");
  if(route.kind==="navigation")return serveNavigationRoute(route,event);
  if(route.bootstrap_submission)return serveFollowedDocument(await followFormPlan(route,event,route.body),event);
  const result=await kernelFetch(route,event.request.signal);
  await applyResponseCookies(route,result,`route:${route.id}`);
  return serveTargetResult(route,result,event);
}
async function rewriteStyle(route,result){
  let decoded;
  try{decoded=decodeTargetSource(route,result)}catch{return blocked("STYLE_ENCODING_UNSUPPORTED",502)}
  const source=decoded.text,pending=[],inherited=route.policy_context;
  if(!inherited||typeof inherited!=="object"||!Array.isArray(inherited.target_csp)||!Array.isArray(inherited.target_csp_report_only))return blocked("STYLE_POLICY_CONTEXT_INVALID",502);
  const context={
    ...inherited,
    effective_base_url:route.target_url,
    document_charset:decoded.encoding_used,
  };
  let output;
  try{
    output=rewriters.css.rewrite_with(source,"stylesheet",raw=>{
      const decision=JSON.parse(rewriters.policy.decide_json(JSON.stringify(context),JSON.stringify({source_boundary:"css-stylesheet",element_namespace:null,element_name:null,attribute_name:null,resource_kind:"Image",raw_value:raw,parser_inserted:false}))),target=decision?.Fetch?.canonical_target;
      if(typeof target!=="string")throw new DOMException("CSS URL blocked","SecurityError");
      const id=randomID();
      pending.push({id,kind:"resource",profile_id:route.profile_id,tab_id:route.tab_id,entry_id:route.entry_id,origin_id:route.origin_id,target_url:target,source_url:route.target_url,abi_identifier:route.abi_identifier,credentials:route.credentials??"include",document_security_policy:route.document_security_policy,policy_context:context,encoding_used:decoded.encoding_used,decode_replacement:decoded.replacement,expires_at:Date.now()+300_000,consumed:false});
      return cssProjectionRoute(buildPolicyRoute("resource",id),raw,target);
    })
  }catch{return blocked("CSS_REWRITE_FAILED",502)}
  await storeRoutes(pending);
  return new Response(output,{status:result.status,headers:{"Content-Type":"text/css;charset=utf-8","Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin"}});
}

function headerTokens(headers,name){return headerValue(headers,name).split(",").map(value=>value.trim().toLowerCase()).filter(Boolean)}
function corsOriginAllowed(headers,plan){
  const value=headerValue(headers,"access-control-allow-origin");
  if(plan.credentials==="include")return value===plan.cors_origin&&headerValue(headers,"access-control-allow-credentials").trim().toLowerCase()==="true";
  return value==="*"||value===plan.cors_origin;
}
function corsHeadersAllowed(headers,names){const allowed=headerTokens(headers,"access-control-allow-headers");return names.every(name=>allowed.includes("*")||allowed.includes(name));}
function corsMethodsAllowed(headers,method){const allowed=headerTokens(headers,"access-control-allow-methods");return allowed.includes("*")||allowed.includes(method.toLowerCase());}
function corsExposedHeaders(headers,credentials){
  const safe=new Set(["cache-control","content-language","content-length","content-type","expires","last-modified","pragma"]);
  for(const name of headerTokens(headers,"access-control-expose-headers")){
    if(name==="*"&&credentials!=="include"){
      for(const [headerName] of headers)safe.add(headerName.toLowerCase());
    }else safe.add(name);
  }
  safe.delete("set-cookie");safe.delete("set-cookie2");
  return safe;
}
async function discardKernelBody(result){try{await result.body.cancel()}catch{}}
const API_HTTP_CACHE_NAME="__zeroproxy_internal_http_v2",API_CACHE_STORED_AT="X-ZP-Cache-Stored-At";
const apiCacheableStatuses=new Set([200,203,204,300,301,308,404,405,410,414,501]);
function apiCacheEligible(plan){
  return plan.api_kind==="fetch"&&plan.method==="GET"&&plan.body_expected===false;
}
function apiCacheRequest(plan){
  const sequence=includesTargetCredentials(plan)?plan.causal_after_seq:0;
  const key=new URL("/_zp/internal-http-cache",self.location.origin);
  key.search=new URLSearchParams({credentials:plan.credentials,method:plan.method,sequence:String(sequence),target:plan.target_url}).toString();
  return new Request(key,{headers:plan.request_headers});
}
function apiCacheControl(headers){
  const directives=new Map;
  for(const part of (headers.get("cache-control")??"").split(",")){
    const [rawName,...rest]=part.trim().split("="),name=rawName.toLowerCase();
    if(name)directives.set(name,rest.join("=").trim().replace(/^"|"$/g,""));
  }
  return directives;
}
function apiCacheFresh(response){
  const stored=Number(response.headers.get(API_CACHE_STORED_AT)),directives=apiCacheControl(response.headers);
  if(!Number.isFinite(stored)||directives.has("no-cache"))return false;
  const age=Math.max(0,Number(response.headers.get("age"))||0)*1_000;
  if(directives.has("max-age")){
    const seconds=Number(directives.get("max-age"));
    return Number.isFinite(seconds)&&seconds>=0&&Date.now()-stored+age<seconds*1_000;
  }
  const expires=Date.parse(response.headers.get("expires")??""),date=Date.parse(response.headers.get("date")??"");
  return Number.isFinite(expires)&&expires>(Number.isFinite(date)?date:stored)&&Date.now()-stored+age<expires-(Number.isFinite(date)?date:stored);
}
function apiCachedResult(response){
  const headers=[...response.headers].filter(([name])=>name.toLowerCase()!==API_CACHE_STORED_AT.toLowerCase());
  return{body:response.body,headers,status:response.status,statusText:response.statusText,redirect:{is_redirect:false,location:""}};
}
async function apiCacheLookup(plan){
  if(!apiCacheEligible(plan)){if(plan.cache==="only-if-cached")apiPlanError("HTTP cache request ineligible");return{cached:null,use:false}}
  if(plan.cache==="no-store"||plan.cache==="reload")return{cached:null,use:false};
  const cache=await caches.open(API_HTTP_CACHE_NAME),request=apiCacheRequest(plan),cached=await cache.match(request);
  if(!cached){
    if(plan.cache==="only-if-cached")apiPlanError("HTTP cache miss");
    return{cache,cached:null,request,use:false};
  }
  const use=plan.cache==="force-cache"||plan.cache==="only-if-cached"||plan.cache==="default"&&apiCacheFresh(cached);
  return{cache,cached,request,use};
}
function conditionalAPIPlan(plan,cached){
  if(!cached||plan.cache!=="no-cache"&&plan.cache!=="default")return plan;
  const headers=plan.request_headers.map(pair=>[pair[0],pair[1]]),names=new Set(headers.map(([name])=>name.toLowerCase()));
  const etag=cached.headers.get("etag"),modified=cached.headers.get("last-modified");
  if(etag&&!names.has("if-none-match"))headers.push(["If-None-Match",etag]);
  else if(modified&&!names.has("if-modified-since"))headers.push(["If-Modified-Since",modified]);
  return{...plan,request_headers:headers};
}
async function revalidatedAPIResult(cached,result){
  if(result.status!==304)return result;
  await discardKernelBody(result);
  const headers=new Headers(cached.headers);
  headers.delete(API_CACHE_STORED_AT);
  for(const [name,value] of result.headers)headers.set(name,value);
  return{body:cached.body,headers:[...headers],status:cached.status,statusText:cached.statusText,redirect:{is_redirect:false,location:""}};
}
function cacheableAPIResult(plan,result){
  if(!apiCacheEligible(plan)||plan.cache==="no-store"||!apiCacheableStatuses.has(result.status))return false;
  const headers=new Headers(result.headers),directives=apiCacheControl(headers);
  return !directives.has("no-store")&&headers.get("vary")!=="*";
}
function stageAPICacheWrite(plan,result,lifetime,signal){
  if(!cacheableAPIResult(plan,result)||!result.body)return result;
  const [publicBody,cacheBody]=result.body.tee(),headers=new Headers(result.headers),requestLifecycle=requestSignalLifecycles.get(signal),cacheReader=cacheBody.getReader();
  const cacheStream=new ReadableStream({
    async pull(controller){
      const next=await cacheReader.read();
      if(next.done)controller.close();
      else controller.enqueue(next.value);
    },
    cancel:reason=>cacheReader.cancel(reason),
  });
  const writerResource=requestLifecycle?.track("writer",`cache:${plan.id}`,()=>cacheReader.cancel("REQUEST_TERMINAL"));
  headers.set(API_CACHE_STORED_AT,String(Date.now()));
  const write=caches.open(API_HTTP_CACHE_NAME)
    .then(cache=>cache.put(apiCacheRequest(plan),new Response(cacheStream,{status:result.status,statusText:result.statusText,headers})))
    .catch(()=>{})
    .finally(()=>writerResource?requestLifecycle.release(writerResource,false):undefined);
  lifetime?.track(write);
  return{...result,body:publicBody};
}
const corsPreflightCache=new Map,CORS_PREFLIGHT_CACHE_LIMIT=256,CORS_PREFLIGHT_MAX_AGE=7_200;
function corsPreflightKey(plan){
  return `${plan.cors_origin}\0${plan.target_url}\0${plan.credentials}\0${plan.method}\0${plan.cors_request_headers.join(",")}`;
}
function rememberCorsPreflight(key,headers){
  const raw=headerValue(headers,"access-control-max-age").trim();
  if(!/^[0-9]+$/.test(raw))return;
  const seconds=Math.min(CORS_PREFLIGHT_MAX_AGE,Number(raw));
  if(seconds<=0)return;
  if(corsPreflightCache.size>=CORS_PREFLIGHT_CACHE_LIMIT)corsPreflightCache.delete(corsPreflightCache.keys().next().value);
  corsPreflightCache.set(key,Date.now()+seconds*1_000);
}
async function corsPreflight(plan,signal){
  if(!plan.cors_cross_origin||plan.request_mode!=="cors")return;
  const needsPreflight=!["GET","HEAD","POST"].includes(plan.method)||plan.cors_request_headers.length!==0;
  if(!needsPreflight)return;
  const key=corsPreflightKey(plan),expires=corsPreflightCache.get(key);
  if(expires>Date.now())return;
  if(expires!==undefined)corsPreflightCache.delete(key);
  const headers=[["Access-Control-Request-Method",plan.method]];
  if(plan.cors_request_headers.length)headers.push(["Access-Control-Request-Headers",plan.cors_request_headers.join(", ")]);
  const result=await kernelFetch({...plan,method:"OPTIONS",request_headers:headers,body_expected:false,redirect:"error",credentials:"omit"},signal);
  const valid=result.status>=200&&result.status<300&&corsOriginAllowed(result.headers,plan)&&corsMethodsAllowed(result.headers,plan.method)&&corsHeadersAllowed(result.headers,plan.cors_request_headers);
  if(valid)rememberCorsPreflight(key,result.headers);
  await discardKernelBody(result);
  if(!valid)apiPlanError("CORS preflight denied");
}
function projectAPIHeaders(plan,result){
  if(!plan.cors_cross_origin&&!plan.cors_tainted)return responseHeaders(result);
  if(plan.cors_cross_origin&&!corsOriginAllowed(result.headers,plan))apiPlanError("CORS response denied");
  const exposed=corsExposedHeaders(result.headers,plan.credentials),headers=new Headers;
  for(const [name,value] of result.headers){
    const lower=name.toLowerCase();
    if(exposed.has(lower)&&lower!=="set-cookie"&&lower!=="set-cookie2"&&!lower.startsWith("x-zp-"))headers.append(name,value);
  }
  return headers;
}
function cancelWebSocketKernel(state) {
  void self.__zeroproxyKernelWebSocketCancelV2(kernelHandle, state.plan.id).catch(() => {});
}

function closeWebSocketPort(state) {
  if (state.portClosed) return;
  state.portClosed = true;
  try { state.port.close(); } catch {}
}

function postWebSocketPort(state, data, transfer = []) {
  if (state.portClosed) return false;
  try {
    state.port.postMessage(data, transfer);
    return true;
  } catch {
    state.closed = true;
    cancelWebSocketKernel(state);
    closeWebSocketPort(state);
    return false;
  }
}

function terminateWebSocketState(state, errorCode, emitError = true) {
  if (state.closed) return;
  state.closed = true;
  if (emitError)
    postWebSocketPort(state, { v: 2, type: "error", request_id: state.plan.id, error: errorCode });
  postWebSocketPort(state, {
    v: 2, type: "close", request_id: state.plan.id, code: 1006, reason: "", was_clean: false,
  });
  cancelWebSocketKernel(state);
  closeWebSocketPort(state);
}

function finishWebSocketState(state, message) {
  if (state.closed) return;
  state.closed = true;
  postWebSocketPort(state, message);
  closeWebSocketPort(state);
}

function validWebSocketCloseEvent(message) {
  const code = message.code;
  return Number.isSafeInteger(code)
    && (code === 1000 || code === 1001 || code === 1002 || code === 1003
      || code === 1005 || code === 1006 || code >= 1007 && code <= 1014
      || code >= 3000 && code <= 4999)
    && typeof message.reason === "string"
    && new TextEncoder().encode(message.reason).byteLength <= 123
    && typeof message.was_clean === "boolean";
}

function validWebSocketKernelEvent(state, message) {
  if (!message
    || message.v !== 2
    || message.request_id !== state.plan.id
    || typeof message.type !== "string") return false;
  if (message.type === "open")
    return !state.opened
      && typeof message.protocol === "string"
      && (message.protocol === "" || state.plan.protocols.includes(message.protocol))
      && Array.isArray(message.set_cookies)
      && message.set_cookies.length <= 128
      && !message.set_cookies.some(value => typeof value !== "string" || value.length > 4096);
  if (message.type === "message")
    return state.opened
      && (message.data_kind === "text" || message.data_kind === "binary")
      && message.data instanceof Uint8Array
      && message.data.byteLength <= state.start.max_message_bytes;
  if (message.type === "error")
    return typeof message.error === "string" && message.error.length > 0 && message.error.length <= 128;
  return message.type === "close" && validWebSocketCloseEvent(message);
}

async function handleWebSocketKernelEvent(state, message) {
  if (state.closed) return;
  if (!validWebSocketKernelEvent(state, message))
    throw new DOMException("Invalid WebSocket kernel event", "SecurityError");
  if (message.type === "open") {
    await applyResponseCookies(
      state.plan,
      { headers: message.set_cookies.map(value => ["Set-Cookie", value]) },
      `websocket:${state.plan.id}`,
    );
    if (state.closed) return;
    state.opened = true;
    const { set_cookies: _ignored, ...publicMessage } = message;
    postWebSocketPort(state, publicMessage);
    return;
  }
  if (message.type === "message") {
    postWebSocketPort(state, message, [message.data.buffer]);
    return;
  }
  if (message.type === "error") {
    if (state.errorSent) return;
    state.errorSent = true;
    postWebSocketPort(state, message);
    if (!state.opened)
      finishWebSocketState(state, {
        v: 2, type: "close", request_id: state.plan.id, code: 1006, reason: "", was_clean: false,
      });
    return;
  }
  finishWebSocketState(state, message);
}

function queueWebSocketKernelEvent(state, message) {
  if (state.closed) return;
  state.eventChain = state.eventChain
    .then(() => handleWebSocketKernelEvent(state, message))
    .catch(() => terminateWebSocketState(state, "KERNEL_EVENT_INVALID"));
}

function exactWebSocketCommand(command, keys) {
  const commandKeys = Object.keys(command);
  return commandKeys.length === keys.length && commandKeys.every(key => keys.includes(key));
}

function validWebSocketSend(state, command) {
  return exactWebSocketCommand(command, ["v", "type", "request_id", "seq", "kind", "data"])
    && Number.isSafeInteger(command.seq)
    && command.seq === state.sequence
    && (command.kind === "text" || command.kind === "binary")
    && command.data instanceof Uint8Array
    && command.data.byteLength <= state.start.max_message_bytes
    && state.opened
    && !state.closeRequested
    && state.pendingCount < 64
    && state.pendingBytes <= state.start.send_high_water_mark - command.data.byteLength;
}

function reserveWebSocketSend(state, command) {
  if (!validWebSocketSend(state, command)) return false;
  state.sequence += 1;
  state.pendingCount += 1;
  state.pendingBytes += command.data.byteLength;
  return true;
}

function releaseWebSocketSend(state, command) {
  state.pendingCount -= 1;
  state.pendingBytes -= command.data.byteLength;
}

async function performWebSocketSend(state, command) {
  try {
    const acknowledgement = await self.__zeroproxyKernelWebSocketSendV2(
      kernelHandle,
      state.plan.id,
      command.seq,
      command.kind,
      command.data,
    );
    if (!acknowledgement
      || acknowledgement.v !== 2
      || acknowledgement.request_id !== state.plan.id
      || acknowledgement.seq !== command.seq
      || acknowledgement.acknowledged !== true)
      throw new Error("invalid acknowledgement");
    postWebSocketPort(state, { v: 2, type: "ack", request_id: state.plan.id, seq: command.seq });
  } finally {
    releaseWebSocketSend(state, command);
  }
}

function validWebSocketCloseCommand(command) {
  if (!exactWebSocketCommand(command, ["v", "type", "request_id", "code", "reason"])
    || !Number.isSafeInteger(command.code)
    || typeof command.reason !== "string"
    || new TextEncoder().encode(command.reason).byteLength > 123) return false;
  return command.code === 1005 && command.reason === ""
    || command.code === 1000
    || command.code >= 3000 && command.code <= 4999;
}

async function performWebSocketClose(state, command) {
  const acknowledgement = await self.__zeroproxyKernelWebSocketCloseV2(
    kernelHandle, state.plan.id, command.code, command.reason,
  );
  if (!acknowledgement
    || acknowledgement.v !== 2
    || acknowledgement.request_id !== state.plan.id
    || acknowledgement.code !== command.code
    || acknowledgement.closed !== true)
    throw new Error("invalid close acknowledgement");
}

function appendWebSocketCommand(state, operation, errorCode) {
  state.commandChain = state.commandChain
    .then(() => state.closed ? undefined : operation())
    .catch(() => terminateWebSocketState(state, errorCode));
}

function handleWebSocketPortCommand(state, command) {
  if (state.closed) return;
  if (!command
    || command.v !== 2
    || command.request_id !== state.plan.id
    || typeof command.type !== "string") {
    terminateWebSocketState(state, "COMMAND_INVALID");
    return;
  }
  if (command.type === "send") {
    if (!reserveWebSocketSend(state, command)) {
      terminateWebSocketState(state, "SEND_INVALID");
      return;
    }
    appendWebSocketCommand(state, () => performWebSocketSend(state, command), "SEND_FAILED");
    return;
  }
  if (command.type === "close") {
    if (!state.opened || state.closeRequested || !validWebSocketCloseCommand(command)) {
      terminateWebSocketState(state, "CLOSE_INVALID");
      return;
    }
    state.closeRequested = true;
    appendWebSocketCommand(state, () => performWebSocketClose(state, command), "CLOSE_FAILED");
    return;
  }
  if (command.type === "cancel"
    && exactWebSocketCommand(command, ["v", "type", "request_id"])) {
    state.closed = true;
    cancelWebSocketKernel(state);
    closeWebSocketPort(state);
    return;
  }
  terminateWebSocketState(state, "COMMAND_INVALID");
}

function validWebSocketStart(start, requestID) {
  return start
    && start.v === 2
    && start.request_id === requestID
    && Number.isSafeInteger(start.max_message_bytes)
    && start.max_message_bytes >= 1
    && start.max_message_bytes <= 4 << 20
    && Number.isSafeInteger(start.send_high_water_mark)
    && start.send_high_water_mark >= start.max_message_bytes
    && start.send_high_water_mark <= 16 << 20;
}

async function openWebSocketPlan(event, message, port) {
  const id = message.payload?.id;
  if (typeof id !== "string" || !port) apiPlanError("Invalid WebSocket plan");
  const plan = await consumeAPIPlan(id, event.source?.id);
  if (!plan || plan.api_kind !== "websocket") apiPlanError("WebSocket plan unavailable");
  await ensureKernelBinding();
  const documentBinding=await provisionKernelDocument(plan);
  const cookie=await outboundCookieContext(plan);
  const requestID=plan.id;
  let releaseReady;
  const readyGate = new Promise(resolve => { releaseReady = resolve; });
  const state = {
    closed: false, closeRequested: false, errorSent: false, eventChain: readyGate,
    opened: false, pendingBytes: 0, pendingCount: 0, plan, port, portClosed: false,
    sequence: 0, start: null, commandChain: Promise.resolve(),
  };
  try {
    state.start = await self.__zeroproxyKernelWebSocketStartV2(kernelHandle, {
      v: 2,
      request_id: requestID,
      plan: {
        plan_id: randomID(),
        source_client_id: documentBinding.sourceClientID,
        document_id: documentBinding.documentID,
        profile_id: plan.profile_id,
        session_id: plan.session_id,
        tab_id: plan.tab_id,
        origin_id: plan.origin_id,
        entry_id: documentBinding.entryID,
        policy_epoch: plan.policy_epoch,
        capability_epoch: plan.capability_epoch,
        target_url: apiTarget(plan.target_url, ["ws:", "wss:"]).href,
        source_url: apiTarget(plan.source_url).href,
        origin: comparableOrigin(apiTarget(plan.source_url)),
        protocols: plan.protocols,
        credentials: plan.credentials,
        cookie_seq: cookie.sequence,
        cookie_header: cookie.header,
        isolation_key_ref: plan.isolation_key_ref,
        persona: plan.persona,
      },
      on_event: kernelMessage => queueWebSocketKernelEvent(state, kernelMessage),
    });
    if (!validWebSocketStart(state.start, requestID))
      apiPlanError("WebSocket kernel unavailable");
    port.onmessage = portEvent => handleWebSocketPortCommand(state, portEvent.data);
    port.onmessageerror = () => terminateWebSocketState(state, "COMMAND_INVALID");
    port.start?.();
    postWebSocketPort(state, {
      v: 2, type: "ready", request_id: requestID,
      max_message_bytes: state.start.max_message_bytes,
      send_high_water_mark: state.start.send_high_water_mark,
    });
    releaseReady();
  } catch (error) {
    state.closed = true;
    releaseReady();
    cancelWebSocketKernel(state);
    closeWebSocketPort(state);
    throw error;
  }
}
async function boundedUploadBytes(stream,signal){
  await ensureSignalRequestPhase(signal,"BODY_OPEN");
  if(!stream)return null;
  const requestLifecycle=requestSignalLifecycles.get(signal),reader=stream.getReader(),chunks=[];
  const readerResource=requestLifecycle?.track("reader","request-upload",()=>reader.cancel("REQUEST_TERMINAL"));
  let length=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array)||value.byteLength===0)throw kernelNetworkError();
      length+=value.byteLength;
      if(length>16<<20)throw new DOMException("Upload exceeds redirect replay limit","QuotaExceededError");
      chunks.push(value);
    }
  }catch(error){
    try{await reader.cancel(error)}catch{}
    throw error;
  }finally{
    if(readerResource)await requestLifecycle.release(readerResource,false);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  return bytes;
}
function replayUpload(bytes){
  if(bytes===null)return null;
  return new ReadableStream({start(controller){controller.enqueue(bytes.slice());controller.close()}},{highWaterMark:1});
}
function redirectedMethod(status,method){
  if(status===303&&method!=="GET"&&method!=="HEAD"||(status===301||status===302)&&method==="POST")return"GET";
  return method;
}
function redirectedHeaders(headers,dropBody){
  if(!dropBody)return headers.map(pair=>[pair[0],pair[1]]);
  return headers.filter(([name])=>!["content-length","content-type","content-encoding","transfer-encoding"].includes(name.toLowerCase())).map(pair=>[pair[0],pair[1]]);
}
async function terminalAPIResult(plan, current, result, redirected, hop, opaqueTainted, corsTainted) {
  if (result.redirect?.is_redirect && plan.redirect === "manual") {
    await discardKernelBody(result);
    return {
      result: { body: null, status: 200, statusText: "", headers: [] },
      finalPlan: current,
      redirected: false,
      responseType: "opaqueredirect",
    };
  }
  if (current.cors_cross_origin && current.request_mode === "cors" && !corsOriginAllowed(result.headers, current)) {
    await discardKernelBody(result);
    apiPlanError("CORS response denied");
  }
  if (!result.redirect?.is_redirect && opaqueTainted)
    return { result, finalPlan: { ...current, cors_tainted: false }, redirected, responseType: "opaque" };
  if (!result.redirect?.is_redirect)
    return { result, finalPlan: { ...current, cors_tainted: corsTainted }, redirected, responseType: corsTainted ? "cors" : "basic" };
  if (plan.redirect === "error") {
    await discardKernelBody(result);
    apiPlanError("Redirect disallowed");
  }
  if (plan.redirect !== "follow" || hop === 20) {
    await discardKernelBody(result);
    apiPlanError("Redirect limit exceeded");
  }
  return null;
}

function fetchSiteFloor(...sites) {
  const rank = { "same-origin": 0, "same-site": 1, "cross-site": 2, "none": 3 };
  let floor = "";
  for (const site of sites) {
    if (!(site in rank)) continue;
    if (floor === "" || rank[site] > rank[floor]) floor = site;
  }
  return floor;
}

async function redirectedAPIPlan(current, result) {
  let target;
  try {
    target = apiTarget(new URL(result.redirect.location, current.target_url).href);
  } catch {
    await discardKernelBody(result);
    apiPlanError("Invalid redirect target");
  }
  await discardKernelBody(result);
  const referrerPolicy = redirectedReferrerPolicy(result.headers, current.referrer_policy);
  const method = redirectedMethod(result.status, current.method);
  const dropBody = method !== current.method;
  const requestSource=apiTarget(current.source_url??originState.target_url);
  const crossOrigin=comparableOrigin(target)!==comparableOrigin(requestSource);
  if(crossOrigin&&current.request_mode==="same-origin")apiPlanError("Cross-origin redirect denied");
  const requestHeaders=redirectedHeaders(current.request_headers,dropBody);
  return {
    plan:{
      ...current,
      target_url:target.href,
      method,
      body_expected:dropBody?false:current.body_expected,
      request_headers:requestHeaders,
      fetch_site_floor:fetchSiteFloor(current.fetch_site_floor,result.requestSite),
      cors_cross_origin:crossOrigin,
      cors_origin:current.request_mode==="cors"&&crossOrigin?comparableOrigin(requestSource):serializeRequestOrigin(requestSource.href,target.href,referrerPolicy,method),
      cors_request_headers:corsRequestHeaders(requestHeaders),
      referrer_policy:referrerPolicy,
      referrer:referrerForRequest(current.referrer_source??current.referrer,target,referrerPolicy),
    },
    dropBody,
  };
}

async function executeAPIHop(plan,current,event,upload,cookieIndex,lifetime){
  await corsPreflight(current,event.request.signal);
  const cacheState=await apiCacheLookup(current);
  if(cacheState.use)return{cookieIndex,result:apiCachedResult(cacheState.cached)};
  const networkPlan=conditionalAPIPlan(current,cacheState.cached);
  let result=await kernelFetch(
    {...networkPlan,redirect:"manual"},
    event.request.signal,
    current.body_expected?replayUpload(upload):null,
  );
  cookieIndex=await applyResponseCookies(current,result,`api:${plan.id}`,cookieIndex);
  if(cacheState.cached&&result.status===304)result=await revalidatedAPIResult(cacheState.cached,result);
  if(!result.redirect?.is_redirect)result=stageAPICacheWrite(current,result,lifetime,event.request.signal);
  return{cookieIndex,result};
}
async function followAPIPlan(plan,event,lifetime,providedUpload,redirectBoundary=null){
  let current={...plan},redirected=false,opaqueTainted=false,corsTainted=false,cookieIndex=0;
  let upload=providedUpload===undefined?await boundedUploadBytes(plan.body_expected?event.request.body:null,event.request.signal):providedUpload;
  for(let hop=0;hop<=20;hop+=1){
    opaqueTainted||=current.request_mode==="no-cors"&&current.cors_cross_origin;
    corsTainted||=current.request_mode==="cors"&&current.cors_cross_origin;
    const hopResult=await executeAPIHop(plan,current,event,upload,cookieIndex,lifetime),result=hopResult.result;
    cookieIndex=hopResult.cookieIndex;
    const terminal=await terminalAPIResult(plan,current,result,redirected,hop,opaqueTainted,corsTainted);
    if(terminal)return terminal;
    const next=await redirectedAPIPlan(current,result),nextUpload=next.dropBody?null:upload;
    if(redirectBoundary!==null){
      const boundary=await redirectBoundary(next.plan,nextUpload);
      if(boundary!==null)return boundary;
    }
    current=next.plan;
    upload=nextUpload;
    redirected=true;
  }
  throw apiPlanError("Redirect limit exceeded");
}
class TrustedEventSourceIDParser {
  constructor() {
    this.decoder = new TextDecoder();
    this.line = "";
    this.cr = false;
    this.overflow = false;
    this.latest = undefined;
  }
  acceptLine() {
    if (!this.overflow && this.line[0] !== ":") {
      const colon = this.line.indexOf(":");
      const field = colon < 0 ? this.line : this.line.slice(0, colon);
      const raw = colon < 0 ? "" : this.line.slice(colon + 1);
      const value = raw[0] === " " ? raw.slice(1) : raw;
      if (field === "id" && value.length <= 4_096 && !value.includes("\0")) this.latest = value;
    }
    this.line = "";
    this.overflow = false;
  }
  acceptCharacter(character) {
    if (this.cr) {
      this.acceptLine();
      this.cr = false;
      if (character === "\n") return;
    }
    if (character === "\r") {
      this.cr = true;
      return;
    }
    if (character === "\n") {
      this.acceptLine();
      return;
    }
    if (this.line.length >= 65_536) this.overflow = true;
    else if (!this.overflow) this.line += character;
  }
  decode(bytes, stream) {
    this.latest = undefined;
    const text = this.decoder.decode(bytes, {stream});
    for (const character of text) this.acceptCharacter(character);
    if (!stream && (this.cr || this.line !== "" || this.overflow)) {
      this.acceptLine();
      this.cr = false;
    }
    return this.latest;
  }
  push(bytes) { return this.decode(bytes, true); }
  finish() { return this.decode(new Uint8Array(), false); }
}
async function persistTrustedEventSourceID(plan,lastEventID){
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),current=await request(store.get(plan.id));
  if(!current||current.api_kind!=="eventsource"||current.live_attempt!==true||current.revision!==plan.revision||
    current.source_client_id!==plan.source_client_id||current.document_id!==plan.document_id){tx.abort();throw new DOMException("EventSource lease revoked","AbortError")}
  current.last_event_id=lastEventID;
  current.last_event_id_updated_at=Date.now();
  store.put(current);
  await complete(tx);
}
function eventSourceLeaseResult(plan,result,lifetime,signal){
  if(plan.api_kind!=="eventsource")return result;
  const requestLifecycle=requestSignalLifecycles.get(signal);
  const contentType=headerValue(result.headers,"content-type").toLowerCase();
  const idParser=result.status===200&&/^text\/event-stream(?:;|$)/u.test(contentType)?new TrustedEventSourceIDParser:null;
  let resolveCompletion,finished=false,leaseResource;
  const completion=new Promise(resolve=>{resolveCompletion=resolve});
  const finish=async(fromCleanup=false)=>{
    if(finished)return;
    finished=true;
    try{await releaseEventSourceAttempt(plan)}
    finally{
      if(leaseResource&&!fromCleanup)await requestLifecycle.release(leaseResource,false);
      resolveCompletion();
    }
  };
  const persistID=async value=>{if(value!==undefined)await persistTrustedEventSourceID(plan,value)};
  leaseResource=requestLifecycle?.track("lease",`eventsource:${plan.id}`,()=>finish(true));
  lifetime?.track(completion);
  if(!result.body){void finish();return result}
  const reader=result.body.getReader(),body=new ReadableStream({
    async pull(controller){
      try{
        const next=await reader.read();
        if(next.done){
          if(idParser)await persistID(idParser.finish());
          await finish();
          controller.close();
        }else{
          if(idParser)await persistID(idParser.push(next.value));
          controller.enqueue(next.value);
        }
      }catch(error){await finish();controller.error(error)}
    },
    async cancel(reason){try{await reader.cancel(reason)}finally{await finish()}},
  });
  return{...result,body};
}
function apiBlocked(code,status=502){
  return markInternalTerminal(new Response(`ZeroProxy API request failed: ${code}`,{status,headers:{"Content-Type":"text/plain;charset=utf-8","Cache-Control":"no-store","X-ZP-API-ERROR":code}}),code,status);
}
async function finalizeAPIResponse(plan, followed, lifetime, signal) {
  let result = followed.result;
  const headers = followed.responseType === "opaque" || followed.responseType === "opaqueredirect"
    ? new Headers()
    : projectAPIHeaders(followed.finalPlan, result);
  if (plan.integrity !== "" && followed.responseType !== "opaque" && followed.responseType !== "opaqueredirect") {
    result = await materializeKernelResult(result);
    const valid = await verifyIntegrity(result.body, plan.integrity, {
      sourceURL: originState.target_url,
      targetURL: followed.finalPlan.target_url,
      corsMode: followed.finalPlan.cors_cross_origin
        ? (plan.credentials === "include" ? "use-credentials" : "anonymous")
        : null,
      headers: result.headers,
    });
    if (!valid) {
      await releaseEventSourceAttempt(plan);
      return apiBlocked("INTEGRITY_MISMATCH");
    }
  }
  result = eventSourceLeaseResult(plan, result, lifetime, signal);
  headers.set("X-ZP-Target-URL", followed.finalPlan.target_url);
  headers.set("X-ZP-Redirected", followed.redirected ? "1" : "0");
  headers.set("X-ZP-Response-Type", followed.responseType);
  return new Response(result.body, {status: result.status, statusText: result.statusText, headers});
}
async function serveAPIPlan(plan,event,lifetime){
  if(plan.api_kind==="websocket")return apiBlocked("API_SURFACE_MISMATCH",400);
  if(event.request.method!==plan.method||Boolean(event.request.body)!==plan.body_expected)return apiBlocked("API_REQUEST_MISMATCH",400);
  await ensureSignalRequestPhase(event.request.signal,"PLANNED");
  const followed=await followAPIPlan(plan,event,lifetime);
  await ensureSignalRequestPhase(event.request.signal,"TRANSFORMING_IF_REQUIRED");
  const isolationRoute={...followed.finalPlan,cors_mode:followed.finalPlan.request_mode==="cors"?"anonymous":null};
  if(!await documentCoepAllows(isolationRoute,followed.result)){await discardKernelBody(followed.result);return apiBlocked("TARGET_CROSS_ORIGIN_POLICY_BLOCKED")}
  return finalizeAPIResponse(plan,followed,lifetime,event.request.signal);
}
async function readWorkerExecutable(id,kind,clientID){
  if(typeof id!=="string")return null;
  const db=await database(),tx=db.transaction("routes","readonly"),route=await request(tx.objectStore("routes").get(id));
  await complete(tx);
  if(!await workerRouteLive(route,clientID)||route.kind!==kind||typeof route.source!=="string")return null;
  return route;
}
async function serveWorkerExecutable(route,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("WORKER_EXECUTABLE_METHOD",400);
  const contentType=route.module_type==="json"?"application/json;charset=utf-8":"text/javascript;charset=utf-8";
  return new Response(route.source,{status:200,headers:{"Content-Type":contentType,"Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin"}});
}
async function serveWorkerGateway(id,token,module,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("WORKER_GATEWAY_METHOD",400);
  const route=await materializeWorkerGateway(id,token,module,event.clientId);
  if(module){
    if(typeof route.module_url!=="string"||!/^\/_zp\/wm\/[A-Za-z0-9_-]{32}\/[a-f0-9]{64}\.mjs$/u.test(route.module_url))return blocked("WORKER_GATEWAY_UNAVAILABLE",410);
    return new Response(null,{status:302,headers:{"Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin","Location":route.module_url}});
  }
  return serveWorkerExecutable(route,event);
}


async function openHistoryRoute(entryID,token){
  if(typeof entryID!=="string"||!/^[A-Za-z0-9_-]{32}$/.test(entryID)||typeof token!=="string"||token.length<32||token.length>16_384)return null;
  const db=await database(),tx=db.transaction("history_keys","readonly"),key=await request(tx.objectStore("history_keys").get(entryID));
  await complete(tx);
  if(!key||key.expires_at<=Date.now()||key.profile_id!==originState?.profile_id||key.origin_id!==originState?.destination_origin_id||key.capability_epoch!==originState?.capability_epoch||typeof key.runtime_capability!=="string")return null;
  historyCrypto??=await loadRustModule("share_crypto");
  let targetURL;
  try{targetURL=historyCrypto.open_history_v2(key.runtime_capability,entryID,token)}catch{return null}
  const visible=new URL(targetURL),fragment=visible.hash;visible.hash="";
  const target=apiTarget(visible.href),current=apiTarget(originState.target_url);
  return {id:entryID,kind:"document",profile_id:key.profile_id,tab_id:key.tab_id,entry_id:entryID,origin_id:key.origin_id,target_url:target.href,visible_target_url:`${target.href}${fragment}`,source_url:originState.target_url,abi_identifier:key.abi_identifier,history_runtime_capability:key.runtime_capability,expires_at:key.expires_at,consumed:false};
}
function sealedFormPolicyAllows(client,target){
  try{
    const decision=JSON.parse(rewriters.policy.decide_json(JSON.stringify(client.policy_context),JSON.stringify({
      source_boundary:"dynamic-dom",
      element_namespace:"http://www.w3.org/1999/xhtml",
      element_name:"form",
      attribute_name:"action",
      resource_kind:"Document",
      raw_value:target.href,
      parser_inserted:false,
    })));
    return decision?.Navigate?.canonical_target===target.href;
  }catch{return false}
}
async function consumeSealedOperation(client,operation){
  const binding={source_client_id:client.client_id,document_id:client.runtime_capability,profile_id:originState.profile_id,origin_id:originState.destination_origin_id,capability_epoch:originState.capability_epoch};
  const db=await database(),tx=db.transaction("routes","readwrite",{durability:"strict"}),store=tx.objectStore("routes"),id=`sealed-use:${client.client_id}`,current=await request(store.get(id));
  store.put(nextSealedOperationRecord(current,binding,operation));
  await complete(tx);
}
function sealedPingTargets(value){
  let payload;
  try{payload=new URL(value)}catch{throw new DOMException("Sealed ping payload rejected","SecurityError")}
  const entries=[...payload.searchParams],endpointValues=payload.searchParams.getAll("endpoint"),destinationValues=payload.searchParams.getAll("to");
  if(payload.origin!=="https://ping.invalid"||payload.pathname!=="/"||payload.hash!==""||entries.length!==2||endpointValues.length!==1||destinationValues.length!==1)throw new DOMException("Sealed ping payload rejected","SecurityError");
  const target=apiTarget(endpointValues[0]),destinationValue=destinationValues[0];
  if(typeof destinationValue!=="string"||destinationValue.length===0||destinationValue.length>16_384)throw new DOMException("Sealed ping destination rejected","SecurityError");
  let destination;
  try{destination=new URL(destinationValue)}catch{throw new DOMException("Sealed ping destination rejected","SecurityError")}
  const port=destination.port===""?(destination.protocol==="https:"?443:80):Number(destination.port);
  if(!["http:","https:"].includes(destination.protocol)||destination.username||destination.password||!Number.isSafeInteger(port)||!commonRelayPorts().includes(port))throw new DOMException("Sealed ping destination rejected","SecurityError");
  return {destination,target};
}
async function openSealedRoute(kind,operation,token,clientID){
  if(!["navigation","form","beacon","ping","download"].includes(kind)||!workerABIIdentifier.test(`__zp_abi_${operation}`)||!workerGatewayToken.test(token))throw new DOMException("Sealed route rejected","SecurityError");
  const client=await authorizeDocumentClient(clientID);
  if(typeof client.runtime_capability!=="string"||client.runtime_capability.length===0)throw new DOMException("Sealed route capability unavailable","SecurityError");
  historyCrypto??=await loadRustModule("share_crypto");
  let targetURL;
  try{targetURL=historyCrypto.open_history_v2(client.runtime_capability,`${kind}:${operation}`,token)}catch{throw new DOMException("Sealed route rejected","SecurityError")}
  const ping=kind==="ping"?sealedPingTargets(targetURL):null,target=ping?.target??apiTarget(targetURL),sourceTarget=apiTarget(client.target_url);
  if(kind==="form"&&!sealedFormPolicyAllows(client,target))throw new DOMException("Sealed form policy denied","SecurityError");
  if(["beacon","ping"].includes(kind)){
    let allowed=false;
    try{allowed=rewriters.policy.csp_allows_connect_json(JSON.stringify(client.policy_context),target.href)===true}catch{}
    if(!allowed)throw new DOMException("Sealed connection policy denied","SecurityError");
    await consumeSealedOperation(client,operation);
  }
  return {client,ping_to:ping?.destination??null,source_target:sourceTarget,target};
}
function sealedRouteBase(opened,kind,event){
  const crossOrigin=opened.target.origin!==opened.source_target.origin,referrerPolicy=opened.client.policy_context?.referrer_policy??"strict-origin-when-cross-origin";
  return {id:`sealed:${kind}:${randomID()}`,kind,profile_id:originState.profile_id,session_id:originState.session_id,tab_id:originState.tab_id,entry_id:originState.entry_id,origin_id:originState.destination_origin_id,document_id:opened.client.runtime_capability,policy_epoch:POLICY_VERSION,capability_epoch:originState.capability_epoch,isolation_key_ref:originState.document_capability,persona:TRANSPORT_PERSONA,target_url:opened.target.href,source_url:opened.source_target.href,abi_identifier:opened.client.abi_identifier,source_client_id:event.clientId,causal_after_seq:cookieSequence,expires_at:Date.now()+60_000,consumed:false,cors_cross_origin:crossOrigin,referrer_policy:referrerPolicy,referrer_source:opened.source_target.href,referrer:referrerForRequest(opened.source_target.href,opened.target,referrerPolicy)};
}
function sealedFormEnctype(contentType){
  for(const enctype of ["application/x-www-form-urlencoded","multipart/form-data","text/plain"])if(formContentTypeMatches(enctype,contentType))return enctype;
  throw new DOMException("Sealed form enctype rejected","SecurityError");
}
function formPlanContentType(plan){
  return plan.request_headers.find(([name])=>name.toLowerCase()==="content-type")?.[1]??"";
}
async function formHandoffSubmission(plan,upload){
  if(plan.method!=="POST")return null;
  if(!(upload instanceof Uint8Array)||upload.byteLength>16<<20)throw new DOMException("Form handoff body rejected","SecurityError");
  const contentType=formPlanContentType(plan);
  sealedFormEnctype(contentType);
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",upload));
  return {method:"POST",content_type:contentType,body_base64:encodeBase64URL(upload),body_length:upload.byteLength,body_sha256:encodeBase64URL(digest),source_url:plan.source_url,referrer_policy:plan.referrer_policy};
}
async function followFormPlan(plan,event,upload){
  const localOrigin=new URL(originState.target_url).origin;
  return followAPIPlan(plan,event,undefined,upload,async(next,nextUpload)=>{
    if(new URL(next.target_url).origin===localOrigin)return null;
    const submission=await formHandoffSubmission(next,nextUpload);
    return serveCrossOriginNavigationHandoff({...next,kind:"document",visible_target_url:next.target_url},submission);
  });
}
async function serveFollowedDocument(followed,event){
  if(followed instanceof Response)return followed;
  const result=followed.result,route={...followed.finalPlan,kind:"document",visible_target_url:followed.finalPlan.target_url,runtime_capability:randomID()};
  await ensureSignalRequestPhase(event.request.signal,"TRANSFORMING_IF_REQUIRED");
  const response=await rewriteDocument(route,await materializeKernelResult(result),event);
  if(internalTerminalResponses.has(response))return response;
  const bindingResource=await bindDocumentClient(event,route,route.runtime_capability),commitResources=documentRouteCommits.get(response)??[];
  if(bindingResource)commitResources.push(bindingResource);
  if(commitResources.length)documentRouteCommits.set(response,commitResources);
  return response;
}
async function serveSealedNavigation(operation,token,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("NAVIGATION_REQUEST_MISMATCH",400);
  const opened=await openSealedRoute("navigation",operation,token,event.clientId);
  return serveNavigationRoute({...sealedRouteBase(opened,"document",event),visible_target_url:opened.target.href},event);
}
async function serveSealedForm(operation,token,event){
  if(event.request.mode!=="navigate"||!["GET","POST"].includes(event.request.method)||event.request.method==="GET"&&event.request.body!==null)return blocked("FORM_REQUEST_MISMATCH",400);
  const opened=await openSealedRoute("form",operation,token,event.clientId),method=event.request.method;
  if(method==="GET")opened.target.search=new URL(event.request.url).search;
  const contentType=event.request.headers.get("Content-Type")??"",enctype=method==="POST"?sealedFormEnctype(contentType):"application/x-www-form-urlencoded",base=sealedRouteBase(opened,"document",event);
  const plan={...base,method,enctype,body_expected:method==="POST",request_headers:method==="POST"?[["Accept","text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],["Content-Type",contentType]]:[["Accept","text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"]],credentials:"include",redirect:"follow",request_mode:"navigate",cors_origin:serializeRequestOrigin(base.source_url,base.target_url,base.referrer_policy,method),cors_request_headers:[]};
  const upload=method==="POST"?await boundedUploadBytes(event.request.body,event.request.signal):null;
  if(opened.target.origin!==opened.source_target.origin){
    const submission=await formHandoffSubmission(plan,upload);
    return serveCrossOriginNavigationHandoff({...plan,visible_target_url:opened.target.href},submission);
  }
  return serveFollowedDocument(await followFormPlan(plan,event,upload),event);
}
async function serveSealedBeacon(operation,token,event){
  if(event.request.method!=="POST")return blocked("BEACON_REQUEST_MISMATCH",400);
  const opened=await openSealedRoute("beacon",operation,token,event.clientId),contentType=event.request.headers.get("Content-Type")??"",body=normalizeBeaconBody(new Uint8Array(await event.request.arrayBuffer()),contentType),headers=[["Accept","*/*"]];
  if(body.contentType!=="")headers.push(["Content-Type",body.contentType]);
  const base=sealedRouteBase(opened,"beacon",event),plan={...base,cors_origin:serializeRequestOrigin(base.source_url,base.target_url,base.referrer_policy,"POST"),method:"POST",request_headers:headers,body_expected:true,credentials:"include",redirect:"follow",request_mode:"no-cors",cors_request_headers:[]},followed=await followAPIPlan(plan,event,undefined,body.body);
  await discardKernelBody(followed.result);
  return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
}
async function serveSealedPing(operation,token,event){
  if(event.request.method!=="POST")return blocked("PING_REQUEST_MISMATCH",400);
  const opened=await openSealedRoute("ping",operation,token,event.clientId),body=normalizePingBody(new Uint8Array(await event.request.arrayBuffer()),event.request.headers.get("Content-Type")??""),base=sealedRouteBase(opened,"ping",event);
  const metadata=anchorPingRequestMetadata(base.source_url,base.target_url,opened.ping_to.href,base.referrer_policy),plan={...base,cors_origin:metadata.corsOrigin,referrer_policy:metadata.referrerPolicy,referrer_source:metadata.referrerSource,referrer:metadata.referrer,method:"POST",request_headers:metadata.headers.map(pair=>[...pair]),body_expected:true,credentials:"include",redirect:"follow",request_mode:"no-cors",cors_request_headers:[]},followed=await followAPIPlan(plan,event,undefined,body);
  await discardKernelBody(followed.result);
  return new Response(null,{status:204,headers:{"Cache-Control":"no-store"}});
}
async function serveSealedDownload(operation,token,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("DOWNLOAD_REQUEST_MISMATCH",400);
  const opened=await openSealedRoute("download",operation,token,event.clientId),plan={...sealedRouteBase(opened,"download",event),method:"GET",request_headers:[["Accept","*/*"]],body_expected:false,credentials:"include",redirect:"follow",request_mode:"navigate",cors_request_headers:[]},followed=await followAPIPlan(plan,event),result=followed.result,headers=responseHeaders(result),fallback=normalizeDownloadFilename(null,followed.finalPlan.target_url);
  headers.set("Content-Disposition",preserveAttachmentDisposition(headers.get("Content-Disposition"),fallback));
  return new Response(result.body,{status:result.status,statusText:result.statusText,headers});
}
async function serveClassicWorkerExecutableRequest(parts, event) {
  const route = await readWorkerExecutable(parts[3].slice(0, -3), "worker-classic", event.clientId);
  return route ? serveWorkerExecutable(route, event) : blocked("WORKER_EXECUTABLE_UNAVAILABLE", 410);
}

async function serveModuleWorkerExecutableRequest(parts,event){
  const graphID=parts[3],moduleID=parts[4].slice(0,-4),id=`${graphID}:${moduleID}`;
  const db=await database(),tx=db.transaction("routes","readonly"),targetRoute=await request(tx.objectStore("routes").get(id));
  await complete(tx);
  if(targetRoute?.kind==="target-worker-module"){
    const binding=targetWorkerBinding();
    if(targetRoute.expires_at<=Date.now()||targetRoute.profile_id!==originState?.profile_id||targetRoute.tab_id!==originState?.tab_id||targetRoute.entry_id!==originState?.entry_id||targetRoute.origin_id!==originState?.destination_origin_id||targetRoute.capability!==binding.capability||targetRoute.client_epoch!==binding.client_epoch||targetRoute.graph_id!==graphID||targetRoute.module_id!==moduleID||!["javascript","json"].includes(targetRoute.module_type)||typeof targetRoute.source!=="string")return blocked("WORKER_EXECUTABLE_UNAVAILABLE",410);
    return serveWorkerExecutable(targetRoute,event);
  }
  const route=await readWorkerExecutable(id,"worker-module",event.clientId);
  if(!route||route.graph_id!==graphID||route.module_id!==moduleID||!["javascript","json"].includes(route.module_type))return blocked("WORKER_EXECUTABLE_UNAVAILABLE",410);
  return serveWorkerExecutable(route,event);
}

async function serveDocumentModuleExecutableRequest(parts,event){
  if(event.request.method!=="GET"||event.request.body!==null)return blocked("DOCUMENT_MODULE_METHOD",400);
  const graphID=parts[3],moduleID=parts[4].slice(0,-4),id=`${graphID}:${moduleID}`;
  const db=await database(),tx=db.transaction("routes","readonly"),route=await request(tx.objectStore("routes").get(id));
  await complete(tx);
  if(!await documentModuleRouteLive(route,event.clientId)||route.kind!=="document-module"||route.graph_id!==graphID||route.module_id!==moduleID||!["javascript","json"].includes(route.module_type)||typeof route.source!=="string")return blocked("DOCUMENT_MODULE_UNAVAILABLE",410);
  return serveWorkerExecutable(route,event);
}

async function serveWorkletExecutableRequest(parts, event) {
  const route = await readWorkerExecutable(parts[3].slice(0, -4), "worklet-wrapper", event.clientId);
  return route ? serveWorkerExecutable(route, event) : blocked("WORKLET_EXECUTABLE_UNAVAILABLE", 410);
}

async function serveHistoryRequest(parts, event) {
  const route = await openHistoryRoute(parts[3], parts[4]);
  return route ? serveTargetRoute(route, event) : blocked("HISTORY_ROUTE_UNAVAILABLE", 410);
}

function serveSealedRequest(parts, event) {
  const sealedKind = parts[2];
  const operation = parts[3];
  const token = parts[4];
  if (sealedKind === "navigation") return serveSealedNavigation(operation, token, event);
  if (sealedKind === "form") return serveSealedForm(operation, token, event);
  if (sealedKind === "beacon") return serveSealedBeacon(operation, token, event);
  if (sealedKind === "ping") return serveSealedPing(operation, token, event);
  return serveSealedDownload(operation, token, event);
}

async function serveAPIRequest(url,event,lifetime){
  const parsed=parsePolicyRoute(url.pathname);
  if(url.search!==""||url.hash!==""||parsed.family!=="api-plan"||parsed.kind!==null)return apiBlocked("API_PLAN_UNAVAILABLE",410);
  const plan=await consumeAPIPlan(parsed.id,event.clientId,event.request);
  if(!plan)return apiBlocked("API_PLAN_UNAVAILABLE",410);
  await ensureSignalRequestPhase(event.request.signal,"AUTHORIZED");
  try{return await serveAPIPlan(plan,event,lifetime)}
  catch(error){await releaseEventSourceAttempt(plan);return apiBlocked(error?.name==="SecurityError"?"POLICY_DENIED":"TARGET_FETCH_FAILED")}
}

async function serveAdmittedTargetRoute(state, url, event) {
  let route = null;
  const navigation = event.request.mode === "navigate";
  try {
    const parsed = parsePolicyRoute(url.pathname);
    if(parsed.family!=="target"||typeof parsed.kind!=="string")
      return navigation ? navigationFailure(null,event,"ROUTE_UNAVAILABLE",410) : blocked("ROUTE_UNAVAILABLE",410);
    route = await consumeRoute(parsed.id,parsed.kind);
    if (!route)
      return navigation ? navigationFailure(null,event,"ROUTE_UNAVAILABLE",410) : blocked("ROUTE_UNAVAILABLE",410);
    await ensureSignalRequestPhase(event.request.signal,"AUTHORIZED");
    const broker=targetWorkerBroker,brokerControls = broker && await broker.controlsFetch({
      client_id: event.clientId || undefined,
      url: route.target_url,
    });
    await ensureSignalRequestPhase(event.request.signal,"PLANNED");
    if(!targetRouteClassMatches(route,event.request))
      return navigation ? navigationFailure(route,event,"ROUTE_CLASS_MISMATCH",403) : blocked("ROUTE_CLASS_MISMATCH");
    if (!brokerControls) return await serveTargetRoute(route, event);
    const dispatch = dispatchTargetWorkerFetch(route, event, broker);
    const softUpdate = targetServiceWorkerSoftUpdate(route.target_url, event.clientId).catch(() => null);
    state.brokerDispatch = true;
    state.dispatch=dispatch;
    void Promise.all([dispatch.lifetime, softUpdate]).then(state.resolveLifetime,state.rejectLifetime);
    const response=await dispatch.response;
    return serveTargetWorkerResponse(route,response,event);
  } catch (error) {
    if (navigation) {
      const code=error?.name==="SecurityError"?"POLICY_DENIED":state.brokerDispatch?"TARGET_WORKER_FETCH_FAILED":"TARGET_FETCH_FAILED";
      return navigationFailure(route,event,code,502);
    }
    if (state.brokerDispatch&&state.dispatch?.claimed) {
      if(error!==null&&(typeof error==="object"||typeof error==="function"))targetWorkerNativeFetchFailures.add(error);
      throw error;
    }
    if(state.brokerDispatch)return blocked(error?.name==="SecurityError"?"TARGET_WORKER_POLICY_DENIED":"TARGET_WORKER_FETCH_FAILED",502);
    return blocked(error?.name === "SecurityError" ? "POLICY_DENIED" : "TARGET_FETCH_FAILED", 502);
  } finally {
    if (!state.brokerDispatch) state.resolveLifetime();
  }
}

function targetRouteAdmission(url, event) {
  const state = { brokerDispatch: false, dispatch: null, rejectLifetime: null, resolveLifetime: null };
  const lifetime = new Promise((resolve,reject) => { state.resolveLifetime = resolve;state.rejectLifetime=reject; });
  return {
    lifetime,
    response: serveAdmittedTargetRoute(state, url, event),
  };
}

function apiRequestAdmission(url,event){
  const writes=[],lifetime={track(promise){writes.push(promise)}};
  let resolveLifetime;
  const completion=new Promise(resolve=>{resolveLifetime=resolve});
  const response=serveAPIRequest(url,event,lifetime);
  void response.then(()=>Promise.allSettled(writes),()=>Promise.allSettled(writes)).then(resolveLifetime);
  return{lifetime:completion,response};
}
function fetchAdmission(event) {
  const url = new URL(event.request.url);
  const kind = classifyRequest(url.pathname);
  const parts = url.pathname.split("/");
  let response;
  switch (kind) {
    case "worker-gateway-classic":
      response = serveWorkerGateway(parts[3], parts[4], false, event)
        .catch(() => blocked("WORKER_GATEWAY_UNAVAILABLE", 410));
      break;
    case "worker-gateway-module":
      response = serveWorkerGateway(parts[3], parts[4], true, event)
        .catch(() => blocked("WORKER_GATEWAY_UNAVAILABLE", 410));
      break;
    case "worker-executable-classic":
      response = serveClassicWorkerExecutableRequest(parts, event)
        .catch(() => blocked("WORKER_EXECUTABLE_UNAVAILABLE", 410));
      break;
    case "worker-executable-module":
      response = serveModuleWorkerExecutableRequest(parts, event)
        .catch(() => blocked("WORKER_EXECUTABLE_UNAVAILABLE", 410));
      break;
    case "document-executable-module":
      response = serveDocumentModuleExecutableRequest(parts, event)
        .catch(() => blocked("DOCUMENT_MODULE_UNAVAILABLE", 410));
      break;
    case "worklet-executable":
      response = serveWorkletExecutableRequest(parts, event)
        .catch(() => blocked("WORKLET_EXECUTABLE_UNAVAILABLE", 410));
      break;
    case "target-worker-executable":
      response = serveTargetWorkerExecutable(parts[3].slice(0, -4), event)
        .catch(() => blocked("TARGET_WORKER_EXECUTABLE_UNAVAILABLE", 410));
      break;
    case "history-route":
      response = serveHistoryRequest(parts, event).catch(() => navigationFailure(null,event,"HISTORY_ROUTE_FAILED",502));
      break;
    case "sealed-route":
      response = Promise.resolve(serveSealedRequest(parts, event))
        .catch(error => event.request.mode==="navigate"
          ? navigationFailure(null,event,error?.name === "SecurityError" ? "SEALED_ROUTE_POLICY_DENIED" : "SEALED_ROUTE_TARGET_FAILED",502)
          : blocked(error?.name === "SecurityError" ? "SEALED_ROUTE_POLICY_DENIED" : "SEALED_ROUTE_TARGET_FAILED",502));
      break;
    case "internal-immutable-asset":
    case "bootstrap":
      response = fetch(event.request);
      break;
    case "api-plan":
      return apiRequestAdmission(url,event);
    case "target-route":
      return targetRouteAdmission(url, event);
    default:
      response = Promise.resolve(event.request.mode==="navigate"?navigationFailure(null,event,"UNKNOWN_REQUEST",404):blocked("UNKNOWN_REQUEST"));
  }
  return { lifetime: null, response };
}

const coordinatorFetchKinds=new Set(["history-route","sealed-route","api-plan","target-route"]);
const localHydrationFetchKinds=new Set([
  "worker-gateway-classic",
  "worker-gateway-module",
  "worker-executable-classic",
  "worker-executable-module",
  "document-executable-module",
  "worklet-executable",
  "target-worker-executable",
  ...coordinatorFetchKinds,
]);
const requestSignalLifecycles=new WeakMap;
function thrownRequestTerminal(error){
  const code=failureCode(error,"REQUEST_FAILED");
  if(code.includes("VERSION"))return"VERSION_MISMATCH";
  if(error?.name==="AbortError"||code.includes("ABORT"))return"ABORTED";
  if(error?.name==="TimeoutError"||code.includes("TIMEOUT"))return"TIMED_OUT";
  if(error?.name==="SecurityError"||code.includes("POLICY")||code.includes("DENIED")||code.includes("REJECTED"))return"POLICY_BLOCKED";
  if(code.includes("REWRITE")||code.includes("ENCODING")||code.includes("INTEGRITY"))return"REWRITE_FAILED";
  if(code.includes("CLIENT_GONE"))return"CLIENT_GONE";
  return"TRANSPORT_FAILED";
}
async function failRequestLifecycle(lifecycleAuthority,state,error){
  try{return await lifecycleAuthority.fail(state,failureCode(error,"REQUEST_FAILED"))}
  catch{return lifecycleAuthority.snapshot()}
}
function ensureRequestPhase(lifecycleAuthority,target){
  return lifecycleAuthority.advanceTo(target);
}
function ensureSignalRequestPhase(signal,target){
  const authority=requestSignalLifecycles.get(signal);
  return authority?ensureRequestPhase(authority,target):Promise.resolve();
}
async function managedLifecycleResponse(response,lifecycleAuthority){
  const internalTerminal=internalTerminalResponses.get(response);
  if(internalTerminal){
    await failRequestLifecycle(lifecycleAuthority,internalTerminal.state,{code:internalTerminal.code});
    return response;
  }
  await ensureRequestPhase(lifecycleAuthority,"TRANSFORMING_IF_REQUIRED");
  await ensureRequestPhase(lifecycleAuthority,"STREAMING");
  const commitResources=documentRouteCommits.get(response)??[];
  if(commitResources.length)await lifecycleAuthority.transfer(commitResources);
  documentRouteCommits.delete(response);
  if(response.body===null){
    await lifecycleAuthority.complete();
    return response;
  }
  const reader=response.body.getReader(),resource=lifecycleAuthority.track("target_body","response",()=>reader.cancel("REQUEST_TERMINAL"));
  const body=new ReadableStream({
    async pull(controller){
      try{
        const next=await reader.read();
        if(next.done){
          await lifecycleAuthority.release(resource,false);
          await lifecycleAuthority.complete();
          controller.close();
        }else controller.enqueue(next.value);
      }catch(error){
        await failRequestLifecycle(lifecycleAuthority,thrownRequestTerminal(error),error);
        controller.error(error);
      }
    },
    async cancel(reason){
      await failRequestLifecycle(lifecycleAuthority,"ABORTED",{code:typeof reason==="string"?reason:"CLIENT_CANCELLED"});
    },
  });
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
function requestLifecycleAuthority(kind,event){
  const authority=createRequestLifecycle({id:randomID(),requestClass:kind,checkpoint:writeRequestCheckpoint});
  requestSignalLifecycles.set(event.request.signal,authority);
  authority.track("map_entry","request-signal",async()=>{requestSignalLifecycles.delete(event.request.signal)});
  const timer=setTimeout(()=>{void failRequestLifecycle(authority,"TIMED_OUT",{code:"REQUEST_DEADLINE_EXCEEDED"})},120_000);
  authority.track("timer","deadline",async()=>clearTimeout(timer));
  return authority;
}
self.addEventListener("fetch",event=>{
  const kind=classifyRequest(new URL(event.request.url).pathname),requestLifecycle=requestLifecycleAuthority(kind,event);
  const operation=(async()=>{
    await recoverAbandonedRequests();
    await requestLifecycle.advance("CLASSIFIED");
    if(localHydrationFetchKinds.has(kind))await hydrateForEvent(coordinatorFetchKinds.has(kind));
    return fetchAdmission(event);
  })();
  const response=operation.then(async admission=>managedLifecycleResponse(await admission.response,requestLifecycle))
    .catch(async error=>{
      const nativeFetchFailure=error!==null&&(typeof error==="object"||typeof error==="function")&&targetWorkerNativeFetchFailures.has(error);
      await failRequestLifecycle(requestLifecycle,thrownRequestTerminal(error),error);
      if(event.request.mode==="navigate")return navigationFailure(null,event,failureCode(error,"REQUEST_FAILED"),503);
      if(nativeFetchFailure)throw error;
      return blocked(failureCode(error,"REQUEST_FAILED"),503);
    });
  const admissionLifetime=operation.then(admission=>admission.lifetime??null);
  const lifetime=Promise.all([response,admissionLifetime,requestLifecycle.settled]).then(()=>{});
  event.respondWith(response);
  event.waitUntil(lifetime);
});
