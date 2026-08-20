//! 2026-06-08 split-bundle (c.1) Step 4: SWC-based CSS rewriter ported from
//! the (now-deleted) `rewriter-rs/` crate. Same surface as before:
//! `rewrite_css(source, base_url, control_prefix, proxy_origin)` → rewrites `url(...)` and
//! `@import` references to route through the proxy's `/zp/api/fetch?url=...`
//! endpoint. The wasm-bindgen export `rewriteCSS` (see `lib.rs`) is what
//! `web/sw.js` (and Step 4-onwards page realm if needed) calls.

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
    // Absolute (proxy-origin) URL, not root-relative. A bare
    // `/zp/api/fetch?url=…` resolves against whatever base the consuming
    // context has — and the membrane virtualises the document base to the
    // TARGET origin. Inside a proxied iframe that turned NAVER's font and
    // sprite requests into `https://spastatic.naver.com/zp/api/fetch?url=…`
    // (404: the target host has no such path), so webfonts and shopping
    // sprites silently vanished. The HTML rewriter already takes
    // `proxy_origin` for exactly this reason; CSS needs the same. Empty
    // `proxy_origin` keeps the legacy root-relative form (tests / callers
    // that render into a non-virtualised base).
    let mut out = String::new();
    out.push_str(proxy_origin.trim_end_matches('/'));
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

    // `image-set()` 는 `url("…")` 없이 **맨 문자열**도 받는다:
    //   background-image: image-set("a.png" 1x, "a@2x.png" 2x)
    // 그 문자열은 AST 에서 `Url` 노드가 아니라 그냥 `Str` 이라 위 visit_url 이
    // 못 본다 — 원본 URL 이 그대로 남아 `img-src 'self'` 에 걸린다(csp-only).
    // 함수 이름이 image-set 계열일 때만 문자열 인자를 URL 로 취급한다.
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

    // Pin: with a proxy origin the emitted references are ABSOLUTE. Root-
    // relative ones resolve against the consuming context's base, which the
    // membrane virtualises to the target origin — inside a proxied iframe the
    // browser then asked the TARGET host for `/zp/api/fetch?url=…` and got 404
    // (this is why NAVER's webfonts and shopping sprites silently disappeared).
    // Target-agnostic: the origin is whatever the proxy is served on at runtime.
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

    // `image-set()` 의 맨 문자열 인자. `url()` 형태는 원래 되고 있었는데
    // 문자열 형태만 새고 있었다(2026-08-20, 인벤토리 대조에서 발견).
    #[test]
    fn image_set_bare_strings_rewritten() {
        let css = r#"#x{background-image:image-set("https://t.example/a.png" 1x, "https://t.example/a2.png" 2x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(out.ok, "rewrite 실패");
        assert!(
            !out.code.contains("t.example/a.png"),
            "1x 후보가 원본으로 남았다 -> {}",
            out.code
        );
        assert!(
            !out.code.contains("t.example/a2.png"),
            "2x 후보가 원본으로 남았다 -> {}",
            out.code
        );
    }

    #[test]
    fn webkit_image_set_also_rewritten() {
        let css = r#"#x{background-image:-webkit-image-set("https://t.example/a.png" 1x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(!out.code.contains("\"https://t.example"), "-webkit- 접두 형태 -> {}", out.code);
        assert!(out.code.contains("api/fetch?url="), "프록시 경로가 아니다 -> {}", out.code);
    }

    // url() 형태는 원래대로 동작해야 한다 — 새 visitor 가 기존 경로를 밀어내면 안 된다.
    #[test]
    fn image_set_url_form_still_rewritten() {
        let css = r#"#x{background-image:image-set(url(https://t.example/a.png) 1x)}"#;
        let out = rewrite_css(css, "https://example.com/", "/zp/", "https://p.example");
        assert!(!out.code.contains("(https://t.example"), "url() 형태 회귀 -> {}", out.code);
        assert!(out.code.contains("api/fetch?url="), "프록시 경로가 아니다 -> {}", out.code);
    }
}
