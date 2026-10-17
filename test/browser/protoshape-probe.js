// Snapshot own property names on native WebIDL interface prototypes.
// Executed via `taskweaver exec-js --file` (wrapped as a function body, so top-level `return` is required).
var NATIVE = /\{\s*\[native code\]\s*\}/;
var out = {};
var names = [];
try { names = Object.getOwnPropertyNames(window); } catch (e) { return JSON.stringify({ __error: 'enumerate:' + e.name }); }
for (var i = 0; i < names.length; i++) {
  var n = names[i];
  var c0 = n.charCodeAt(0);
  if (c0 < 65 || c0 > 90) continue;
  var proto = null;
  try {
    var iface = window[n];
    if (typeof iface !== 'function') continue;
    // Filter to constructors whose `toString()` reports `[native code]` (including masked proxy replacement classes)
    // to exclude page-defined uppercase constructors.
    if (!NATIVE.test(Function.prototype.toString.call(iface))) continue;
    proto = iface.prototype;
  } catch (e) { continue; }
  if (!proto || typeof proto !== 'object') continue;
  try {
    out[n] = Object.getOwnPropertyNames(proto).sort();
  } catch (e) {}
}
return JSON.stringify(out);
