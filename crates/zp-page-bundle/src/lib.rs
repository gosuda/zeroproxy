//! ZeroProxy page-realm WASM bundle (cdylib).
//!
//! Exports `bundleVersion` and `rewriteScript` for dynamic `<script>` insertion
//! and eval hooks in the page realm. Outbound transport, HTML transformation,
//! and CSS rewriting run in the Service Worker (`zp-bundle` and
//! `zp-kernel-bundle`).

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {}

#[wasm_bindgen(js_name = bundleVersion)]
pub fn bundle_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}

fn parse_script_kind(kind: &str) -> Result<zp_rewriter::ScriptKind, JsError> {
    match kind {
        "classic" => Ok(zp_rewriter::ScriptKind::Classic),
        "classic-local" => Ok(zp_rewriter::ScriptKind::ClassicLocal),
        "module" => Ok(zp_rewriter::ScriptKind::Module),
        "event-handler" => Ok(zp_rewriter::ScriptKind::EventHandler),
        "eval" => Ok(zp_rewriter::ScriptKind::Eval),
        "function" => Ok(zp_rewriter::ScriptKind::Function),
        "worker" => Ok(zp_rewriter::ScriptKind::Worker),
        other => Err(JsError::new(&format!("unknown script kind: {other}"))),
    }
}

#[wasm_bindgen(js_name = rewriteScript)]
pub fn rewrite_script_js(
    source: &str,
    kind: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let kind = parse_script_kind(kind)?;
    let opts = zp_rewriter::RewriteOpts { kind, target_url: target_url.to_string(), strict: true, proxy_origin: proxy_origin.to_string() };
    zp_rewriter::rewrite_script(source, &opts)
        .map(|r| r.code)
        .map_err(|e| JsError::new(&e.to_string()))
}

