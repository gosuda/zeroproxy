import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { ERROR_VERSION } from "../web/generated/errors.mjs";
import { DISABLED_CAPABILITY_METHODS } from "../web/generated/emerging-network-capabilities.mjs";
import { DISABLED_NETWORK_GLOBALS } from "../web/generated/owned-globals.mjs";
import { runtimeClassicSource } from "../web/runtime/index.mjs";

const root = new URL("../", import.meta.url);
const source = new URL("../web/", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const webOutput = new URL("./web/", output);
const wasmBuild = new URL("./wasm/", output);
const GO_TOOLCHAIN = "go1.26.3";
if (process.version !== "v24.4.1") throw new Error(`build requires Node v24.4.1, received ${process.version}`);
const wasmBindgenVersion = execFileSync("wasm-bindgen", ["--version"], { cwd: root, encoding: "utf8" }).trim();
if (wasmBindgenVersion !== "wasm-bindgen 0.2.122") throw new Error(`build requires wasm-bindgen 0.2.122, received ${wasmBindgenVersion}`);

function run(command, args, env={}) {
  execFileSync(command, args, {cwd:root, stdio:"inherit", env:{...process.env,...env}});
}
async function files(directory) {
  const entries = await readdir(directory, {withFileTypes:true});
  const result = [];
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function immutableAsset(path, logicalName, selectors) {
  const bytes=await readFile(path),hash=createHash("sha256").update(bytes).digest("hex"),directory=new URL(`./_zp/assets/${hash}/`,webOutput);
  await mkdir(directory,{recursive:true});
  await writeFile(new URL(logicalName,directory),bytes);
  selectors[logicalName]=`/_zp/assets/${hash}/${logicalName}`;
}
async function immutableModuleGraph(paths, logicalName, entryRelative, selectors) {
  const graph=[];
  for(const path of [...paths].sort()){
    const name=relative(source.pathname,path).replaceAll("\\","/");
    if(name.startsWith("../")||name==="")throw new Error(`module graph path escapes web root: ${path}`);
    graph.push({name,bytes:await readFile(path)});
  }
  const digest=createHash("sha256");
  for(const entry of graph)digest.update(entry.name).update("\0").update(entry.bytes).update("\0");
  const hash=digest.digest("hex"),directory=new URL(`./_zp/assets/${hash}/`,webOutput);
  for(const entry of graph){
    const destination=new URL(entry.name,directory);
    await mkdir(new URL("./",destination),{recursive:true});
    await writeFile(destination,entry.bytes);
  }
  selectors[logicalName]=`/_zp/assets/${hash}/${entryRelative}`;
}

run(process.execPath, ["scripts/verify-toolchains.mjs"]);
run(process.execPath, ["scripts/generate-address-policy.mjs", "--check"]);
run(process.execPath, ["scripts/generate-errors.mjs", "--check"]);
run(process.execPath, ["scripts/generate-native-failure-shapes.mjs", "--check"]);
run(process.execPath, ["scripts/generate-stealth-profile.mjs", "--check"]);
run(process.execPath, ["scripts/generate-policy-bindings.mjs", "--check"]);
run(process.execPath, ["scripts/generate-policy-inventory.mjs", "--check"]);
run(process.execPath, ["scripts/generate-emerging-network-capabilities.mjs", "--check"]);
run(process.execPath, ["scripts/generate-owned-globals.mjs", "--check"]);
await rm(output, {recursive:true, force:true});
await mkdir(wasmBuild, {recursive:true});
await cp(source, webOutput, {recursive:true, force:false, errorOnExist:true});
run("cargo",["build","--workspace","--release","--target","wasm32-unknown-unknown","--locked"],{RUSTFLAGS:'--cfg getrandom_backend="wasm_js"'});
run("go",["build","-trimpath","-ldflags=-buildid=","-o",new URL("./kernel.wasm",wasmBuild).pathname,"./cmd/wasm-kernel"],{GOOS:"js",GOARCH:"wasm",CGO_ENABLED:"0",GOTOOLCHAIN:GO_TOOLCHAIN});
run("go",["build","-trimpath","-ldflags=-buildid=","-o",new URL("./zeroproxy-server",output).pathname,"./cmd/zeroproxy-server"],{CGO_ENABLED:"0",GOTOOLCHAIN:GO_TOOLCHAIN});
const goRoot=execFileSync("go",["env","GOROOT"],{cwd:root,encoding:"utf8",env:{...process.env,GOTOOLCHAIN:GO_TOOLCHAIN}}).trim();
let wasmExec=join(goRoot,"lib","wasm","wasm_exec.js");
try{await readFile(wasmExec)}catch{wasmExec=join(goRoot,"misc","wasm","wasm_exec.js")}
const selectors={};
await immutableAsset(new URL("./kernel.wasm",wasmBuild),"kernel.wasm",selectors);
await immutableAsset(wasmExec,"wasm_exec.js",selectors);
await immutableAsset(new URL("./native-failure-page.mjs",source),"native-failure-page.mjs",selectors);
for (const crate of ["policy_core","cookie_core","html_rewriter","js_compiler","css_rewriter","import_map","share_crypto"]) {
  const bindings=new URL(`./bindings/${crate}/`,output),raw=new URL(`./target/wasm32-unknown-unknown/release/${crate}.wasm`,root);
  await mkdir(bindings,{recursive:true});
  run("wasm-bindgen",[raw.pathname,"--target","web","--out-dir",bindings.pathname,"--out-name",crate]);
  await immutableAsset(new URL(`./${crate}_bg.wasm`,bindings),`${crate}.wasm`,selectors);
  await immutableAsset(new URL(`./${crate}.js`,bindings),`${crate}.js`,selectors);
}
const classicBindings=new URL("./bindings/js_compiler_classic/",output),classicRaw=new URL("./target/wasm32-unknown-unknown/release/js_compiler.wasm",root);
await mkdir(classicBindings,{recursive:true});
run("wasm-bindgen",[classicRaw.pathname,"--target","no-modules","--out-dir",classicBindings.pathname,"--out-name","js_compiler_classic"]);
await immutableAsset(new URL("./js_compiler_classic_bg.wasm",classicBindings),"js_compiler_classic.wasm",selectors);
const historyClassicBindings=new URL("./bindings/share_crypto_classic/",output),historyClassicRaw=new URL("./target/wasm32-unknown-unknown/release/share_crypto.wasm",root);
await mkdir(historyClassicBindings,{recursive:true});
run("wasm-bindgen",[historyClassicRaw.pathname,"--target","no-modules","--out-dir",historyClassicBindings.pathname,"--out-name","share_crypto_classic"]);
await immutableAsset(new URL("./share_crypto_classic_bg.wasm",historyClassicBindings),"share_crypto_classic.wasm",selectors);
const workerModules=[...await files(new URL("./worker/",source).pathname),new URL("./compiler-cache.mjs",source).pathname,new URL("./compiler-result.mjs",source).pathname,new URL("./generated/emerging-network-capabilities.mjs",source).pathname,new URL("./generated/owned-globals.mjs",source).pathname,new URL("./runtime/compiler.mjs",source).pathname];
await immutableModuleGraph(workerModules,"worker-bootstrap.mjs","worker/worker-bootstrap.mjs",selectors);
selectors["worker-bootstrap-classic.js"]=selectors["worker-bootstrap.mjs"].replace(/worker-bootstrap\.mjs$/u,"worker-bootstrap-classic.js");
const glue=await readFile(new URL("./js_compiler_classic.js",classicBindings),"utf8");
const historyGlue=(await readFile(new URL("./share_crypto_classic.js",historyClassicBindings),"utf8")).replaceAll("wasm_bindgen","history_crypto");
const routeClassic=await readFile(new URL("./generated/route-spec-classic.js",source),"utf8");
const prelude=runtimeClassicSource()
  .replaceAll("__ZP_COMPILER_WASM_URL__",selectors["js_compiler_classic.wasm"])
  .replaceAll("__ZP_HISTORY_CRYPTO_WASM_URL__",selectors["share_crypto_classic.wasm"])
  .replaceAll("__ZP_WORKER_BOOTSTRAP_MODULE_URL__",selectors["worker-bootstrap.mjs"])
  .replaceAll("__ZP_WORKER_BOOTSTRAP_CLASSIC_URL__",selectors["worker-bootstrap-classic.js"])
  .replaceAll("__ZP_DISABLED_NETWORK_GLOBALS__",JSON.stringify(DISABLED_NETWORK_GLOBALS))
  .replaceAll("__ZP_DISABLED_CAPABILITY_METHODS__",JSON.stringify(DISABLED_CAPABILITY_METHODS));
const runtimeBundle=new URL("./runtime-prelude.js",classicBindings);await writeFile(runtimeBundle,`(()=>{\n${glue}\n${historyGlue}\n${routeClassic}\n${prelude}\n})();\n`);
await immutableAsset(runtimeBundle,"runtime-prelude.js",selectors);
const serviceWorkerModules=[...(await files(new URL("./sw/",source).pathname)).filter(path=>path.endsWith(".mjs")),...workerModules,new URL("./diagnostics.mjs",source).pathname,new URL("./generated/errors.mjs",source).pathname,new URL("./generated/policy.mjs",source).pathname,new URL("./generated/policy-inventory.mjs",source).pathname,new URL("./generated/route-spec.mjs",source).pathname];
await immutableModuleGraph(serviceWorkerModules,"service-worker.mjs","sw/sw.mjs",selectors);
const serviceWorkerRustNames=["policy_core","html_rewriter","js_compiler","css_rewriter","share_crypto"];
const serviceWorkerRustImports=serviceWorkerRustNames.map((name,index)=>`import * as rust${index} from ${JSON.stringify(selectors[`${name}.js`])};`).join("\n");
const serviceWorkerRustRecords=serviceWorkerRustNames.map((name,index)=>`${JSON.stringify(name)}:Object.freeze({module:rust${index},module_url:${JSON.stringify(selectors[`${name}.js`])},wasm_url:${JSON.stringify(selectors[`${name}.wasm`])}})`).join(",");
const serviceWorkerKernelImport=`import ${JSON.stringify(selectors["wasm_exec.js"])};`;
const targetWorkerModules=(await files(new URL("./sw/target-worker/",source).pathname)).filter(path=>basename(path)!=="host-classic.js");
await immutableModuleGraph(targetWorkerModules,"target-worker-host.mjs","sw/target-worker/host-entry.mjs",selectors);
const targetWorkerClassicHost=new URL("./target-worker-host-classic.js",classicBindings);
await writeFile(targetWorkerClassicHost,(await readFile(new URL("./sw/target-worker/host-classic.js",source),"utf8")).replaceAll("__ZP_TARGET_WORKER_HOST_MODULE_URL__",selectors["target-worker-host.mjs"]));
await immutableAsset(targetWorkerClassicHost,"target-worker-host-classic.js",selectors);
const browserSupportHash=createHash("sha256")
  .update(await readFile(new URL("./protocol/support-matrix.json",root)))
  .update(Uint8Array.of(0))
  .update(await readFile(new URL("./protocol/browser-boundaries.json",root)))
  .digest("hex");
const tupleArtifactPaths=[
  new URL("./zeroproxy-server",output).pathname,
  new URL("./bootstrap.mjs",source).pathname,
  new URL("./diagnostics.mjs",source).pathname,
  new URL("./generated/policy.mjs",source).pathname,
  new URL("./generated/errors.mjs",source).pathname,
  new URL("./generated/native-failure-shapes.mjs",source).pathname,
  new URL("./generated/stealth-profile.mjs",source).pathname,
  new URL("./protocol/messages.schema.json",root).pathname,
  new URL("./protocol/errors.schema.json",root).pathname,
  new URL("./protocol/errors.sources.json",root).pathname,
  new URL("./protocol/diagnostics.schema.json",root).pathname,
  new URL("./protocol/compatibility-deltas.json",root).pathname,
  new URL("./protocol/compatibility-deltas.schema.json",root).pathname,
  new URL("./protocol/compatibility-deltas.sig",root).pathname,
  new URL("./protocol/release-signing-keys.json",root).pathname,
  new URL("./protocol/native-failure-shapes.json",root).pathname,
  new URL("./protocol/native-failure-shapes.schema.json",root).pathname,
  new URL("./protocol/stealth-profile.json",root).pathname,
  new URL("./protocol/stealth-profile.schema.json",root).pathname,
  new URL("./test/browser/stealth-release-host.mjs",root).pathname,
  new URL("./test/browser/stealth-release-oracle.html",root).pathname,
  new URL("./test/browser/stealth-release-probes.mjs",root).pathname,
  new URL("./test/browser/stealth-release-worker.mjs",root).pathname,
  ...await files(new URL("./control/",source).pathname),
].sort();
const tupleArtifactHash=createHash("sha256").update(JSON.stringify(selectors));
for(const path of tupleArtifactPaths){
  tupleArtifactHash.update(Uint8Array.of(0)).update(relative(root.pathname,path)).update(Uint8Array.of(0)).update(await readFile(path));
}
const compatibilityTuple={
  schema_version:1,
  compatibility_epoch:2,
  server_version:"2.0.0",
  control_version:"2.0.0",
  service_worker_version:"2.0.0",
  go_kernel_version:"2.0.0",
  rust_core_version:"2.0.0",
  runtime_version:"2.0.0",
  policy_version:2,
  message_version:2,
  error_version:ERROR_VERSION,
  browser_support_sha256:browserSupportHash,
  selectors_sha256:createHash("sha256").update(JSON.stringify(selectors)).digest("hex"),
  artifact_set_sha256:tupleArtifactHash.digest("hex"),
};
const compatibilityHash=createHash("sha256").update(JSON.stringify(compatibilityTuple)).digest("hex");
await writeFile(new URL("./_zp/sw.js",webOutput),`${serviceWorkerRustImports}\n${serviceWorkerKernelImport}\nimport ${JSON.stringify(selectors["service-worker.mjs"])};\nglobalThis.__zeroproxyStaticRustModules=Object.freeze({${serviceWorkerRustRecords}});\nglobalThis.__zeroproxyStaticKernel=Object.freeze({wasm_exec_url:${JSON.stringify(selectors["wasm_exec.js"])},kernel_wasm_url:${JSON.stringify(selectors["kernel.wasm"])}});\nglobalThis.__zeroproxyCompatibility=Object.freeze({tuple:Object.freeze(${JSON.stringify(compatibilityTuple)}),hash:${JSON.stringify(compatibilityHash)}});\n`);
await writeFile(new URL("./_zp/version.json",webOutput),JSON.stringify({version:2,release_id:"2.0.0-dev",compatibility_hash:compatibilityHash,compatibility_tuple:compatibilityTuple,selectors},null,2)+"\n");

const outputPath = webOutput.pathname,manifest={version:2,generated_by:"scripts/build.mjs",assets:{}};
for (const path of await files(outputPath)) {
  const bytes=await readFile(path),name=relative(outputPath,path).replaceAll("\\","/");
  manifest.assets[name]={sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
}
await writeFile(new URL("./asset-manifest.json",output),JSON.stringify(manifest,null,2)+"\n");
const stale=(await files(output.pathname)).filter(path=>basename(path).startsWith("zz_"));
if(stale.length)throw new Error(`transient assets present: ${stale.join(", ")}`);
console.log(`built ${Object.keys(manifest.assets).length} web assets and ${Object.keys(selectors).length} WASM assets`);
