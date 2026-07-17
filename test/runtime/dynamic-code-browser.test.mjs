import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist/web");
const pinnedChromium = path.join(
  root,
  ".puppeteer-cache/chrome/mac_arm-150.0.7871.124/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const pinnedFirefox = path.join(
  root,
  ".puppeteer-cache/firefox/mac_arm-stable_152.0.6/Firefox.app/Contents/MacOS/firefox",
);
const chromium = process.env.ZP_CHROMIUM_PATH
  ?? process.env.CHROME_BIN
  ?? (existsSync(pinnedChromium) ? pinnedChromium : null);
const firefox = process.env.ZP_FIREFOX_PATH
  ?? (existsSync(pinnedFirefox) ? pinnedFirefox : null);
const abiName = "__zp_abi_222222222222222222222222222222222222222222222222";

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      if (pathname === "/document-module-probe.mjs") {
        const body = `const ${abiName}=globalThis[${JSON.stringify(abiName)}].moduleContext(import.meta,"https://target.example/app/document-module.mjs");const repeated=globalThis[${JSON.stringify(abiName)}].moduleContext(import.meta,"https://target.example/app/document-module.mjs");globalThis.__zpDocumentModuleProbe=Object.freeze({contextFrozen:Object.isFrozen(${abiName}),contextStable:repeated===${abiName},metaStable:repeated.importMeta===${abiName}.importMeta,nativeURL:import.meta.url,resolvedURL:${abiName}.importMeta.resolve("./dependency.mjs"),targetURL:${abiName}.importMeta.url});export default true;`;
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
        });
        response.end(body);
        return;
      }
      if (pathname === "/compiler-adapter.html") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end("<!doctype html><title>compiler adapter</title>");
        return;
      }
      const file = pathname === "/dynamic-code-oracle.html"
        ? path.join(root, "test/browser/dynamic-code-oracle.html")
        : path.resolve(dist, `.${pathname}`);
      if (
        file !== path.join(root, "test/browser/dynamic-code-oracle.html")
        && !file.startsWith(`${dist}${path.sep}`)
      ) throw new Error("invalid path");
      const body = await readFile(file);
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": contentType(file) });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

for (const lane of [
  { browser: "chrome", executablePath: chromium, family: "chromium", protocol: "cdp" },
  { browser: "firefox", executablePath: firefox, family: "firefox", protocol: "webDriverBiDi" },
]) {
test(`page Function families compile through shipped WASM in ${lane.family}`, {
  skip: lane.executablePath ? false : `pinned ${lane.family} unavailable`,
  timeout: 30_000,
}, async () => {
  const server = await startServer();
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await puppeteer.launch({
    browser: lane.browser,
    executablePath: lane.executablePath,
    headless: true,
    protocol: lane.protocol,
    args: lane.family === "chromium" ? ["--disable-gpu", "--no-sandbox"] : [],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${address.port}/dynamic-code-oracle.html`, {
      waitUntil: "load",
    });
    await page.waitForFunction(() => globalThis.__dynamicCodeOracle !== undefined && globalThis.__dynamicCodeSyntaxOracle === true, {
      timeout: 15_000,
    });
    const result = await page.evaluate(() => globalThis.__dynamicCodeOracle);
    assert.equal(result.ok, true, JSON.stringify(result.tests?.filter((entry) => !entry.ok)));
    const adapterPage = await browser.newPage();
    await adapterPage.goto(`http://127.0.0.1:${address.port}/compiler-adapter.html`);
    const adapterState = await adapterPage.evaluate(async (name) => {
      const { createCompiler } = await import("/runtime/compiler.mjs");
      const compiler = await createCompiler({ abiIdentifier: name });
      const dynamic = compiler.compileDynamicFunction(
        ["value"],
        "return value",
        "FunctionBody",
      );
      const dynamicAgain = compiler.compileDynamicFunction(
        ["value"],
        "return value",
        "FunctionBody",
      );
      const source = compiler.compile("window", "IndirectEvalScript");
      const sourceAgain = compiler.compile("window", "IndirectEvalScript");
      return {
        bodyStructured: dynamic.body?.ok === true,
        cacheHitIdentity: dynamic === dynamicAgain && source === sourceAgain,
        diagnosticsFrozen: Object.isFrozen(dynamic.diagnostics),
        ok: dynamic.ok,
        nestedResultFrozen: Object.isFrozen(dynamic.body)
          && Object.isFrozen(source.source_map)
          && Object.isFrozen(source.edits),
        parameterStructured: dynamic.parameters?.[0]?.ok === true,
        schemaVersion: dynamic.schema_version,
      };
    }, abiName);
    await adapterPage.close();
    assert.deepEqual(adapterState, {
      bodyStructured: true,
      cacheHitIdentity: true,
      diagnosticsFrozen: true,
      ok: true,
      nestedResultFrozen: true,
      parameterStructured: true,
      schemaVersion: 1,
    });
    const abiState = await page.evaluate((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      const requiredSurface = [
        "scope",
        "thisValue",
        "evalSource",
        "indirectEval",
        "dynamicFunction",
        "importOperand",
        "moduleMeta",
        "moduleContext",
        "sourceRegistry",
        "runtimeHealth",
      ];
      return {
        configurable: descriptor?.configurable,
        enumerable: descriptor?.enumerable,
        frozen: Object.isFrozen(descriptor?.value),
        matchingNames: Reflect.ownKeys(globalThis)
          .filter((key) => typeof key === "string" && /^__zp_abi_[a-f0-9]{48}$/u.test(key)),
        ready: descriptor?.value?.runtimeHealth() === true,
        surfaceComplete: requiredSurface.every((key) => Object.hasOwn(descriptor?.value, key)),
        writable: descriptor?.writable,
      };
    }, abiName);
    assert.deepEqual(abiState, {
      configurable: false,
      enumerable: false,
      frozen: true,
      matchingNames: [abiName],
      ready: true,
      surfaceComplete: true,
      writable: false,
    });
    const evalState = await page.evaluate((name) => {
      const abi = globalThis[name];
      const facade = abi.scope.window;
      const descriptors = [
        Object.getOwnPropertyDescriptor(globalThis, "eval"),
        Object.getOwnPropertyDescriptor(facade, "eval"),
        Object.getOwnPropertyDescriptor(abi.scope, "eval"),
      ];
      const intrinsicEval = descriptors[0].value;
      const attacker = () => { globalThis.__zpEvalAttackerCalled = true; };
      globalThis.__zpEvalAttackerCalled = false;
      const operations = {
        facadeDelete: Reflect.deleteProperty(facade, "eval"),
        facadeDefineCompatible: Reflect.defineProperty(facade, "eval", { value: abi.indirectEval }),
        facadeDefineIncompatible: Reflect.defineProperty(facade, "eval", { value: attacker }),
        facadeSet: Reflect.set(facade, "eval", attacker),
        rawDelete: Reflect.deleteProperty(globalThis, "eval"),
        rawDefineCompatible: Reflect.defineProperty(globalThis, "eval", { value: intrinsicEval }),
        rawDefineIncompatible: Reflect.defineProperty(globalThis, "eval", { value: attacker }),
        rawSet: Reflect.set(globalThis, "eval", attacker),
        scopeDelete: Reflect.deleteProperty(abi.scope, "eval"),
        scopeDefineCompatible: Reflect.defineProperty(abi.scope, "eval", { value: abi.indirectEval }),
        scopeDefineIncompatible: Reflect.defineProperty(abi.scope, "eval", { value: attacker }),
        scopeSet: Reflect.set(abi.scope, "eval", attacker),
      };
      const sloppyAssignment = Function(
        "scope",
        "value",
        "return (scope.eval=value)===value",
      )(abi.scope, attacker);
      let strictAssignment = null;
      try {
        Function("scope", "value", "'use strict';scope.eval=value")(abi.scope, attacker);
      } catch (error) {
        strictAssignment = error.constructor.name;
      }
      const sloppyUpdate = Function(
        "scope",
        "return Number.isNaN(scope.eval++)",
      )(abi.scope);
      let strictUpdate = null;
      try {
        Function("scope", "'use strict';scope.eval++")(abi.scope);
      } catch (error) {
        strictUpdate = error.constructor.name;
      }
      const temporalResult = Function(
        "abi",
        "value",
        "return eval(abi.evalSource((abi.scope.eval=value,'6*7'),{caller_strict:false}))",
      )(abi, attacker);
      const state = {
        attackerCalled: globalThis.__zpEvalAttackerCalled,
        attributes: descriptors.map((descriptor) => [
          descriptor.configurable,
          descriptor.enumerable,
          descriptor.writable,
        ]),
        facadeValue: descriptors[1].value === abi.indirectEval,
        health: abi.runtimeHealth(),
        operations,
        rawValue: descriptors[0].value === intrinsicEval,
        scopeValue: descriptors[2].value === abi.indirectEval,
        sloppyAssignment,
        sloppyUpdate,
        strictAssignment,
        strictUpdate,
        temporalResult,
      };
      delete globalThis.__zpEvalAttackerCalled;
      return state;
    }, abiName);
    assert.deepEqual(evalState, {
      attackerCalled: false,
      attributes: [
        [false, false, false],
        [false, false, false],
        [false, false, false],
      ],
      facadeValue: true,
      health: true,
      operations: {
        facadeDelete: false,
        facadeDefineCompatible: true,
        facadeDefineIncompatible: false,
        facadeSet: false,
        rawDelete: false,
        rawDefineCompatible: true,
        rawDefineIncompatible: false,
        rawSet: false,
        scopeDelete: false,
        scopeDefineCompatible: true,
        scopeDefineIncompatible: false,
        scopeSet: false,
      },
      rawValue: true,
      scopeValue: true,
      sloppyAssignment: true,
      sloppyUpdate: true,
      strictAssignment: "TypeError",
      strictUpdate: "TypeError",
      temporalResult: 42,
    });
    const dynamicState = await page.evaluate(async (name) => {
      const abi = globalThis[name];
      const scope = abi.scope;
      const targetURL = "https://target.example/app/index.html";
      const indirectEval = scope.eval;
      const nonString = Object.freeze({ sentinel: true });
      const indirectValues = [
        indirectEval("location.href"),
        (0, indirectEval)("location.href"),
        indirectEval?.("location.href"),
        indirectEval.call({ ignored: true }, "location.href"),
        indirectEval.apply(null, ["location.href"]),
        Reflect.apply(indirectEval, undefined, ["location.href"]),
        scope.window.eval("location.href"),
      ];
      const indirectThis = indirectEval("this");
      indirectEval("var __zp_indirect_global = 31");

      const familyFacades = {
        AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
        AsyncGeneratorFunction: Object.getPrototypeOf(async function* () {}).constructor,
        Function: scope.Function,
        GeneratorFunction: Object.getPrototypeOf(function* () {}).constructor,
      };
      const familyInputs = [
        ["Function", "return location.href"],
        ["AsyncFunction", "return location.href"],
        ["GeneratorFunction", "yield location.href"],
        ["AsyncGeneratorFunction", "yield location.href"],
      ];
      const familyResults = [];
      for (const [familyName, body] of familyInputs) {
        const facade = familyFacades[familyName];
        const called = Reflect.apply(facade, { ignored: true }, [body]);
        const constructed = Reflect.construct(facade, [body]);
        const bound = facade.bind({ ignored: true }, body)();
        function CustomNewTarget() {}
        const customPrototype = Object.create(null);
        CustomNewTarget.prototype = customPrototype;
        const custom = Reflect.construct(facade, [body], CustomNewTarget);
        let values;
        if (familyName === "Function") {
          values = [called(), constructed(), bound(), custom()];
        } else if (familyName === "AsyncFunction") {
          values = await Promise.all([called(), constructed(), bound(), custom()]);
        } else if (familyName === "GeneratorFunction") {
          values = [
            called().next().value,
            constructed().next().value,
            bound().next().value,
            custom().next().value,
          ];
        } else {
          values = [
            (await called().next()).value,
            (await constructed().next()).value,
            (await bound().next()).value,
            (await custom().next()).value,
          ];
        }
        familyResults.push({
          authoredSource: Function.prototype.toString.call(called).includes(body)
            && !Function.prototype.toString.call(called).includes("__zp_abi_"),
          backReference: facade.prototype.constructor === facade,
          calledInstance: called instanceof facade,
          boundInstance: bound instanceof facade,
          constructedInstance: constructed instanceof facade,
          customInstance: custom instanceof CustomNewTarget,
          customPrototype: Object.getPrototypeOf(custom) === customPrototype,
          constructorConstructor: facade.constructor === familyFacades.Function,
          length: facade.length,
          name: facade.name,
          reflectedNative: Function.prototype.toString.call(facade).includes("[native code]"),
          values,
        });
      }

      const functionDescriptor = Object.getOwnPropertyDescriptor(
        scope.window,
        "Function",
      );
      const dynamicPaths = {
        constructorConstructor: familyFacades.AsyncFunction.constructor(
          "return location.href",
        )() === targetURL,
        descriptor: functionDescriptor.value(
          "return location.href",
        )() === targetURL,
        global: indirectEval(
          "Function('return location.href')()",
        ) === targetURL,
        sloppyThis: scope.Function("return this")() === scope.window,
        strictThis: scope.Function("'use strict';return this")() === undefined,
      };
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const child = frame.contentWindow;
      const childEval = child.eval;
      const crossRealm = {
        childFunction: child.Function("return this")() === child,
        childReceiverIgnored: childEval.call(scope.window, "this") === child,
        childReflection: Function.prototype.toString.call(child.Function)
          .includes("[native code]"),
        parentReceiverIgnored: indirectEval.call(child, "this") === scope.window,
      };
      frame.remove();

      const closure = Object.freeze({ retained: true });
      let functionTimerValue = null;
      await new Promise((resolve) => {
        scope.setTimeout((value) => {
          functionTimerValue = value;
          resolve();
        }, 0, closure);
      });
      scope.window.__zp_string_timer_value = null;
      scope.setTimeout(
        "globalThis.__zp_string_timer_value = location.href",
        0,
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
      const stringTimerValue = scope.window.__zp_string_timer_value;
      const indirectGlobal = scope.window.__zp_indirect_global;
      delete scope.window.__zp_string_timer_value;
      delete scope.window.__zp_indirect_global;
      return {
        constructorBackReferences: [
          Object.getPrototypeOf(function () {}).constructor === familyFacades.Function,
          Object.getPrototypeOf(async function () {}).constructor
            === familyFacades.AsyncFunction,
          Object.getPrototypeOf(function* () {}).constructor
            === familyFacades.GeneratorFunction,
          Object.getPrototypeOf(async function* () {}).constructor
            === familyFacades.AsyncGeneratorFunction,
        ],
        crossRealm,
        dynamicPaths,
        evalIdentity: [
          scope.globalThis.eval === indirectEval,
          scope.self.eval === indirectEval,
          scope.window.eval === indirectEval,
        ],
        evalName: indirectEval.name,
        evalReflectedNative: Function.prototype.toString.call(indirectEval)
          .includes("[native code]"),
        familyResults,
        functionTimerRetained: functionTimerValue === closure,
        indirectGlobal,
        indirectNonString: indirectEval(nonString) === nonString,
        indirectThis: indirectThis === scope.window,
        indirectValues,
        stringTimerValue,
        targetURL,
      };
    }, abiName);
    assert.deepEqual(dynamicState.constructorBackReferences, [true, true, true, true]);
    assert.deepEqual(dynamicState.crossRealm, {
      childFunction: true,
      childReceiverIgnored: true,
      childReflection: true,
      parentReceiverIgnored: true,
    });
    assert.deepEqual(dynamicState.dynamicPaths, {
      constructorConstructor: true,
      descriptor: true,
      global: true,
      sloppyThis: true,
      strictThis: true,
    });
    assert.deepEqual(dynamicState.evalIdentity, [true, true, true]);
    assert.equal(dynamicState.evalName, "eval");
    assert.equal(dynamicState.evalReflectedNative, true);
    assert.equal(dynamicState.functionTimerRetained, true);
    assert.equal(dynamicState.indirectGlobal, 31);
    assert.equal(dynamicState.indirectNonString, true);
    assert.equal(dynamicState.indirectThis, true);
    assert.deepEqual(
      dynamicState.indirectValues,
      Array(7).fill(dynamicState.targetURL),
    );
    assert.equal(dynamicState.stringTimerValue, dynamicState.targetURL);
    assert.deepEqual(
      dynamicState.familyResults,
      ["Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]
        .map((name) => ({
          authoredSource: true,
          backReference: true,
          boundInstance: true,
          calledInstance: true,
          constructedInstance: true,
          customInstance: true,
          customPrototype: true,
          constructorConstructor: true,
          length: 1,
          name,
          reflectedNative: true,
          values: Array(4).fill(dynamicState.targetURL),
        })),
    );
    const moduleState = await page.evaluate(async () => {
      await import("/document-module-probe.mjs");
      return globalThis.__zpDocumentModuleProbe;
    });
    assert.equal(moduleState.contextFrozen, true);
    assert.equal(moduleState.contextStable, true);
    assert.equal(moduleState.metaStable, true);
    assert.equal(moduleState.targetURL, "https://target.example/app/document-module.mjs");
    assert.match(moduleState.nativeURL, /\/document-module-probe\.mjs$/u);
    assert.equal(moduleState.resolvedURL, "https://target.example/app/dependency.mjs");
    const version = JSON.parse(
      await readFile(path.join(dist, "_zp/version.json"), "utf8"),
    );
    const policyPage = await browser.newPage();
    try {
      await policyPage.goto(`http://127.0.0.1:${address.port}/empty`, {
        waitUntil: "load",
      });
      const policyRuntimeURL = new URL(
        version.selectors["runtime-prelude.js"],
        `http://127.0.0.1:${address.port}`,
      );
      policyRuntimeURL.hash = `abi=${abiName}&url=${encodeURIComponent("https://target.example/policy.html")}&ports=80%2C443&strings=0`;
      await policyPage.addScriptTag({ url: policyRuntimeURL.href });
      const policyState = await policyPage.evaluate(async (name) => {
        const scope = globalThis[name].scope;
        const constructors = [
          scope.Function,
          Object.getPrototypeOf(async function () {}).constructor,
          Object.getPrototypeOf(function* () {}).constructor,
          Object.getPrototypeOf(async function* () {}).constructor,
        ];
        const denialNames = constructors.map((constructor) => {
          try {
            constructor("return 1");
            return null;
          } catch (error) {
            return error.name;
          }
        });
        let conversions = 0;
        const converted = {
          toString() {
            conversions += 1;
            return "return 1";
          },
        };
        let convertedError;
        try {
          scope.Function(converted);
        } catch (error) {
          convertedError = error.name;
        }
        let malformedError;
        try {
          scope.Function("value", "value", "'use strict';return value");
        } catch (error) {
          malformedError = error.name;
        }
        let symbolError;
        try {
          scope.Function(Symbol("body"));
        } catch (error) {
          symbolError = error.name;
        }
        let evalError;
        try {
          scope.eval("location.href");
        } catch (error) {
          evalError = error.name;
        }
        let timerConversions = 0;
        let timerError;
        try {
          scope.setTimeout({
            toString() {
              timerConversions += 1;
              return "location.href";
            },
          }, 0);
        } catch (error) {
          timerError = error.name;
        }
        const closure = Object.freeze({ retained: true });
        const functionTimerRetained = await new Promise((resolve) => {
          scope.setTimeout((value) => resolve(value === closure), 0, closure);
        });
        const nonString = Object.freeze({ sentinel: true });
        return {
          convertedError,
          conversions,
          denialNames,
          evalError,
          functionTimerRetained,
          malformedError,
          nonStringEval: scope.eval(nonString) === nonString,
          symbolError,
          timerConversions,
          timerError,
        };
      }, abiName);
      assert.deepEqual(policyState, {
        convertedError: "EvalError",
        conversions: 1,
        denialNames: ["EvalError", "EvalError", "EvalError", "EvalError"],
        evalError: "EvalError",
        functionTimerRetained: true,
        malformedError: "EvalError",
        nonStringEval: true,
        symbolError: "TypeError",
        timerConversions: 1,
        timerError: "EvalError",
      });
    } finally {
      await policyPage.close();
    }
    const blockedPage = await browser.newPage();
    try {
      await blockedPage.goto(`http://127.0.0.1:${address.port}/empty`, {
        waitUntil: "load",
      });
      await blockedPage.evaluate(() => {
        globalThis.__zpEvalGetterCalls = 0;
        Object.defineProperty(globalThis, "eval", {
          configurable: true,
          enumerable: false,
          get() {
            globalThis.__zpEvalGetterCalls += 1;
            return () => undefined;
          },
        });
      });
      const runtimeURL = new URL(
        version.selectors["runtime-prelude.js"],
        `http://127.0.0.1:${address.port}`,
      );
      runtimeURL.hash = `abi=${abiName}&url=${encodeURIComponent("https://target.example/accessor.html")}&ports=80%2C443`;
      await blockedPage.addScriptTag({ url: runtimeURL.href }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(await blockedPage.evaluate((name) => ({
        abiInstalled: Object.hasOwn(globalThis, name),
        blocked: document.body?.textContent.includes(
          "privacy runtime could not be installed",
        ) === true,
        getterCalls: globalThis.__zpEvalGetterCalls,
      }), abiName), {
        abiInstalled: false,
        blocked: true,
        getterCalls: 0,
      });
    } finally {
      await blockedPage.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
}
