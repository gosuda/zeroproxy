//! ZeroProxy page-realm WASM bundle (cdylib).
//!
//! Exports `bundleVersion` and `rewriteScript` for dynamic `<script>` insertion
//! and eval hooks in the page realm. Outbound transport, HTML transformation,
//! and CSS rewriting run in the Service Worker (`zp-bundle` and
//! `zp-kernel-bundle`).

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use wasm_bindgen::prelude::*;
use zp_rewriter::{RewriteOpts, RewriterInstance, ScriptKind};

thread_local! {
    static REWRITER: RefCell<RewriterInstance> = RefCell::new(RewriterInstance::new());
}

#[wasm_bindgen(start)]
pub fn init() {}

#[wasm_bindgen(js_name = bundleVersion)]
pub fn bundle_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}

#[wasm_bindgen(js_name = rewriteScript)]
pub fn rewrite_script_js(
    source: &str,
    kind: &str,
    target_url: &str,
    proxy_origin: &str,
) -> Result<String, JsError> {
    let kind = kind
        .parse::<ScriptKind>()
        .map_err(|other| JsError::new(&format!("unknown script kind: {other}")))?;
    let opts = RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
        proxy_origin: proxy_origin.to_string(),
    };
    REWRITER.with(|r| {
        r.borrow_mut()
            .rewrite(source, &opts)
            .map(|res| res.code)
            .map_err(|e| JsError::new(&e.to_string()))
    })
}

