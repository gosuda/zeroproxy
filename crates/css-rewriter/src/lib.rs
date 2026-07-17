use cssparser::{
    AtRuleParser, CowRcStr, DeclarationParser, ParseError, Parser, ParserInput,
    QualifiedRuleParser, RuleBodyItemParser, RuleBodyParser, StyleSheetParser, Token,
};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Stylesheet,
    DeclarationList,
    ComponentValue,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}
#[derive(Debug, Error, Eq, PartialEq)]
pub enum Error {
    #[error("CSS parse failed")]
    Parse,
    #[error("overlapping CSS edits")]
    Overlap,
    #[error("URL policy blocked")]
    Blocked,
}

fn descend<'i, 't, F>(
    parser: &mut Parser<'i, 't>,
    route: &mut F,
    edits: &mut Vec<Edit>,
) -> Result<(), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    let mut nested_error = None;
    parser
        .parse_nested_block::<_, (), ()>(|nested| {
            if let Err(error) = scan_tokens(nested, route, edits, false) {
                nested_error = Some(error);
            }
            Ok(())
        })
        .map_err(|_| Error::Parse)?;
    nested_error.map_or(Ok(()), Err)
}

fn scan_tokens<'i, 't, F>(
    parser: &mut Parser<'i, 't>,
    route: &mut F,
    edits: &mut Vec<Edit>,
    rewrite_import_string: bool,
) -> Result<(), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    let mut import_pending = rewrite_import_string;
    while !parser.is_exhausted() {
        let start = parser.position().byte_index();
        let token = parser
            .next_including_whitespace_and_comments()
            .map_err(|_| Error::Parse)?
            .clone();
        match token {
            Token::QuotedString(value) if import_pending => {
                let end = parser.position().byte_index();
                edits.push(Edit {
                    start,
                    end,
                    replacement: format!("\"{}\"", escape(&route(&value)?)),
                });
                import_pending = false;
            }
            Token::Semicolon => import_pending = false,
            Token::UnquotedUrl(value) => {
                let end = parser.position().byte_index();
                edits.push(Edit {
                    start,
                    end,
                    replacement: format!("url({})", route(&value)?),
                });
            }
            Token::Function(name) if name.eq_ignore_ascii_case("url") => {
                let Ok(value) = parser.parse_nested_block::<_, String, ()>(|nested| {
                    nested
                        .expect_url_or_string()
                        .map(|value| value.as_ref().to_owned())
                        .map_err(Into::into)
                }) else {
                    continue;
                };
                let end = parser.position().byte_index();
                edits.push(Edit {
                    start,
                    end,
                    replacement: format!("url(\"{}\")", escape(&route(&value)?)),
                });
            }
            Token::Function(_)
            | Token::ParenthesisBlock
            | Token::SquareBracketBlock
            | Token::CurlyBracketBlock => descend(parser, route, edits)?,
            Token::BadUrl(_) | Token::BadString(_) => {}
            _ => {}
        }
    }
    Ok(())
}

struct SyntaxParser<'a, F> {
    route: &'a mut F,
    edits: &'a mut Vec<Edit>,
    failure: Option<Error>,
    imports_open: bool,
}

#[derive(Clone, Copy)]
enum AtRulePrelude {
    Import,
    LayerStatement,
    Other,
}

impl<'a, F> SyntaxParser<'a, F>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    fn scan<'i, 't>(
        &mut self,
        input: &mut Parser<'i, 't>,
        rewrite_import_string: bool,
    ) -> Result<(), ParseError<'i, Error>> {
        if let Err(error) = scan_tokens(input, self.route, self.edits, rewrite_import_string) {
            self.failure = Some(error);
            return Err(input.new_custom_error(Error::Parse));
        }
        Ok(())
    }
}

impl<'i, F> AtRuleParser<'i> for SyntaxParser<'_, F>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    type Prelude = AtRulePrelude;
    type AtRule = ();
    type Error = Error;

    fn parse_prelude<'t>(
        &mut self,
        name: CowRcStr<'i>,
        input: &mut Parser<'i, 't>,
    ) -> Result<Self::Prelude, ParseError<'i, Self::Error>> {
        let prelude = if name.eq_ignore_ascii_case("import") {
            AtRulePrelude::Import
        } else if name.eq_ignore_ascii_case("layer") {
            AtRulePrelude::LayerStatement
        } else {
            AtRulePrelude::Other
        };
        self.scan(
            input,
            matches!(prelude, AtRulePrelude::Import) && self.imports_open,
        )?;
        Ok(prelude)
    }

    fn rule_without_block(
        &mut self,
        prelude: Self::Prelude,
        _start: &cssparser::ParserState,
    ) -> Result<Self::AtRule, ()> {
        if !matches!(
            prelude,
            AtRulePrelude::Import | AtRulePrelude::LayerStatement
        ) {
            self.imports_open = false;
        }
        Ok(())
    }

    fn parse_block<'t>(
        &mut self,
        _prelude: Self::Prelude,
        _start: &cssparser::ParserState,
        input: &mut Parser<'i, 't>,
    ) -> Result<Self::AtRule, ParseError<'i, Self::Error>> {
        self.imports_open = false;
        self.scan(input, false)
    }
}

impl<'i, F> QualifiedRuleParser<'i> for SyntaxParser<'_, F>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    type Prelude = ();
    type QualifiedRule = ();
    type Error = Error;

    fn parse_prelude<'t>(
        &mut self,
        input: &mut Parser<'i, 't>,
    ) -> Result<Self::Prelude, ParseError<'i, Self::Error>> {
        self.imports_open = false;
        self.scan(input, false)
    }

    fn parse_block<'t>(
        &mut self,
        _prelude: Self::Prelude,
        _start: &cssparser::ParserState,
        input: &mut Parser<'i, 't>,
    ) -> Result<Self::QualifiedRule, ParseError<'i, Self::Error>> {
        self.scan(input, false)
    }
}

impl<'i, F> DeclarationParser<'i> for SyntaxParser<'_, F>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    type Declaration = ();
    type Error = Error;

    fn parse_value<'t>(
        &mut self,
        _name: CowRcStr<'i>,
        input: &mut Parser<'i, 't>,
        _start: &cssparser::ParserState,
    ) -> Result<Self::Declaration, ParseError<'i, Self::Error>> {
        self.scan(input, false)
    }
}

impl<'i, F> RuleBodyItemParser<'i, (), Error> for SyntaxParser<'_, F>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    fn parse_declarations(&self) -> bool {
        true
    }

    fn parse_qualified(&self) -> bool {
        false
    }
}

pub fn rewrite_stylesheet<F>(source: &str, route: F) -> Result<(String, Vec<Edit>), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    rewrite_in_mode(source, Mode::Stylesheet, route)
}

pub fn rewrite_declaration_list<F>(source: &str, route: F) -> Result<(String, Vec<Edit>), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    rewrite_in_mode(source, Mode::DeclarationList, route)
}

pub fn rewrite_component_value<F>(source: &str, route: F) -> Result<(String, Vec<Edit>), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    rewrite_in_mode(source, Mode::ComponentValue, route)
}

pub fn rewrite<F>(source: &str, mode: Mode, route: F) -> Result<(String, Vec<Edit>), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    rewrite_in_mode(source, mode, route)
}

fn rewrite_in_mode<F>(source: &str, mode: Mode, mut route: F) -> Result<(String, Vec<Edit>), Error>
where
    F: FnMut(&str) -> Result<String, Error>,
{
    let mut input = ParserInput::new(source);
    let mut parser = Parser::new(&mut input);
    let mut edits = Vec::new();
    match mode {
        Mode::ComponentValue => scan_tokens(&mut parser, &mut route, &mut edits, false)?,
        Mode::Stylesheet => {
            let mut syntax = SyntaxParser {
                route: &mut route,
                edits: &mut edits,
                failure: None,
                imports_open: true,
            };
            for _ in StyleSheetParser::new(&mut parser, &mut syntax) {}
            if let Some(error) = syntax.failure {
                return Err(error);
            }
        }
        Mode::DeclarationList => {
            let mut syntax = SyntaxParser {
                route: &mut route,
                edits: &mut edits,
                failure: None,
                imports_open: false,
            };
            for _ in RuleBodyParser::new(&mut parser, &mut syntax) {}
            if let Some(error) = syntax.failure {
                return Err(error);
            }
        }
    }
    edits.sort_by_key(|edit| edit.start);
    for pair in edits.windows(2) {
        if pair[0].end > pair[1].start {
            return Err(Error::Overlap);
        }
    }
    let mut output = source.to_owned();
    for edit in edits.iter().rev() {
        output.replace_range(edit.start..edit.end, &edit.replacement);
    }
    Ok((output, edits))
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\a ")
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn rewrite_with(
    source: &str,
    mode: &str,
    route: &js_sys::Function,
) -> Result<String, wasm_bindgen::JsValue> {
    let mode = match mode {
        "stylesheet" => Mode::Stylesheet,
        "declaration-list" => Mode::DeclarationList,
        "component-value" => Mode::ComponentValue,
        _ => return Err(wasm_bindgen::JsValue::from_str("invalid CSS mode")),
    };
    rewrite(source, mode, |url| {
        route
            .call1(
                &wasm_bindgen::JsValue::NULL,
                &wasm_bindgen::JsValue::from_str(url),
            )
            .map_err(|_| Error::Blocked)?
            .as_string()
            .ok_or(Error::Blocked)
    })
    .map(|(output, _)| output)
    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_only_url_spans() {
        let source = "/*keep*/a{background:url('../x.png');color:red}";
        let (out, edits) =
            rewrite(source, Mode::Stylesheet, |url| Ok(format!("/_zp/{url}"))).unwrap();
        assert!(out.starts_with("/*keep*/a{"));
        assert!(out.contains("url(\"/_zp/../x.png\")"));
        assert_eq!(edits.len(), 1);
    }
    #[test]
    fn rewrites_string_import_and_nested_modern_functions() {
        let source = "@import \"theme.css\" layer(base);a{background:image-set(url(a.png) 1x,url('b.png') 2x)}";
        let (out, edits) =
            rewrite(source, Mode::Stylesheet, |url| Ok(format!("/r/{url}"))).unwrap();
        assert!(out.contains("@import \"/r/theme.css\""));
        assert!(out.contains("url(/r/a.png)"));
        assert!(out.contains("url(\"/r/b.png\")"));
        assert_eq!(edits.len(), 3);
    }
    #[test]
    fn blocked_url_fails_without_output() {
        assert_eq!(
            rewrite("a{src:url(x)}", Mode::Stylesheet, |_| Err(Error::Blocked)),
            Err(Error::Blocked)
        );
    }

    #[test]
    fn modes_only_treat_top_level_import_strings_as_stylesheet_imports() {
        let source = "@import \"theme.css\"; color: url(icon.svg);";
        let stylesheet = rewrite_stylesheet(source, |url| Ok(format!("/r/{url}")))
            .unwrap()
            .0;
        let declarations = rewrite_declaration_list(source, |url| Ok(format!("/r/{url}")))
            .unwrap()
            .0;
        let component = rewrite_component_value(source, |url| Ok(format!("/r/{url}")))
            .unwrap()
            .0;
        assert_eq!(
            stylesheet,
            "@import \"/r/theme.css\"; color: url(/r/icon.svg);"
        );
        assert_eq!(
            declarations,
            "@import \"theme.css\"; color: url(/r/icon.svg);"
        );
        assert_eq!(component, "@import \"theme.css\"; color: url(/r/icon.svg);");
    }

    #[test]
    fn nested_import_strings_are_not_stylesheet_imports() {
        let source = "@media screen { @import \"nested.css\"; a { background: url(icon.svg) } }";
        let output = rewrite_stylesheet(source, |url| Ok(format!("/r/{url}")))
            .unwrap()
            .0;
        assert_eq!(
            output,
            "@media screen { @import \"nested.css\"; a { background: url(/r/icon.svg) } }"
        );
    }

    #[test]
    fn stylesheet_parser_does_not_accept_import_after_a_qualified_rule() {
        let output = rewrite_stylesheet(
            "a { background: url(first.png) } @import \"late.css\";",
            |url| Ok(format!("/r/{url}")),
        )
        .unwrap()
        .0;
        assert_eq!(
            output,
            "a { background: url(/r/first.png) } @import \"late.css\";"
        );
    }

    #[test]
    fn declaration_parser_recovers_after_a_malformed_declaration() {
        let output = rewrite_declaration_list(
            "broken ???; background: image-set(url(good.png) 1x);",
            |url| Ok(format!("/r/{url}")),
        )
        .unwrap()
        .0;
        assert_eq!(
            output,
            "broken ???; background: image-set(url(/r/good.png) 1x);"
        );
    }

    #[test]
    fn stylesheet_parser_keeps_import_eligible_after_a_layer_statement() {
        let output = rewrite_stylesheet("@layer base; @import \"target.css\";", |url| {
            Ok(format!("/r/{url}"))
        })
        .unwrap()
        .0;
        assert_eq!(output, "@layer base; @import \"/r/target.css\";");
    }

    #[test]
    fn stylesheet_parser_recovers_after_a_malformed_url() {
        let output = rewrite_stylesheet(
            "a{background:url(bad space)} b{background:url(good.png)}",
            |url| Ok(format!("/r/{url}")),
        )
        .unwrap()
        .0;
        assert_eq!(
            output,
            "a{background:url(bad space)} b{background:url(/r/good.png)}"
        );
    }
}
