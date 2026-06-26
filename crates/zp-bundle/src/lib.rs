//! ZeroProxy SW rewriter WASM bundle (cdylib).
//!
//! 2026-06-08 split-bundle (c.3): the rewriter half of the former
//! monolithic `zp-bundle`. The kernel / transport stack (rustls + h2 +
//! yamux + mlkem + tokio + flate2 / brotli / ruzstd + membrane / rtcgw /
//! wtproxy) moved to the sibling `zp-kernel-bundle` crate so its wasm
//! can be fetched + instantiated lazily — only on the first
//! `transportFetch` — instead of blocking SW `activate`. This crate
//! covers the eager path: every script / CSS / HTML response runs
//! through `rewriteScript`, `rewriteCSS`, or `transformHtml`, so its
//! wasm must be ready before the SW serves the first byte.
//!
//! Loaded by the Service Worker (`web/sw.js`) via
//! `importScripts('/__zp/zp_bundle_sw.js')` + `wbg({ module_or_path:
//! '/__zp/zp_bundle_sw_bg.wasm' })` inside `initBundle()`.
//!
//! Page-realm continues to use `zp-page-bundle` — an even leaner cdylib
//! that drops `transformHtml` / sourcemap / CSP exports.

#![cfg(target_arch = "wasm32")]

pub mod css;

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
    let opts = zp_rewriter::RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
    };
    zp_rewriter::rewrite_script(source, &opts)
        .map(|r| r.code)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Patch-mode emit (memory plan #3). Returns the patch list as a flat
/// JSON string the caller can deserialise once and apply in-place over
/// the original source buffer. Avoids the full re-emit cost on
/// 90%-unchanged scripts.
///
/// Output schema:
///   `{"patches":[{"start":<u32>,"end":<u32>,"replacement":"<str>"}],"len":<u32>}`
///
/// `len` is the original source byte length (lets the JS side allocate
/// the exact output buffer up-front).
#[wasm_bindgen(js_name = rewriteScriptPatches)]
pub fn rewrite_script_patches_js(
    source: &str,
    kind: &str,
    target_url: &str,
) -> Result<String, JsError> {
    let kind = parse_script_kind(kind)?;
    let opts = zp_rewriter::RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
    };
    // Use the patch-only API: skips the O(n) `apply_patches` +
    // `strip_sourcemap_pragma` string reconstruction. The JS caller already
    // owns the original source buffer and applies patches against it.
    let result = zp_rewriter::rewrite_script_patches(source, &opts)
        .map_err(|e| JsError::new(&e.to_string()))?;
    // Hand-rolled JSON (no serde_json dependency drag). Replacement
    // strings can contain quotes / backslashes / control chars, so we
    // escape them per JSON spec.
    let mut out = String::with_capacity(source.len() / 4 + 64);
    out.push_str("{\"len\":");
    out.push_str(&source.len().to_string());
    out.push_str(",\"patches\":[");
    for (i, p) in result.patches.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"start\":");
        out.push_str(&p.start.to_string());
        out.push_str(",\"end\":");
        out.push_str(&p.end.to_string());
        out.push_str(",\"replacement\":");
        json_escape_into(&p.replacement, &mut out);
        out.push('}');
    }
    out.push_str("]}");
    Ok(out)
}

fn json_escape_into(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// D2 source-map composer: returns a Source Map v3 JSON document mapping
/// the rewritten script back to the original source. The SW serves it at
/// `/__zp/sourcemap?u=<targetUrl>&k=<kind>` so DevTools breakpoints set on
/// the rewritten (`__zp_*`-wrapped) code land on the original identifiers.
#[wasm_bindgen(js_name = composeSourceMap)]
pub fn compose_source_map_js(
    source: &str,
    kind: &str,
    target_url: &str,
) -> Result<String, JsError> {
    let kind = parse_script_kind(kind)?;
    let opts = zp_rewriter::RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
    };
    zp_rewriter::compose_source_map(source, &opts, target_url)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Same as `composeSourceMap` but additionally chains the resulting map
/// with the target site's *original* `.map` (the one the bundler emitted
/// alongside the source). DevTools resolves rewritten → typescript /
/// pre-minify origin in one hop instead of stopping at the bundled `.js`.
/// `original_map_json` may be empty — the function falls back to the
/// unchained map without raising.
#[wasm_bindgen(js_name = composeSourceMapChained)]
pub fn compose_source_map_chained_js(
    source: &str,
    kind: &str,
    target_url: &str,
    original_map_json: &str,
) -> Result<String, JsError> {
    let kind = parse_script_kind(kind)?;
    let opts = zp_rewriter::RewriteOpts {
        kind,
        target_url: target_url.to_string(),
        strict: true,
    };
    zp_rewriter::compose_source_map_chained(source, &opts, target_url, original_map_json)
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

/// Streaming HTML transform for progressive document render. Construct once per
/// document; feed decoded (gunzipped) HTML byte chunks via [`HtmlTxn::write`] as
/// they arrive from the kernel `ReadableStream`; finish with [`HtmlTxn::end`].
/// Each `write` returns the rewritten bytes produced so far, so the SW can pipe
/// them straight to the page. `prelude_html` is injected right after `<head>`
/// (pass `""` to skip). Same strict-mode rewrite as `transformHtml`, just
/// incremental — see `zp_htmltx::HtmlTxn` for the chunk-invariance guarantee.
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
        let opts = zp_htmltx::TransformOptions {
            target_url: target_url.to_string(),
            strict: true,
            pending_gate: true,
            proxy_origin: proxy_origin.to_string(),
        };
        HtmlTxn {
            inner: Some(zp_htmltx::HtmlTxn::new(&opts, prelude_html.to_string())),
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

/// 2026-06-08 split-bundle (c.1) Step 4: SWC-based CSS rewriter (ported from
/// the now-deleted `rewriter-rs/` crate). Returns the rewritten CSS or
/// throws a `CSS_PARSE_FAILED` JsError. `base_url` is the CSS file's
/// absolute URL (used to resolve relative refs in `url(...)` / `@import`);
/// `control_prefix` is typically `/zp/`.
#[wasm_bindgen(js_name = rewriteCSS)]
pub fn rewrite_css_js(source: &str, base_url: &str, control_prefix: &str) -> Result<String, JsError> {
    let out = css::rewrite_css(source, base_url, control_prefix);
    if out.ok {
        Ok(out.code)
    } else {
        Err(JsError::new(&out.error))
    }
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

// Kernel exports moved out in (c.3) — see `crates/zp-kernel-bundle/`.
