import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { differential, loadProductCompiler, NATIVE_HOST_COVERAGE, observeNativeSource, pathExists, ROOT, withBrowserLane } from "./native-differential-harness.mjs";

const chromiumPath = process.env.ZP_CHROMIUM_PATH ?? path.join(
  ROOT,
  ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const firefoxPath = process.env.ZP_FIREFOX_PATH ?? path.join(ROOT, ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox");

const fixtures = Object.freeze([
  {
    id: "non-callable-selected-call",
    sourceKind: "ClassicScriptInline",
    source: "const value={method:1}; value.method()",
  },
  {
    id: "getter-rhs-setter-order",
    sourceKind: "ClassicScriptInline",
    source: "const value={get x(){effects.push('get');return 2},set x(next){effects.push('set:'+next)}};function rhs(){effects.push('rhs');return 3}value.x+=rhs();effects.join(',')",
  },
  {
    id: "tonumeric-bigint-postfix",
    sourceKind: "ClassicScriptInline",
    source: "let value=1n;const old=value++;[old,value].join(',')",
  },
  {
    id: "strict-failed-set",
    sourceKind: "ClassicScriptInline",
    source: "'use strict';const value={};Object.defineProperty(value,'x',{value:1});value.x=(effects.push('rhs'),2)",
  },
  {
    id: "strict-failed-delete",
    sourceKind: "ClassicScriptInline",
    source: "'use strict';const value=new Proxy({x:1},{deleteProperty(){effects.push('delete');return false}});delete value.x",
  },
  {
    id: "primitive-in",
    sourceKind: "ClassicScriptInline",
    source: "'x' in 1",
  },
  {
    id: "private-in",
    sourceKind: "ClassicScriptInline",
    source: "class Value{#x;has(candidate){return #x in candidate}};new Value().has(new Value())",
  },
  {
    id: "proxy-in",
    sourceKind: "ClassicScriptInline",
    source: "const value=new Proxy({x:1},{has(target,key){effects.push(String(key));return Reflect.has(target,key)}});'x' in value",
  },
  {
    id: "optional-call-short-circuit",
    sourceKind: "ClassicScriptInline",
    source: "let callable=null;callable?.(effects.push('argument'));effects.length",
  },
  {
    id: "optional-call-spread-short-circuit",
    sourceKind: "ClassicScriptInline",
    source: "let callable=null;function* args(){effects.push('spread');yield 1}callable?.(...args());effects.length",
  },
  {
    id: "optional-member-receiver",
    sourceKind: "ClassicScriptInline",
    source: "const value={x:7,method(){effects.push(this===value);return this.x}};value.method?.()",
  },
  {
    id: "optional-chain-grouping",
    sourceKind: "ClassicScriptInline",
    source: "let value=null;try{(value?.method)()}catch(error){effects.push(error.constructor.name)}effects.join(',')",
  },
  {
    id: "with-receiver-and-proxy-capture",
    sourceKind: "ClassicScriptInline",
    source: "const target={x:7,method(){effects.push(this===target);return this.x}};const value=new Proxy(target,{has(object,key){effects.push('has:'+String(key));return Reflect.has(object,key)},get(object,key,receiver){effects.push('get:'+String(key));return Reflect.get(object,key,receiver)}});with(value){method()}effects.at(-1)",
  },
  {
    id: "derived-this-before-super",
    sourceKind: "ClassicScriptInline",
    source: "class Base{};class Derived extends Base{constructor(){this.x}};new Derived()",
    requiresEdit: true,
  },
  {
    id: "owned-global-read",
    sourceKind: "ClassicScriptInline",
    source: "self===globalThis",
    requiresEdit: true,
  },
  {
    id: "owned-global-lexical-shadow",
    sourceKind: "ClassicScriptInline",
    source: "(()=>{const self=41;return self+1})()",
  },
  {
    id: "strict-and-sloppy-this",
    sourceKind: "ClassicScriptInline",
    source: "function sloppy(){return this===globalThis}function strict(){'use strict';return this===undefined}[sloppy(),strict()].join(',')",
    requiresEdit: true,
  },
  {
    id: "direct-eval-single-argument",
    sourceKind: "ClassicScriptInline",
    source: "eval((effects.push('argument'),'effects.push(\"eval\"); 7'))",
    requiresEdit: true,
  },
  {
    id: "parenthesized-direct-eval",
    sourceKind: "ClassicScriptInline",
    source: "(()=>{let lexical=7;return ((eval))('lexical')})()",
    requiresEdit: true,
  },
  {
    id: "events-and-promises",
    sourceKind: "ClassicScriptInline",
    source: "Promise.resolve().then(()=>__zpEvents.push('microtask')).then(()=>effects.push('settled'))",
  },
  {
    id: "descriptor-and-source-reflection",
    sourceKind: "ClassicScriptInline",
    source: "function sample(a,b){return a+b}globalThis.__zpDescriptors=Object.getOwnPropertyDescriptor(sample,'length');globalThis.__zpSourceReflection=Function.prototype.toString.call(sample);sample(2,3)",
    requiresEdit: true,
  },
  {
    id: "function-body-owned-global",
    sourceKind: "FunctionBody",
    source: "effects.push(self===globalThis);return effects.join(',')",
    requiresEdit: true,
  },
  {
    id: "module-identity-and-import-meta",
    sourceKind: "ModuleScript",
    source: "const token={value:7};globalThis.__zpModuleIdentity=token;globalThis.__zpSourceReflection=import.meta.url;export {token};export default token;",
    requiresEdit: true,
  },
  {
    id: "owned-global-assignment",
    sourceKind: "ClassicScriptInline",
    source: "fetch=(effects.push('rhs'),42);[typeof fetch,effects.join(',')].join(':')",
    requiresEdit: true,
  },
  {
    id: "owned-global-update",
    sourceKind: "ClassicScriptInline",
    source: "open=1;const old=open++;[old,open].join(',')",
    requiresEdit: true,
  },
  {
    id: "owned-global-destructuring",
    sourceKind: "ClassicScriptInline",
    source: "[open]=[7];({open}={open:8});open",
    requiresEdit: true,
  },
  {
    id: "owned-global-for-in",
    sourceKind: "ClassicScriptInline",
    source: "for(open in {first:1}){effects.push(open)}effects.join(',')",
    requiresEdit: true,
  },
  {
    id: "owned-global-for-of",
    sourceKind: "ClassicScriptInline",
    source: "for(open of ['first','second']){effects.push(open)}effects.join(',')",
    requiresEdit: true,
  },
  {
    id: "owned-global-delete-typeof",
    sourceKind: "ClassicScriptInline",
    source: "const deleted=delete open;[deleted,typeof open].join(',')",
    requiresEdit: true,
  },
  {
    id: "lexical-shadowing-forms",
    sourceKind: "ClassicScriptInline",
    source: "{let fetch=1;effects.push(fetch)}{const fetch=2;effects.push(fetch)}function parameter(fetch){return fetch}function local(){var fetch=4;return fetch}try{throw 5}catch(fetch){effects.push(fetch)}class window{};effects.push(parameter(3),local(),new window() instanceof window);effects.join(',')",
  },
  {
    id: "arrow-lexical-this",
    sourceKind: "ClassicScriptInline",
    source: "const outer=this;const arrow=()=>this===outer;arrow()",
    requiresEdit: true,
  },
  {
    id: "method-and-accessor-this",
    sourceKind: "ClassicScriptInline",
    source: "const value={method(){return this},get current(){return this}};[value.method()===value,value.current===value].join(',')",
    requiresEdit: true,
  },
  {
    id: "callback-this",
    sourceKind: "ClassicScriptInline",
    source: "function callback(){return this?.marker}callback.call({marker:7})",
    requiresEdit: true,
  },
  {
    id: "class-constructor-this",
    sourceKind: "ClassicScriptInline",
    source: "class Value{constructor(){this.marker=7}read(){return this.marker}};new Value().read()",
    requiresEdit: true,
  },
  {
    id: "direct-eval-zero-argument",
    sourceKind: "ClassicScriptInline",
    source: "((eval))()",
  },
  {
    id: "direct-eval-multiple-arguments-red-before",
    sourceKind: "ClassicScriptInline",
    source: "eval('1','2')",
    expectedRedBefore: /UNSUPPORTED_DIRECT_EVAL_SHAPE/u,
  },
  {
    id: "parenthesized-direct-eval-multiple-arguments-red-before",
    sourceKind: "ClassicScriptInline",
    source: "((eval))('1','2')",
    expectedRedBefore: /UNSUPPORTED_DIRECT_EVAL_SHAPE/u,
  },
  {
    id: "direct-eval-spread-red-before",
    sourceKind: "ClassicScriptInline",
    source: "eval(...['1'])",
    expectedRedBefore: /UNSUPPORTED_DIRECT_EVAL_SHAPE/u,
  },
  {
    id: "certified-shadowed-eval-remains-native",
    sourceKind: "ClassicScriptInline",
    source: "const eval=value=>value+':shadowed';eval('value')",
  },
  {
    id: "shadowed-parameter-eval-red-before",
    sourceKind: "ClassicScriptInline",
    source: "function run(eval){return eval('value')}run(value=>value+':shadowed')",
    expectedRedBefore: /UNSUPPORTED_DIRECT_EVAL_BINDING/u,
  },
  {
    id: "shadowed-parameter-alias-red-before",
    sourceKind: "ClassicScriptInline",
    source: "function run(eval){const alias=eval;return alias('value')}run(value=>value+':shadowed')",
    expectedRedBefore: /UNSUPPORTED_DIRECT_EVAL_BINDING/u,
  },
  {
    id: "optional-eval-is-indirect",
    sourceKind: "ClassicScriptInline",
    source: "(()=>{let lexical=7;return eval?.('typeof lexical')})()",
    requiresEdit: true,
  },
  {
    id: "indirect-eval-alias",
    sourceKind: "ClassicScriptInline",
    source: "const alias=eval;alias('effects.push(\"indirect\");9')",
    requiresEdit: true,
  },
  {
    id: "indirect-eval-comma",
    sourceKind: "ClassicScriptInline",
    source: "(0,eval)('effects.push(\"comma\");10')",
    requiresEdit: true,
  },
  {
    id: "indirect-eval-call-apply",
    sourceKind: "ClassicScriptInline",
    source: "const first=globalThis.eval.call(null,'11');const second=globalThis.eval.apply(null,['12']);[first,second].join(',')",
    requiresEdit: true,
  },
  {
    id: "cross-realm-indirect-eval",
    sourceKind: "ClassicScriptInline",
    source: "const frame=document.createElement('iframe');document.body.append(frame);const value=frame.contentWindow.eval('4+4');frame.remove();value",
    requiresEdit: true,
  },
  {
    id: "function-constructor-call",
    sourceKind: "ClassicScriptInline",
    source: "Function('a','b','return a+b')(2,3)",
    requiresEdit: true,
  },
  {
    id: "function-constructor-custom-new-target",
    sourceKind: "ClassicScriptInline",
    source: "class Custom{};const value=Reflect.construct(Function,['return 7'],Custom);[Object.getPrototypeOf(value)===Custom.prototype,value()].join(',')",
    requiresEdit: true,
  },
  {
    id: "async-function-body",
    sourceKind: "AsyncFunctionBody",
    source: "await Promise.resolve();effects.push(self===globalThis);return 7",
    requiresEdit: true,
  },
  {
    id: "generator-function-body",
    sourceKind: "GeneratorFunctionBody",
    source: "effects.push(self===globalThis);yield 7",
    requiresEdit: true,
  },
  {
    id: "async-generator-function-body",
    sourceKind: "AsyncGeneratorFunctionBody",
    source: "await Promise.resolve();effects.push(self===globalThis);yield 7",
    requiresEdit: true,
  },
  {
    id: "event-handler-host-body",
    sourceKind: "EventHandler",
    source: "'use strict';effects.push([event.type,this===__zpHandlerElement,self===globalThis].join(':'));return false",
    requiresEdit: true,
  },
  {
    id: "direct-eval-source-kind-strict-direct-host",
    sourceKind: "DirectEvalScript",
    source: "'use strict';var directEvalBinding=7;effects.push([self===globalThis,Object.hasOwn(globalThis,'directEvalBinding')].join(':'));7",
    requiresEdit: true,
  },
  {
    id: "indirect-eval-source-kind-global-host",
    sourceKind: "IndirectEvalScript",
    source: "var indirectEvalBinding=7;effects.push([self===globalThis,Object.hasOwn(globalThis,'indirectEvalBinding')].join(':'));7",
    requiresEdit: true,
  },
  {
    id: "timer-string-source-kind",
    sourceKind: "TimerString",
    source: "'use strict';effects.push(['timer',self===globalThis].join(':'))",
    requiresEdit: true,
  },
  {
    id: "javascript-url-source-kind",
    sourceKind: "JavaScriptURL",
    source: "'use strict';effects.push(['javascript-url',self===globalThis].join(':'));'<article>result</article>'",
    requiresEdit: true,
  },
  {
    id: "classic-worker-source-kind",
    sourceKind: "ClassicWorker",
    source: "effects.push(self===globalThis);",
    requiresEdit: true,
  },
  {
    id: "shared-classic-worker-source-kind",
    sourceKind: "SharedClassicWorker",
    source: "effects.push(self===globalThis);",
    requiresEdit: true,
  },
  {
    id: "target-service-worker-classic-source-kind",
    sourceKind: "TargetServiceWorkerClassic",
    source: "effects.push(self===globalThis);",
    requiresEdit: true,
  },
  {
    id: "module-worker-source-kind",
    sourceKind: "ModuleWorker",
    source: "effects.push(globalThis===globalThis);export const value=7",
    requiresEdit: true,
  },
  {
    id: "shared-module-worker-source-kind",
    sourceKind: "SharedModuleWorker",
    source: "effects.push(globalThis===globalThis);export const value=7",
    requiresEdit: true,
  },
  {
    id: "target-service-worker-module-source-kind",
    sourceKind: "TargetServiceWorkerModule",
    source: "effects.push(globalThis===globalThis);export const value=7",
    requiresEdit: true,
  },
  {
    id: "worklet-module-source-kind",
    sourceKind: "WorkletModule",
    source: "effects.push(globalThis===globalThis);export const value=7",
    requiresEdit: true,
  },
  {
    id: "source-spelling-comments-directives-asi-template-regex",
    sourceKind: "ClassicScriptExternal",
    source: "'use strict'\n/* retained */\nconst template=`${1+1}`\nconst regex=/a+/u\neffects.push(template,regex.test('aa'))\n//# sourceURL=target-visible.js\neffects.join(',')",
  },
  {
    id: "hashbang-script-goal",
    sourceKind: "ClassicScriptExternal",
    source: "#!/usr/bin/env node\neffects.push('hashbang');7",
  },
  {
    id: "annex-b-if-function-declaration",
    sourceKind: "ClassicScriptInline",
    source: "if(true)function legacy(){return 7};legacy()",
  },
  {
    id: "legacy-html-open-comment",
    sourceKind: "ClassicScriptInline",
    source: "<!-- legacy comment\neffects.push('html-comment');effects.join(',')",
  },
  {
    id: "bom-script",
    sourceKind: "ClassicScriptInline",
    source: "\uFEFFeffects.push('bom');effects.join(',')",
  },
]);

const rejectedGrammarFixtures = Object.freeze([
  ["typescript-extension", "const value: number = 1", "ClassicScriptInline"],
  ["jsx-extension", "const value=<div/>", "ClassicScriptInline"],
  ["decorators-proposal", "@sealed class Value{}", "ClassicScriptInline"],
  ["function-bind-proposal", "function value(){};const bound=::value", "ClassicScriptInline"],
  ["auto-accessor-proposal", "class Value{accessor field}", "ClassicScriptInline"],
  ["resource-management-proposal", "using resource=null", "ClassicScriptInline"],
  ["export-default-from-proposal", "export value from './dependency.js'", "ModuleScript"],
]);

const lanes = [
  {
    family: "chromium",
    exactBuild: "150.0.7871.124",
    binaryPath: chromiumPath,
    available: await pathExists(chromiumPath),
  },
  {
    family: "firefox",
    exactBuild: "152.0.6",
    binaryPath: firefoxPath,
    available: await pathExists(firefoxPath),
  },
];

for (const lane of lanes) {
  test(`actual compiler output matches native ${lane.family}`, { skip: lane.available ? false : `${lane.family} binary unavailable; release support remains false` }, async (context) => {
    const compiler = await loadProductCompiler();
    await withBrowserLane(lane, async (browser) => {
      for (const fixture of fixtures) {
        await context.test(fixture.id, async () => {
          if (fixture.expectedRedBefore) {
            await assert.rejects(() => differential(browser, fixture, compiler), fixture.expectedRedBefore);
          } else {
            await differential(browser, fixture, compiler);
          }
        });
      }
    });
  });
  test(`native ${lane.family} and compiler reject unshipped grammar`, { skip: lane.available ? false : `${lane.family} binary unavailable; release support remains false` }, async () => {
    const compiler = await loadProductCompiler();
    await withBrowserLane(lane, async (browser) => {
      for (const [id, source, sourceKind] of rejectedGrammarFixtures) {
        assert.throws(() => compiler.compile(source, sourceKind), /PARSE_FAILED/u, id);
        const observation = await observeNativeSource(browser, { source, sourceKind });
        assert.equal(observation.exception?.constructor, "SyntaxError", id);
      }
    });
  });
}

test("native host coverage executes the exact source-kind wire enum", () => {
  assert.deepEqual(
    NATIVE_HOST_COVERAGE.covered.map(({ sourceKind, host }) => [sourceKind, host]),
    [
      ["ClassicScriptExternal", "classic-script-external"],
      ["ClassicScriptInline", "classic-script-inline"],
      ["ModuleScript", "module-script"],
      ["DirectEvalScript", "direct-eval"],
      ["IndirectEvalScript", "indirect-eval"],
      ["TimerString", "timer-string"],
      ["FunctionBody", "function-body"],
      ["AsyncFunctionBody", "async-function-body"],
      ["GeneratorFunctionBody", "generator-function-body"],
      ["AsyncGeneratorFunctionBody", "async-generator-function-body"],
      ["EventHandler", "event-handler"],
      ["JavaScriptURL", "javascript-url"],
      ["ClassicWorker", "classic-worker"],
      ["ModuleWorker", "module-worker"],
      ["SharedClassicWorker", "shared-classic-worker"],
      ["SharedModuleWorker", "shared-module-worker"],
      ["TargetServiceWorkerClassic", "service-worker-classic"],
      ["TargetServiceWorkerModule", "service-worker-module"],
      ["WorkletModule", "worklet-module"],
    ],
  );
  assert.deepEqual(NATIVE_HOST_COVERAGE.deferred, []);
});

test("compiler oracle covers exact goals, early errors, modules, dynamic code, and host kinds", async () => {
  const compiler = await loadProductCompiler();
  for (const [source, sourceKind, code] of [
    ["return 1", "ClassicScriptInline", "PARSE_FAILED"],
    ["with({}){}", "ModuleScript", "PARSE_FAILED"],
    ["await 0", "ClassicScriptInline", "PARSE_FAILED"],
    ["yield 1", "FunctionBody", "PARSE_FAILED"],
    ["import value from './dependency.js'", "ClassicScriptInline", "PARSE_FAILED"],
    ["export const value=1", "ClassicScriptInline", "PARSE_FAILED"],
    ["'use strict';with({value:1}){value}", "DirectEvalScript", "PARSE_FAILED"],
    ["const value: number = 1", "ClassicScriptInline", "PARSE_FAILED"],
    ["const value=<div/>", "ClassicScriptInline", "PARSE_FAILED"],
    ["@sealed class Value{}", "ClassicScriptInline", "PARSE_FAILED"],
    ["eval('1','2')", "ClassicScriptInline", "UNSUPPORTED_DIRECT_EVAL_SHAPE"],
    ["function run(eval){return eval('1')}", "ClassicScriptInline", "UNSUPPORTED_DIRECT_EVAL_BINDING"],
    ["var fetch", "DirectEvalScript", "UNSUPPORTED_DIRECT_EVAL_BINDING"],
    ["with(scope){fetch()}", "ClassicScriptInline", "UNSUPPORTED_DYNAMIC_SCOPE"],
    [`let ${compiler.abiIdentifier}=1`, "ClassicScriptInline", "ABI_IDENTIFIER_COLLISION"],
    ["let value; let value", "ClassicScriptInline", "PARSE_FAILED"],
  ]) {
    assert.throws(() => compiler.compile(source, sourceKind), new RegExp(code, "u"));
  }

  const functionBody = compiler.compile("return 1", "FunctionBody");
  assert.equal(functionBody.code, "return 1");
  assert.equal(typeof compiler.compile("await 0;return 1", "AsyncFunctionBody").code, "string");
  assert.equal(typeof compiler.compile("yield 1", "GeneratorFunctionBody").code, "string");
  assert.equal(typeof compiler.compile("await 0;yield 1", "AsyncGeneratorFunctionBody").code, "string");
  assert.equal(typeof compiler.compile("#!/usr/bin/env node\nvoid 0", "ClassicScriptExternal").code, "string");
  const dynamicFunction = compiler.compileDynamicFunction(
    ["fetch", "value = self"],
    "return fetch",
    "FunctionBody",
  );
  assert.equal(dynamicFunction.parameters[0].code, "fetch");
  assert.match(dynamicFunction.parameters[1].code, new RegExp(`${compiler.abiIdentifier}\\.scope\\.self`, "u"));
  assert.equal(dynamicFunction.body.code, "return fetch");
  assert.doesNotMatch(dynamicFunction.body.code, /\.scope\.fetch/u);
  assert.equal(
    Function(...dynamicFunction.parameters.map((parameter) => parameter.code), dynamicFunction.body.code)(41, 42),
    41,
  );
  assert.throws(
    () => compiler.compileDynamicFunction(
      ["value", "value"],
      "\"use strict\"; return value",
      "FunctionBody",
    ),
    /PARSE_FAILED/u,
  );
  const safeWith = compiler.compile("with(scope){ordinary()}", "ClassicScriptInline");
  assert.equal(safeWith.code, "with(scope){ordinary()}");

  const module = compiler.compile(
    "import value from './dependency.js';export {value} from './export.js';import('./literal.js',{with:{type:'json'}});const name='./computed.js';import(name);",
    "ModuleScript",
  );
  assert.deepEqual(module.module_specifiers.map((entry) => entry.specifier), [
    "./dependency.js",
    "./export.js",
    "./literal.js",
  ]);
  for (const specifier of module.module_specifiers) {
    assert.equal(typeof specifier.original_start, "number");
    assert.equal(typeof specifier.generated_start, "number");
    assert.ok(specifier.original_end > specifier.original_start);
    assert.ok(specifier.generated_end > specifier.generated_start);
  }

  const directives = compiler.compile(
    "const decoy='//# sourceURL=decoy.js';\n//# sourceURL=first.js\n/*# sourceMappingURL=target.map */\n//@ sourceURL=last.js",
    "ClassicScriptExternal",
  );
  assert.equal(directives.source_url, "last.js");
  assert.equal(directives.source_mapping_url, "target.map");

  for (const sourceKind of [
    "ClassicScriptExternal",
    "ClassicScriptInline",
    "ModuleScript",
    "DirectEvalScript",
    "IndirectEvalScript",
    "TimerString",
    "FunctionBody",
    "AsyncFunctionBody",
    "GeneratorFunctionBody",
    "AsyncGeneratorFunctionBody",
    "EventHandler",
    "JavaScriptURL",
    "ClassicWorker",
    "ModuleWorker",
    "SharedClassicWorker",
    "SharedModuleWorker",
    "TargetServiceWorkerClassic",
    "TargetServiceWorkerModule",
    "WorkletModule",
  ]) {
    const source = /Module|Worklet/u.test(sourceKind) ? "export const value=1" : "void 0";
    assert.equal(typeof compiler.compile(source, sourceKind).code, "string", sourceKind);
  }

});
