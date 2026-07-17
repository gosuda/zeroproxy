import { promises as fs } from "node:fs";
import path from "node:path";
import { build as esbuild } from "esbuild";
import webpack from "webpack";

import { canonicalJson, collectBuildIdentity } from "./gates/common.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const outputRoot = path.join(root, "test/frameworks");
const target = ["chrome150", "firefox152"];
const fixturePackageNames = [
  "@angular/compiler", "@angular/core", "@angular/platform-browser", "esbuild", "jquery", "react",
  "react-dom", "rxjs", "tslib", "vue", "webpack", "zone.js",
];
const packageManifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (process.versions.node !== packageManifest.engines.node)
  throw new Error(`framework fixtures require Node ${packageManifest.engines.node}, got ${process.versions.node}`);
const installedPackageVersions = await Promise.all(fixturePackageNames.map(async name => {
  const installed = JSON.parse(await fs.readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
  const pinned = packageManifest.devDependencies[name];
  if (installed.version !== pinned)
    throw new Error(`framework fixture package ${name} must resolve to ${pinned}, got ${installed.version}`);
  return [name, installed.version];
}));
const toolchain = {
  node: process.versions.node,
  packages: Object.fromEntries(installedPackageVersions),
};

async function reset(category) {
  const directory = path.join(outputRoot, category);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function write(directory, relativePath, contents) {
  const destination = path.join(directory, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
}

function page(title, body, script = "app.js", type = "module") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><h1>${title}</h1>${body}<script ${type ? `type="${type}" ` : ""}src="${script}"></script></body></html>\n`;
}

async function bundle(directory, source, options = {}) {
  await esbuild({
    stdin: { contents: source, resolveDir: root, sourcefile: `${path.basename(directory)}.mjs`, loader: "js" },
    outfile: path.join(directory, "app.js"),
    bundle: true,
    format: "esm",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    target,
    ...options,
  });
}

async function buildReact() {
  const directory = await reset("react");
  await write(directory, "index.html", page("React fixture", '<main id="root"></main>'));
  await bundle(directory, `import React, {useState} from "react"; import {createRoot} from "react-dom/client";
const burn=()=>{const end=performance.now()+20;while(performance.now()<end){}};
function App(){const [count,setCount]=useState(0); return React.createElement("button",{id:"increment",onClick:()=>{burn();setCount(value=>value+1)}},String(count));}
createRoot(document.querySelector("#root")).render(React.createElement(App));
globalThis.__fixtureAction=async()=>{const button=document.querySelector("#increment"); button.click(); await new Promise(resolve=>setTimeout(resolve)); return button.textContent==="1";};
globalThis.__fixtureReady=()=>document.querySelector("#increment")?.textContent==="0";`);
}

async function buildVue() {
  const directory = await reset("vue");
  await write(directory, "index.html", page("Vue fixture", '<main id="root"></main>'));
  await bundle(directory, `import {createApp,h,ref} from "vue";
const burn=()=>{const end=performance.now()+20;while(performance.now()<end){}};
const App={setup(){const count=ref(0); return()=>h("button",{id:"increment",onClick:()=>{burn();count.value++}},String(count.value));}};
createApp(App).mount("#root");
globalThis.__fixtureAction=async()=>{const button=document.querySelector("#increment"); button.click(); await Promise.resolve(); return button.textContent==="1";};
globalThis.__fixtureReady=()=>document.querySelector("#increment")?.textContent==="0";`);
}

async function buildAngular() {
  const directory = await reset("angular-zone");
  await write(directory, "index.html", page("Angular Zone fixture", "<fixture-app></fixture-app>"));
  await bundle(directory, `import "zone.js"; import "@angular/compiler"; import {Component} from "@angular/core"; import {bootstrapApplication} from "@angular/platform-browser";
const burn=()=>{const end=performance.now()+20;while(performance.now()<end){}}; class App { count=0; increment(){burn();this.count+=1;} }
Component({selector:"fixture-app",standalone:true,template:'<button id="increment" (click)="increment()">{{count}}</button>'})(App);
await bootstrapApplication(App); globalThis.__fixtureAction=async()=>{const button=document.querySelector("#increment"); button.click(); await new Promise(resolve=>setTimeout(resolve)); return button.textContent.trim()==="1";}; globalThis.__fixtureReady=()=>document.querySelector("#increment")?.textContent.trim()==="0";`);
}

async function buildEsm() {
  const directory = await reset("vite-next-esm");
  await write(directory, "index.html", page("Vite Next ESM fixture", '<button id="load">load</button><output id="result"></output>'));
  await write(directory, "chunk.mjs", "export const eager = 'eager';\n");
  await write(directory, "lazy.mjs", "export default 'lazy';\n");
  await write(directory, "app.js", `import {eager} from "./chunk.mjs"; const result=document.querySelector("#result"),button=document.querySelector("#load"); const load=async()=>{const end=performance.now()+20;while(performance.now()<end){} const lazy=await import("./lazy.mjs"); result.textContent=eager+":"+lazy.default+":"+new URL(import.meta.url).pathname.split("/").at(-1); return result.textContent==="eager:lazy:app.js";}; button.addEventListener("click",load);
globalThis.__fixtureAction=async()=>{button.click(); while(result.textContent==="")await new Promise(resolve=>setTimeout(resolve)); return result.textContent==="eager:lazy:app.js";};
globalThis.__fixtureReady=()=>button!==null;\n`);
}

function runWebpack(config) {
  return new Promise((resolve, reject) => webpack(config, (error, stats) => {
    if (error) { reject(error); return; }
    if (stats.hasErrors()) { reject(new Error(stats.toString({ all: false, errors: true }))); return; }
    resolve();
  }));
}

async function buildWebpack() {
  const directory = await reset("webpack");
  const sourceDirectory = path.join(outputRoot, ".webpack-source");
  await fs.rm(sourceDirectory, { recursive: true, force: true });
  await fs.mkdir(sourceDirectory, { recursive: true });
  await write(sourceDirectory, "index.js", `const button=document.querySelector("#load"),result=document.querySelector("#result"); const load=async()=>{const end=performance.now()+20;while(performance.now()<end){} const value=await import("./lazy.js"); result.textContent=value.default}; button.addEventListener("click",load); globalThis.__fixtureAction=async()=>{button.click();while(result.textContent==="")await new Promise(resolve=>setTimeout(resolve));return result.textContent==="webpack-lazy";}; globalThis.__fixtureReady=()=>button!==null;`);
  await write(sourceDirectory, "lazy.js", "export default 'webpack-lazy';\n");
  await runWebpack({ mode: "production", context: sourceDirectory, entry: "./index.js", devtool: false, output: { path: directory, filename: "app.js", chunkFilename: "chunk.[contenthash].js", clean: false }, optimization: { moduleIds: "deterministic", chunkIds: "deterministic" } });
  await write(directory, "index.html", page("Webpack fixture", '<button id="load">load</button><output id="result"></output>', "app.js", ""));
  await fs.rm(sourceDirectory, { recursive: true, force: true });
}

async function buildJQuery() {
  const directory = await reset("jquery");
  await write(directory, "index.html", page("jQuery fixture", '<button id="increment">0</button>', "jquery.min.js", "" ).replace("</body>", '<script src="app.js"></script></body>'));
  await fs.copyFile(path.join(root, "node_modules/jquery/dist/jquery.min.js"), path.join(directory, "jquery.min.js"));
  await write(directory, "app.js", `globalThis.__fixtureAction=async()=>{$("#increment").trigger("click"); return $("#increment").text()==="1";}; $("#increment").on("click",function(){const end=performance.now()+20;while(performance.now()<end){} this.textContent=String(Number(this.textContent)+1)}); globalThis.__fixtureReady=()=>$.fn.jquery==="3.7.1";\n`);
}

async function buildPwa() {
  const directory = await reset("pwa");
  await write(directory, "index.html", page("PWA fixture", '<output id="result"></output>'));
  await write(directory, "sw.js", `self.addEventListener("install",event=>event.waitUntil(caches.open("fixture-v1").then(cache=>cache.add("./index.html")))); self.addEventListener("activate",event=>event.waitUntil(self.clients.claim())); self.addEventListener("fetch",()=>{});\n`);
  await write(directory, "app.js", `const registration=await navigator.serviceWorker.register("./sw.js"); await navigator.serviceWorker.ready; globalThis.__fixtureAction=async()=>{const keys=await caches.keys(); document.querySelector("#result").textContent=registration.scope; return keys.includes("fixture-v1")&&registration.scope===new URL("./",location.href).href;}; globalThis.__fixtureReady=()=>registration.active!==null;\n`);
}

async function buildFrame() {
  const directory = await reset("frame");
  await write(directory, "index.html", page("Frame fixture", '<button id="send">send</button><iframe id="child" src="child.html"></iframe><output id="result"></output>'));
  await write(directory, "child.html", '<!doctype html><script>addEventListener("message",event=>event.source.postMessage({echo:event.data},"*"));</script>\n');
  await write(directory, "app.js", `const frame=document.querySelector("#child"),button=document.querySelector("#send"),result=document.querySelector("#result"); await new Promise(resolve=>frame.addEventListener("load",resolve,{once:true})); const send=()=>{const end=performance.now()+20;while(performance.now()<end){} frame.contentWindow.postMessage("frame-action","*")}; button.addEventListener("click",send); addEventListener("message",event=>{result.textContent=event.data.echo}); globalThis.__fixtureAction=async()=>{button.click();while(result.textContent==="")await new Promise(resolve=>setTimeout(resolve));return result.textContent==="frame-action"}; globalThis.__fixtureReady=()=>frame.contentDocument?.readyState==="complete";\n`);
}

async function buildMedia() {
  const directory = await reset("media");
  await write(directory, "image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>\n');
  await write(directory, "index.html", page("Media fixture", '<img id="image" src="image.svg" width="32" height="32"><button id="draw">draw</button><canvas id="canvas" width="32" height="32"></canvas>'));
  await write(directory, "app.js", `const image=document.querySelector("#image"),button=document.querySelector("#draw"),context=document.querySelector("#canvas").getContext("2d"); await image.decode(); const draw=()=>{const end=performance.now()+20;while(performance.now()<end){} context.drawImage(image,0,0)}; button.addEventListener("click",draw); globalThis.__fixtureAction=async()=>{button.click();return context.getImageData(1,1,1,1).data[1]>100;}; globalThis.__fixtureReady=()=>image.complete&&image.naturalWidth===32;\n`);
}

async function buildEditor() {
  const directory = await reset("editor");
  await write(directory, "index.html", page("Editor fixture", '<div id="editor" contenteditable="true">alpha</div>'));
  await write(directory, "app.js", `const editor=document.querySelector("#editor"); editor.addEventListener("beforeinput",()=>{const end=performance.now()+20;while(performance.now()<end){}}); globalThis.__fixtureAction=async()=>{editor.focus(); const selection=getSelection(); selection.selectAllChildren(editor); selection.collapseToEnd(); document.execCommand("insertText",false," beta"); return editor.textContent==="alpha beta";}; globalThis.__fixtureReady=()=>editor.isContentEditable;\n`);
}

async function buildUpload() {
  const directory = await reset("upload");
  await write(directory, "index.html", page("Upload fixture", '<input id="file" type="file"><output id="result"></output>'));
  await write(directory, "app.js", `const input=document.querySelector("#file"); input.addEventListener("change",()=>document.querySelector("#result").textContent=input.files[0]?.name??""); globalThis.__fixtureAction=async()=>{const transfer=new DataTransfer(); transfer.items.add(new File(["fixture"],"fixture.txt",{type:"text/plain"})); input.files=transfer.files; input.dispatchEvent(new Event("change",{bubbles:true})); return input.files.length===1&&document.querySelector("#result").textContent==="fixture.txt";}; globalThis.__fixtureReady=()=>input.type==="file";\n`);
}

async function buildDownload() {
  const directory = await reset("download");
  await write(directory, "index.html", page("Download fixture", '<a id="download" download="fixture.txt">download</a>'));
  await write(directory, "app.js", `const link=document.querySelector("#download"); const url=URL.createObjectURL(new Blob(["fixture"],{type:"text/plain"})); link.href=url; globalThis.__fixtureAction=async()=>{link.addEventListener("click",event=>event.preventDefault(),{once:true}); link.click(); return link.download==="fixture.txt"&&link.href.startsWith("blob:");}; globalThis.__fixtureReady=()=>link.href.startsWith("blob:"); addEventListener("pagehide",()=>URL.revokeObjectURL(url),{once:true});\n`);
}

async function buildArticle() {
  const directory = await reset("article");
  await write(directory, "index.html", page("Article fixture", '<main><article><h1>Deterministic article</h1><p id="summary">alpha</p><details id="details"><summary>More</summary><p>beta</p></details></article></main>'));
  await write(directory, "app.js", `const details=document.querySelector("#details"),summary=details.querySelector("summary"); summary.addEventListener("click",()=>{const end=performance.now()+20;while(performance.now()<end){}}); globalThis.__fixtureAction=async()=>{summary.click(); document.querySelector("#summary").textContent+=" beta"; return details.open&&document.querySelector("#summary").textContent==="alpha beta";}; globalThis.__fixtureReady=()=>document.querySelector("article")!==null;\n`);
}

async function buildStyledDocument() {
  const directory = await reset("styled-document");
  await write(directory, "style.css", `:root{color-scheme:light}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.grid>div{height:32px;background:#246}\n`);
  await write(directory, "index.html", page("Styled document fixture", '<link rel="stylesheet" href="style.css"><button id="add">add</button><main class="grid" id="grid"><div></div><div></div><div></div><div></div></main>'));
  await write(directory, "app.js", `const grid=document.querySelector("#grid"),button=document.querySelector("#add"); const add=()=>{const end=performance.now()+20;while(performance.now()<end){} grid.append(document.createElement("div"))}; button.addEventListener("click",add); globalThis.__fixtureAction=async()=>{button.click();return grid.children.length===5&&getComputedStyle(grid).display==="grid";}; globalThis.__fixtureReady=()=>getComputedStyle(grid).display==="grid";\n`);
}

async function buildGallery() {
  const directory = await reset("gallery");
  await write(directory, "image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="#4682b4"/></svg>\n');
  await write(directory, "index.html", page("Gallery fixture", '<button id="toggle">toggle</button><main id="gallery"><img src="image.svg" width="48" height="32"><img src="image.svg" width="48" height="32" loading="lazy"></main>'));
  await write(directory, "app.js", `const images=[...document.images],button=document.querySelector("#toggle"); await Promise.all(images.map(image=>image.decode())); const toggle=()=>{const end=performance.now()+20;while(performance.now()<end){} images[1].toggleAttribute("hidden")};button.addEventListener("click",toggle);globalThis.__fixtureAction=async()=>{button.click();return images.every(image=>image.complete)&&images[1].hidden;}; globalThis.__fixtureReady=()=>images.every(image=>image.complete&&image.naturalWidth===48);\n`);
}

async function buildCanvasApp() {
  const directory = await reset("canvas-app");
  await write(directory, "index.html", page("Canvas application fixture", '<button id="paint">paint</button><canvas id="canvas" width="64" height="64"></canvas><output id="result"></output>'));
  await write(directory, "app.js", `const canvas=document.querySelector("#canvas"),context=canvas.getContext("2d"),button=document.querySelector("#paint"),result=document.querySelector("#result"); context.fillStyle="#123456"; context.fillRect(0,0,64,64); const paint=()=>{const end=performance.now()+20;while(performance.now()<end){} context.fillStyle="#abcdef"; context.fillRect(16,16,32,32);result.textContent="painted"};button.addEventListener("click",paint); globalThis.__fixtureAction=async()=>{button.click();const pixel=context.getImageData(20,20,1,1).data; return pixel[0]===171&&pixel[1]===205&&pixel[2]===239;}; globalThis.__fixtureReady=()=>context.getImageData(1,1,1,1).data[2]===86;\n`);
}

async function buildInteractiveList() {
  const directory = await reset("interactive-list");
  await write(directory, "index.html", page("Interactive list fixture", '<form id="form"><input id="item"><button>Add</button></form><ul id="items"><li>alpha</li></ul>'));
  await write(directory, "app.js", `const form=document.querySelector("#form"),input=document.querySelector("#item"),items=document.querySelector("#items"); form.addEventListener("submit",event=>{event.preventDefault();const end=performance.now()+20;while(performance.now()<end){} const item=document.createElement("li"); item.textContent=input.value; items.append(item)}); globalThis.__fixtureAction=async()=>{input.value="beta"; form.requestSubmit(); return items.children.length===2&&items.lastElementChild.textContent==="beta";}; globalThis.__fixtureReady=()=>items.children.length===1;\n`);
}

async function buildToggleControl() {
  const directory = await reset("toggle-control");
  await write(directory, "index.html", page("Toggle control fixture", '<button id="toggle-control" aria-expanded="false">toggle</button><section id="panel" hidden>panel</section>'));
  await write(directory, "app.js", `const button=document.querySelector("#toggle-control"),panel=document.querySelector("#panel"); const toggle=()=>{const end=performance.now()+20;while(performance.now()<end){} panel.hidden=!panel.hidden;button.setAttribute("aria-expanded",String(!panel.hidden))};button.addEventListener("click",toggle);globalThis.__fixtureAction=async()=>{button.click();return !panel.hidden&&button.getAttribute("aria-expanded")==="true"};globalThis.__fixtureReady=()=>panel.hidden;\n`);
}

async function buildTabControl() {
  const directory = await reset("tab-control");
  await write(directory, "index.html", page("Tab control fixture", '<div role="tablist"><button id="tab-beta" role="tab" aria-selected="false">Beta</button></div><section id="tab-panel">alpha</section>'));
  await write(directory, "app.js", `const button=document.querySelector("#tab-beta"),panel=document.querySelector("#tab-panel"); const select=()=>{const end=performance.now()+20;while(performance.now()<end){} button.setAttribute("aria-selected","true");panel.textContent="beta"};button.addEventListener("click",select);globalThis.__fixtureAction=async()=>{button.click();return panel.textContent==="beta"&&button.getAttribute("aria-selected")==="true"};globalThis.__fixtureReady=()=>panel.textContent==="alpha";\n`);
}

const builders = [buildReact, buildVue, buildAngular, buildEsm, buildWebpack, buildJQuery, buildPwa, buildFrame, buildMedia, buildEditor, buildUpload, buildDownload, buildArticle, buildStyledDocument, buildGallery, buildCanvasApp, buildInteractiveList, buildToggleControl, buildTabControl];
await fs.mkdir(outputRoot, { recursive: true });
for (const buildFixture of builders) await buildFixture();

const categories = ["react", "vue", "angular-zone", "vite-next-esm", "webpack", "jquery", "pwa", "frame", "media", "editor", "upload", "download", "article", "styled-document", "gallery", "canvas-app", "interactive-list", "toggle-control", "tab-control"];
const performanceProtocols = {
  react: { interaction: { kind: "click", selector: "#increment" }, postcondition_expression: 'document.querySelector("#increment")?.textContent === "1"' },
  vue: { interaction: { kind: "click", selector: "#increment" }, postcondition_expression: 'document.querySelector("#increment")?.textContent === "1"' },
  "angular-zone": { interaction: { kind: "click", selector: "#increment" }, postcondition_expression: 'document.querySelector("#increment")?.textContent.trim() === "1"' },
  "vite-next-esm": { interaction: { kind: "click", selector: "#load" }, postcondition_expression: 'document.querySelector("#result")?.textContent === "eager:lazy:app.js"' },
  webpack: { interaction: { kind: "click", selector: "#load" }, postcondition_expression: 'document.querySelector("#result")?.textContent === "webpack-lazy"' },
  jquery: { interaction: { kind: "click", selector: "#increment" }, postcondition_expression: 'document.querySelector("#increment")?.textContent === "1"' },
  frame: { interaction: { kind: "click", selector: "#send" }, postcondition_expression: 'document.querySelector("#result")?.textContent === "frame-action"' },
  media: { interaction: { kind: "click", selector: "#draw" }, postcondition_expression: 'document.querySelector("#canvas")?.getContext("2d").getImageData(1,1,1,1).data[1] > 100' },
  editor: { interaction: { kind: "type", selector: "#editor", text: " beta", submit: false }, postcondition_expression: 'document.querySelector("#editor")?.textContent === "alpha beta"' },
  article: { interaction: { kind: "click", selector: "#details summary" }, postcondition_expression: 'document.querySelector("#details")?.open === true' },
  "styled-document": { interaction: { kind: "click", selector: "#add" }, postcondition_expression: 'document.querySelector("#grid")?.children.length === 5' },
  gallery: { interaction: { kind: "click", selector: "#toggle" }, postcondition_expression: "document.images[1]?.hidden === true" },
  "canvas-app": { interaction: { kind: "click", selector: "#paint" }, postcondition_expression: 'document.querySelector("#result")?.textContent === "painted"' },
  "interactive-list": { interaction: { kind: "type", selector: "#item", text: "beta", submit: true }, postcondition_expression: 'document.querySelector("#items")?.children.length === 2' },
  "toggle-control": { interaction: { kind: "click", selector: "#toggle-control" }, postcondition_expression: 'document.querySelector("#toggle-control")?.getAttribute("aria-expanded") === "true"' },
  "tab-control": { interaction: { kind: "click", selector: "#tab-beta" }, postcondition_expression: 'document.querySelector("#tab-panel")?.textContent === "beta"' },
};
const fixtures = [];
for (const category of categories) {
  const identity = await collectBuildIdentity(path.join(outputRoot, category));
  fixtures.push({ category, path: category, entry_path: "index.html", tree_sha256: identity.tree_sha256, action_expression: "await globalThis.__fixtureAction()", ready_expression: "typeof globalThis.__fixtureReady === 'function' && globalThis.__fixtureReady() === true", ...(performanceProtocols[category] ?? {}) });
}
await fs.writeFile(path.join(outputRoot, "manifest.json"), canonicalJson({ schema_version: 1, toolchain, fixtures }));
process.stdout.write(`built ${fixtures.length} immutable framework fixtures\n`);
