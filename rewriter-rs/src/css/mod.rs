use swc_css_ast::{
    DeclarationOrAtRule, ImportHref, ListOfComponentValues, Str, Stylesheet, UrlValue,
};
use swc_css_visit::{Visit, VisitWith};

pub(crate) fn rewrite(
    source: &str,
    base_url: &str,
    control_prefix: &str,
) -> Result<String, String> {
    let control_prefix = if control_prefix.is_empty() {
        "/zp/"
    } else {
        control_prefix
    };
    collect_replacements(source, base_url, control_prefix)
        .map(|replacements| apply_replacements(source, replacements))
}

fn proxied_url(raw: &str, base_url: &str, control_prefix: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with("var(") {
        return None;
    }
    let lower = s.get(..s.len().min(32)).unwrap_or("").to_ascii_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("about:")
        || lower.starts_with("javascript:")
        || lower.starts_with("vbscript:")
    {
        return None;
    }
    let base = url::Url::parse(base_url).ok()?;
    let mut abs = base.join(s).ok()?;
    if abs.scheme() != "http" && abs.scheme() != "https" {
        return None;
    }
    let fragment = abs.fragment().map(str::to_string);
    abs.set_fragment(None);
    let mut out = String::new();
    out.push_str(control_prefix);
    if !out.ends_with('/') {
        out.push('/');
    }
    out.push_str("api/fetch?url=");
    out.extend(url::form_urlencoded::byte_serialize(
        abs.as_str().as_bytes(),
    ));
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(&fragment);
    }
    Some(out)
}

fn escape_string(s: &str, quote: u8) -> String {
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
struct Replacement {
    start: usize,
    end: usize,
    text: String,
}

fn collect_replacements(
    source: &str,
    base_url: &str,
    control_prefix: &str,
) -> Result<Vec<Replacement>, String> {
    use swc_common::{sync::Lrc, FileName, SourceMap};
    use swc_css_parser::{parse_file, parser::ParserConfig};

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), source.to_string());
    let start_pos = fm.start_pos.0;

    let mut stylesheet_errors = Vec::new();
    if let Ok(stylesheet) =
        parse_file::<Stylesheet>(&fm, None, ParserConfig::default(), &mut stylesheet_errors)
    {
        let mut collector = UrlCollector::new(base_url, control_prefix, start_pos, source.len());
        stylesheet.visit_with(&mut collector);
        if !collector.replacements.is_empty() || source.contains('{') || source.contains("@import")
        {
            return Ok(collector.replacements);
        }
    }

    let mut declaration_errors = Vec::new();
    if let Ok(declarations) = parse_file::<Vec<DeclarationOrAtRule>>(
        &fm,
        None,
        ParserConfig::default(),
        &mut declaration_errors,
    ) {
        let mut collector = UrlCollector::new(base_url, control_prefix, start_pos, source.len());
        for declaration in &declarations {
            declaration.visit_with(&mut collector);
        }
        if !collector.replacements.is_empty() {
            return Ok(collector.replacements);
        }
    }

    let mut value_errors = Vec::new();
    if let Ok(values) =
        parse_file::<ListOfComponentValues>(&fm, None, ParserConfig::default(), &mut value_errors)
    {
        let mut collector = UrlCollector::new(base_url, control_prefix, start_pos, source.len());
        values.visit_with(&mut collector);
        return Ok(collector.replacements);
    }

    Err("CSS_PARSE_FAILED".to_string())
}

fn apply_replacements(source: &str, mut replacements: Vec<Replacement>) -> String {
    replacements.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut out = String::with_capacity(
        source.len() + replacements.iter().map(|r| r.text.len()).sum::<usize>(),
    );
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

struct UrlCollector<'a> {
    base_url: &'a str,
    control_prefix: &'a str,
    start_pos: u32,
    source_len: usize,
    replacements: Vec<Replacement>,
}

impl<'a> UrlCollector<'a> {
    fn new(base_url: &'a str, control_prefix: &'a str, start_pos: u32, source_len: usize) -> Self {
        Self {
            base_url,
            control_prefix,
            start_pos,
            source_len,
            replacements: Vec::new(),
        }
    }

    fn span_offsets(&self, span: swc_common::Span) -> Option<(usize, usize)> {
        let start = span.lo.0.checked_sub(self.start_pos)? as usize;
        let end = span.hi.0.checked_sub(self.start_pos)? as usize;
        if start < end && end <= self.source_len {
            Some((start, end))
        } else {
            None
        }
    }

    fn add_quoted_replacement(&mut self, span: swc_common::Span, raw: &str) {
        let Some(next) = proxied_url(raw, self.base_url, self.control_prefix) else {
            return;
        };
        let Some((start, end)) = self.span_offsets(span) else {
            return;
        };
        self.replacements.push(Replacement {
            start,
            end,
            text: format!("\"{}\"", escape_string(&next, b'"')),
        });
    }

    fn add_string_replacement(&mut self, s: &Str) {
        self.add_quoted_replacement(s.span, s.value.as_ref());
    }
}

impl Visit for UrlCollector<'_> {
    fn visit_import_href(&mut self, node: &ImportHref) {
        match node {
            ImportHref::Str(s) => self.add_string_replacement(s),
            ImportHref::Url(u) => self.visit_url(u),
        }
    }

    fn visit_url(&mut self, node: &swc_css_ast::Url) {
        let Some(value) = node.value.as_ref() else {
            return;
        };
        match &**value {
            UrlValue::Str(s) => self.add_string_replacement(s),
            UrlValue::Raw(raw) => self.add_quoted_replacement(raw.span, raw.value.as_ref()),
        }
    }
}
