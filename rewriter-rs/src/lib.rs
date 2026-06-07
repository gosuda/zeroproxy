// 2026-06-08 split-bundle (c.1) Step 3: drop OXC-based JS rewriter. The
// `crates/zp-rewriter` (modern OXC 0.133) crate is now the SOLE OXC-based
// JS rewriter — it powers both SW (via `rewriteScript` on `self.ZPBundle`)
// and page realm (via `globalThis.ZPBundle`). This crate is reduced to
// the SWC-based CSS rewriter only; Step 4 will port the CSS path to
// `zp-bundle` and delete `rewriter-rs/` entirely.

use swc_css_ast::{DeclarationOrAtRule, ImportHref, ListOfComponentValues, Str, Stylesheet, UrlValue};
use swc_css_visit::{Visit, VisitWith};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct RewriteOutput {
    ok: bool,
    code: String,
    error: String,
}

#[wasm_bindgen]
impl RewriteOutput {
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool { self.ok }
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String { self.code.clone() }
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> String { self.error.clone() }
}

#[wasm_bindgen]
pub fn rewrite_css(source: &str, base_url: &str, control_prefix: &str) -> RewriteOutput {
    let control_prefix = if control_prefix.is_empty() { "/zp/" } else { control_prefix };
    match collect_css_replacements(source, base_url, control_prefix) {
        Ok(replacements) => RewriteOutput {
            ok: true,
            code: apply_css_replacements(source, replacements),
            error: String::new(),
        },
        Err(error) => RewriteOutput { ok: false, code: String::new(), error },
    }
}

fn proxied_css_url(raw: &str, base_url: &str, control_prefix: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with("var(") {
        return None;
    }
    let lower = s.get(..s.len().min(32)).unwrap_or("").to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") || lower.starts_with("about:") || lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
        return None;
    }
    let base = url::Url::parse(base_url).ok()?;
    let abs = base.join(s).ok()?;
    if abs.scheme() != "http" && abs.scheme() != "https" {
        return None;
    }
    let mut out = String::new();
    out.push_str(control_prefix);
    if !out.ends_with('/') { out.push('/'); }
    out.push_str("api/fetch?url=");
    out.extend(url::form_urlencoded::byte_serialize(abs.as_str().as_bytes()));
    Some(out)
}

fn css_escape_string(s: &str, quote: u8) -> String {
    let q = quote as char;
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == q || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[derive(Clone)]
struct CssReplacement {
    start: usize,
    end: usize,
    text: String,
}

fn collect_css_replacements(source: &str, base_url: &str, control_prefix: &str) -> Result<Vec<CssReplacement>, String> {
    use swc_common::{sync::Lrc, FileName, SourceMap};
    use swc_css_parser::{parse_file, parser::ParserConfig};

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), source.to_string());
    let start_pos = fm.start_pos.0;

    let mut stylesheet_errors = Vec::new();
    if let Ok(stylesheet) = parse_file::<Stylesheet>(&fm, None, ParserConfig::default(), &mut stylesheet_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
        stylesheet.visit_with(&mut collector);
        if !collector.replacements.is_empty() || source.contains('{') || source.contains("@import") {
            return Ok(collector.replacements);
        }
    }

    let mut declaration_errors = Vec::new();
    if let Ok(declarations) = parse_file::<Vec<DeclarationOrAtRule>>(&fm, None, ParserConfig::default(), &mut declaration_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
        for declaration in &declarations {
            declaration.visit_with(&mut collector);
        }
        if !collector.replacements.is_empty() {
            return Ok(collector.replacements);
        }
    }

    let mut value_errors = Vec::new();
    if let Ok(values) = parse_file::<ListOfComponentValues>(&fm, None, ParserConfig::default(), &mut value_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
        values.visit_with(&mut collector);
        return Ok(collector.replacements);
    }

    Err("CSS_PARSE_FAILED".to_string())
}

fn apply_css_replacements(source: &str, mut replacements: Vec<CssReplacement>) -> String {
    replacements.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut out = String::with_capacity(source.len() + replacements.iter().map(|r| r.text.len()).sum::<usize>());
    let mut pos = 0usize;
    for r in replacements {
        if r.start < pos || r.start > r.end || r.end > source.len() {
            continue;
        }
        out.push_str(&source[pos..r.start]);
        out.push_str(&r.text);
        pos = r.end;
    }
    out.push_str(&source[pos..]);
    out
}

struct CssUrlCollector<'a> {
    base_url: &'a str,
    control_prefix: &'a str,
    start_pos: u32,
    source_len: usize,
    replacements: Vec<CssReplacement>,
}

impl<'a> CssUrlCollector<'a> {
    fn new(base_url: &'a str, control_prefix: &'a str, start_pos: u32, source_len: usize) -> Self {
        Self { base_url, control_prefix, start_pos, source_len, replacements: Vec::new() }
    }

    fn span_offsets(&self, span: swc_common::Span) -> Option<(usize, usize)> {
        let start = span.lo.0.checked_sub(self.start_pos)? as usize;
        let end = span.hi.0.checked_sub(self.start_pos)? as usize;
        if start < end && end <= self.source_len { Some((start, end)) } else { None }
    }

    fn add_quoted_replacement(&mut self, span: swc_common::Span, raw: &str) {
        let Some(next) = proxied_css_url(raw, self.base_url, self.control_prefix) else { return; };
        let Some((start, end)) = self.span_offsets(span) else { return; };
        self.replacements.push(CssReplacement {
            start,
            end,
            text: format!("\"{}\"", css_escape_string(&next, b'"')),
        });
    }

    fn add_string_replacement(&mut self, s: &Str) {
        self.add_quoted_replacement(s.span, &s.value.to_string());
    }
}

impl Visit for CssUrlCollector<'_> {
    fn visit_import_href(&mut self, node: &ImportHref) {
        match node {
            ImportHref::Str(s) => self.add_string_replacement(s),
            ImportHref::Url(u) => self.visit_url(u),
        }
    }

    fn visit_url(&mut self, node: &swc_css_ast::Url) {
        let Some(value) = node.value.as_ref() else { return; };
        match &**value {
            UrlValue::Str(s) => self.add_string_replacement(s),
            UrlValue::Raw(raw) => self.add_quoted_replacement(raw.span, &raw.value.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> (&'static str, &'static str) {
        ("https://example.com/", "/zp/")
    }

    #[test]
    fn rewrites_url_in_stylesheet() {
        let (base, prefix) = opts();
        let css = "body { background: url(/img/bg.png); }";
        let out = rewrite_css(css, base, prefix);
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert!(out.code.contains("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fimg%2Fbg.png"), "got: {}", out.code);
    }

    #[test]
    fn skips_data_blob_javascript_schemes() {
        let (base, prefix) = opts();
        let css = "body { background: url(data:image/png;base64,abc); background-image: url(blob:foo); cursor: url(javascript:alert(1)); }";
        let out = rewrite_css(css, base, prefix);
        assert!(out.ok);
        assert!(out.code.contains("data:image/png"));
        assert!(out.code.contains("blob:foo"));
        assert!(!out.code.contains("/zp/api/fetch?url=javascript"));
    }

    #[test]
    fn rewrites_at_import() {
        let (base, prefix) = opts();
        let css = "@import \"/styles/reset.css\";";
        let out = rewrite_css(css, base, prefix);
        assert!(out.ok);
        assert!(out.code.contains("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fstyles%2Freset.css"));
    }
}
