//! ZeroProxy page-realm WASM bundle (cdylib).
//!
//! 2026-06-08 split-bundle (c.2): strict subset of `zp-bundle` containing
//! only the rewriter + sourcemap + CSP/share-URL/CSS helpers — no kernel,
//! no transport stack. Page realm doesn't make outbound fetches (the SW
//! does), so dropping rustls / h2 / mlkem / yamux / tokio / flate2 /
//! brotli / ruzstd / membrane / rtcgw / wtproxy shrinks the page wasm
//! by ~1.5-2.5 MB versus loading the SW bundle on the page.
//!
//! The SW continues to load the full `zp-bundle` via
//! `importScripts('/__zp/zp_bundle_sw.js')`.

#![cfg(target_arch = "wasm32")]

// 2026-06-09 E3 size win: CSS rewriter dropped from the page bundle —
// audit confirmed the page realm never calls `rewriteCSS` (only the SW
// realm does, via the full `zp-bundle`). See Cargo.toml for the
// rationale. The build.mjs binding script already null-guards
// `rewriteCSS`, so removing the export is a graceful no-op page-side.

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
        "module" => Ok(zp_rewriter::ScriptKind::Module),
        "event-handler" => Ok(zp_rewriter::ScriptKind::EventHandler),
        "eval" => Ok(zp_rewriter::ScriptKind::Eval),
        "function" => Ok(zp_rewriter::ScriptKind::Function),
        "worker" => Ok(zp_rewriter::ScriptKind::Worker),
        other => Err(JsError::new(&format!("unknown script kind: {other}"))),
    }
}

#[wasm_bindgen(js_name = rewriteScript)]
pub fn rewrite_script_js(source: &str, kind: &str, target_url: &str) -> Result<String, JsError> {
    let kind = parse_script_kind(kind)?;
    let opts = zp_rewriter::RewriteOpts { kind, target_url: target_url.to_string(), strict: true };
    zp_rewriter::rewrite_script(source, &opts)
        .map(|r| r.code)
        .map_err(|e| JsError::new(&e.to_string()))
}

