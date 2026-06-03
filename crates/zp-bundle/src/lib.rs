//! ZeroProxy single WASM bundle (cdylib).
//!
//! Loaded by both Service Worker (`web/sw.js`) and page prelude
//! (`web/runtime-prelude.js`). Exposes rewriter + membrane + transport kernel
//! through one wasm-bindgen surface so JS shims stay thin.

#![cfg(target_arch = "wasm32")]

// Browser-side modules absorbed from the former zp-kernel / zp-membrane /
// zp-wtproxy-client / zp-rtcgw-client crates. They all link into the same
// cdylib anyway; keeping them as sub-modules removes 4× Cargo.toml + linker
// boundaries and lets helpers share state without going through pub APIs.
// `zp-shared` stays a separate crate (Go parity boundary), and the legacy
// `zp-page-rt` raw-C cdylib stays separate (dead-strip avoidance with
// wasm-bindgen — see trap-notebook 2026-05-30 wasm-page-rt entry).
pub mod kernel;
pub mod membrane;
pub mod rtcgw_client;
pub mod wtproxy_client;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    // Future: install console hooks, panic-hook for diagnostics
}

/// Bundle version (mirrors zp-shared); used by SW↔prelude version verification (B3.d).
#[wasm_bindgen(js_name = bundleVersion)]
pub fn bundle_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}

/// Rewrite a JS source. Strict mode. Returns code or throws.
#[wasm_bindgen(js_name = rewriteScript)]
pub fn rewrite_script_js(source: &str, kind: &str, target_url: &str) -> Result<String, JsError> {
    let kind = match kind {
        "classic" => zp_rewriter::ScriptKind::Classic,
        "module" => zp_rewriter::ScriptKind::Module,
        "event-handler" => zp_rewriter::ScriptKind::EventHandler,
        "eval" => zp_rewriter::ScriptKind::Eval,
        "function" => zp_rewriter::ScriptKind::Function,
        "worker" => zp_rewriter::ScriptKind::Worker,
        other => return Err(JsError::new(&format!("unknown script kind: {other}"))),
    };
    let opts = zp_rewriter::RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
    };
    zp_rewriter::rewrite_script(source, &opts)
        .map(|r| r.code)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Transform target HTML — calls zp-htmltx + zp-rewriter for inline scripts.
#[wasm_bindgen(js_name = transformHtml)]
pub fn transform_html_js(
    html: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let opts = zp_htmltx::TransformOptions {
        target_url: target_url.to_string(),
        strict: true,
        pending_gate: true,
        proxy_origin: proxy_origin.to_string(),
    };
    zp_htmltx::transform(html, &opts)
        .map(|r| r.html)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Build the strict CSP for a given proxy WebSocket origin.
#[wasm_bindgen(js_name = buildCSP)]
pub fn build_csp_js(ws_origin: &str) -> String {
    zp_shared::build_csp(ws_origin)
}

/// Build the CSP for a given proxy WebSocket origin, with the armed
/// challenge-compatibility projection. `challenge_compat=false` is byte-equal
/// to [`build_csp_js`]; `true` adds `https://challenges.cloudflare.com` to
/// script/frame/child/connect-src (and nothing else) for Cloudflare Turnstile.
#[wasm_bindgen(js_name = buildCSPWith)]
pub fn build_csp_with_js(ws_origin: &str, challenge_compat: bool) -> String {
    zp_shared::build_csp_with(ws_origin, &zp_shared::CspOptions { challenge_compat })
}

/// Pure predicate: does the response classify as a Cloudflare challenge
/// document or subresource? Inputs are the pre-extracted Cf-Mitigated value,
/// the final-URL host, and the final-URL path. Mirrors
/// `zp_shared::is_challenge_document`; the SW calls this to decide whether to
/// arm `buildCSPWith` and skip its own `no-store` overwrite.
#[wasm_bindgen(js_name = isChallengeDocument)]
pub fn is_challenge_document_js(cf_mitigated: &str, host: &str, path: &str) -> bool {
    zp_shared::is_challenge_document(cf_mitigated, host, path)
}

// Kernel's #[wasm_bindgen] exports live in the `kernel` module of this same
// cdylib now (previously a separate rlib that needed force-linking). Same-
// crate wasm-bindgen exports are emitted by the proc macro and reachable from
// the JS glue without the dead-strip workaround the old rlib structure
// required. Left in source as a reminder for anyone re-splitting later.
