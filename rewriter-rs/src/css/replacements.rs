use swc_css_ast::{
    DeclarationOrAtRule, ImportHref, ListOfComponentValues, Str, Stylesheet, UrlValue,
};
use swc_css_visit::{Visit, VisitWith};

use super::url::{escape_string, proxied_url};

#[derive(Clone)]
pub(crate) struct Replacement {
    start: usize,
    end: usize,
    text: String,
}

pub(crate) fn collect_replacements(
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

pub(crate) fn apply_replacements(source: &str, mut replacements: Vec<Replacement>) -> String {
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
