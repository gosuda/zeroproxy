//! Host-agnostic document transform facade (`zp-engine`).
//!
//! Single entry point for embedders that need ZeroProxy's document
//! pipeline without the wasm-bindgen surface: script rewrite (full and
//! patch mode), source-map composition, HTML transform (one-shot and
//! streaming [`zp_htmltx::HtmlTxn`]), CSS rewrite, CSP construction, and
//! Cloudflare challenge detection.
//!
//! `zp-bundle` and `zp-page-bundle` `#[wasm_bindgen]` exports delegate
//! here so the JS-facing and native paths share one implementation,
//! including error strings.
//!
//! Builds for any target without `wasm-bindgen` or `web-sys`.

pub use zp_css as css;
pub use zp_htmltx as htmltx;
pub use zp_rewriter as rewriter;
pub use zp_shared as shared;

use std::fmt;

use zp_rewriter::{RewriteOpts, RewriterInstance, ScriptKind};

/// Per-document transform context: the virtual target identity, the proxy
/// origin that emitted links resolve against, and the control route prefix.
pub struct DocCtx<'a> {
    pub target_url: &'a str,
    pub proxy_origin: &'a str,
    pub control_prefix: &'a str,
}

impl<'a> DocCtx<'a> {
    pub fn new(target_url: &'a str, proxy_origin: &'a str) -> Self {
        DocCtx {
            target_url,
            proxy_origin,
            control_prefix: "/zp/",
        }
    }

    pub fn with_control_prefix(mut self, control_prefix: &'a str) -> Self {
        self.control_prefix = control_prefix;
        self
    }

    fn rewrite_opts(&self, kind: ScriptKind) -> RewriteOpts {
        RewriteOpts {
            kind,
            target_url: self.target_url.to_string(),
            proxy_origin: self.proxy_origin.to_string(),
        }
    }

    fn transform_options(&self) -> zp_htmltx::TransformOptions {
        zp_htmltx::TransformOptions {
            target_url: self.target_url.to_string(),
            proxy_origin: self.proxy_origin.to_string(),
        }
    }
}

/// Facade error. `Display` delegates to the inner error text so WASM shims
/// (`JsError::new(&e.to_string())`) emit identical messages.
#[derive(Debug)]
pub enum EngineError {
    UnknownScriptKind(String),
    Rewrite(zp_rewriter::RewriteError),
    Html(zp_htmltx::TransformError),
    Css(zp_css::CssError),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::UnknownScriptKind(k) => write!(f, "unknown script kind: {k}"),
            EngineError::Rewrite(e) => fmt::Display::fmt(e, f),
            EngineError::Html(e) => fmt::Display::fmt(e, f),
            EngineError::Css(e) => fmt::Display::fmt(e, f),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<zp_rewriter::RewriteError> for EngineError {
    fn from(e: zp_rewriter::RewriteError) -> Self {
        EngineError::Rewrite(e)
    }
}

impl From<zp_css::CssError> for EngineError {
    fn from(e: zp_css::CssError) -> Self {
        EngineError::Css(e)
    }
}

impl From<zp_htmltx::TransformError> for EngineError {
    fn from(e: zp_htmltx::TransformError) -> Self {
        EngineError::Html(e)
    }
}

/// Maps a `kind` string to [`ScriptKind`]. The accepted names form part of the
/// JS ABI (`rewriteScript(src, kind, ...)`).
pub fn parse_script_kind(kind: &str) -> Result<ScriptKind, EngineError> {
    kind.parse::<ScriptKind>()
        .map_err(EngineError::UnknownScriptKind)
}

/// JSON envelope for patch-mode rewrites. Serialized without `serde_json`
/// following the wire contract:
/// `{"len":<u32>,"patches":[{"start":<u32>,"end":<u32>,"replacement":"<str>"}]}`.
pub fn patches_to_json(source_len: usize, patches: &[zp_rewriter::Patch]) -> String {
    let mut out = String::with_capacity(source_len / 4 + 64);
    out.push_str("{\"len\":");
    out.push_str(&source_len.to_string());
    out.push_str(",\"patches\":[");
    for (i, p) in patches.iter().enumerate() {
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
    out
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

/// Stateful transform engine. Owns a [`RewriterInstance`] so warm-path
/// rewrites amortise the OXC bump-arena allocation across calls.
pub struct TransformEngine {
    rewriter: RewriterInstance,
}

impl Default for TransformEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl TransformEngine {
    pub fn new() -> Self {
        TransformEngine {
            rewriter: RewriterInstance::new(),
        }
    }

    /// Transformer version (mirrors `zp_shared::TRANSFORMER_VERSION`), used
    /// by the version check between the Service Worker and prelude.
    pub fn version(&self) -> &'static str {
        zp_shared::TRANSFORMER_VERSION
    }

    /// Script rewrite for a typed [`ScriptKind`]; a script that fails to parse is an error (fail closed).
    pub fn rewrite_script(
        &mut self,
        source: &str,
        kind: ScriptKind,
        ctx: &DocCtx,
    ) -> Result<String, EngineError> {
        let opts = ctx.rewrite_opts(kind);
        self.rewriter
            .rewrite(source, &opts)
            .map(|r| r.code)
            .map_err(EngineError::from)
    }

    /// Patch-mode emit: the flat patch JSON envelope (`patches_to_json`) without reconstructing the output source, reusing the persistent OXC
    /// arena on [`RewriterInstance`].
    pub fn rewrite_script_patches_json(
        &mut self,
        source: &str,
        kind: ScriptKind,
        ctx: &DocCtx,
    ) -> Result<String, EngineError> {
        let opts = ctx.rewrite_opts(kind);
        let result = self.rewriter.rewrite_patches(source, &opts)?;
        Ok(patches_to_json(source.len(), &result.patches))
    }

    /// Source Map v3 mapping rewritten positions back to the original.
    pub fn compose_source_map(
        &mut self,
        source: &str,
        kind: ScriptKind,
        ctx: &DocCtx,
        source_url: &str,
    ) -> Result<String, EngineError> {
        let opts = ctx.rewrite_opts(kind);
        Ok(zp_rewriter::compose_source_map(source, &opts, source_url)?)
    }

    /// `compose_source_map` + chain with the target site's original map.
    pub fn compose_source_map_chained(
        &mut self,
        source: &str,
        kind: ScriptKind,
        ctx: &DocCtx,
        source_url: &str,
        original_map_json: &str,
    ) -> Result<String, EngineError> {
        let opts = ctx.rewrite_opts(kind);
        Ok(zp_rewriter::compose_source_map_chained(
            source,
            &opts,
            source_url,
            original_map_json,
        )?)
    }

    /// One-shot HTML transform (fail closed: unparsable scripts are replaced).
    pub fn transform_html(&mut self, html: &str, ctx: &DocCtx) -> Result<String, EngineError> {
        let opts = ctx.transform_options();
        zp_htmltx::transform(html, &opts)
            .map(|r| r.html)
            .map_err(EngineError::from)
    }

    /// Streaming HTML transform: the caller feeds decoded chunks into
    /// the returned transaction and pipes rewritten bytes out per write.
    pub fn html_txn(&self, ctx: &DocCtx, prelude_html: &str) -> zp_htmltx::HtmlTxn {
        let opts = ctx.transform_options();
        zp_htmltx::HtmlTxn::new(&opts, prelude_html.to_string())
    }

    /// CSS rewrite using `ctx.control_prefix` and `ctx.proxy_origin`.
    pub fn rewrite_css_with_ctx(
        &mut self,
        source: &str,
        base_url: &str,
        ctx: &DocCtx,
    ) -> Result<String, EngineError> {
        self.rewrite_css(source, base_url, ctx.control_prefix, ctx)
    }

    /// CSS rewrite. `base_url` is the CSS file's absolute URL;
    /// `control_prefix` is typically `/zp/`; `ctx.proxy_origin` makes the
    /// emitted `/zp/api/v2/fetch?url=…` references absolute (empty keeps
    /// legacy root-relative output).
    pub fn rewrite_css(
        &mut self,
        source: &str,
        base_url: &str,
        control_prefix: &str,
        ctx: &DocCtx,
    ) -> Result<String, EngineError> {
        let out = zp_css::rewrite_css(source, base_url, control_prefix, ctx.proxy_origin)?;
        Ok(out.code)
    }

    /// Strict CSP for a proxy WebSocket origin.
    pub fn build_csp(&self, ws_origin: &str) -> String {
        zp_shared::build_csp(ws_origin)
    }

    /// CSP with the armed challenge-compatibility projection
    /// (Cloudflare Turnstile hosts on the four listed directives only).
    pub fn build_csp_with(&self, ws_origin: &str, challenge_compat: bool) -> String {
        zp_shared::build_csp_with(ws_origin, &zp_shared::CspOptions { challenge_compat })
    }

    /// Cloudflare challenge-document classifier (see
    /// `zp_shared::is_challenge_document` for the rule).
    pub fn is_challenge_document(&self, cf_mitigated: &str, host: &str, path: &str) -> bool {
        zp_shared::is_challenge_document(cf_mitigated, host, path)
    }

    /// Force-drop arena capacity after a one-off large rewrite.
    pub fn reset(&mut self) {
        self.rewriter.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> DocCtx<'static> {
        DocCtx::new("https://example.com/app.js", "http://proxy.localhost:8080")
    }

    #[test]
    fn rewrite_and_patch_modes_agree_on_the_same_script() {
        let mut engine = TransformEngine::new();
        let src = "var f = eval; f('return globalThis');";
        let full = engine.rewrite_script(src, ScriptKind::Classic, &ctx()).unwrap();
        assert!(full.contains("__zp_get"), "{full}");
        let patches = engine
            .rewrite_script_patches_json(src, ScriptKind::Classic, &ctx())
            .unwrap();
        assert!(patches.starts_with(&format!("{{\"len\":{}", src.len())), "{patches}");
        assert!(patches.contains("eval"), "{patches}");
    }

    #[test]
    fn script_kind_names_are_parsed_at_the_boundary() {
        assert!(matches!(parse_script_kind("module"), Ok(ScriptKind::Module)));
        match parse_script_kind("bogus") {
            Err(EngineError::UnknownScriptKind(k)) => assert_eq!(k, "bogus"),
            other => panic!("expected UnknownScriptKind, got {other:?}"),
        }
    }

    #[test]
    fn unparsable_script_is_an_error_not_passthrough() {
        let mut engine = TransformEngine::new();
        let err = engine
            .rewrite_script("function (", ScriptKind::Classic, &ctx())
            .unwrap_err();
        assert!(matches!(err, EngineError::Rewrite(_)), "{err}");
    }

    #[test]
    fn doc_ctx_with_control_prefix_routes_css() {
        let mut engine = TransformEngine::new();
        let ctx = DocCtx::new("https://example.com/", "http://proxy.localhost:8080")
            .with_control_prefix("/custom-zp/");
        let css = "body { background: url('/bg.png'); }";
        let out = engine
            .rewrite_css_with_ctx(css, "https://example.com/style.css", &ctx)
            .unwrap();
        assert!(out.contains("http://proxy.localhost:8080/custom-zp/api/v2/fetch?url="));
    }
}
