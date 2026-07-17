const entryID="__ENTRY_ID__";
const capability="__CAPABILITY__";
const abi="__ABI__";
const runtimeAsset="__RUNTIME_ASSET__";
const runtimeBootstrap="__RUNTIME_BOOTSTRAP__";
const dbName="sealed-history-browser-oracle";
const routePattern=new RegExp(`^/_zp/history/(${entryID})/([A-Za-z0-9_-]{32,16384})$`);
function database(){return new Promise((resolve,reject)=>{const opening=indexedDB.open(dbName,1);opening.onupgradeneeded=()=>opening.result.createObjectStore("routes",{keyPath:"path"});opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})}
function complete(transaction){return new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error);transaction.onerror=()=>reject(transaction.error)})}
function request(value){return new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error)})}
async function storeRoutes(routes){
  if(!Array.isArray(routes)||routes.length===0||routes.length>8)throw new Error("invalid history routes");
  const db=await database(),transaction=db.transaction("routes","readwrite"),store=transaction.objectStore("routes");
  for(const route of routes){
    if(!route||typeof route.path!=="string"||typeof route.target!=="string"||!routePattern.test(route.path)||!route.target.startsWith("https://target.example/"))throw new Error("invalid history route");
    store.put({path:route.path,target:route.target});
  }
  await complete(transaction);
}
async function routeFor(path){const db=await database(),transaction=db.transaction("routes","readonly"),route=await request(transaction.objectStore("routes").get(path));await complete(transaction);return route??null}
function unavailable(){return new Response("HISTORY_ROUTE_UNAVAILABLE",{status:410,headers:{"Content-Type":"text/plain;charset=utf-8","Cache-Control":"no-store"}})}
function rehydratedDocument(route){
  const runtimeURL=`${runtimeAsset}#abi=${abi}&url=${encodeURIComponent(route.target)}&ports=443&cookie=${capability}&strings=0`.replaceAll("&","&amp;");
  const script="globalThis.__sealedHistoryRehydrated={ok:true,documentURL:document.URL,state:history.state}";
  return new Response(`<!doctype html><meta charset="utf-8"><title>history rehydrated</title><script src="${runtimeURL}" data-zp-cookie-bootstrap="${runtimeBootstrap}"></script><script>${script}</script>`,{status:200,headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; base-uri 'none'"}})
}
self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("message",event=>{
  const message=event.data;
  if(message?.v===2&&message.operation==="BIND_RUNTIME_PORT"&&event.ports[0]){event.ports[0].postMessage({v:2,operation:"RUNTIME_PORT_READY"});return}
  const reply=value=>event.ports[0]?.postMessage(value);
  if(message?.type==="STORE_HISTORY_ROUTES"){event.waitUntil(storeRoutes(message.routes).then(()=>reply({ok:true}),()=>reply({ok:false})));return}
  if(message?.type==="DROP_HISTORY_MEMORY"){reply({ok:true});return}
});
self.addEventListener("fetch",event=>{
  const match=routePattern.exec(new URL(event.request.url).pathname);
  if(!match)return;
  event.respondWith(routeFor(new URL(event.request.url).pathname).then(route=>route?rehydratedDocument(route):unavailable(),unavailable));
});
