//! SWC-based CSS rewriter: rewrites `url(...)`, `@import`, and `image-set(...)`
//! references to route through the proxy's `/zp/api/fetch?url=...` endpoint.

use swc_css_ast::{DeclarationOrAtRule, ImportHref, ListOfComponentValues, Str, Stylesheet, UrlValue};
use swc_css_visit::{Visit, VisitWith};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CssRewriteResult {
    pub ok: bool,
    pub code: String,
    pub error: String,
}

pub fn rewrite_css(source: &str, base_url: &str, control_prefix: &str, proxy_origin: &str) -> CssRewriteResult {
    let control_prefix = if control_prefix.is_empty() { "/zp/" } else { control_prefix };
    match collect_css_replacements(source, base_url, control_prefix, proxy_origin) {
        Ok(replacements) => CssRewriteResult {
            ok: true,
            code: apply_css_replacements(source, replacements),
            error: String::new(),
        },
        Err(error) => CssRewriteResult { ok: false, code: String::new(), error },
    }
}

fn proxied_css_url(
    raw: &str,
    base_url: &str,
    control_prefix: &str,
    proxy_origin: &str,
) -> Option<String> {
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
    // Emit an absolute proxy-origin URL when `proxy_origin` is provided so
    // references inside proxied iframes do not resolve against a virtualized
    // target `<base>`. `zp_shared::subresource_proxy_url` preserves URL
    // fragments (`sprite.svg#icon`) outside the encoded `url=` query parameter.
    Some(zp_shared::subresource_proxy_url(
        abs.as_str(),
        proxy_origin,
        control_prefix,
        None,
    ))
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

fn collect_css_replacements(source: &str, base_url: &str, control_prefix: &str, proxy_origin: &str) -> Result<Vec<CssReplacement>, String> {
    use swc_common::{sync::Lrc, FileName, SourceMap};
    use swc_css_parser::{parse_file, parser::ParserConfig};

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), source.to_string());
    let start_pos = fm.start_pos.0;

    let mut stylesheet_errors = Vec::new();
    if let Ok(stylesheet) = parse_file::<Stylesheet>(&fm, None, ParserConfig::default(), &mut stylesheet_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, proxy_origin, start_pos, source.len());
        stylesheet.visit_with(&mut collector);
        if !collector.replacements.is_empty() || source.contains('{') || source.contains("@import") {
            return Ok(collector.replacements);
        }
    }

    let mut declaration_errors = Vec::new();
    if let Ok(declarations) = parse_file::<Vec<DeclarationOrAtRule>>(&fm, None, ParserConfig::default(), &mut declaration_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, proxy_origin, start_pos, source.len());
        for declaration in &declarations {
            declaration.visit_with(&mut collector);
        }
        if !collector.replacements.is_empty() {
            return Ok(collector.replacements);
        }
    }

    let mut value_errors = Vec::new();
    if let Ok(values) = parse_file::<ListOfComponentValues>(&fm, None, ParserConfig::default(), &mut value_errors) {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, proxy_origin, start_pos, source.len());
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
    proxy_origin: &'a str,
    start_pos: u32,
    source_len: usize,
    replacements: Vec<CssReplacement>,
}

impl<'a> CssUrlCollector<'a> {
    fn new(base_url: &'a str, control_prefix: &'a str, proxy_origin: &'a str, start_pos: u32, source_len: usize) -> Self {
        Self { base_url, control_prefix, proxy_origin, start_pos, source_len, replacements: Vec::new() }
    }

    fn span_offsets(&self, span: swc_common::Span) -> Option<(usize, usize)> {
        let start = span.lo.0.checked_sub(self.start_pos)? as usize;
        let end = span.hi.0.checked_sub(self.start_pos)? as usize;
        if start < end && end <= self.source_len { Some((start, end)) } else { None }
    }

    fn add_quoted_replacement(&mut self, span: swc_common::Span, raw: &str) {
        let Some(next) = proxied_css_url(raw, self.base_url, self.control_prefix, self.proxy_origin) else { return; };
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

    // `image-set()` accepts bare string literal arguments without `url("...")`:
    //   background-image: image-set("a.png" 1x, "a@2x.png" 2x)
    // Those strings parse as `Str` nodes rather than `Url` nodes in the AST, so
    // rewrite them directly when visiting `image-set` or `-webkit-image-set`.
    fn visit_function(&mut self, node: &swc_css_ast::Function) {
        let name = match &node.name {
            swc_css_ast::FunctionName::Ident(i) => i.value.to_string(),
            swc_css_ast::FunctionName::DashedIdent(i) => i.value.to_string(),
        };
        let lower = name.to_ascii_lowercase();
        if lower == "image-set" || lower == "-webkit-image-set" {
            for v in &node.value {
                if let swc_css_ast::ComponentValue::Str(st) = v {
                    self.add_string_replacement(st);
                }
            }
        }
        node.visit_children_with(self);
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
        let out = rewrite_css(css, base, prefix, "");
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert!(out.code.contains("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fimg%2Fbg.png"), "got: {}", out.code);
    }

    #[test]
    fn skips_data_blob_javascript_schemes() {
        let (base, prefix) = opts();
        let css = "body { background: url(data:image/png;base64,abc); background-image: url(blob:foo); cursor: url(javascript:alert(1)); }";
        let out = rewrite_css(css, base, prefix, "");
        assert!(out.ok);
        assert!(out.code.contains("data:image/png"));
        assert!(out.code.contains("blob:foo"));
        assert!(!out.code.contains("/zp/api/fetch?url=javascript"));
    }

    #[test]
    fn rewrites_at_import() {
        let (base, prefix) = opts();
        let css = "@import \"/styles/reset.css\";";
        let out = rewrite_css(css, base, prefix, "");
        assert!(out.ok);
        assert!(out.code.contains("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fstyles%2Freset.css"));
    }

    // With a non-empty `proxy_origin`, emitted references must be absolute so
    // they do not resolve against a virtualized target `<base>` inside proxied
    // iframes.
    #[test]
    fn proxy_origin_makes_urls_absolute() {
        let (base, prefix) = opts();
        let origin = "http://proxy.localhost:18080";
        for css in [
            "body { background: url(/img/bg.png); }",
            "@import \"/styles/reset.css\";",
            "@font-face { src: url(../fonts/x.woff2) format('woff2'); }",
        ] {
            let out = rewrite_css(css, base, prefix, origin);
            assert!(out.ok, "rewrite failed: {}", out.error);
            assert!(
                out.code.contains("http://proxy.localhost:18080/zp/api/fetch?url="),
                "expected absolute proxy URL, got: {}",
                out.code
            );
            // No bare root-relative reference must survive.
            assert!(
                !out.code.contains("\"/zp/api/fetch"),
                "root-relative reference leaked: {}",
                out.code
            );
        }
    }

    // A trailing slash on the origin must not produce `//zp/`.
    #[test]
    fn proxy_origin_trailing_slash_is_normalised() {
        let (base, prefix) = opts();
        let out = rewrite_css("body { background: url(/img/bg.png); }", base, prefix, "https://p.example/");
        assert!(out.ok);
        assert!(out.code.contains("https://p.example/zp/api/fetch?url="), "got: {}", out.code);
        assert!(!out.code.contains("//zp/api"), "double slash: {}", out.code);
    }
}

#[cfg(test)]
mod image_set_tests {
    use super::*;

    #[test]
    fn image_set_bare_strings_rewritten() {
        let css = r#"#x{background-image:image-set("https://t.example/a.png" 1x, "https://t.example/a2.png" 2x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(out.ok, "rewrite failed");
        assert!(
            !out.code.contains("t.example/a.png"),
            "1x candidate was not rewritten: {}",
            out.code
        );
        assert!(
            !out.code.contains("t.example/a2.png"),
            "2x candidate was not rewritten: {}",
            out.code
        );
    }

    #[test]
    fn webkit_image_set_also_rewritten() {
        let css = r#"#x{background-image:-webkit-image-set("https://t.example/a.png" 1x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(!out.code.contains("\"https://t.example"), "-webkit- prefixed form not rewritten: {}", out.code);
        assert!(out.code.contains("api/fetch?url="), "expected proxy path, got: {}", out.code);
    }

    #[test]
    fn image_set_url_form_still_rewritten() {
        let css = r#"#x{background-image:image-set(url(https://t.example/a.png) 1x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(!out.code.contains("(https://t.example"), "url() form regression: {}", out.code);
        assert!(out.code.contains("api/fetch?url="), "expected proxy path, got: {}", out.code);
    }
}
