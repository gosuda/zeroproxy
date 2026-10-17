//! ZeroProxy Service Worker rewriter WASM bundle (cdylib).
//!
//! Exposes the eager document transformation path (`rewriteScript`,
//! `rewriteCSS`, `transformHtml`, `HtmlTxn`, source-map composition, and CSP
//! helpers). The transport stack lives in the sibling `zp-kernel-bundle` crate
//! and is loaded lazily on first `transportFetch`.
//!
//! Loaded by the Service Worker (`web/sw.js`) via
//! `importScripts('/__zp/zp_bundle_sw.js')` and `wbg({ module_or_path:
//! '/__zp/zp_bundle_sw_bg.wasm' })` inside `initBundle()`.
//!
//! The page realm uses `zp-page-bundle`, a smaller cdylib that omits HTML,
//! CSS, source-map, and CSP exports.

#![cfg(target_arch = "wasm32")]

pub use zp_css as css;

use std::cell::RefCell;

use wasm_bindgen::prelude::*;
use zp_engine::{DocCtx, TransformEngine};

thread_local! {
    /// Thread-local engine shared across WASM exports so warm-path rewrites
    /// reuse the OXC bump arena.
    static ENGINE: RefCell<TransformEngine> = RefCell::new(TransformEngine::new());
}

/// Runs `f` on the shared engine, mapping `EngineError` to `JsError`.
fn with_engine<R>(
    f: impl FnOnce(&mut TransformEngine) -> Result<R, zp_engine::EngineError>,
) -> Result<R, JsError> {
    ENGINE
        .with(|e| f(&mut e.borrow_mut()))
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(start)]
pub fn init() {
    // Install a panic hook so Rust panics log their file/line and message to
    // the Service Worker console and `self.__zpRustTrace` instead of trapping
    // as a bare `RuntimeError: unreachable`.
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "?".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let full = format!("ZP_BUNDLE_PANIC at {loc}: {msg}");
        web_sys::console::error_1(&JsValue::from_str(&full));
        push_trace(&full);
    }));
}

/// Append a diagnostic line to `self.__zpRustTrace` (a plain JS array owned by
/// the Service Worker). Best-effort: any failure is swallowed, since this runs
/// from a panic hook where unwinding further would lose the message entirely.
fn push_trace(line: &str) {
    let global = js_sys::global();
    let key = JsValue::from_str("__zpRustTrace");
    let arr = match js_sys::Reflect::get(&global, &key) {
        Ok(v) if v.is_object() => js_sys::Array::from(&v),
        _ => {
            let fresh = js_sys::Array::new();
            let _ = js_sys::Reflect::set(&global, &key, &fresh);
            fresh
        }
    };
    if arr.length() >= 512 {
        let _ = arr.shift();
    }
    arr.push(&JsValue::from_str(line));
    let _ = js_sys::Reflect::set(&global, &key, &arr);
}

/// Bundle version (mirrors `zp-shared`); used for version verification between
/// the Service Worker and prelude.
#[wasm_bindgen(js_name = bundleVersion)]
pub fn bundle_version() -> String {
    zp_engine::TransformEngine::new().version().to_string()
}

/// Rewrite a JS source. Strict mode. Returns code or throws.
#[wasm_bindgen(js_name = rewriteScript)]
pub fn rewrite_script_js(source: &str, kind: &str, target_url: &str, proxy_origin: &str) -> Result<String, JsError> {
    let ctx = DocCtx::new(target_url, proxy_origin);
    with_engine(|e| e.rewrite_script(source, kind, &ctx))
}

/// Patch-mode script rewrite. Returns a flat JSON patch list that the caller
/// deserialises once and applies over the original source buffer, avoiding full
/// codegen re-emission on mostly unchanged scripts.
///
/// Output schema:
///   `{"patches":[{"start":<u32>,"end":<u32>,"replacement":"<str>"}],"len":<u32>}`
///
/// `len` is the original source byte length so the JS caller can preallocate
/// the output buffer.
#[wasm_bindgen(js_name = rewriteScriptPatches)]
pub fn rewrite_script_patches_js(
    source: &str,
    kind: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let ctx = DocCtx::new(target_url, proxy_origin);
    with_engine(|e| e.rewrite_script_patches_json(source, kind, &ctx))
}

/// Source-map composer: returns a Source Map v3 JSON document mapping the
/// rewritten script back to the original source. Served by the Service Worker
/// at `/__zp/sourcemap?u=<targetUrl>&k=<kind>` so DevTools breakpoints on
/// rewritten (`__zp_*`-wrapped) code resolve to original identifiers.
#[wasm_bindgen(js_name = composeSourceMap)]
pub fn compose_source_map_js(
    source: &str,
    kind: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let ctx = DocCtx::new(target_url, proxy_origin);
    with_engine(|e| e.compose_source_map(source, kind, &ctx, target_url))
}

/// Composes the rewriter source map and chains it with the target site's
/// original `.map` so DevTools resolves rewritten code back to pre-bundler
/// sources in one hop. When `original_map_json` is empty or invalid, falls
/// back to the unchained map.
#[wasm_bindgen(js_name = composeSourceMapChained)]
pub fn compose_source_map_chained_js(
    source: &str,
    kind: &str,
    target_url: &str,
    original_map_json: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let ctx = DocCtx::new(target_url, proxy_origin);
    with_engine(|e| {
        e.compose_source_map_chained(source, kind, &ctx, target_url, original_map_json)
    })
}

/// Transform target HTML via `zp-htmltx` and `zp-rewriter` for inline scripts.
#[wasm_bindgen(js_name = transformHtml)]
pub fn transform_html_js(
    html: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let ctx = DocCtx::new(target_url, proxy_origin);
    with_engine(|e| e.transform_html(html, &ctx))
}

/// Streaming HTML transform for progressive document rendering. Construct once
/// per document, feed decoded HTML byte chunks via [`HtmlTxn::write`] as they
/// arrive from the kernel `ReadableStream`, and finish with [`HtmlTxn::end`].
/// `prelude_html` is injected right after `<head>` (pass `""` to skip).
/// Applies the same strict-mode rewrite rules as `transformHtml`; see
/// `zp_htmltx::HtmlTxn` for the chunk-invariance guarantee.
#[wasm_bindgen]
pub struct HtmlTxn {
    // `Option` so `end` can consume the inner txn (lol_html's `end` takes self
    // by value) while keeping the JS-side object alive; post-`end` calls throw.
    inner: Option<zp_htmltx::HtmlTxn>,
}

#[wasm_bindgen]
impl HtmlTxn {
    #[wasm_bindgen(constructor)]
    pub fn new(target_url: &str, proxy_origin: &str, prelude_html: &str) -> HtmlTxn {
        let ctx = DocCtx::new(target_url, proxy_origin);
        HtmlTxn {
            inner: Some(TransformEngine::new().html_txn(&ctx, prelude_html)),
        }
    }

    /// Feed a chunk of decoded HTML bytes; returns the rewritten bytes produced
    /// by it (may be empty while an element is buffered across the boundary).
    pub fn write(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| JsError::new("HtmlTxn: write after end"))?;
        inner.write(chunk).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Flush both passes and return the final tail bytes. Consumes the txn;
    /// any further `write`/`end` throws.
    pub fn end(&mut self) -> Result<Vec<u8>, JsError> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("HtmlTxn: end after end"))?;
        inner
            .end()
            .map(|(bytes, _diags)| bytes)
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

/// Rewrites CSS `url(...)` and `@import` references using `zp-css`, or throws a
/// `CSS_PARSE_FAILED` `JsError`. `base_url` is the stylesheet's absolute URL;
/// `control_prefix` is typically `/zp/`.
///
/// When `proxy_origin` (e.g. `http://proxy.localhost:18080`) is non-empty,
/// emitted `/zp/api/fetch?url=...` URLs are absolute so they do not resolve
/// against a virtualized target `<base>` inside proxied iframes.
#[wasm_bindgen(js_name = rewriteCSS)]
pub fn rewrite_css_js(
    source: &str,
    base_url: &str,
    control_prefix: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let ctx = DocCtx::new("", proxy_origin);
    with_engine(|e| e.rewrite_css(source, base_url, control_prefix, &ctx))
}

/// Build the strict CSP for a given proxy WebSocket origin.
#[wasm_bindgen(js_name = buildCSP)]
pub fn build_csp_js(ws_origin: &str) -> String {
    ENGINE.with(|e| e.borrow().build_csp(ws_origin))
}

/// Build the CSP for a given proxy WebSocket origin, with the armed
/// challenge-compatibility projection. `challenge_compat=false` is byte-equal
/// to [`build_csp_js`]; `true` adds `https://challenges.cloudflare.com` to
/// script/frame/child/connect-src (and nothing else) for Cloudflare Turnstile.
#[wasm_bindgen(js_name = buildCSPWith)]
pub fn build_csp_with_js(ws_origin: &str, challenge_compat: bool) -> String {
    ENGINE.with(|e| e.borrow().build_csp_with(ws_origin, challenge_compat))
}

/// Pure predicate: does the response classify as a Cloudflare challenge
/// document or subresource? Inputs are the pre-extracted Cf-Mitigated value,
/// the final-URL host, and the final-URL path. Mirrors
/// `zp_shared::is_challenge_document`; the SW calls this to decide whether to
/// arm `buildCSPWith` and skip its own `no-store` overwrite.
#[wasm_bindgen(js_name = isChallengeDocument)]
pub fn is_challenge_document_js(cf_mitigated: &str, host: &str, path: &str) -> bool {
    ENGINE.with(|e| e.borrow().is_challenge_document(cf_mitigated, host, path))
}
