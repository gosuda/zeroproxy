use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::AssignmentOperator;
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
pub fn rewrite_script(source: &str, kind: &str, target_url: &str, control_prefix: &str) -> RewriteOutput {
    let allocator = Allocator::default();
    let source_type = if kind == "module" { SourceType::mjs() } else { SourceType::cjs() };
    let ret = Parser::new(&allocator, source, source_type).parse();
    if !ret.errors.is_empty() {
        return RewriteOutput { ok: false, code: String::new(), error: "PARSE_FAILED".to_string() };
    }
    let mut rewriter = Rewriter::new(source, kind == "module", target_url, control_prefix);
    rewriter.walk_program(&ret.program);
    RewriteOutput { ok: true, code: rewriter.finish(), error: String::new() }
}

const GLOBALS: &[&str] = &[
    "window", "self", "globalThis", "location", "document", "history", "top", "parent", "opener", "frames",
    "WebSocket", "eval", "Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction",
];
const MEMBER_HELPER_PROPS: &[&str] = &[
    "location", "defaultView", "contentWindow", "contentDocument", "top", "parent", "opener", "frames", "constructor", "postMessage",
];
const CALL_HELPER_PROPS: &[&str] = &[
    "assign", "replace", "open", "get", "getOwnPropertyDescriptor", "defineProperty",
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
}

impl<'a> Rewriter<'a> {
    fn new(source: &'a str, module: bool, target_url: &'a str, control_prefix: &'a str) -> Self {
        Self {
            source,
            module,
            target_url,
            control_prefix: if control_prefix.is_empty() { "/zp/" } else { control_prefix },
            replacements: Vec::new(),
            scopes: Vec::new(),
        }
    }

    fn finish(mut self) -> String {
        self.replacements.sort_by(|a, b| {
            a.start.cmp(&b.start)
                .then(b.priority.cmp(&a.priority))
                .then((b.end - b.start).cmp(&(a.end - a.start)))
        });
        let mut chosen: Vec<Replacement> = Vec::new();
        let mut covered_end = 0usize;
        for r in self.replacements {
            if !chosen.is_empty() && r.start < covered_end { continue; }
            covered_end = r.end;
            chosen.push(r);
        }
        let mut out = String::with_capacity(self.source.len() + chosen.iter().map(|r| r.text.len()).sum::<usize>());
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
        self.source.get(span.start as usize..span.end as usize).unwrap_or("")
    }

    fn push_scope(&mut self, scope: HashSet<String>) { self.scopes.push(scope); }
    fn pop_scope(&mut self) { self.scopes.pop(); }
    fn declare(&mut self, name: &str) {
        if let Some(scope) = self.scopes.last_mut() { scope.insert(name.to_string()); }
    }
    fn declared(&self, name: &str) -> bool { self.scopes.iter().rev().any(|scope| scope.contains(name)) }
    fn add_replacement(&mut self, span: Span, text: String, priority: i32) {
        let start = span.start as usize;
        let end = span.end as usize;
        if start < end { self.replacements.push(Replacement { start, end, text, priority }); }
    }

    fn walk_program(&mut self, program: &Program<'a>) {
        self.push_scope(self.collect_body_bindings(&program.body, ScopeMode::FunctionRoot));
        for stmt in &program.body { self.walk_statement(stmt); }
        self.pop_scope();
    }

    fn walk_statement(&mut self, stmt: &Statement<'a>) {
        match stmt {
            Statement::BlockStatement(block) => {
                self.push_scope(self.collect_body_bindings(&block.body, ScopeMode::Block));
                for stmt in &block.body { self.walk_statement(stmt); }
                self.pop_scope();
            }
            Statement::ExpressionStatement(expr) => self.walk_expression(&expr.expression),
            Statement::IfStatement(stmt) => {
                self.walk_expression(&stmt.test);
                self.walk_statement(&stmt.consequent);
                if let Some(alt) = &stmt.alternate { self.walk_statement(alt); }
            }
            Statement::WhileStatement(stmt) => { self.walk_expression(&stmt.test); self.walk_statement(&stmt.body); }
            Statement::DoWhileStatement(stmt) => { self.walk_statement(&stmt.body); self.walk_expression(&stmt.test); }
            Statement::ForStatement(stmt) => {
                let scoped = matches!(stmt.init.as_ref(), Some(ForStatementInit::VariableDeclaration(decl)) if decl.kind != VariableDeclarationKind::Var);
                if scoped { self.push_scope(HashSet::new()); }
                if let Some(init) = &stmt.init {
                    match init {
                        ForStatementInit::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
                        _ => self.walk_expression(init.to_expression()),
                    }
                }
                if let Some(test) = &stmt.test { self.walk_expression(test); }
                if let Some(update) = &stmt.update { self.walk_expression(update); }
                self.walk_statement(&stmt.body);
                if scoped { self.pop_scope(); }
            }
            Statement::ForInStatement(stmt) => {
                let scoped = matches!(&stmt.left, ForStatementLeft::VariableDeclaration(decl) if decl.kind != VariableDeclarationKind::Var);
                if scoped { self.push_scope(HashSet::new()); }
                match &stmt.left {
                    ForStatementLeft::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
                    _ => self.walk_assignment_target(stmt.left.to_assignment_target()),
                }
                self.walk_expression(&stmt.right);
                self.walk_statement(&stmt.body);
                if scoped { self.pop_scope(); }
            }
            Statement::ForOfStatement(stmt) => {
                let scoped = matches!(&stmt.left, ForStatementLeft::VariableDeclaration(decl) if decl.kind != VariableDeclarationKind::Var);
                if scoped { self.push_scope(HashSet::new()); }
                match &stmt.left {
                    ForStatementLeft::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
                    _ => self.walk_assignment_target(stmt.left.to_assignment_target()),
                }
                self.walk_expression(&stmt.right);
                self.walk_statement(&stmt.body);
                if scoped { self.pop_scope(); }
            }
            Statement::ReturnStatement(stmt) => { if let Some(arg) = &stmt.argument { self.walk_expression(arg); } }
            Statement::ThrowStatement(stmt) => self.walk_expression(&stmt.argument),
            Statement::SwitchStatement(stmt) => {
                self.walk_expression(&stmt.discriminant);
                for case in &stmt.cases {
                    if let Some(test) = &case.test { self.walk_expression(test); }
                    for stmt in &case.consequent { self.walk_statement(stmt); }
                }
            }
            Statement::TryStatement(stmt) => {
                self.walk_block_statement(&stmt.block);
                if let Some(handler) = &stmt.handler {
                    let mut scope = HashSet::new();
                    if let Some(param) = &handler.param { self.collect_binding_pattern(&param.pattern, &mut scope); }
                    self.push_scope(scope);
                    self.walk_block_statement(&handler.body);
                    self.pop_scope();
                }
                if let Some(finalizer) = &stmt.finalizer { self.walk_block_statement(finalizer); }
            }
            Statement::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
            Statement::FunctionDeclaration(func) => self.walk_function(func),
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id { self.declare(id.name.as_str()); }
                for elem in &class.body.body {
                    match elem {
                        ClassElement::PropertyDefinition(prop) => if let Some(value) = &prop.value { self.walk_expression(value); },
                        ClassElement::AccessorProperty(prop) => if let Some(value) = &prop.value { self.walk_expression(value); },
                        _ => {}
                    }
                }
            }
            Statement::ImportDeclaration(decl) => self.add_replacement(decl.source.span, format!("{:?}", self.module_specifier(decl.source.value.as_str())), 95),
            Statement::ExportNamedDeclaration(decl) => {
                if let Some(source) = &decl.source { self.add_replacement(source.span, format!("{:?}", self.module_specifier(source.value.as_str())), 95); }
                if let Some(inner) = &decl.declaration { self.walk_declaration(inner); }
            }
            Statement::ExportAllDeclaration(decl) => self.add_replacement(decl.source.span, format!("{:?}", self.module_specifier(decl.source.value.as_str())), 95),
            Statement::ExportDefaultDeclaration(decl) => self.walk_export_default(decl),
            _ => {}
        }
    }
    fn walk_declaration(&mut self, decl: &Declaration<'a>) {
        match decl {
            Declaration::VariableDeclaration(decl) => self.walk_variable_declaration(decl),
            Declaration::FunctionDeclaration(func) => self.walk_function(func),
            Declaration::ClassDeclaration(class) => {
                if let Some(id) = &class.id { self.declare(id.name.as_str()); }
                for elem in &class.body.body {
                    match elem {
                        ClassElement::PropertyDefinition(prop) => if let Some(value) = &prop.value { self.walk_expression(value); },
                        ClassElement::AccessorProperty(prop) => if let Some(value) = &prop.value { self.walk_expression(value); },
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    fn walk_export_default(&mut self, decl: &ExportDefaultDeclaration<'a>) {
        match &decl.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(func) => self.walk_function(func),
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                if let Some(id) = &class.id { self.declare(id.name.as_str()); }
            }
            other => {
                if let Some(expr) = other.as_expression() { self.walk_expression(expr); }
            }
        }
    }
    fn walk_function(&mut self, func: &Function<'a>) {
        if let Some(id) = &func.id { self.declare(id.name.as_str()); }
        let mut scope = HashSet::new();
        if let Some(id) = &func.id { scope.insert(id.name.to_string()); }
        self.collect_formal_parameters(&func.params, &mut scope);
        if let Some(body) = &func.body {
            let body_scope = self.collect_body_bindings(&body.statements, ScopeMode::FunctionRoot);
            scope.extend(body_scope);
            self.push_scope(scope);
            for stmt in &body.statements { self.walk_statement(stmt); }
            self.pop_scope();
        }
    }
    fn walk_block_statement(&mut self, block: &BlockStatement<'a>) {
        self.push_scope(self.collect_body_bindings(&block.body, ScopeMode::Block));
        for stmt in &block.body { self.walk_statement(stmt); }
        self.pop_scope();
    }

    fn walk_variable_declaration(&mut self, decl: &VariableDeclaration<'a>) {
        for declarator in &decl.declarations {
            self.walk_binding_pattern(&declarator.id);
            if let Some(init) = &declarator.init { self.walk_expression(init); }
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
                for elem in &arr.elements { if let Some(p) = elem { self.walk_binding_pattern(p); } }
                if let Some(rest) = &arr.rest { self.walk_binding_pattern(&rest.argument); }
            }
            BindingPatternKind::ObjectPattern(obj) => {
                for prop in &obj.properties {
                    if prop.computed { self.walk_property_key(&prop.key); }
                    self.walk_binding_pattern(&prop.value);
                }
                if let Some(rest) = &obj.rest { self.walk_binding_pattern(&rest.argument); }
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
                for elem in &arr.elements { if let Some(item) = elem { self.walk_assignment_target_maybe_default(item); } }
                if let Some(rest) = &arr.rest { self.walk_assignment_target(&rest.target); }
            }
            AssignmentTarget::ObjectAssignmentTarget(obj) => {
                for prop in &obj.properties {
                    match prop {
                        AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(id) => {
                            if let Some(init) = &id.init { self.walk_expression(init); }
                        }
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(prop) => {
                            if prop.computed { self.walk_property_key(&prop.name); }
                            self.walk_assignment_target_maybe_default(&prop.binding);
                        }
                    }
                }
                if let Some(rest) = &obj.rest { self.walk_assignment_target(&rest.target); }
            }
            _ => {}
        }
    }

    fn walk_assignment_target_maybe_default(&mut self, target: &AssignmentTargetMaybeDefault<'a>) {
        match target {
            AssignmentTargetMaybeDefault::AssignmentTargetIdentifier(_) => {}
            AssignmentTargetMaybeDefault::ComputedMemberExpression(expr) => { self.walk_expression(&expr.object); self.walk_expression(&expr.expression); }
            AssignmentTargetMaybeDefault::StaticMemberExpression(expr) => self.walk_expression(&expr.object),
            AssignmentTargetMaybeDefault::PrivateFieldExpression(expr) => self.walk_expression(&expr.object),
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
                    self.add_replacement(id.span, format!("__zp_get(globalThis,{:?})", id.name.as_str()), 10);
                }
            }
            Expression::StaticMemberExpression(expr) => {
                if self.is_import_meta_url_static(expr) {
                    self.add_replacement(expr.span, format!("{:?}", self.target_url), 90);
                    return;
                }
                if self.member_needs_helper_static(expr) {
                    self.add_replacement(expr.span, format!("__zp_get({},{:?})", self.render_expression(&expr.object), expr.property.name.as_str()), 80);
                    return;
                }
                self.walk_expression(&expr.object);
            }
            Expression::ComputedMemberExpression(expr) => {
                if self.member_needs_helper_computed(expr) {
                    self.add_replacement(expr.span, format!("__zp_get({},{})", self.render_expression(&expr.object), self.render_expression(&expr.expression)), 80);
                    return;
                }
                self.walk_expression(&expr.object);
                self.walk_expression(&expr.expression);
            }
            Expression::PrivateFieldExpression(expr) => self.walk_expression(&expr.object),
            Expression::AssignmentExpression(expr) => self.walk_assignment_expression(expr),
            Expression::UpdateExpression(expr) => self.walk_update_expression(expr),
            Expression::ImportExpression(expr) => self.walk_import_expression(expr),
            Expression::CallExpression(expr) => self.walk_call_expression(expr),
            Expression::NewExpression(expr) => self.walk_new_expression(expr),
            Expression::BinaryExpression(expr) => { self.walk_expression(&expr.left); self.walk_expression(&expr.right); }
            Expression::LogicalExpression(expr) => { self.walk_expression(&expr.left); self.walk_expression(&expr.right); }
            Expression::ConditionalExpression(expr) => { self.walk_expression(&expr.test); self.walk_expression(&expr.consequent); self.walk_expression(&expr.alternate); }
            Expression::UnaryExpression(expr) => self.walk_expression(&expr.argument),
            Expression::AwaitExpression(expr) => self.walk_expression(&expr.argument),
            Expression::YieldExpression(expr) => if let Some(arg) = &expr.argument { self.walk_expression(arg); },
            Expression::SequenceExpression(expr) => for e in &expr.expressions { self.walk_expression(e); },
            Expression::ParenthesizedExpression(expr) => self.walk_expression(&expr.expression),
            Expression::ChainExpression(expr) => match &expr.expression {
                ChainElement::CallExpression(call) => self.walk_call_expression(call),
                ChainElement::TSNonNullExpression(inner) => self.walk_expression(&inner.expression),
                ChainElement::ComputedMemberExpression(inner) => { self.walk_expression(&inner.object); self.walk_expression(&inner.expression); }
                ChainElement::StaticMemberExpression(inner) => self.walk_expression(&inner.object),
                ChainElement::PrivateFieldExpression(inner) => self.walk_expression(&inner.object),
            },
            Expression::ObjectExpression(expr) => {
                for prop in &expr.properties {
                    match prop {
                        ObjectPropertyKind::ObjectProperty(prop) => {
                            if prop.computed { self.walk_property_key(&prop.key); }
                            self.walk_expression(&prop.value);
                        }
                        ObjectPropertyKind::SpreadProperty(prop) => self.walk_expression(&prop.argument),
                    }
                }
            }
            Expression::ArrayExpression(expr) => {
                for elem in &expr.elements {
                    match elem {
                        ArrayExpressionElement::SpreadElement(spread) => self.walk_expression(&spread.argument),
                        ArrayExpressionElement::Elision(_) => {}
                        _ => self.walk_expression(elem.to_expression()),
                    }
                }
            }
            Expression::FunctionExpression(func) => self.walk_function(func),
            Expression::ArrowFunctionExpression(func) => {
                let mut scope = HashSet::new();
                self.collect_formal_parameters(&func.params, &mut scope);
                scope.extend(self.collect_body_bindings(&func.body.statements, ScopeMode::FunctionRoot));
                self.push_scope(scope);
                for stmt in &func.body.statements { self.walk_statement(stmt); }
                self.pop_scope();
            }
            _ => {}
        }
    }

    fn walk_assignment_expression(&mut self, expr: &AssignmentExpression<'a>) {
        if let Some((base, prop)) = self.assignment_target(&expr.left) {
            if expr.operator == AssignmentOperator::Assign {
                self.add_replacement(expr.span, format!("(__zp_set({},{},{}))", base, prop, self.render_expression(&expr.right)), 100);
                return;
            }
            let op = assignment_operator_text(expr.operator);
            let rhs = if matches!(expr.operator, AssignmentOperator::LogicalAnd | AssignmentOperator::LogicalOr | AssignmentOperator::LogicalNullish) {
                format!("()=>({})", self.render_expression(&expr.right))
            } else {
                self.render_expression(&expr.right)
            };
            self.add_replacement(expr.span, format!("(__zp_assign({},{},{:?},{}))", base, prop, op, rhs), 100);
            return;
        }
        self.walk_assignment_target(&expr.left);
        self.walk_expression(&expr.right);
    }

    fn walk_update_expression(&mut self, expr: &UpdateExpression<'a>) {
        self.walk_simple_assignment_target(&expr.argument);
    }

    fn walk_simple_assignment_target(&mut self, target: &SimpleAssignmentTarget<'a>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => {}
            SimpleAssignmentTarget::ComputedMemberExpression(expr) => { self.walk_expression(&expr.object); self.walk_expression(&expr.expression); }
            SimpleAssignmentTarget::StaticMemberExpression(expr) => self.walk_expression(&expr.object),
            SimpleAssignmentTarget::PrivateFieldExpression(expr) => self.walk_expression(&expr.object),
            _ => {}
        }
    }

    fn walk_import_expression(&mut self, expr: &ImportExpression<'a>) {
        if let Expression::StringLiteral(spec) = &expr.source {
            self.add_replacement(spec.span, format!("{:?}", self.module_specifier(spec.value.as_str())), 95);
            return;
        }
        self.add_replacement(expr.source.span(), format!("__zp_module_url({},{:?})", self.render_expression(&expr.source), self.target_url), 95);
    }

    fn walk_call_expression(&mut self, expr: &CallExpression<'a>) {
        if let Some((base, prop)) = self.call_target(&expr.callee) {
            let args = self.render_arguments(&expr.arguments);
            self.add_replacement(expr.span, format!("(__zp_call({},{},[{}]))", base, prop, args), 90);
            return;
        }
        self.walk_expression(&expr.callee);
        for arg in &expr.arguments { self.walk_argument(arg); }
    }

    fn walk_new_expression(&mut self, expr: &NewExpression<'a>) {
        if let Some(target) = self.construct_target(&expr.callee) {
            let args = self.render_arguments(&expr.arguments);
            self.add_replacement(expr.span, format!("(__zp_construct({},[{}]))", target, args), 90);
            return;
        }
        self.walk_expression(&expr.callee);
        for arg in &expr.arguments { self.walk_argument(arg); }
    }

    fn walk_argument(&mut self, arg: &Argument<'a>) {
        match arg {
            Argument::SpreadElement(spread) => self.walk_expression(&spread.argument),
            _ => self.walk_expression(arg.to_expression()),
        }
    }

    fn render_arguments(&self, args: &[Argument<'a>]) -> String {
        args.iter().map(|arg| match arg {
            Argument::SpreadElement(spread) => format!("...{}", self.render_expression(&spread.argument)),
            _ => self.render_expression(arg.to_expression()),
        }).collect::<Vec<_>>().join(",")
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
            Expression::StaticMemberExpression(expr) => {
                if self.is_import_meta_url_static(expr) { return format!("{:?}", self.target_url); }
                if self.member_needs_helper_static(expr) {
                    return format!("__zp_get({},{:?})", self.render_expression(&expr.object), expr.property.name.as_str());
                }
                format!("{}{}{}", self.render_expression(&expr.object), &self.source[expr.object.span().end as usize..expr.property.span.start as usize], self.span_text(expr.property.span))
            }
            Expression::ComputedMemberExpression(expr) => {
                if self.member_needs_helper_computed(expr) {
                    return format!("__zp_get({},{})", self.render_expression(&expr.object), self.render_expression(&expr.expression));
                }
                format!("{}[{}]", self.render_expression(&expr.object), self.render_expression(&expr.expression))
            }
            Expression::PrivateFieldExpression(_) => self.span_text(expr.span()).to_string(),
            Expression::CallExpression(expr) => {
                if let Some((base, prop)) = self.call_target(&expr.callee) {
                    return format!("(__zp_call({},{},[{}]))", base, prop, self.render_arguments(&expr.arguments));
                }
                format!("{}({})", self.render_expression(&expr.callee), self.render_arguments(&expr.arguments))
            }
            Expression::NewExpression(expr) => {
                if let Some(target) = self.construct_target(&expr.callee) {
                    let args = self.render_arguments(&expr.arguments);
                    return format!("(__zp_construct({},[{}]))", target, args);
                }
                let args = self.render_arguments(&expr.arguments);
                format!("new {}({})", self.render_expression(&expr.callee), args)
            }
            Expression::BinaryExpression(expr) => format!("{}{}{}", self.render_expression(&expr.left), &self.source[expr.left.span().end as usize..expr.right.span().start as usize], self.render_expression(&expr.right)),
            Expression::LogicalExpression(expr) => format!("{}{}{}", self.render_expression(&expr.left), &self.source[expr.left.span().end as usize..expr.right.span().start as usize], self.render_expression(&expr.right)),
            Expression::ConditionalExpression(expr) => format!("{}{}{}{}{}", self.render_expression(&expr.test), &self.source[expr.test.span().end as usize..expr.consequent.span().start as usize], self.render_expression(&expr.consequent), &self.source[expr.consequent.span().end as usize..expr.alternate.span().start as usize], self.render_expression(&expr.alternate)),
            Expression::UnaryExpression(expr) => format!("{}{}", &self.source[expr.span.start as usize..expr.argument.span().start as usize], self.render_expression(&expr.argument)),
            Expression::UpdateExpression(expr) => if expr.prefix { format!("{}{}", &self.source[expr.span.start as usize..expr.argument.span().start as usize], self.render_simple_assignment_target(&expr.argument)) } else { format!("{}{}", self.render_simple_assignment_target(&expr.argument), &self.source[expr.argument.span().end as usize..expr.span.end as usize]) },
            Expression::ObjectExpression(expr) => {
                let mut parts = Vec::new();
                for prop in &expr.properties {
                    match prop {
                        ObjectPropertyKind::SpreadProperty(spread) => parts.push(format!("...{}", self.render_expression(&spread.argument))),
                        ObjectPropertyKind::ObjectProperty(prop) => {
                            if prop.method || prop.kind != PropertyKind::Init { parts.push(self.span_text(prop.span).to_string()); }
                            else if prop.shorthand {
                                parts.push(format!("{}: {}", self.span_text(prop.key.span()), self.render_expression(&prop.value)));
                            } else if prop.computed {
                                parts.push(format!("[{}]: {}", self.render_property_key(&prop.key), self.render_expression(&prop.value)));
                            } else {
                                parts.push(format!("{}: {}", self.span_text(prop.key.span()), self.render_expression(&prop.value)));
                            }
                        }
                    }
                }
                format!("{{{}}}", parts.join(","))
            }
            Expression::ArrayExpression(expr) => {
                let mut parts = Vec::new();
                for elem in &expr.elements {
                    match elem {
                        ArrayExpressionElement::Elision(_) => parts.push(String::new()),
                        ArrayExpressionElement::SpreadElement(spread) => parts.push(format!("...{}", self.render_expression(&spread.argument))),
                        _ => parts.push(self.render_expression(elem.to_expression())),
                    }
                }
                format!("[{}]", parts.join(","))
            }
            Expression::AssignmentExpression(expr) => {
                if let Some((base, prop)) = self.assignment_target(&expr.left) {
                    if expr.operator == AssignmentOperator::Assign {
                        format!("(__zp_set({},{},{}))", base, prop, self.render_expression(&expr.right))
                    } else {
                        let rhs = if matches!(expr.operator, AssignmentOperator::LogicalAnd | AssignmentOperator::LogicalOr | AssignmentOperator::LogicalNullish) {
                            format!("()=>({})", self.render_expression(&expr.right))
                        } else {
                            self.render_expression(&expr.right)
                        };
                        format!("(__zp_assign({},{},{:?},{}))", base, prop, assignment_operator_text(expr.operator), rhs)
                    }
                } else {
                    self.span_text(expr.span).to_string()
                }
            }
            Expression::ChainExpression(expr) => self.span_text(expr.span).to_string(),
            _ => self.span_text(expr.span()).to_string(),
        }
    }

    fn render_property_key(&self, key: &PropertyKey<'a>) -> String {
        match key {
            PropertyKey::StaticIdentifier(id) => id.name.to_string(),
            _ => self.span_text(key.span()).to_string(),
        }
    }

    fn render_simple_assignment_target(&self, target: &SimpleAssignmentTarget<'a>) -> String {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
                if self.is_global_name(id.name.as_str()) && !self.declared(id.name.as_str()) {
                    format!("__zp_get(globalThis,{:?})", id.name.as_str())
                } else {
                    self.span_text(id.span).to_string()
                }
            }
            SimpleAssignmentTarget::StaticMemberExpression(expr) => format!("{}.{}", self.render_expression(&expr.object), expr.property.name.as_str()),
            SimpleAssignmentTarget::ComputedMemberExpression(expr) => format!("{}[{}]", self.render_expression(&expr.object), self.render_expression(&expr.expression)),
            SimpleAssignmentTarget::PrivateFieldExpression(expr) => self.span_text(expr.span).to_string(),
            _ => self.span_text(target.span()).to_string(),
        }
    }

    fn collect_body_bindings(&self, body: &[Statement<'a>], mode: ScopeMode) -> HashSet<String> {
        let mut names = HashSet::new();
        for stmt in body { self.collect_statement_bindings(stmt, mode, &mut names); }
        names
    }

    fn collect_statement_bindings(&self, stmt: &Statement<'a>, mode: ScopeMode, names: &mut HashSet<String>) {
        match stmt {
            Statement::ImportDeclaration(decl) => {
                if let Some(specs) = &decl.specifiers {
                    for spec in specs {
                        match spec {
                            ImportDeclarationSpecifier::ImportSpecifier(spec) => { names.insert(spec.local.name.to_string()); }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(spec) => { names.insert(spec.local.name.to_string()); }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(spec) => { names.insert(spec.local.name.to_string()); }
                        }
                    }
                }
            }
            Statement::FunctionDeclaration(func) => { if let Some(id) = &func.id { names.insert(id.name.to_string()); } }
            Statement::ClassDeclaration(class) => { if let Some(id) = &class.id { names.insert(id.name.to_string()); } }
            Statement::VariableDeclaration(decl) => {
                if mode == ScopeMode::Block {
                    if decl.kind != VariableDeclarationKind::Var { for d in &decl.declarations { self.collect_binding_pattern(&d.id, names); } }
                } else if decl.kind == VariableDeclarationKind::Var {
                    for d in &decl.declarations { self.collect_binding_pattern(&d.id, names); }
                }
            }
            Statement::BlockStatement(block) if mode != ScopeMode::Block => for stmt in &block.body { self.collect_statement_bindings(stmt, mode, names); },
            Statement::IfStatement(stmt) if mode != ScopeMode::Block => { self.collect_statement_bindings(&stmt.consequent, mode, names); if let Some(alt) = &stmt.alternate { self.collect_statement_bindings(alt, mode, names); } }
            Statement::ForStatement(stmt) if mode != ScopeMode::Block => {
                if let Some(ForStatementInit::VariableDeclaration(decl)) = &stmt.init { if decl.kind == VariableDeclarationKind::Var { for d in &decl.declarations { self.collect_binding_pattern(&d.id, names); } } }
                self.collect_statement_bindings(&stmt.body, mode, names);
            }
            Statement::ForInStatement(stmt) if mode != ScopeMode::Block => { if let ForStatementLeft::VariableDeclaration(decl) = &stmt.left { if decl.kind == VariableDeclarationKind::Var { for d in &decl.declarations { self.collect_binding_pattern(&d.id, names); } } } self.collect_statement_bindings(&stmt.body, mode, names); }
            Statement::ForOfStatement(stmt) if mode != ScopeMode::Block => { if let ForStatementLeft::VariableDeclaration(decl) = &stmt.left { if decl.kind == VariableDeclarationKind::Var { for d in &decl.declarations { self.collect_binding_pattern(&d.id, names); } } } self.collect_statement_bindings(&stmt.body, mode, names); }
            Statement::WhileStatement(stmt) if mode != ScopeMode::Block => self.collect_statement_bindings(&stmt.body, mode, names),
            Statement::DoWhileStatement(stmt) if mode != ScopeMode::Block => self.collect_statement_bindings(&stmt.body, mode, names),
            Statement::LabeledStatement(stmt) if mode != ScopeMode::Block => self.collect_statement_bindings(&stmt.body, mode, names),
            Statement::SwitchStatement(stmt) if mode != ScopeMode::Block => for case in &stmt.cases { for child in &case.consequent { self.collect_statement_bindings(child, mode, names); } },
            Statement::TryStatement(stmt) if mode != ScopeMode::Block => {
                self.collect_block_bindings(&stmt.block, names, mode);
                if let Some(handler) = &stmt.handler { self.collect_block_bindings(&handler.body, names, mode); }
                if let Some(finalizer) = &stmt.finalizer { self.collect_block_bindings(finalizer, names, mode); }
            }
            _ => {}
        }
    }
    fn collect_block_bindings(&self, block: &BlockStatement<'a>, names: &mut HashSet<String>, mode: ScopeMode) {
        for stmt in &block.body { self.collect_statement_bindings(stmt, mode, names); }
    }

    fn collect_binding_pattern(&self, pattern: &BindingPattern<'a>, names: &mut HashSet<String>) {
        match &pattern.kind {
            BindingPatternKind::BindingIdentifier(id) => { names.insert(id.name.to_string()); }
            BindingPatternKind::AssignmentPattern(pat) => self.collect_binding_pattern(&pat.left, names),
            BindingPatternKind::ArrayPattern(arr) => {
                for elem in &arr.elements { if let Some(p) = elem { self.collect_binding_pattern(p, names); } }
                if let Some(rest) = &arr.rest { self.collect_binding_pattern(&rest.argument, names); }
            }
            BindingPatternKind::ObjectPattern(obj) => {
                for prop in &obj.properties { self.collect_binding_pattern(&prop.value, names); }
                if let Some(rest) = &obj.rest { self.collect_binding_pattern(&rest.argument, names); }
            }
        }
    }

    fn collect_formal_parameters(&self, params: &FormalParameters<'a>, names: &mut HashSet<String>) {
        for param in &params.items { self.collect_binding_pattern(&param.pattern, names); }
        if let Some(rest) = &params.rest { self.collect_binding_pattern(&rest.argument, names); }
    }

    fn is_global_name(&self, name: &str) -> bool { GLOBALS.iter().any(|global| *global == name) && !self.declared(name) }

    fn member_needs_helper_static(&self, expr: &StaticMemberExpression<'a>) -> bool {
        MEMBER_HELPER_PROPS.iter().any(|prop| *prop == expr.property.name.as_str())
    }

    fn member_needs_helper_computed(&self, expr: &ComputedMemberExpression<'a>) -> bool {
        self.is_window_like_expression(&expr.object)
    }

    fn is_window_like_expression(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::Identifier(id) => matches!(id.name.as_str(), "window" | "self" | "globalThis" | "top" | "parent" | "frames" | "document") && !self.declared(id.name.as_str()),
            Expression::StaticMemberExpression(member) => matches!(member.property.name.as_str(), "defaultView" | "contentWindow" | "window" | "self" | "globalThis" | "top" | "parent" | "opener" | "frames") && self.is_window_like_expression(&member.object),
            Expression::ComputedMemberExpression(member) => self.is_window_like_expression(&member.object),
            _ => false,
        }
    }

    fn is_virtual_location_expression(&self, expr: &Expression<'a>) -> bool {
        match expr {
            Expression::Identifier(id) => id.name == "location" && !self.declared(id.name.as_str()),
            Expression::StaticMemberExpression(member) => member.property.name == "location" && self.is_window_like_expression(&member.object),
            Expression::ComputedMemberExpression(member) => self.is_window_like_expression(&member.object),
            _ => false,
        }
    }

    fn assignment_target(&self, target: &AssignmentTarget<'a>) -> Option<(String, String)> {
        match target {
            AssignmentTarget::AssignmentTargetIdentifier(id) if self.is_global_name(id.name.as_str()) && matches!(id.name.as_str(), "location" | "window") => Some(("globalThis".to_string(), format!("{:?}", id.name.as_str()))),
            AssignmentTarget::StaticMemberExpression(expr) if expr.property.name == "location" && self.is_window_like_expression(&expr.object) => Some((self.render_expression(&expr.object), format!("{:?}", expr.property.name.as_str()))),
            AssignmentTarget::StaticMemberExpression(expr) if matches!(expr.property.name.as_str(), "href" | "hash") && self.is_virtual_location_expression(&expr.object) => Some((self.render_expression(&expr.object), format!("{:?}", expr.property.name.as_str()))),
            AssignmentTarget::ComputedMemberExpression(expr) if self.is_window_like_expression(&expr.object) || self.is_virtual_location_expression(&expr.object) => Some((self.render_expression(&expr.object), self.render_expression(&expr.expression))),
            AssignmentTarget::StaticMemberExpression(expr) if self.member_needs_helper_static(expr) => Some((self.render_expression(&expr.object), format!("{:?}", expr.property.name.as_str()))),
            AssignmentTarget::ComputedMemberExpression(expr) if self.member_needs_helper_computed(expr) => Some((self.render_expression(&expr.object), self.render_expression(&expr.expression))),
            _ => None,
        }
    }

    fn call_target(&self, callee: &Expression<'a>) -> Option<(String, String)> {
        match callee {
            Expression::StaticMemberExpression(expr) => {
                let prop = expr.property.name.as_str();
                if CALL_HELPER_PROPS.iter().any(|name| *name == prop) || self.member_needs_helper_static(expr) {
                    Some((self.render_expression(&expr.object), format!("{:?}", prop)))
                } else {
                    None
                }
            }
            Expression::ComputedMemberExpression(expr) => {
                if self.member_needs_helper_computed(expr) {
                    Some((self.render_expression(&expr.object), self.render_expression(&expr.expression)))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn construct_target(&self, callee: &Expression<'a>) -> Option<String> {
        match callee {
            Expression::Identifier(id) if self.is_global_name(id.name.as_str()) => Some(self.render_expression(callee)),
            Expression::StaticMemberExpression(expr) if self.is_window_like_expression(&expr.object) => Some(self.render_expression(callee)),
            Expression::ComputedMemberExpression(expr) if self.is_window_like_expression(&expr.object) => Some(self.render_expression(callee)),
            _ => None,
        }
    }

    fn is_import_meta_url_static(&self, expr: &StaticMemberExpression<'a>) -> bool {
        self.module && expr.property.name == "url" && matches!(&expr.object, Expression::MetaProperty(meta) if meta.meta.name == "import" && meta.property.name == "meta")
    }

    fn module_specifier(&self, raw: &str) -> String {
        if !self.module { return raw.to_string(); }
        if is_bare_specifier(raw) { return raw.to_string(); }
        if has_scheme(raw) && !raw.starts_with("http://") && !raw.starts_with("https://") {
            return format!("{}error/POLICY_BLOCKED", self.control_prefix);
        }
        let abs = join_url(self.target_url, raw);
        if !abs.starts_with("http://") && !abs.starts_with("https://") {
            return format!("{}error/POLICY_BLOCKED", self.control_prefix);
        }
        format!("{}api/script?kind=module&u={}", self.control_prefix, percent_encode(abs))
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

fn is_bare_specifier(spec: &str) -> bool {
    !spec.starts_with('/') && !spec.starts_with("./") && !spec.starts_with("../") && !has_scheme(spec)
}

fn has_scheme(spec: &str) -> bool {
    let mut chars = spec.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' { return true; }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') { return false; }
    }
    false
}

fn join_url(base: &str, raw: &str) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") { return raw.to_string(); }
    if raw.starts_with('/') {
        if let Some(idx) = base.find("://") {
            let rest = &base[idx + 3..];
            if let Some(slash) = rest.find('/') { return format!("{}{}", &base[..idx + 3 + slash], raw); }
        }
        return raw.to_string();
    }
    let prefix = match base.rfind('/') { Some(i) => &base[..=i], None => base };
    let mut parts: Vec<&str> = prefix.split('/').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    for part in raw.split('/') {
        match part {
            "." => {}
            ".." => { if parts.len() > 3 { parts.pop(); } }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn percent_encode(input: String) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
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
        assert!(code.contains("__zp_assign(__zp_get(__zp_get(globalThis,\"window\"),\"location\"),\"hash\""));
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
        assert!(code.contains("import \"/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js\";"));
        assert!(code.contains("__zp_module_url('./chunks/' + name + '.js',\"https://example.com/assets/main.js\")"));
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
        assert!(code.contains("__zp_construct(__zp_get(globalThis,\"WebSocket\"),['/ws',['chat']])"));
        assert!(code.contains("__zp_call(Object,\"getOwnPropertyDescriptor\",[__zp_get(globalThis,\"window\"),'location'])"));
    }

    #[test]
    fn parse_failures_return_error() {
        let out = rewrite_script("if (", "classic", "https://example.com/app.js", "/zp/");
        assert!(!out.ok);
        assert_eq!(out.error, "PARSE_FAILED");
    }
}
