export function install(scope) {
  scope.importScripts("./classic-helper.js");
  scope.addEventListener("fetch", event => event.respondWith(new Response(null, { status: 204 })));
}
