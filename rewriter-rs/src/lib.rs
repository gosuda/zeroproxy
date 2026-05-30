use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, UpdateOperator};
use swc_css_ast::{
    DeclarationOrAtRule, ImportHref, ListOfComponentValues, Str, Stylesheet, UrlValue,
};
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
    pub fn ok(&self) -> bool {
        self.ok
    }
    #[wasm_bindgen(getter)]
    pub fn code(&self) -> String {
        self.code.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> String {
        self.error.clone()
    }
}

#[wasm_bindgen]
pub fn rewrite_script(
    source: &str,
    kind: &str,
    target_url: &str,
    control_prefix: &str,
) -> RewriteOutput {
    match normalize_kind(kind) {
        "module" => rewrite_program_source(source, true, target_url, control_prefix),
        "event-handler" => rewrite_wrapped_source(
            source,
            "function __zp_event__(event){\n",
            "\n}",
            false,
            target_url,
            control_prefix,
            true,
        ),
        "function" => rewrite_wrapped_source(
            source,
            "function __zp_dynamic__(){\n",
            "\n}",
            false,
            target_url,
            control_prefix,
            false,
        ),
        _ => rewrite_program_source(source, false, target_url, control_prefix),
    }
}

#[wasm_bindgen]
pub fn rewrite_css(source: &str, base_url: &str, control_prefix: &str) -> RewriteOutput {
    let control_prefix = if control_prefix.is_empty() {
        "/zp/"
    } else {
        control_prefix
    };
    match collect_css_replacements(source, base_url, control_prefix) {
        Ok(replacements) => RewriteOutput {
            ok: true,
            code: apply_css_replacements(source, replacements),
            error: String::new(),
        },
        Err(error) => RewriteOutput {
            ok: false,
            code: String::new(),
            error,
        },
    }
}

fn proxied_css_url(raw: &str, base_url: &str, control_prefix: &str) -> Option<String> {
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

fn collect_css_replacements(
    source: &str,
    base_url: &str,
    control_prefix: &str,
) -> Result<Vec<CssReplacement>, String> {
    use swc_common::{sync::Lrc, FileName, SourceMap};
    use swc_css_parser::{parse_file, parser::ParserConfig};

    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(FileName::Anon.into(), source.to_string());
    let start_pos = fm.start_pos.0;

    let mut stylesheet_errors = Vec::new();
    if let Ok(stylesheet) =
        parse_file::<Stylesheet>(&fm, None, ParserConfig::default(), &mut stylesheet_errors)
    {
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
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
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
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
        let mut collector = CssUrlCollector::new(base_url, control_prefix, start_pos, source.len());
        values.visit_with(&mut collector);
        return Ok(collector.replacements);
    }

    Err("CSS_PARSE_FAILED".to_string())
}

fn apply_css_replacements(source: &str, mut replacements: Vec<CssReplacement>) -> String {
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

struct CssUrlCollector<'a> {
    base_url: &'a str,
    control_prefix: &'a str,
    start_pos: u32,
    source_len: usize,
    replacements: Vec<CssReplacement>,
}

impl<'a> CssUrlCollector<'a> {
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
        let Some(next) = proxied_css_url(raw, self.base_url, self.control_prefix) else {
            return;
        };
        let Some((start, end)) = self.span_offsets(span) else {
            return;
        };
        self.replacements.push(CssReplacement {
            start,
            end,
            text: format!("\"{}\"", css_escape_string(&next, b'"')),
        });
    }

    fn add_string_replacement(&mut self, s: &Str) {
        self.add_quoted_replacement(s.span, s.value.as_ref());
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
        let Some(value) = node.value.as_ref() else {
            return;
        };
        match &**value {
            UrlValue::Str(s) => self.add_string_replacement(s),
            UrlValue::Raw(raw) => self.add_quoted_replacement(raw.span, raw.value.as_ref()),
        }
    }
}

fn normalize_kind(kind: &str) -> &'static str {
    match kind {
        "module" => "module",
        "event-handler" | "event" => "event-handler",
        "function" => "function",
        _ => "classic",
    }
}

fn rewrite_program_source(
    source: &str,
    module: bool,
    target_url: &str,
    control_prefix: &str,
) -> RewriteOutput {
    let allocator = Allocator::default();
    let source_type = if module {
        SourceType::mjs()
    } else {
        SourceType::cjs()
    };
    let ret = Parser::new(&allocator, source, source_type).parse();
    if !ret.errors.is_empty() {
        return RewriteOutput {
            ok: false,
            code: String::new(),
            error: "PARSE_FAILED".to_string(),
        };
    }
    let mut rewriter = Rewriter::new(source, module, target_url, control_prefix);
    rewriter.walk_program(&ret.program);
    RewriteOutput {
        ok: true,
        code: rewriter.finish(),
        error: String::new(),
    }
}

fn rewrite_wrapped_source(
    source: &str,
    prefix: &str,
    suffix: &str,
    module: bool,
    target_url: &str,
    control_prefix: &str,
    event_handler: bool,
) -> RewriteOutput {
    let mut wrapped = String::with_capacity(prefix.len() + source.len() + suffix.len());
    wrapped.push_str(prefix);
    wrapped.push_str(source);
    wrapped.push_str(suffix);
    let out = rewrite_program_source(&wrapped, module, target_url, control_prefix);
    if !out.ok {
        return out;
    }
    if out.code.len() < prefix.len() + suffix.len() {
        return RewriteOutput {
            ok: false,
            code: String::new(),
            error: "REWRITE_FAILED".to_string(),
        };
    }
    let inner_end = out.code.len() - suffix.len();
    let inner = &out.code[prefix.len()..inner_end];
    let code = if event_handler {
        let mut event = String::with_capacity(inner.len() + 76);
        event.push_str("return __zp_runEvent(this,event,function(__zp_scope){with(__zp_scope){\n");
        event.push_str(inner);
        event.push_str("\n}})");
        event
    } else {
        inner.to_string()
    };
    RewriteOutput {
        ok: true,
        code,
        error: String::new(),
    }
}

const GLOBALS: &[&str] = &[
    "window",
    "self",
    "globalThis",
    "location",
    "origin",
    "document",
    "history",
    "top",
    "parent",
    "opener",
    "frames",
    "WebSocket",
    "eval",
    "Function",
    "AsyncFunction",
    "GeneratorFunction",
    "AsyncGeneratorFunction",
];
const MEMBER_HELPER_PROPS: &[&str] = &[
    "location",
    "defaultView",
    "contentWindow",
    "contentDocument",
    "top",
    "parent",
    "opener",
    "frames",
    "constructor",
    "postMessage",
];
const CALL_HELPER_PROPS: &[&str] = &[
    "assign",
    "replace",
    "open",
    "get",
    "has",
    "ownKeys",
    "keys",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "defineProperty",
];

#[derive(Clone)]
struct Replacement {
    start: usize,
    end: usize,
    text: String,
    priority: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScopeMode {
    FunctionRoot,
    Block,
}

struct Rewriter<'a> {
    source: &'a str,
    module: bool,
    target_url: &'a str,
    control_prefix: &'a str,
    replacements: Vec<Replacement>,
    scopes: Vec<HashSet<String>>,
    window_aliases: Vec<HashSet<String>>,
    document_aliases: Vec<HashSet<String>>,
}

impl<'a> Rewriter<'a> {
    fn new(source: &'a str, module: bool, target_url: &'a str, control_prefix: &'a str) -> Self {
        Self {
            source,
            module,
            target_url,
            control_prefix: if control_prefix.is_empty() {
                "/zp/"
            } else {
                control_prefix
            },
            replacements: Vec::new(),
            scopes: Vec::new(),
            window_aliases: Vec::new(),
            document_aliases: Vec::new(),
        }
    }

    fn finish(mut self) -> String {
        self.replacements.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then(b.priority.cmp(&a.priority))
                .then((b.end - b.start).cmp(&(a.end - a.start)))
        });
        let mut chosen: Vec<Replacement> = Vec::new();
        let mut covered_end = 0usize;
        for r in self.replacements {
            if !chosen.is_empty() && r.start < covered_end {
                continue;
            }
            covered_end = r.end;
            chosen.push(r);
        }
        let mut out = String::with_capacity(
            self.source.len() + chosen.iter().map(|r| r.text.len()).sum::<usize>(),
        );
        let mut pos = 0usize;
        for r in chosen {
            out.push_str(&self.source[pos..r.start]);
            out.push_str(&r.text);
            pos = r.end;
        }
        out.push_str(&self.source[pos..]);
        out
    }

    fn span_text(&self, span: Span) -> &str {
        self.source
            .get(span.start as usize..span.end as usize)
            .unwrap_or("")
    }

    fn push_scope(&mut self, scope: HashSet<String>) {
        self.scopes.push(scope);
        self.window_aliases.push(HashSet::new());
        self.document_aliases.push(HashSet::new());
    }
    fn pop_scope(&mut self) {
        self.scopes.pop();
        self.window_aliases.pop();
        self.document_aliases.pop();
    }
    fn declare(&mut self, name: &str) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.insert(name.to_string());
        }
    }
    fn declared(&self, name: &str) -> bool {
        self.scopes.iter().rev().any(|scope| scope.contains(name))
    }
    fn declare_window_alias(&mut self, name: &str) {
        if let Some(scope) = self.window_aliases.last_mut() {
            scope.insert(name.to_string());
        }
    }
    fn remove_window_alias(&mut self, name: &str) {
        if let Some(scope) = self.window_aliases.last_mut() {
            scope.remove(name);
        }
    }
    fn is_window_alias(&self, name: &str) -> bool {
        self.window_aliases
            .iter()
            .rev()
            .any(|scope| scope.contains(name))
    }
    fn declare_document_alias(&mut self, name: &str) {
        if let Some(scope) = self.document_aliases.last_mut() {
            scope.insert(name.to_string());
        }
    }
    fn remove_document_alias(&mut self, name: &str) {
        if let Some(scope) = self.document_aliases.last_mut() {
            scope.remove(name);
        }
    }
    fn is_document_alias(&self, name: &str) -> bool {
        self.document_aliases
            .iter()
            .rev()
            .any(|scope| scope.contains(name))
    }
    fn add_replacement(&mut self, span: Span, text: String, priority: i32) {
        let start = span.start as usize;
        let end = span.end as usize;
        if start < end {
            self.replacements.push(Replacement {
                start,
                end,
                text,
                priority,
            });
        }
    }

    fn walk_program(&mut self, program: &Program<'a>) {
        self.push_scope(self.collect_body_bindings(&program.body, ScopeMode::FunctionRoot));
        for stmt in &program.body {
            self.walk_statement(stmt);
        }
        self.pop_scope();
    }

    fn walk_statement(&mut self, stmt: &Statement<'a>) {
        match stmt {
            Statement::BlockStatement(block) => self.walk_block_statement(block),
            Statement::ExpressionStatement(expr) => {
                self.walk_expression_statement(stmt.span(), &expr.expression)
            }
            Statement::IfStatement(stmt) => {
                self.walk_expression(&stmt.test);
                self.walk_statement(&stmt.consequent);
                if let Some(alt) = &stmt.alternate {
                    self.walk_statement(alt);
                }
            }
            Statement::WhileStatement(stmt) => {
                self.walk_expression(&stmt.test);
                self.walk_statement(&stmt.body);
            }
            Statement::DoWhileStatement(stmt) => {
                self.walk_statement(&stmt.body);
                self.walk_expression(&stmt.test);
            }
            Statement::ForStatement(stmt) => self.walk_for_statement(stmt),
            Statement::ForInStatement(stmt) => self.walk_for_in_statement(stmt),
            Statement::ForOfStatement(stmt) => self.walk_for_of_statement(stmt),
            Statement::ReturnStatement(stmt) => {
                if let Some(arg) = &stmt.argument {
                    self.walk_expression(arg);
                }
            }
            Statement::ThrowStatement(stmt) => self.walk_expression(&stmt.argument),
            Statement::SwitchStatement(stmt) => self.walk_switch_statement(stmt),
            Statement::TryStatement(stmt) => self.walk_try_statement(stmt),
            Statement::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
            Statement::FunctionDeclaration(func) => self.walk_function(func),
            Statement::ClassDeclaration(class) => self.walk_class(class, true),
            Statement::ImportDeclaration(decl) => self.rewrite_module_source(&decl.source),
            Statement::ExportNamedDeclaration(decl) => {
                if let Some(source) = &decl.source {
                    self.rewrite_module_source(source);
                }
                if let Some(inner) = &decl.declaration {
                    self.walk_declaration(inner);
                }
            }
            Statement::ExportAllDeclaration(decl) => self.rewrite_module_source(&decl.source),
            Statement::ExportDefaultDeclaration(decl) => self.walk_export_default(decl),
            _ => {}
        }
    }

    fn rewrite_module_source(&mut self, source: &StringLiteral<'a>) {
        self.add_replacement(
            source.span,
            format!("{:?}", self.module_specifier(source.value.as_str())),
            95,
        );
    }

    fn walk_expression_statement(&mut self, stmt_span: Span, expr: &Expression<'a>) {
        if let Expression::AssignmentExpression(assign) = expr {
            if self.assignment_target(&assign.left).is_some() {
                self.add_replacement(
                    stmt_span,
                    format!("{};", self.render_assignment_expression(assign)),
                    100,
                );
                return;
            }
        }
        self.walk_expression(expr)
    }

    fn for_left_is_scoped(left: &ForStatementLeft<'a>) -> bool {
        matches!(left, ForStatementLeft::VariableDeclaration(decl) if decl.kind != VariableDeclarationKind::Var)
    }

    fn walk_for_left(&mut self, left: &ForStatementLeft<'a>) {
        match left {
            ForStatementLeft::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
            _ => self.walk_assignment_target(left.to_assignment_target()),
        }
    }

    fn walk_for_statement(&mut self, stmt: &ForStatement<'a>) {
        let scoped = matches!(stmt.init.as_ref(), Some(ForStatementInit::VariableDeclaration(decl)) if decl.kind != VariableDeclarationKind::Var);
        if scoped {
            self.push_scope(HashSet::new());
        }
        if let Some(init) = &stmt.init {
            match init {
                ForStatementInit::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
                _ => self.walk_expression(init.to_expression()),
            }
        }
        if let Some(test) = &stmt.test {
            self.walk_expression(test);
        }
        if let Some(update) = &stmt.update {
            self.walk_expression(update);
        }
        self.walk_statement(&stmt.body);
        if scoped {
            self.pop_scope();
        }
    }

    fn walk_for_in_statement(&mut self, stmt: &ForInStatement<'a>) {
        let scoped = Self::for_left_is_scoped(&stmt.left);
        if scoped {
            self.push_scope(HashSet::new());
        }
        self.walk_for_left(&stmt.left);
        self.walk_expression(&stmt.right);
        self.walk_statement(&stmt.body);
        if scoped {
            self.pop_scope();
        }
    }

    fn walk_for_of_statement(&mut self, stmt: &ForOfStatement<'a>) {
        let scoped = Self::for_left_is_scoped(&stmt.left);
        if scoped {
            self.push_scope(HashSet::new());
        }
        self.walk_for_left(&stmt.left);
        self.walk_expression(&stmt.right);
        self.walk_statement(&stmt.body);
        if scoped {
            self.pop_scope();
        }
    }

    fn walk_switch_statement(&mut self, stmt: &SwitchStatement<'a>) {
        self.walk_expression(&stmt.discriminant);
        for case in &stmt.cases {
            if let Some(test) = &case.test {
                self.walk_expression(test);
            }
            for stmt in &case.consequent {
                self.walk_statement(stmt);
            }
        }
    }

    fn walk_try_statement(&mut self, stmt: &TryStatement<'a>) {
        self.walk_block_statement(&stmt.block);
        if let Some(handler) = &stmt.handler {
            let mut scope = HashSet::new();
            if let Some(param) = &handler.param {
                self.collect_binding_pattern(&param.pattern, &mut scope);
            }
            self.push_scope(scope);
            self.walk_block_statement(&handler.body);
            self.pop_scope();
        }
        if let Some(finalizer) = &stmt.finalizer {
            self.walk_block_statement(finalizer);
        }
    }
    fn walk_declaration(&mut self, decl: &Declaration<'a>) {
        match decl {
            Declaration::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
            Declaration::FunctionDeclaration(func) => self.walk_function(func),
            Declaration::ClassDeclaration(class) => self.walk_class(class, true),
            _ => {}
        }
    }
    fn walk_export_default(&mut self, decl: &ExportDefaultDeclaration<'a>) {
        match &decl.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(func) => self.walk_function(func),
            ExportDefaultDeclarationKind::ClassDeclaration(class) => self.walk_class(class, true),
            other => {
                if let Some(expr) = other.as_expression() {
                    self.walk_expression(expr);
                }
            }
        }
    }
    fn walk_function(&mut self, func: &Function<'a>) {
        if let Some(id) = &func.id {
            self.declare(id.name.as_str());
        }
        let mut scope = HashSet::new();
        if let Some(id) = &func.id {
            scope.insert(id.name.to_string());
        }
        self.collect_formal_parameters(&func.params, &mut scope);
        if let Some(body) = &func.body {
            let body_scope = self.collect_body_bindings(&body.statements, ScopeMode::FunctionRoot);
            scope.extend(body_scope);
            self.push_scope(scope);
            for stmt in &body.statements {
                self.walk_statement(stmt);
            }
            self.pop_scope();
        }
    }
    fn walk_class(&mut self, class: &Class<'a>, declare_id: bool) {
        if declare_id {
            if let Some(id) = &class.id {
                self.declare(id.name.as_str());
            }
        }
        if let Some(super_class) = &class.super_class {
            self.walk_expression(super_class);
        }
        let mut pushed_name_scope = false;
        if let Some(id) = &class.id {
            let mut scope = HashSet::new();
            scope.insert(id.name.to_string());
            self.push_scope(scope);
            pushed_name_scope = true;
        }
        for elem in &class.body.body {
            match elem {
                ClassElement::StaticBlock(block) => {
                    self.push_scope(self.collect_body_bindings(&block.body, ScopeMode::Block));
                    for stmt in &block.body {
                        self.walk_statement(stmt);
                    }
                    self.pop_scope();
                }
                ClassElement::MethodDefinition(method) => {
                    if method.computed {
                        self.walk_property_key(&method.key);
                    }
                    self.walk_function(&method.value);
                }
                ClassElement::PropertyDefinition(prop) => {
                    if prop.computed {
                        self.walk_property_key(&prop.key);
                    }
                    if let Some(value) = &prop.value {
                        self.walk_expression(value);
                    }
                }
                ClassElement::AccessorProperty(prop) => {
                    if prop.computed {
                        self.walk_property_key(&prop.key);
                    }
                    if let Some(value) = &prop.value {
                        self.walk_expression(value);
                    }
                }
                _ => {}
            }
        }
        if pushed_name_scope {
            self.pop_scope();
        }
    }
    fn walk_block_statement(&mut self, block: &BlockStatement<'a>) {
        self.push_scope(self.collect_body_bindings(&block.body, ScopeMode::Block));
        for stmt in &block.body {
            self.walk_statement(stmt);
        }
        self.pop_scope();
    }

    fn walk_variable_declaration(&mut self, decl: &VariableDeclaration<'a>) {
        for declarator in &decl.declarations {
            self.declare_binding_pattern(&declarator.id);
            if let BindingPatternKind::BindingIdentifier(id) = &declarator.id.kind {
                if let Some(init) = &declarator.init {
                    if self.expression_is_window_alias_source(init) {
                        self.declare_window_alias(id.name.as_str());
                        self.add_replacement(
                            init.span(),
                            self.render_window_alias_source(init),
                            80,
                        );
                    } else if self.expression_is_document_alias_source(init) {
                        self.declare_document_alias(id.name.as_str());
                        self.add_replacement(init.span(), self.render_expression(init), 80);
                    }
                }
            }
            self.walk_binding_pattern(&declarator.id);
            if let Some(init) = &declarator.init {
                self.walk_expression(init);
            }
        }
    }

    fn declare_binding_pattern(&mut self, pattern: &BindingPattern<'a>) {
        let mut names = HashSet::new();
        self.collect_binding_pattern(pattern, &mut names);
        for name in names {
            self.declare(&name);
        }
    }

    fn walk_binding_pattern(&mut self, pattern: &BindingPattern<'a>) {
        match &pattern.kind {
            BindingPatternKind::BindingIdentifier(_) => {}
            BindingPatternKind::AssignmentPattern(pat) => {
                self.walk_binding_pattern(&pat.left);
                self.walk_expression(&pat.right);
            }
            BindingPatternKind::ArrayPattern(arr) => {
                for p in (&arr.elements).into_iter().flatten() {
                    self.walk_binding_pattern(p);
                }
                if let Some(rest) = &arr.rest {
                    self.walk_binding_pattern(&rest.argument);
                }
            }
            BindingPatternKind::ObjectPattern(obj) => {
                for prop in &obj.properties {
                    if prop.computed {
                        self.walk_property_key(&prop.key);
                    }
                    self.walk_binding_pattern(&prop.value);
                }
                if let Some(rest) = &obj.rest {
                    self.walk_binding_pattern(&rest.argument);
                }
            }
        }
    }

    fn walk_assignment_target(&mut self, target: &AssignmentTarget<'a>) {
        match target {
            AssignmentTarget::AssignmentTargetIdentifier(_) => {}
            AssignmentTarget::ComputedMemberExpression(expr) => {
                self.walk_expression(&expr.object);
                self.walk_expression(&expr.expression);
            }
            AssignmentTarget::StaticMemberExpression(expr) => self.walk_expression(&expr.object),
            AssignmentTarget::PrivateFieldExpression(expr) => self.walk_expression(&expr.object),
            AssignmentTarget::ArrayAssignmentTarget(arr) => {
                for item in (&arr.elements).into_iter().flatten() {
                    self.walk_assignment_target_maybe_default(item);
                }
                if let Some(rest) = &arr.rest {
                    self.walk_assignment_target(&rest.target);
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(obj) => {
                for prop in &obj.properties {
                    match prop {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(id) => {
                            if let Some(init) = &id.init {
                                self.walk_expression(init);
                            }
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(prop) => {
                            if prop.computed {
                                self.walk_property_key(&prop.name);
                            }
                            self.walk_assignment_target_maybe_default(&prop.binding);
                        }
                    }
                }
                if let Some(rest) = &obj.rest {
                    self.walk_assignment_target(&rest.target);
                }
            }
            _ => {}
        }
    }

    fn walk_assignment_target_maybe_default(&mut self, target: &AssignmentTargetMaybeDefault<'a>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetIdentifier(_) => {}
            AssignmentTargetMaybeDefault::ComputedMemberExpression(expr) => {
                self.walk_expression(&expr.object);
                self.walk_expression(&expr.expression);
            }
            AssignmentTargetMaybeDefault::StaticMemberExpression(expr) => {
                self.walk_expression(&expr.object)
            }
            AssignmentTargetMaybeDefault::PrivateFieldExpression(expr) => {
                self.walk_expression(&expr.object)
            }
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(target) => {
                self.walk_assignment_target(&target.binding);
                self.walk_expression(&target.init);
            }
            _ => {}
        }
    }

    fn walk_property_key(&mut self, key: &PropertyKey<'a>) {
        match key {
            PropertyKey::StaticIdentifier(_) | PropertyKey::PrivateIdentifier(_) => {}
            _ => self.walk_expression(key.to_expression()),
        }
    }

    fn walk_expression(&mut self, expr: &Expression<'a>) {
        match expr {
            Expression::Identifier(id) => {
                if self.is_global_name(id.name.as_str()) && !self.declared(id.name.as_str()) {
                    self.add_replacement(
                        id.span,
                        format!("__zp_get(globalThis,{:?})", id.name.as_str()),
                        10,
                    );
                }
            }
            Expression::StaticMemberExpression(expr) => self.walk_static_member_expression(expr),
            Expression::ComputedMemberExpression(expr) => {
                self.walk_computed_member_expression(expr)
            }
            Expression::PrivateFieldExpression(expr) => self.walk_expression(&expr.object),
            Expression::AssignmentExpression(expr) => self.walk_assignment_expression(expr),
            Expression::UpdateExpression(expr) => self.walk_update_expression(expr),
            Expression::ImportExpression(expr) => self.walk_import_expression(expr),
            Expression::CallExpression(expr) => self.walk_call_expression(expr),
            Expression::NewExpression(expr) => self.walk_new_expression(expr),
            Expression::BinaryExpression(expr) => self.walk_binary_expression(expr),
            Expression::LogicalExpression(expr) => {
                self.walk_expression(&expr.left);
                self.walk_expression(&expr.right);
            }
            Expression::ConditionalExpression(expr) => {
                self.walk_expression(&expr.test);
                self.walk_expression(&expr.consequent);
                self.walk_expression(&expr.alternate);
            }
            Expression::UnaryExpression(expr) => self.walk_expression(&expr.argument),
            Expression::AwaitExpression(expr) => self.walk_expression(&expr.argument),
            Expression::YieldExpression(expr) => {
                if let Some(arg) = &expr.argument {
                    self.walk_expression(arg);
                }
            }
            Expression::SequenceExpression(expr) => {
                for e in &expr.expressions {
                    self.walk_expression(e);
                }
            }
            Expression::ParenthesizedExpression(expr) => self.walk_expression(&expr.expression),
            Expression::ChainExpression(expr) => self.walk_chain_element(&expr.expression),
            Expression::ObjectExpression(expr) => self.walk_object_expression(expr),
            Expression::ArrayExpression(expr) => self.walk_array_expression(expr),
            Expression::FunctionExpression(func) => self.walk_function(func),
            Expression::ClassExpression(class) => self.walk_class(class, false),
            Expression::ArrowFunctionExpression(func) => self.walk_arrow_function(func),
            Expression::TemplateLiteral(tpl) => {
                for expr in &tpl.expressions {
                    self.walk_expression(expr);
                }
            }
            Expression::TaggedTemplateExpression(tagged) => {
                self.walk_expression(&tagged.tag);
                for expr in &tagged.quasi.expressions {
                    self.walk_expression(expr);
                }
            }
            Expression::TSAsExpression(expr) => self.walk_expression(&expr.expression),
            Expression::TSSatisfiesExpression(expr) => self.walk_expression(&expr.expression),
            Expression::TSNonNullExpression(expr) => self.walk_expression(&expr.expression),
            Expression::TSTypeAssertion(expr) => self.walk_expression(&expr.expression),
            Expression::TSInstantiationExpression(expr) => self.walk_expression(&expr.expression),
            _ => {}
        }
    }

    fn member_get_helper(&self, span: Span) -> &'static str {
        if self.member_access_is_optional(span) {
            "__zp_optionalGet"
        } else {
            "__zp_get"
        }
    }

    fn walk_static_member_expression(&mut self, expr: &StaticMemberExpression<'a>) {
        if self.is_import_meta_url_static(expr) {
            self.add_replacement(expr.span, format!("{:?}", self.target_url), 90);
            return;
        }
        if self.member_needs_helper_static(expr) {
            self.add_replacement(
                expr.span,
                format!(
                    "{}({},{:?})",
                    self.member_get_helper(expr.span),
                    self.render_expression(&expr.object),
                    expr.property.name.as_str()
                ),
                80,
            );
            return;
        }
        self.walk_expression(&expr.object);
    }

    fn walk_computed_member_expression(&mut self, expr: &ComputedMemberExpression<'a>) {
        if self.member_needs_helper_computed(expr) {
            self.add_replacement(
                expr.span,
                format!(
                    "{}({},{})",
                    self.member_get_helper(expr.span),
                    self.render_expression(&expr.object),
                    self.render_expression(&expr.expression)
                ),
                80,
            );
            return;
        }
        self.walk_expression(&expr.object);
        self.walk_expression(&expr.expression);
    }

    fn walk_chain_element(&mut self, elem: &ChainElement<'a>) {
        match elem {
            ChainElement::CallExpression(call) => self.walk_call_expression(call),
            ChainElement::TSNonNullExpression(inner) => self.walk_expression(&inner.expression),
            ChainElement::ComputedMemberExpression(inner) => {
                self.walk_expression(&inner.object);
                self.walk_expression(&inner.expression);
            }
            ChainElement::StaticMemberExpression(inner) => self.walk_expression(&inner.object),
            ChainElement::PrivateFieldExpression(inner) => self.walk_expression(&inner.object),
        }
    }

    fn walk_object_expression(&mut self, expr: &ObjectExpression<'a>) {
        for prop in &expr.properties {
            match prop {
                ObjectPropertyKind::ObjectProperty(prop) => self.walk_object_property(prop),
                ObjectPropertyKind::SpreadProperty(prop) => self.walk_expression(&prop.argument),
            }
        }
    }

    fn walk_object_property(&mut self, prop: &ObjectProperty<'a>) {
        if prop.computed {
            self.walk_property_key(&prop.key);
        }
        if prop.shorthand {
            if let Expression::Identifier(id) = &prop.value {
                if self.is_global_name(id.name.as_str()) && !self.declared(id.name.as_str()) {
                    self.add_replacement(
                        prop.span,
                        format!(
                            "{}: {}",
                            self.span_text(prop.key.span()),
                            self.render_expression(&prop.value)
                        ),
                        90,
                    );
                    return;
                }
            }
        }
        self.walk_expression(&prop.value);
    }

    fn walk_array_expression(&mut self, expr: &ArrayExpression<'a>) {
        for elem in &expr.elements {
            match elem {
                ArrayExpressionElement::SpreadElement(spread) => {
                    self.walk_expression(&spread.argument)
                }
                ArrayExpressionElement::Elision(_) => {}
                _ => self.walk_expression(elem.to_expression()),
            }
        }
    }

    fn walk_arrow_function(&mut self, func: &ArrowFunctionExpression<'a>) {
        let mut scope = HashSet::new();
        self.collect_formal_parameters(&func.params, &mut scope);
        scope.extend(self.collect_body_bindings(&func.body.statements, ScopeMode::FunctionRoot));
        self.push_scope(scope);
        for stmt in &func.body.statements {
            self.walk_statement(stmt);
        }
        self.pop_scope();
    }

    fn walk_assignment_expression(&mut self, expr: &AssignmentExpression<'a>) {
        if expr.operator == AssignmentOperator::Assign {
            if let AssignmentTarget::AssignmentTargetIdentifier(id) = &expr.left {
                if self.expression_is_window_alias_source(&expr.right) {
                    self.declare_window_alias(id.name.as_str());
                    self.remove_document_alias(id.name.as_str());
                    self.add_replacement(
                        expr.span,
                        format!(
                            "{} = {}",
                            self.span_text(id.span),
                            self.render_window_alias_source(&expr.right)
                        ),
                        80,
                    );
                    return;
                } else if self.expression_is_document_alias_source(&expr.right) {
                    self.declare_document_alias(id.name.as_str());
                    self.remove_window_alias(id.name.as_str());
                    self.add_replacement(
                        expr.span,
                        format!(
                            "{} = {}",
                            self.span_text(id.span),
                            self.render_expression(&expr.right)
                        ),
                        80,
                    );
                    return;
                } else {
                    self.remove_window_alias(id.name.as_str());
                    self.remove_document_alias(id.name.as_str());
                }
            }
        }
        if let Some((base, prop)) = self.assignment_target(&expr.left) {
            if expr.operator == AssignmentOperator::Assign {
                self.add_replacement(
                    expr.span,
                    format!(
                        "(__zp_set({},{},{}))",
                        base,
                        prop,
                        self.render_expression(&expr.right)
                    ),
                    100,
                );
                return;
            }
            let op = assignment_operator_text(expr.operator);
            let rhs = if matches!(
                expr.operator,
                AssignmentOperator::LogicalAnd
                    | AssignmentOperator::LogicalOr
                    | AssignmentOperator::LogicalNullish
            ) {
                format!("()=>({})", self.render_expression(&expr.right))
            } else {
                self.render_expression(&expr.right)
            };
            self.add_replacement(
                expr.span,
                format!("(__zp_assign({},{},{:?},{}))", base, prop, op, rhs),
                100,
            );
            return;
        }
        self.walk_assignment_target(&expr.left);
        self.walk_expression(&expr.right);
    }

    fn walk_binary_expression(&mut self, expr: &BinaryExpression<'a>) {
        if expr.operator == BinaryOperator::In {
            self.add_replacement(
                expr.span,
                format!(
                    "(__zp_has({},{}))",
                    self.render_expression(&expr.right),
                    self.render_expression(&expr.left)
                ),
                90,
            );
            return;
        }
        self.walk_expression(&expr.left);
        self.walk_expression(&expr.right);
    }

    fn walk_update_expression(&mut self, expr: &UpdateExpression<'a>) {
        if let Some((base, prop)) = self.simple_assignment_target(&expr.argument) {
            self.add_replacement(
                expr.span,
                format!(
                    "(__zp_update({},{},{:?},{}))",
                    base,
                    prop,
                    update_operator_text(expr.operator),
                    expr.prefix
                ),
                100,
            );
            return;
        }
        self.walk_simple_assignment_target(&expr.argument);
    }

    fn walk_simple_assignment_target(&mut self, target: &SimpleAssignmentTarget<'a>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => {}
            SimpleAssignmentTarget::ComputedMemberExpression(expr) => {
                self.walk_expression(&expr.object);
                self.walk_expression(&expr.expression);
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr) => {
                self.walk_expression(&expr.object)
            }
            SimpleAssignmentTarget::PrivateFieldExpression(expr) => {
                self.walk_expression(&expr.object)
            }
            _ => {}
        }
    }

    fn walk_import_expression(&mut self, expr: &ImportExpression<'a>) {
        if let Expression::StringLiteral(spec) = &expr.source {
            self.add_replacement(
                spec.span,
                format!("{:?}", self.module_specifier(spec.value.as_str())),
                95,
            );
            return;
        }
        self.add_replacement(
            expr.source.span(),
            format!(
                "__zp_module_url({},{:?})",
                self.render_expression(&expr.source),
                self.target_url
            ),
            95,
        );
    }

    fn walk_call_expression(&mut self, expr: &CallExpression<'a>) {
        if let Some((base, prop)) = self.call_target(&expr.callee) {
            let args = self.render_arguments(&expr.arguments);
            let helper = if self.call_access_is_optional(expr.span, expr.callee.span()) {
                "__zp_optionalCall"
            } else {
                "__zp_call"
            };
            self.add_replacement(
                expr.span,
                format!("({}({},{},[{}]))", helper, base, prop, args),
                90,
            );
            return;
        }
        self.walk_expression(&expr.callee);
        for arg in &expr.arguments {
            self.walk_argument(arg);
        }
    }

    fn walk_new_expression(&mut self, expr: &NewExpression<'a>) {
        if let Some(target) = self.construct_target(&expr.callee) {
            let args = self.render_arguments(&expr.arguments);
            self.add_replacement(
                expr.span,
                format!("(__zp_construct({},[{}]))", target, args),
                90,
            );
            return;
        }
        self.walk_expression(&expr.callee);
        for arg in &expr.arguments {
            self.walk_argument(arg);
        }
    }

    fn walk_argument(&mut self, arg: &Argument<'a>) {
        match arg {
            Argument::SpreadElement(spread) => self.walk_expression(&spread.argument),
            _ => self.walk_expression(arg.to_expression()),
        }
    }

    fn render_arguments(&self, args: &[Argument<'a>]) -> String {
        args.iter()
            .map(|arg| match arg {
                Argument::SpreadElement(spread) => {
                    format!("...{}", self.render_expression(&spread.argument))
                }
                _ => self.render_expression(arg.to_expression()),
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    fn render_expression(&self, expr: &Expression<'a>) -> String {
        match expr {
            Expression::Identifier(id) => {
                if self.is_global_name(id.name.as_str()) && !self.declared(id.name.as_str()) {
                    format!("__zp_get(globalThis,{:?})", id.name.as_str())
                } else {
                    self.span_text(id.span).to_string()
                }
            }
            Expression::StaticMemberExpression(expr) => self.render_static_member(expr),
            Expression::ComputedMemberExpression(expr) => self.render_computed_member(expr),
            Expression::PrivateFieldExpression(expr) => self.render_span_with(
                expr.span,
                vec![(expr.object.span(), self.render_expression(&expr.object))],
            ),
            Expression::CallExpression(expr) => self.render_call_expression(expr),
            Expression::NewExpression(expr) => self.render_new_expression(expr),
            Expression::ImportExpression(expr) => self.render_import_expression(expr),
            Expression::BinaryExpression(expr) => self.render_binary_expression(expr),
            Expression::LogicalExpression(expr) => self.render_span_with(
                expr.span,
                vec![
                    (expr.left.span(), self.render_expression(&expr.left)),
                    (expr.right.span(), self.render_expression(&expr.right)),
                ],
            ),
            Expression::ConditionalExpression(expr) => self.render_span_with(
                expr.span,
                vec![
                    (expr.test.span(), self.render_expression(&expr.test)),
                    (
                        expr.consequent.span(),
                        self.render_expression(&expr.consequent),
                    ),
                    (
                        expr.alternate.span(),
                        self.render_expression(&expr.alternate),
                    ),
                ],
            ),
            Expression::UnaryExpression(expr) => self.render_span_with(
                expr.span,
                vec![(expr.argument.span(), self.render_expression(&expr.argument))],
            ),
            Expression::UpdateExpression(expr) => self.render_update_expression(expr),
            Expression::AwaitExpression(expr) => self.render_span_with(
                expr.span,
                vec![(expr.argument.span(), self.render_expression(&expr.argument))],
            ),
            Expression::YieldExpression(expr) => {
                if let Some(arg) = &expr.argument {
                    self.render_span_with(
                        expr.span,
                        vec![(arg.span(), self.render_expression(arg))],
                    )
                } else {
                    self.span_text(expr.span).to_string()
                }
            }
            Expression::SequenceExpression(expr) => self.render_span_with(
                expr.span,
                expr.expressions
                    .iter()
                    .map(|e| (e.span(), self.render_expression(e)))
                    .collect(),
            ),
            Expression::ParenthesizedExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            Expression::ChainExpression(expr) => {
                self.render_chain_element(expr.span, &expr.expression)
            }
            Expression::TemplateLiteral(expr) => self.render_span_with(
                expr.span,
                expr.expressions
                    .iter()
                    .map(|e| (e.span(), self.render_expression(e)))
                    .collect(),
            ),
            Expression::TaggedTemplateExpression(expr) => {
                let mut parts = Vec::with_capacity(expr.quasi.expressions.len() + 1);
                parts.push((expr.tag.span(), self.render_expression(&expr.tag)));
                parts.extend(
                    expr.quasi
                        .expressions
                        .iter()
                        .map(|e| (e.span(), self.render_expression(e))),
                );
                self.render_span_with(expr.span, parts)
            }
            Expression::ObjectExpression(expr) => self.render_object_expression(expr),
            Expression::ArrayExpression(expr) => self.render_array_expression(expr),
            Expression::AssignmentExpression(expr) => self.render_assignment_expression(expr),
            Expression::TSAsExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            Expression::TSSatisfiesExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            Expression::TSNonNullExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            Expression::TSTypeAssertion(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            Expression::TSInstantiationExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                )],
            ),
            _ => self.span_text(expr.span()).to_string(),
        }
    }

    fn render_binary_expression(&self, expr: &BinaryExpression<'a>) -> String {
        if expr.operator == BinaryOperator::In {
            return format!(
                "(__zp_has({},{}))",
                self.render_expression(&expr.right),
                self.render_expression(&expr.left)
            );
        }
        self.render_span_with(
            expr.span,
            vec![
                (expr.left.span(), self.render_expression(&expr.left)),
                (expr.right.span(), self.render_expression(&expr.right)),
            ],
        )
    }

    fn render_span_with(&self, span: Span, mut parts: Vec<(Span, String)>) -> String {
        parts.sort_by_key(|(part_span, _)| part_span.start);
        let start = span.start as usize;
        let end = span.end as usize;
        let mut out = String::with_capacity(
            end.saturating_sub(start) + parts.iter().map(|(_, text)| text.len()).sum::<usize>(),
        );
        let mut pos = start;
        for (part_span, text) in parts {
            let part_start = part_span.start as usize;
            let part_end = part_span.end as usize;
            if part_start < pos || part_end > end {
                continue;
            }
            out.push_str(&self.source[pos..part_start]);
            out.push_str(&text);
            pos = part_end;
        }
        out.push_str(&self.source[pos..end]);
        out
    }

    fn render_static_member(&self, expr: &StaticMemberExpression<'a>) -> String {
        if self.is_import_meta_url_static(expr) {
            return format!("{:?}", self.target_url);
        }
        if self.member_needs_helper_static(expr) {
            let helper = if self.member_access_is_optional(expr.span) {
                "__zp_optionalGet"
            } else {
                "__zp_get"
            };
            return format!(
                "{}({},{:?})",
                helper,
                self.render_expression(&expr.object),
                expr.property.name.as_str()
            );
        }
        self.render_span_with(
            expr.span,
            vec![(expr.object.span(), self.render_expression(&expr.object))],
        )
    }

    fn render_computed_member(&self, expr: &ComputedMemberExpression<'a>) -> String {
        if self.member_needs_helper_computed(expr) {
            let helper = if self.member_access_is_optional(expr.span) {
                "__zp_optionalGet"
            } else {
                "__zp_get"
            };
            return format!(
                "{}({},{})",
                helper,
                self.render_expression(&expr.object),
                self.render_expression(&expr.expression)
            );
        }
        self.render_span_with(
            expr.span,
            vec![
                (expr.object.span(), self.render_expression(&expr.object)),
                (
                    expr.expression.span(),
                    self.render_expression(&expr.expression),
                ),
            ],
        )
    }

    fn render_call_expression(&self, expr: &CallExpression<'a>) -> String {
        if let Some((base, prop)) = self.call_target(&expr.callee) {
            let helper = if self.call_access_is_optional(expr.span, expr.callee.span()) {
                "__zp_optionalCall"
            } else {
                "__zp_call"
            };
            return format!(
                "({}({},{},[{}]))",
                helper,
                base,
                prop,
                self.render_arguments(&expr.arguments)
            );
        }
        let mut parts = Vec::with_capacity(expr.arguments.len() + 1);
        parts.push((expr.callee.span(), self.render_expression(&expr.callee)));
        parts.extend(
            expr.arguments
                .iter()
                .map(|arg| (arg.span(), self.render_argument(arg))),
        );
        self.render_span_with(expr.span, parts)
    }

    fn render_new_expression(&self, expr: &NewExpression<'a>) -> String {
        if let Some(target) = self.construct_target(&expr.callee) {
            return format!(
                "(__zp_construct({},[{}]))",
                target,
                self.render_arguments(&expr.arguments)
            );
        }
        let mut parts = Vec::with_capacity(expr.arguments.len() + 1);
        parts.push((expr.callee.span(), self.render_expression(&expr.callee)));
        parts.extend(
            expr.arguments
                .iter()
                .map(|arg| (arg.span(), self.render_argument(arg))),
        );
        self.render_span_with(expr.span, parts)
    }

    fn render_import_expression(&self, expr: &ImportExpression<'a>) -> String {
        let source = if let Expression::StringLiteral(spec) = &expr.source {
            format!("{:?}", self.module_specifier(spec.value.as_str()))
        } else {
            format!(
                "__zp_module_url({},{:?})",
                self.render_expression(&expr.source),
                self.target_url
            )
        };
        self.render_span_with(expr.span, vec![(expr.source.span(), source)])
    }

    fn render_update_expression(&self, expr: &UpdateExpression<'a>) -> String {
        if let Some((base, prop)) = self.simple_assignment_target(&expr.argument) {
            return format!(
                "(__zp_update({},{},{:?},{}))",
                base,
                prop,
                update_operator_text(expr.operator),
                expr.prefix
            );
        }
        self.render_span_with(
            expr.span,
            vec![(
                expr.argument.span(),
                self.render_simple_assignment_target(&expr.argument),
            )],
        )
    }

    fn render_object_expression(&self, expr: &ObjectExpression<'a>) -> String {
        let mut parts = Vec::new();
        for prop in &expr.properties {
            match prop {
                ObjectPropertyKind::SpreadProperty(spread) => {
                    parts.push(format!("...{}", self.render_expression(&spread.argument)))
                }
                ObjectPropertyKind::ObjectProperty(prop) => {
                    if prop.method || prop.kind != PropertyKind::Init {
                        parts.push(self.span_text(prop.span).to_string());
                    } else if prop.shorthand {
                        parts.push(format!(
                            "{}: {}",
                            self.span_text(prop.key.span()),
                            self.render_expression(&prop.value)
                        ));
                    } else if prop.computed {
                        parts.push(format!(
                            "[{}]: {}",
                            self.render_property_key(&prop.key),
                            self.render_expression(&prop.value)
                        ));
                    } else {
                        parts.push(format!(
                            "{}: {}",
                            self.span_text(prop.key.span()),
                            self.render_expression(&prop.value)
                        ));
                    }
                }
            }
        }
        format!("{{{}}}", parts.join(","))
    }

    fn render_array_expression(&self, expr: &ArrayExpression<'a>) -> String {
        let mut parts = Vec::new();
        for elem in &expr.elements {
            match elem {
                ArrayExpressionElement::Elision(_) => parts.push(String::new()),
                ArrayExpressionElement::SpreadElement(spread) => {
                    parts.push(format!("...{}", self.render_expression(&spread.argument)))
                }
                _ => parts.push(self.render_expression(elem.to_expression())),
            }
        }
        format!("[{}]", parts.join(","))
    }

    fn render_assignment_expression(&self, expr: &AssignmentExpression<'a>) -> String {
        if let Some((base, prop)) = self.assignment_target(&expr.left) {
            if expr.operator == AssignmentOperator::Assign {
                format!(
                    "(__zp_set({},{},{}))",
                    base,
                    prop,
                    self.render_expression(&expr.right)
                )
            } else {
                let rhs = if matches!(
                    expr.operator,
                    AssignmentOperator::LogicalAnd
                        | AssignmentOperator::LogicalOr
                        | AssignmentOperator::LogicalNullish
                ) {
                    format!("()=>({})", self.render_expression(&expr.right))
                } else {
                    self.render_expression(&expr.right)
                };
                format!(
                    "(__zp_assign({},{},{:?},{}))",
                    base,
                    prop,
                    assignment_operator_text(expr.operator),
                    rhs
                )
            }
        } else {
            self.render_span_with(
                expr.span,
                vec![
                    (expr.left.span(), self.render_assignment_target(&expr.left)),
                    (expr.right.span(), self.render_expression(&expr.right)),
                ],
            )
        }
    }

    fn render_chain_element(&self, _span: Span, elem: &ChainElement<'a>) -> String {
        match elem {
            ChainElement::CallExpression(call) => self.render_call_expression(call),
            ChainElement::TSNonNullExpression(inner) => self.render_expression(&inner.expression),
            ChainElement::ComputedMemberExpression(inner) => self.render_computed_member(inner),
            ChainElement::StaticMemberExpression(inner) => self.render_static_member(inner),
            ChainElement::PrivateFieldExpression(inner) => self.render_span_with(
                inner.span,
                vec![(inner.object.span(), self.render_expression(&inner.object))],
            ),
        }
    }

    fn render_property_key(&self, key: &PropertyKey<'a>) -> String {
        match key {
            PropertyKey::StaticIdentifier(id) => id.name.to_string(),
            PropertyKey::PrivateIdentifier(id) => self.span_text(id.span).to_string(),
            _ => self.render_expression(key.to_expression()),
        }
    }

    fn render_argument(&self, arg: &Argument<'a>) -> String {
        match arg {
            Argument::SpreadElement(spread) => {
                format!("...{}", self.render_expression(&spread.argument))
            }
            _ => self.render_expression(arg.to_expression()),
        }
    }

    fn render_assignment_target(&self, target: &AssignmentTarget<'a>) -> String {
        match target {
            AssignmentTarget::AssignmentTargetIdentifier(id) => self.span_text(id.span).to_string(),
            AssignmentTarget::StaticMemberExpression(expr) => self.render_static_member(expr),
            AssignmentTarget::ComputedMemberExpression(expr) => self.render_computed_member(expr),
            AssignmentTarget::PrivateFieldExpression(expr) => self.render_span_with(
                expr.span,
                vec![(expr.object.span(), self.render_expression(&expr.object))],
            ),
            _ => self.span_text(target.span()).to_string(),
        }
    }

    fn render_simple_assignment_target(&self, target: &SimpleAssignmentTarget<'a>) -> String {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
                self.span_text(id.span).to_string()
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr) => self.render_static_member(expr),
            SimpleAssignmentTarget::ComputedMemberExpression(expr) => {
                self.render_computed_member(expr)
            }
            SimpleAssignmentTarget::PrivateFieldExpression(expr) => self.render_span_with(
                expr.span,
                vec![(expr.object.span(), self.render_expression(&expr.object))],
            ),
            _ => self.span_text(target.span()).to_string(),
        }
    }

    fn collect_body_bindings(&self, body: &[Statement<'a>], mode: ScopeMode) -> HashSet<String> {
        let mut names = HashSet::new();
        for stmt in body {
            self.collect_statement_bindings(stmt, mode, &mut names);
        }
        names
    }

    fn collect_statement_bindings(
        &self,
        stmt: &Statement<'a>,
        mode: ScopeMode,
        names: &mut HashSet<String>,
    ) {
        match stmt {
            Statement::ImportDeclaration(decl) => Self::collect_import_bindings(decl, names),
            Statement::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    names.insert(id.name.to_string());
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    names.insert(id.name.to_string());
                }
            }
            Statement::VariableDeclaration(decl) => {
                self.collect_variable_declaration_bindings(decl, mode, names)
            }
            _ if mode != ScopeMode::Block => {
                self.collect_nested_statement_bindings(stmt, mode, names)
            }
            _ => {}
        }
    }

    fn collect_import_bindings(decl: &ImportDeclaration<'a>, names: &mut HashSet<String>) {
        let Some(specs) = &decl.specifiers else {
            return;
        };
        for spec in specs {
            let local = match spec {
                ImportDeclarationSpecifier::ImportSpecifier(spec) => &spec.local.name,
                ImportDeclarationSpecifier::ImportDefaultSpecifier(spec) => &spec.local.name,
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(spec) => &spec.local.name,
            };
            names.insert(local.to_string());
        }
    }

    fn collect_declarator_bindings(
        &self,
        decl: &VariableDeclaration<'a>,
        names: &mut HashSet<String>,
    ) {
        for d in &decl.declarations {
            self.collect_binding_pattern(&d.id, names);
        }
    }

    fn collect_variable_declaration_bindings(
        &self,
        decl: &VariableDeclaration<'a>,
        mode: ScopeMode,
        names: &mut HashSet<String>,
    ) {
        let is_var = decl.kind == VariableDeclarationKind::Var;
        // Block scopes hoist only lexical (let/const) bindings; function-root
        // scopes hoist only `var` bindings.
        if (mode == ScopeMode::Block) != is_var {
            self.collect_declarator_bindings(decl, names);
        }
    }

    /// Hoist `var` bindings from the head of a `for`/`for-in`/`for-of` loop.
    fn collect_for_head_var_bindings(
        &self,
        decl: &VariableDeclaration<'a>,
        names: &mut HashSet<String>,
    ) {
        if decl.kind == VariableDeclarationKind::Var {
            self.collect_declarator_bindings(decl, names);
        }
    }

    /// Recurse into the bodies of control-flow statements. Only reached for
    /// function-root scopes (`mode != ScopeMode::Block`), where nested `var`
    /// declarations hoist to the enclosing function.
    fn collect_nested_statement_bindings(
        &self,
        stmt: &Statement<'a>,
        mode: ScopeMode,
        names: &mut HashSet<String>,
    ) {
        match stmt {
            Statement::BlockStatement(block) => self.collect_block_bindings(block, names, mode),
            Statement::IfStatement(stmt) => {
                self.collect_statement_bindings(&stmt.consequent, mode, names);
                if let Some(alt) = &stmt.alternate {
                    self.collect_statement_bindings(alt, mode, names);
                }
            }
            Statement::ForStatement(stmt) => {
                if let Some(ForStatementInit::VariableDeclaration(decl)) = &stmt.init {
                    self.collect_for_head_var_bindings(decl, names);
                }
                self.collect_statement_bindings(&stmt.body, mode, names);
            }
            Statement::ForInStatement(stmt) => {
                if let ForStatementLeft::VariableDeclaration(decl) = &stmt.left {
                    self.collect_for_head_var_bindings(decl, names);
                }
                self.collect_statement_bindings(&stmt.body, mode, names);
            }
            Statement::ForOfStatement(stmt) => {
                if let ForStatementLeft::VariableDeclaration(decl) = &stmt.left {
                    self.collect_for_head_var_bindings(decl, names);
                }
                self.collect_statement_bindings(&stmt.body, mode, names);
            }
            Statement::WhileStatement(stmt) => {
                self.collect_statement_bindings(&stmt.body, mode, names)
            }
            Statement::DoWhileStatement(stmt) => {
                self.collect_statement_bindings(&stmt.body, mode, names)
            }
            Statement::LabeledStatement(stmt) => {
                self.collect_statement_bindings(&stmt.body, mode, names)
            }
            Statement::SwitchStatement(stmt) => {
                for case in &stmt.cases {
                    for child in &case.consequent {
                        self.collect_statement_bindings(child, mode, names);
                    }
                }
            }
            Statement::TryStatement(stmt) => {
                self.collect_block_bindings(&stmt.block, names, mode);
                if let Some(handler) = &stmt.handler {
                    self.collect_block_bindings(&handler.body, names, mode);
                }
                if let Some(finalizer) = &stmt.finalizer {
                    self.collect_block_bindings(finalizer, names, mode);
                }
            }
            _ => {}
        }
    }
    fn collect_block_bindings(
        &self,
        block: &BlockStatement<'a>,
        names: &mut HashSet<String>,
        mode: ScopeMode,
    ) {
        for stmt in &block.body {
            self.collect_statement_bindings(stmt, mode, names);
        }
    }

    fn collect_binding_pattern(&self, pattern: &BindingPattern<'a>, names: &mut HashSet<String>) {
        match &pattern.kind {
            BindingPatternKind::BindingIdentifier(id) => {
                names.insert(id.name.to_string());
            }
            BindingPatternKind::AssignmentPattern(pat) => {
                self.collect_binding_pattern(&pat.left, names)
            }
            BindingPatternKind::ArrayPattern(arr) => {
                for p in (&arr.elements).into_iter().flatten() {
                    self.collect_binding_pattern(p, names);
                }
                if let Some(rest) = &arr.rest {
                    self.collect_binding_pattern(&rest.argument, names);
                }
            }
            BindingPatternKind::ObjectPattern(obj) => {
                for prop in &obj.properties {
                    self.collect_binding_pattern(&prop.value, names);
                }
                if let Some(rest) = &obj.rest {
                    self.collect_binding_pattern(&rest.argument, names);
                }
            }
        }
    }

    fn collect_formal_parameters(
        &self,
        params: &FormalParameters<'a>,
        names: &mut HashSet<String>,
    ) {
        for param in &params.items {
            self.collect_binding_pattern(&param.pattern, names);
        }
        if let Some(rest) = &params.rest {
            self.collect_binding_pattern(&rest.argument, names);
        }
    }

    fn is_global_name(&self, name: &str) -> bool {
        GLOBALS.contains(&name) && !self.declared(name)
    }

    fn member_needs_helper_static(&self, expr: &StaticMemberExpression<'a>) -> bool {
        !matches!(&expr.object, Expression::Super(_))
            && MEMBER_HELPER_PROPS
                .iter()
                .any(|prop| *prop == expr.property.name.as_str())
    }

    fn member_needs_helper_computed(&self, expr: &ComputedMemberExpression<'a>) -> bool {
        !matches!(&expr.object, Expression::Super(_))
            && self.is_window_like_expression(&expr.object)
    }

    fn is_window_like_expression(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                (matches!(
                    name,
                    "window"
                        | "self"
                        | "globalThis"
                        | "top"
                        | "parent"
                        | "opener"
                        | "frames"
                        | "document"
                ) && !self.declared(name))
                    || self.is_window_alias(name)
                    || self.is_document_alias(name)
            }
            Expression::StaticMemberExpression(member) => {
                matches!(
                    member.property.name.as_str(),
                    "defaultView"
                        | "contentWindow"
                        | "window"
                        | "self"
                        | "globalThis"
                        | "top"
                        | "parent"
                        | "opener"
                        | "frames"
                ) && self.is_window_like_expression(&member.object)
            }
            Expression::ComputedMemberExpression(member) => {
                self.is_window_like_expression(&member.object)
            }
            _ => false,
        }
    }

    fn expression_is_window_alias_source(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::ThisExpression(_) => false,
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                (matches!(
                    name,
                    "window" | "self" | "globalThis" | "top" | "parent" | "opener" | "frames"
                ) && !self.declared(name))
                    || self.is_window_alias(name)
            }
            Expression::StaticMemberExpression(_) => self.is_window_like_expression(expr),
            Expression::LogicalExpression(expr) => {
                self.expression_is_window_alias_source(&expr.left)
                    || self.expression_is_window_alias_source(&expr.right)
            }
            Expression::ConditionalExpression(expr) => {
                self.expression_is_window_alias_source(&expr.consequent)
                    || self.expression_is_window_alias_source(&expr.alternate)
            }
            Expression::ParenthesizedExpression(expr) => {
                self.expression_is_window_alias_source(&expr.expression)
            }
            _ => false,
        }
    }

    fn expression_is_document_alias_source(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                name == "document" && !self.declared(name) || self.is_document_alias(name)
            }
            Expression::StaticMemberExpression(member) => {
                member.property.name == "document" && self.is_window_like_expression(&member.object)
            }
            Expression::ComputedMemberExpression(member) => {
                self.is_window_like_expression(&member.object)
            }
            Expression::LogicalExpression(expr) => {
                self.expression_is_document_alias_source(&expr.left)
                    || self.expression_is_document_alias_source(&expr.right)
            }
            Expression::ConditionalExpression(expr) => {
                self.expression_is_document_alias_source(&expr.consequent)
                    || self.expression_is_document_alias_source(&expr.alternate)
            }
            Expression::ParenthesizedExpression(expr) => {
                self.expression_is_document_alias_source(&expr.expression)
            }
            _ => false,
        }
    }

    fn render_window_alias_source(&self, expr: &Expression<'a>) -> String {
        match expr {
            Expression::ThisExpression(_) => "__zp_get(globalThis,\"window\")".to_string(),
            Expression::LogicalExpression(expr) => self.render_span_with(
                expr.span,
                vec![
                    (
                        expr.left.span(),
                        self.render_window_alias_source(&expr.left),
                    ),
                    (
                        expr.right.span(),
                        self.render_window_alias_source(&expr.right),
                    ),
                ],
            ),
            Expression::ConditionalExpression(expr) => self.render_span_with(
                expr.span,
                vec![
                    (expr.test.span(), self.render_expression(&expr.test)),
                    (
                        expr.consequent.span(),
                        self.render_window_alias_source(&expr.consequent),
                    ),
                    (
                        expr.alternate.span(),
                        self.render_window_alias_source(&expr.alternate),
                    ),
                ],
            ),
            Expression::ParenthesizedExpression(expr) => self.render_span_with(
                expr.span,
                vec![(
                    expr.expression.span(),
                    self.render_window_alias_source(&expr.expression),
                )],
            ),
            _ => self.render_expression(expr),
        }
    }

    fn is_virtual_location_expression(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::Identifier(id) => id.name == "location" && !self.declared(id.name.as_str()),
            Expression::StaticMemberExpression(member) => {
                member.property.name == "location" && self.is_window_like_expression(&member.object)
            }
            Expression::ComputedMemberExpression(member) => {
                self.is_window_like_expression(&member.object)
            }
            _ => false,
        }
    }

    fn assignment_target(&self, target: &AssignmentTarget<'a>) -> Option<(String, String)> {
        match target {
            AssignmentTarget::AssignmentTargetIdentifier(id)
                if self.is_global_name(id.name.as_str())
                    && matches!(id.name.as_str(), "location" | "window") =>
            {
                Some(("globalThis".to_string(), format!("{:?}", id.name.as_str())))
            }
            AssignmentTarget::StaticMemberExpression(expr)
                if expr.property.name == "location"
                    && self.is_window_like_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            AssignmentTarget::StaticMemberExpression(expr)
                if matches!(expr.property.name.as_str(), "href" | "hash")
                    && self.is_virtual_location_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            AssignmentTarget::ComputedMemberExpression(expr)
                if self.is_window_like_expression(&expr.object)
                    || self.is_virtual_location_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    self.render_expression(&expr.expression),
                ))
            }
            AssignmentTarget::StaticMemberExpression(expr)
                if self.member_needs_helper_static(expr) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            AssignmentTarget::ComputedMemberExpression(expr)
                if self.member_needs_helper_computed(expr) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    self.render_expression(&expr.expression),
                ))
            }
            _ => None,
        }
    }

    fn simple_assignment_target(
        &self,
        target: &SimpleAssignmentTarget<'a>,
    ) -> Option<(String, String)> {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(id)
                if self.is_global_name(id.name.as_str())
                    && matches!(id.name.as_str(), "location" | "window") =>
            {
                Some(("globalThis".to_string(), format!("{:?}", id.name.as_str())))
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr)
                if expr.property.name == "location"
                    && self.is_window_like_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr)
                if matches!(expr.property.name.as_str(), "href" | "hash")
                    && self.is_virtual_location_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            SimpleAssignmentTarget::ComputedMemberExpression(expr)
                if self.is_window_like_expression(&expr.object)
                    || self.is_virtual_location_expression(&expr.object) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    self.render_expression(&expr.expression),
                ))
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr)
                if self.member_needs_helper_static(expr) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    format!("{:?}", expr.property.name.as_str()),
                ))
            }
            SimpleAssignmentTarget::ComputedMemberExpression(expr)
                if self.member_needs_helper_computed(expr) =>
            {
                Some((
                    self.render_expression(&expr.object),
                    self.render_expression(&expr.expression),
                ))
            }
            _ => None,
        }
    }
    fn call_target(&self, callee: &Expression<'a>) -> Option<(String, String)> {
        match callee {
            Expression::StaticMemberExpression(expr) => {
                if matches!(&expr.object, Expression::Super(_)) {
                    return None;
                }
                let prop = expr.property.name.as_str();
                if CALL_HELPER_PROPS.contains(&prop) || self.member_needs_helper_static(expr) {
                    Some((self.render_expression(&expr.object), format!("{:?}", prop)))
                } else {
                    None
                }
            }
            Expression::ComputedMemberExpression(expr) => {
                if self.member_needs_helper_computed(expr) {
                    Some((
                        self.render_expression(&expr.object),
                        self.render_expression(&expr.expression),
                    ))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn member_access_is_optional(&self, span: Span) -> bool {
        self.span_text(span).contains("?.")
    }

    fn call_access_is_optional(&self, call_span: Span, callee_span: Span) -> bool {
        if self.span_text(callee_span).contains("?.") {
            return true;
        }
        let start = callee_span.end as usize;
        let end = call_span.end as usize;
        self.source
            .get(start..end)
            .unwrap_or("")
            .trim_start()
            .starts_with("?.")
    }

    fn construct_target(&self, callee: &Expression<'a>) -> Option<String> {
        match callee {
            Expression::Identifier(id) if self.is_global_name(id.name.as_str()) => {
                Some(self.render_expression(callee))
            }
            Expression::StaticMemberExpression(expr)
                if self.is_window_like_expression(&expr.object)
                    || self.member_needs_helper_static(expr) =>
            {
                Some(self.render_expression(callee))
            }
            Expression::ComputedMemberExpression(expr)
                if self.is_window_like_expression(&expr.object)
                    || self.member_needs_helper_computed(expr) =>
            {
                Some(self.render_expression(callee))
            }
            Expression::ChainExpression(expr) => match &expr.expression {
                ChainElement::StaticMemberExpression(inner)
                    if self.is_window_like_expression(&inner.object)
                        || self.member_needs_helper_static(inner) =>
                {
                    Some(self.render_expression(callee))
                }
                ChainElement::ComputedMemberExpression(inner)
                    if self.is_window_like_expression(&inner.object)
                        || self.member_needs_helper_computed(inner) =>
                {
                    Some(self.render_expression(callee))
                }
                _ => None,
            },
            _ => None,
        }
    }

    fn is_import_meta_url_static(&self, expr: &StaticMemberExpression<'a>) -> bool {
        self.module
            && expr.property.name == "url"
            && matches!(&expr.object, Expression::MetaProperty(meta) if meta.meta.name == "import" && meta.property.name == "meta")
    }

    fn module_specifier(&self, raw: &str) -> String {
        if self.target_url.is_empty() {
            return raw.to_string();
        }
        if is_bare_specifier(raw) {
            return raw.to_string();
        }
        if has_scheme(raw) && !raw.starts_with("http://") && !raw.starts_with("https://") {
            return format!("{}error/POLICY_BLOCKED", self.control_prefix);
        }
        let abs = join_url(self.target_url, raw);
        if !abs.starts_with("http://") && !abs.starts_with("https://") {
            return format!("{}error/POLICY_BLOCKED", self.control_prefix);
        }
        format!(
            "{}api/script?kind=module&u={}",
            self.control_prefix,
            percent_encode(abs)
        )
    }
}

fn assignment_operator_text(op: AssignmentOperator) -> &'static str {
    match op {
        AssignmentOperator::Assign => "=",
        AssignmentOperator::Addition => "+=",
        AssignmentOperator::Subtraction => "-=",
        AssignmentOperator::Multiplication => "*=",
        AssignmentOperator::Division => "/=",
        AssignmentOperator::Remainder => "%=",
        AssignmentOperator::Exponential => "**=",
        AssignmentOperator::ShiftLeft => "<<=",
        AssignmentOperator::ShiftRight => ">>=",
        AssignmentOperator::ShiftRightZeroFill => ">>>=",
        AssignmentOperator::BitwiseOR => "|=",
        AssignmentOperator::BitwiseXOR => "^=",
        AssignmentOperator::BitwiseAnd => "&=",
        AssignmentOperator::LogicalOr => "||=",
        AssignmentOperator::LogicalAnd => "&&=",
        AssignmentOperator::LogicalNullish => "??=",
    }
}

fn update_operator_text(op: UpdateOperator) -> &'static str {
    match op {
        UpdateOperator::Increment => "++",
        UpdateOperator::Decrement => "--",
    }
}
fn is_bare_specifier(spec: &str) -> bool {
    !spec.starts_with('/')
        && !spec.starts_with("./")
        && !spec.starts_with("../")
        && !has_scheme(spec)
}

fn has_scheme(spec: &str) -> bool {
    let mut chars = spec.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return false;
        }
    }
    false
}

fn join_url(base: &str, raw: &str) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    if raw.starts_with('/') {
        if let Some(idx) = base.find("://") {
            let rest = &base[idx + 3..];
            if let Some(slash) = rest.find('/') {
                return format!("{}{}", &base[..idx + 3 + slash], raw);
            }
        }
        return raw.to_string();
    }
    let prefix = match base.rfind('/') {
        Some(i) => &base[..=i],
        None => base,
    };
    let mut parts: Vec<&str> = prefix.split('/').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    for part in raw.split('/') {
        match part {
            "." => {}
            ".." => {
                if parts.len() > 3 {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn percent_encode(input: String) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 15));
            }
        }
    }
    out
}

fn hex(v: u8) -> char {
    match v {
        0..=9 => (b'0' + v) as char,
        _ => (b'A' + (v - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite_ok(source: &str, kind: &str, target_url: &str) -> String {
        let out = rewrite_script(source, kind, target_url, "/zp/");
        assert!(out.ok, "rewrite failed: {}", out.error);
        out.code
    }

    #[test]
    fn rewrites_virtualized_globals_and_shadowing() {
        let code = rewrite_ok(
            "function f(x) { if (x) { var location = { href: 'local' }; } return location.href; }\nwindow.location.hash += '-tail';\ndocument.defaultView.location.href;",
            "classic",
            "https://example.com/app.js",
        );
        assert!(code.contains("return location.href;"));
        assert!(code.contains(
            "__zp_assign(__zp_get(__zp_get(globalThis,\"window\"),\"location\"),\"hash\""
        ));
        assert!(code.contains("__zp_get(__zp_get(globalThis,\"document\"),\"defaultView\")"));
        assert!(!code.contains("return __zp_get(globalThis,\"location\")"));
    }

    #[test]
    fn rewrites_module_urls_and_dynamic_imports() {
        let code = rewrite_ok(
            "import './dep.js'; export async function load(name) { await import('./chunks/' + name + '.js'); return new URL('/worker-fixture.js', import.meta.url).href; }",
            "module",
            "https://example.com/assets/main.js",
        );
        assert!(code.contains(
            "import \"/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js\";"
        ));
        assert!(code.contains(
            "__zp_module_url('./chunks/' + name + '.js',\"https://example.com/assets/main.js\")"
        ));
        assert!(code.contains("\"https://example.com/assets/main.js\""));
    }

    #[test]
    fn rewrites_calls_and_constructors() {
        let code = rewrite_ok(
            "window.location = '/next'; const ws = new WebSocket('/ws', ['chat']); Object.getOwnPropertyDescriptor(window, 'location');",
            "classic",
            "https://example.com/app.js",
        );
        assert!(code.contains("__zp_set(__zp_get(globalThis,\"window\"),\"location\",'/next')"));
        assert!(
            code.contains("__zp_construct(__zp_get(globalThis,\"WebSocket\"),['/ws',['chat']])")
        );
        assert!(code.contains("__zp_call(Object,\"getOwnPropertyDescriptor\",[__zp_get(globalThis,\"window\"),'location'])"));
    }

    #[test]
    fn preserves_super_member_syntax() {
        let code = rewrite_ok(
            "class Child extends Parent { method() { super.get(); return super.constructor; } }",
            "module",
            "https://example.com/app.js",
        );
        assert!(code.contains("super.get();"));
        assert!(code.contains("return super.constructor;"));
        assert!(!code.contains("__zp_get(super"));
        assert!(!code.contains("__zp_call(super"));
    }

    #[test]
    fn parse_failures_return_error() {
        let out = rewrite_script("if (", "classic", "https://example.com/app.js", "/zp/");
        assert!(!out.ok);
        assert_eq!(out.error, "PARSE_FAILED");
    }
}
