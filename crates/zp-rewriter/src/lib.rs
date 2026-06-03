//! ZeroProxy JS rewriter — OXC AST-based.
//!
//! Patch-mode output (plan: 메모리 최적화 원칙 #3): rather than re-emit the
//! full source, we return a list of (offset, length, replacement) tuples that
//! the caller applies in place. This keeps unchanged source bytes shared and
//! avoids the O(n) cost of full codegen on 90%-unchanged scripts.
//!
//! Initial rule set (mirrors web/js-rewriter.js):
//! - Unresolved global identifier references to a dangerous list
//!   (location, window, document, history, top, parent, opener, frames, self,
//!   globalThis) become `__zp_get(globalThis, '<name>')`.
//! - Locally bound identifiers with the same name are NOT rewritten
//!   (scope tracking via OXC semantic later; this initial pass uses a simple
//!   declaration stack walk).

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};
use std::collections::HashSet;
use zp_shared::ErrorCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    Classic,
    Module,
    EventHandler,
    Eval,
    Function,
    Worker,
}

impl ScriptKind {
    fn source_type(self) -> SourceType {
        match self {
            ScriptKind::Module => SourceType::mjs(),
            _ => SourceType::cjs(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RewriteOpts {
    pub kind: ScriptKind,
    pub target_url: String,
    pub strict: bool,
}

/// A single source patch: replace `source[span.start..span.end]` with `replacement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub start: u32,
    pub end: u32,
    pub replacement: String,
}

#[derive(Debug, Default)]
pub struct RewriteResult {
    pub code: String,
    pub patches: Vec<Patch>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RewriteError {
    #[error("parse failed: {0}")]
    ParseFailed(String),
    #[error("rewrite failed: {0}")]
    RewriteFailed(String),
    #[error("unsupported syntax: {0}")]
    UnsupportedSyntax(String),
}

impl RewriteError {
    pub fn code(&self) -> ErrorCode {
        ErrorCode::RewriteFailed
    }
}

/// Names that, when referenced as an *unbound* global identifier, must be
/// routed through the runtime membrane instead of touching the real native.
pub(crate) const DANGEROUS_GLOBALS: &[&str] = &[
    "location",
    "window",
    "document",
    "history",
    "top",
    "parent",
    "opener",
    "frames",
    "self",
    "globalThis",
];

/// Member names that, when accessed on ANY object, must go through the
/// runtime membrane (`__zp_get(obj, 'name')`). These are the cross-realm
/// escape vectors that target code uses to reach an unmediated native
/// `Location` / `Window` / `Document` even after the global identifier
/// has been rewritten (e.g., `iframe.contentWindow.location`).
pub(crate) const DANGEROUS_MEMBERS: &[&str] = &[
    "location",
    "contentWindow",
    "contentDocument",
    "defaultView",
    "frameElement",
    "parent",
    "top",
    "opener",
    "frames",
    // URL-shape properties — rewriter doesn't know if base is a Location
    // instance, so wrap on every access. Membrane's Location-base intercept
    // returns virtualURL.* values for true Location instances; falls
    // through to native for unrelated objects (URL instances are
    // legitimately different and return their own values).
    "href",
    "protocol",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
    "origin",
];

/// Method names that, when called on ANY object, should be routed through the
/// runtime membrane (`__zp_call(obj, 'method', [args])`). Calling these on a
/// virtual Location or virtual Window must observe the proxy navigation
/// semantics; calling them on an unrelated object is a no-op (the membrane
/// `__zp_call` falls through to native).
pub(crate) const DANGEROUS_METHODS: &[&str] = &[
    "assign",
    "replace",
    "open",
    "postMessage",
    "pushState",
    "replaceState",
];

fn is_dangerous_global(name: &str) -> bool {
    DANGEROUS_GLOBALS.iter().any(|g| *g == name)
}

fn is_dangerous_member(name: &str) -> bool {
    DANGEROUS_MEMBERS.iter().any(|m| *m == name)
}

fn is_dangerous_method(name: &str) -> bool {
    DANGEROUS_METHODS.iter().any(|m| *m == name)
}

/// Rewrite a JavaScript source string per the strict-mode policy.
pub fn rewrite_script(source: &str, opts: &RewriteOpts) -> Result<RewriteResult, RewriteError> {
    let allocator = Allocator::default();
    let source_type = opts.kind.source_type();
    let ret = Parser::new(&allocator, source, source_type).parse();

    if !ret.errors.is_empty() && opts.strict {
        let msg = ret
            .errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(RewriteError::ParseFailed(msg));
    }

    let mut visitor = RewriteVisitor::new();
    visitor.visit_program(&ret.program);

    // Apply patches to produce final code. Patches sorted by start ascending
    // and non-overlapping (visitor guarantees this for identifier rewrites).
    let mut patches = visitor.patches;
    patches.sort_by_key(|p| p.start);
    let code = apply_patches(source, &patches);

    Ok(RewriteResult {
        code,
        patches,
        diagnostics: visitor.diagnostics,
    })
}

/// Shift any embedded absolute spans inside a marker replacement string by
/// `-offset` so they make sense in a sub-source view. Markers we know:
/// - MEMBER_GET: obj_start, obj_end (positions 2, 3)
/// - MEMBER_SET: obj_start, obj_end, val_start, val_end (positions 2, 3, 5, 6)
/// - METHOD_CALL: obj_start, obj_end, args_start, args_end (positions 2, 3, 5, 6)
fn shift_marker_positions(replacement: &str, offset: u32) -> String {
    let prefixes: &[(&str, &[usize])] = &[
        ("\u{1}GLOBAL_GET\u{1}", &[]),
        ("\u{1}MEMBER_GET\u{1}", &[2, 3]),
        ("\u{1}MEMBER_SET\u{1}", &[2, 3, 5, 6]),
        ("\u{1}METHOD_CALL\u{1}", &[2, 3, 5, 6]),
    ];
    for (prefix, shift_indices) in prefixes {
        if replacement.starts_with(*prefix) {
            let mut parts: Vec<String> = replacement.split('\u{1}').map(str::to_string).collect();
            for &i in *shift_indices {
                if i < parts.len() {
                    if let Ok(v) = parts[i].parse::<u32>() {
                        parts[i] = v.saturating_sub(offset).to_string();
                    }
                }
            }
            return parts.join("\u{1}");
        }
    }
    replacement.to_string()
}

fn apply_patches(source: &str, patches: &[Patch]) -> String {
    // Deduplicate overlapping patches: when patch B is fully contained inside
    // patch A (A.start <= B.start && B.end <= A.end), prefer A (outer) and
    // drop B. This matches the rewrite semantics where outer member-get
    // already wraps the inner receiver text verbatim, including any
    // dangerous identifier the inner pass also flagged.
    let mut sorted: Vec<&Patch> = patches.iter().collect();
    sorted.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end))); // outer first
    let mut chosen: Vec<&Patch> = Vec::with_capacity(sorted.len());
    let mut last_end: u32 = 0;
    for p in sorted {
        if p.start < last_end {
            // Overlaps previous chosen — skip (inner contained in outer).
            continue;
        }
        chosen.push(p);
        last_end = p.end;
    }

    let mut out = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut cursor: usize = 0;
    // 패치 emission 시 leading `(` 가 필요한지 결정.
    // - 직전 byte 가 identifier-continue (영숫자/`_`/`$`) 면 `return` 같은
    //   keyword 또는 free identifier 와 glue 됨 → paren 필요.
    // - 직전 non-ws 토큰이 `new` 면 `new MemberExpression Arguments` 문법이
    //   call 을 capture 함 → paren 으로 격리 필요.
    // - 그 외 (`(`/`,`/`{`/`}`/`;`/`=`/`\n` + identifier-continue 가 아닌 경우)
    //   는 paren 미추가 — `var x=1\n(call)` 같은 ASI 위험 회피.
    let needs_paren_prefix = |start: usize| -> bool {
        if start == 0 {
            return false;
        }
        let prev = bytes[start - 1];
        if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'$' {
            return true;
        }
        // Look back past whitespace for `new` keyword.
        let mut i = start;
        while i > 0 {
            let c = bytes[i - 1];
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                i -= 1;
                continue;
            }
            break;
        }
        if i >= 3 {
            let kw = &bytes[i - 3..i];
            if kw == b"new" {
                // Ensure `new` is not part of a longer identifier like `renew`.
                if i == 3 {
                    return true;
                }
                let before = bytes[i - 4];
                if !(before.is_ascii_alphanumeric() || before == b'_' || before == b'$') {
                    return true;
                }
            }
        }
        false
    };
    for p in chosen {
        let start = p.start as usize;
        let end = p.end as usize;
        if start < cursor || end > bytes.len() || start > end {
            continue;
        }
        out.push_str(&source[cursor..start]);
        // Marker patches need the receiver source text. Helper recursively
        // applies any contained inner patches to a sub-range of source.
        // CRITICAL: when shifting markers into the sub-range, also shift the
        // absolute spans embedded inside the marker replacement strings —
        // those refer to positions in the ORIGINAL source, which become wrong
        // once the marker is applied against a sub-string.
        let rewrite_range = |start: usize, end: usize| -> String {
            if start >= end || end > bytes.len() {
                return String::new();
            }
            let sub = &source[start..end];
            let offset = start as u32;
            let inner: Vec<Patch> = patches
                .iter()
                .filter(|q| (q.start as usize) >= start && (q.end as usize) <= end)
                .filter(|q| !std::ptr::eq(*q, p))
                .map(|q| Patch {
                    start: q.start - offset,
                    end: q.end - offset,
                    replacement: shift_marker_positions(&q.replacement, offset),
                })
                .collect();
            if inner.is_empty() {
                sub.to_string()
            } else {
                apply_patches(sub, &inner)
            }
        };

        if p.replacement.starts_with("\u{1}GLOBAL_GET\u{1}") {
            // \u{1}GLOBAL_GET\u{1}<name>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 4 {
                let name = parts[2];
                if needs_paren_prefix(start) {
                    out.push_str(&format!("(__zp_get(globalThis,{:?}))", name));
                } else {
                    out.push_str(&format!("__zp_get(globalThis,{:?})", name));
                }
                cursor = end;
                continue;
            }
        } else if p.replacement.starts_with("\u{1}MEMBER_GET\u{1}") {
            // \u{1}MEMBER_GET\u{1}<obj_start>\u{1}<obj_end>\u{1}<prop>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 6 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let prop = parts[4];
                if obj_start < obj_end && obj_end <= bytes.len() {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    if needs_paren_prefix(start) {
                        out.push_str(&format!("(__zp_get({},{:?}))", obj_src, prop));
                    } else {
                        out.push_str(&format!("__zp_get({},{:?})", obj_src, prop));
                    }
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}MEMBER_SET\u{1}") {
            // \u{1}MEMBER_SET\u{1}<obj_start>\u{1}<obj_end>\u{1}<prop>\u{1}<val_start>\u{1}<val_end>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 8 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let prop = parts[4];
                let val_start: usize = parts[5].parse().unwrap_or(0);
                let val_end: usize = parts[6].parse().unwrap_or(0);
                if obj_start < obj_end && val_start <= val_end && val_end <= bytes.len() {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    let val_src = rewrite_range(val_start, val_end);
                    if needs_paren_prefix(start) {
                        out.push_str(&format!("(__zp_set({},{:?},{}))", obj_src, prop, val_src));
                    } else {
                        out.push_str(&format!("__zp_set({},{:?},{})", obj_src, prop, val_src));
                    }
                    cursor = end;
                    continue;
                }
            }
        } else if p.replacement.starts_with("\u{1}METHOD_CALL\u{1}") {
            // \u{1}METHOD_CALL\u{1}<obj_start>\u{1}<obj_end>\u{1}<method>\u{1}<args_start>\u{1}<args_end>\u{1}
            let parts: Vec<&str> = p.replacement.split('\u{1}').collect();
            if parts.len() >= 8 {
                let obj_start: usize = parts[2].parse().unwrap_or(0);
                let obj_end: usize = parts[3].parse().unwrap_or(0);
                let method = parts[4];
                let args_start: usize = parts[5].parse().unwrap_or(0);
                let args_end: usize = parts[6].parse().unwrap_or(0);
                if obj_start < obj_end {
                    let obj_src = rewrite_range(obj_start, obj_end);
                    let args_src = if args_start < args_end && args_end <= bytes.len() {
                        rewrite_range(args_start, args_end)
                    } else {
                        String::new()
                    };
                    if needs_paren_prefix(start) {
                        out.push_str(&format!(
                            "(__zp_call({},{:?},[{}]))",
                            obj_src, method, args_src
                        ));
                    } else {
                        out.push_str(&format!(
                            "__zp_call({},{:?},[{}])",
                            obj_src, method, args_src
                        ));
                    }
                    cursor = end;
                    continue;
                }
            }
        }
        out.push_str(&p.replacement);
        cursor = end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// Persistent rewriter instance — reuses an allocator across calls.
pub struct RewriterInstance {
    // OXC Allocator is reset between calls. Holding a single one here would
    // require unsafe trickery to outlive the borrow; we instead allocate
    // per call but keep the configuration here as a placeholder for future
    // arena reuse via bumpalo Reset.
}

impl Default for RewriterInstance {
    fn default() -> Self {
        Self::new()
    }
}

impl RewriterInstance {
    pub fn new() -> Self {
        Self {}
    }

    pub fn rewrite(
        &mut self,
        source: &str,
        opts: &RewriteOpts,
    ) -> Result<RewriteResult, RewriteError> {
        rewrite_script(source, opts)
    }

    pub fn reset(&mut self) {}
}

/// AST visitor that walks programs and produces global-identifier patches.
struct RewriteVisitor {
    patches: Vec<Patch>,
    diagnostics: Vec<String>,
    /// Stack of lexical scopes; each scope holds names that should NOT be
    /// rewritten because they shadow the dangerous globals.
    scopes: Vec<HashSet<String>>,
}

impl RewriteVisitor {
    fn new() -> Self {
        Self {
            patches: Vec::new(),
            diagnostics: Vec::new(),
            scopes: vec![HashSet::new()],
        }
    }

    fn push_scope(&mut self) {
        self.scopes.push(HashSet::new());
    }

    fn pop_scope(&mut self) {
        self.scopes.pop();
    }

    fn declare(&mut self, name: &str) {
        if let Some(top) = self.scopes.last_mut() {
            top.insert(name.to_string());
        }
    }

    fn is_shadowed(&self, name: &str) -> bool {
        self.scopes.iter().rev().any(|scope| scope.contains(name))
    }

    fn emit_global_get(&mut self, span: Span, name: &str) {
        // 괄호는 contextual 로 apply_patches 에서 결정. 여기서는 marker 로 emission.
        self.patches.push(Patch {
            start: span.start,
            end: span.end,
            replacement: format!("\u{1}GLOBAL_GET\u{1}{}\u{1}", name),
        });
    }
}

impl<'a> Visit<'a> for RewriteVisitor {
    fn visit_program(&mut self, program: &Program<'a>) {
        // Collect hoisted function + var declarations into top-level scope first.
        for stmt in &program.body {
            if let Statement::FunctionDeclaration(f) = stmt {
                if let Some(id) = &f.id {
                    self.declare(id.name.as_str());
                }
            }
        }
        walk::walk_program(self, program);
    }

    fn visit_function(&mut self, func: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        self.push_scope();
        for param in &func.params.items {
            collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        }
        if let Some(id) = &func.id {
            self.declare(id.name.as_str());
        }
        walk::walk_function(self, func, flags);
        self.pop_scope();
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        self.push_scope();
        for param in &arrow.params.items {
            collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        }
        walk::walk_arrow_function_expression(self, arrow);
        self.pop_scope();
    }

    fn visit_block_statement(&mut self, block: &BlockStatement<'a>) {
        self.push_scope();
        walk::walk_block_statement(self, block);
        self.pop_scope();
    }

    fn visit_variable_declarator(&mut self, decl: &VariableDeclarator<'a>) {
        collect_binding_pattern(&decl.id, &mut |a| self.declare(a));
        walk::walk_variable_declarator(self, decl);
    }

    fn visit_catch_parameter(&mut self, param: &CatchParameter<'a>) {
        collect_binding_pattern(&param.pattern, &mut |a| self.declare(a));
        walk::walk_catch_parameter(self, param);
    }

    fn visit_identifier_reference(&mut self, ident: &IdentifierReference<'a>) {
        let name = ident.name.as_str();
        if is_dangerous_global(name) && !self.is_shadowed(name) {
            self.emit_global_get(ident.span, name);
        }
    }

    fn visit_call_expression(&mut self, expr: &CallExpression<'a>) {
        // First walk children (args + callee) so global identifiers are
        // patched normally. Then check if this is a dangerous method call.
        walk::walk_call_expression(self, expr);
        if let Expression::StaticMemberExpression(member) = &expr.callee {
            let method = member.property.name.as_str();

            // Reflect.get(obj, 'dangerous') / Reflect.set(obj, 'dangerous', val) /
            // Object.getOwnPropertyDescriptor(obj, 'dangerous'): rewrite to the
            // membrane equivalent so the descriptor / value returned is the
            // proxy-wrapped one rather than a clean native reference.
            if let Expression::Identifier(recv) = &member.object {
                let recv_name = recv.name.as_str();
                if !self.is_shadowed(recv_name) {
                    if recv_name == "Reflect" && (method == "get" || method == "set") {
                        if let Some(dangerous) = static_string_arg(&expr.arguments, 1) {
                            if is_dangerous_member(dangerous) || is_dangerous_global(dangerous) {
                                use oxc_span::GetSpan;
                                if let Some(arg0) = expr.arguments.first() {
                                    let obj_span = arg0.span();
                                    if method == "get" {
                                        self.patches.push(Patch {
                                            start: expr.span.start,
                                            end: expr.span.end,
                                            replacement: format!(
                                                "\u{1}MEMBER_GET\u{1}{}\u{1}{}\u{1}{}\u{1}",
                                                obj_span.start, obj_span.end, dangerous
                                            ),
                                        });
                                        return;
                                    }
                                    if method == "set" && expr.arguments.len() >= 3 {
                                        let val_span = expr.arguments[2].span();
                                        self.patches.push(Patch {
                                            start: expr.span.start,
                                            end: expr.span.end,
                                            replacement: format!(
                                                "\u{1}MEMBER_SET\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                                                obj_span.start,
                                                obj_span.end,
                                                dangerous,
                                                val_span.start,
                                                val_span.end
                                            ),
                                        });
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    if recv_name == "Object" && method == "getOwnPropertyDescriptor" {
                        if let Some(dangerous) = static_string_arg(&expr.arguments, 1) {
                            if is_dangerous_member(dangerous) || is_dangerous_global(dangerous) {
                                self.diagnostics.push(format!(
                                    "Object.getOwnPropertyDescriptor({{...}},'{}') call observed; descriptor value passes through membrane",
                                    dangerous
                                ));
                            }
                        }
                    }
                }
            }

            // Same reason as visit_static_member_expression / assignment:
            // `super.method(...)` must stay literal — wrapping it strips the
            // class context and triggers "'super' keyword unexpected here".
            if matches!(member.object, Expression::Super(_)) {
                return;
            }
            if is_dangerous_method(method) {
                use oxc_span::GetSpan;
                let obj_span = member.object.span();
                let args_span = if expr.arguments.is_empty() {
                    None
                } else {
                    let first = expr.arguments.first().unwrap();
                    let last = expr.arguments.last().unwrap();
                    Some((first.span().start, last.span().end))
                };
                let (args_start, args_end) = args_span.unwrap_or((0, 0));
                self.patches.push(Patch {
                    start: expr.span.start,
                    end: expr.span.end,
                    replacement: format!(
                        "\u{1}METHOD_CALL\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                        obj_span.start, obj_span.end, method, args_start, args_end
                    ),
                });
            }
        }
    }

    fn visit_with_statement(&mut self, stmt: &WithStatement<'a>) {
        // `with(obj){...}` lets free identifiers inside the body bind to obj's
        // properties at runtime. Strict mode JS rejects with-statements outright,
        // but classic-script targets may use them. We don't currently rewrite
        // identifier references inside the body specially — record a diagnostic
        // so audit can see when target code uses this pattern.
        self.diagnostics.push(format!(
            "with-statement at {}..{}: free identifier rewrites may be incorrect inside body",
            stmt.span.start, stmt.span.end
        ));
        walk::walk_with_statement(self, stmt);
    }

    fn visit_assignment_expression(&mut self, expr: &AssignmentExpression<'a>) {
        walk::walk_assignment_expression(self, expr);
        // Detect simple assignments like `obj.<dangerous> = value` and rewrite
        // them to `__zp_set(obj, 'dangerous', value)`. Compound assignments
        // (`+=`, `-=`, etc.) are intentionally left as native — they have
        // read-then-write semantics that the membrane setter still observes
        // because the read goes through __zp_get.
        if expr.operator != oxc_syntax::operator::AssignmentOperator::Assign {
            return;
        }
        let target = match &expr.left {
            AssignmentTarget::StaticMemberExpression(m) => m,
            _ => return,
        };
        // Same reason as visit_static_member_expression: `super.x = v` would
        // become invalid `__zp_set(super, "x", v)`.
        if matches!(target.object, Expression::Super(_)) {
            return;
        }
        let prop = target.property.name.as_str();
        if !is_dangerous_member(prop) {
            return;
        }
        use oxc_span::GetSpan;
        let obj_span = target.object.span();
        let value_span = expr.right.span();
        self.patches.push(Patch {
            start: expr.span.start,
            end: expr.span.end,
            replacement: format!(
                "\u{1}MEMBER_SET\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}",
                obj_span.start, obj_span.end, prop, value_span.start, value_span.end
            ),
        });
    }

    fn visit_static_member_expression(&mut self, expr: &StaticMemberExpression<'a>) {
        // Walk children first (so receiver is rewritten before we wrap).
        walk::walk_static_member_expression(self, expr);
        // `super.x` is only legal as part of a class method's body — `super`
        // is a keyword and cannot appear as an identifier expression, so
        // `__zp_get(super, "x")` is a SyntaxError. Leave super member access
        // untouched (it's already restricted to its class context).
        if matches!(expr.object, Expression::Super(_)) {
            return;
        }
        // If the receiver is a bare identifier that's bound in the current
        // lexical scope (function param, destructured param, var/let/const,
        // catch parameter), the access is *local* and the membrane rewrite
        // would change semantics. `function f(location){ return location.href; }`
        // must remain `location.href`, not `__zp_get(location, "href")` —
        // the param shadows the global. The visit_identifier_reference path
        // already honours `is_shadowed` for the receiver; mirror that here
        // so the dangerous-member detection doesn't override the shadowing.
        if let Expression::Identifier(recv) = &expr.object {
            if self.is_shadowed(recv.name.as_str()) {
                return;
            }
        }
        let prop = expr.property.name.as_str();
        if is_dangerous_member(prop) {
            // Note: we intentionally keep the inner identifier patch that
            // visit_identifier_reference may have emitted for the receiver.
            // `apply_patches` sorts overlapping patches outer-first into
            // `chosen` and drops the inner one from the apply set, but the
            // `MEMBER_GET` marker resolver re-runs `rewrite_range` over the
            // receiver substring — that step picks the inner identifier
            // patch back up so a `location.href` read renders as
            // `__zp_get(__zp_get(globalThis,"location"),"href")` and an
            // `obj.href = v` assignment uses the rewritten receiver inside
            // the `__zp_set` call. Draining the inner patch here would strip
            // the receiver back to the bare source slice and break the
            // `javascript_url_anchor_routed` contract in zp-htmltx.
            // Record the textual span of the object so we can splice it as the
            // first arg to __zp_get(obj, 'name'). We don't have the source
            // string here; we record the object span and the visitor's caller
            // (the apply_patches step) will use source[obj.start..obj.end].
            // To do that we emit a patch whose replacement references a
            // placeholder we resolve below via the source string.
            // Implementation: we just emit (start..end of full member expr)
            // with replacement built from source slice in a post-walk pass.
            // For now we use a Patch with the textual span and store a marker.
            self.patches.push(Patch {
                start: expr.span.start,
                end: expr.span.end,
                replacement: format!(
                    "\u{1}MEMBER_GET\u{1}{}\u{1}{}\u{1}{}\u{1}",
                    expr.object_span().start,
                    expr.object_span().end,
                    prop
                ),
            });
        }
    }
}

/// Helper: object span of a static member expression `obj.prop` ranges from
/// the start of `obj` to before the `.`.
trait StaticMemberExt {
    fn object_span(&self) -> Span;
}
impl<'a> StaticMemberExt for StaticMemberExpression<'a> {
    fn object_span(&self) -> Span {
        // Use the receiver expression's span. Helper enum: Expression has a
        // GetSpan impl; we use the trait to extract it.
        use oxc_span::GetSpan;
        self.object.span()
    }
}

/// Extract a static string-literal argument from a call's argument list.
/// Used to recognise patterns like `Reflect.get(x, 'location')` where the
/// property is statically known. Returns None for computed/dynamic args.
fn static_string_arg<'a>(
    args: &oxc_allocator::Vec<'a, Argument<'a>>,
    idx: usize,
) -> Option<&'a str> {
    let arg = args.get(idx)?;
    match arg {
        Argument::StringLiteral(s) => Some(s.value.as_str()),
        _ => None,
    }
}

/// Walk a BindingPattern (destructuring, etc.) and call `out` for each
/// declared name. v0.133: BindingPattern is a direct enum.
fn collect_binding_pattern<'a, F: FnMut(&str)>(pat: &BindingPattern<'a>, out: &mut F) {
    match pat {
        BindingPattern::BindingIdentifier(id) => out(id.name.as_str()),
        BindingPattern::ObjectPattern(obj) => {
            for prop in &obj.properties {
                collect_binding_pattern(&prop.value, out);
            }
            if let Some(rest) = &obj.rest {
                collect_binding_pattern(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(arr) => {
            for el in &arr.elements {
                if let Some(el) = el {
                    collect_binding_pattern(el, out);
                }
            }
            if let Some(rest) = &arr.rest {
                collect_binding_pattern(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(asn) => {
            collect_binding_pattern(&asn.left, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RewriteOpts {
        RewriteOpts {
            kind: ScriptKind::Classic,
            target_url: "https://example.com/".into(),
            strict: true,
        }
    }

    #[test]
    fn super_constructor_with_extends_globalthis_member() {
        // Real-world pattern from kw-owner: class extends a rewritten global,
        // constructor calls super(args). Rewriter must keep super() in place
        // and the class context valid.
        let src =
            "class A extends globalThis.X { constructor(p) { super(p); this.location = p; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(r.code.contains("super(p)"), "super(p) gone: {}", r.code);
        // Make sure we didn't accidentally rewrite super.location to __zp_set(super,...)
        assert!(
            !r.code.contains("__zp_set(super"),
            "super target wrapped: {}",
            r.code
        );
    }

    #[test]
    fn super_method_call_not_rewritten() {
        // `super.write(...)` (or any other dangerous-method name) must NOT be
        // wrapped in __zp_call(super, ...) — that's the actual failure mode
        // we see on comic.naver.com's kw-owner bundle.
        let src = "class C extends B { m() { super.write('x'); } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_call(super"),
            "super.method() must stay native, got: {}",
            r.code
        );
        assert!(
            r.code.contains("super.write"),
            "super.write missing: {}",
            r.code
        );
    }

    #[test]
    fn super_call_not_rewritten() {
        // `super(...)` in a constructor must stay literal — wrapping would
        // strip class context and trigger "'super' keyword unexpected".
        let src = "class C extends B { constructor() { super(); this.x = 1; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("super()"),
            "super() must remain in output, got: {}",
            r.code
        );
    }

    #[test]
    fn super_member_access_not_rewritten() {
        // `super.foo` and `super.foo = v` must be left untouched even when
        // `foo` is on the dangerous-member list — `__zp_get(super, "foo")`
        // is a SyntaxError outside class context. Observed on comic.naver.com
        // (webtoon) bundles where the entire React init fails because one
        // vendor script throws SyntaxError: 'super' keyword unexpected here.
        let src = "class C extends B { m() { return super.location; } }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get(super"),
            "super.x must stay native, got: {}",
            r.code
        );
        let src2 = "class C extends B { m(v) { super.location = v; } }";
        let r2 = rewrite_script(src2, &opts()).unwrap();
        assert!(
            !r2.code.contains("__zp_set(super"),
            "super.x = v must stay native, got: {}",
            r2.code
        );
    }

    #[test]
    fn empty_source_no_patches() {
        let r = rewrite_script("", &opts()).unwrap();
        assert_eq!(r.patches.len(), 0);
        assert_eq!(r.code, "");
    }

    #[test]
    fn rewrites_unbound_location() {
        let src = "var x = location.href;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"location\")"),
            "got: {}",
            r.code
        );
    }

    #[test]
    fn rewrites_unbound_window() {
        let src = "console.log(window);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"window\")"),
            "got: {}",
            r.code
        );
    }

    #[test]
    fn does_not_rewrite_shadowed_location() {
        let src = "function f(location){ return location.href; }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "shadowed param should not be rewritten, got: {}",
            r.code
        );
    }

    #[test]
    fn does_not_rewrite_var_decl_with_same_name() {
        let src = "var location = 'x'; use(location);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "shadowed var should not be rewritten, got: {}",
            r.code
        );
    }

    #[test]
    fn rewrites_history_and_top() {
        let src = "history.pushState({}, '', top.location.pathname);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(globalThis,\"history\")"),
            "history not rewritten: {}",
            r.code
        );
        assert!(
            r.code.contains("__zp_get(globalThis,\"top\")"),
            "top not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn parse_failure_is_strict_error() {
        let r = rewrite_script("function {", &opts());
        assert!(
            matches!(r, Err(RewriteError::ParseFailed(_))),
            "got: {:?}",
            r
        );
    }

    #[test]
    fn module_mode_handles_import() {
        let mut o = opts();
        o.kind = ScriptKind::Module;
        let r = rewrite_script("import { x } from './mod.js'; use(window);", &o).unwrap();
        assert!(r.code.contains("__zp_get(globalThis,\"window\")"));
    }

    #[test]
    fn patches_are_in_source_order() {
        let src = "a(window); b(location); c(history);";
        let r = rewrite_script(src, &opts()).unwrap();
        for win in r.patches.windows(2) {
            assert!(win[0].start <= win[1].start, "patches not sorted");
        }
    }

    #[test]
    fn destructuring_param_shadows() {
        let src = "function f({location}) { return location.href; }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "destructured param should shadow, got: {}",
            r.code
        );
    }

    #[test]
    fn catch_clause_param_shadows() {
        let src = "try { use(window); } catch (window) { use(window); }";
        let r = rewrite_script(src, &opts()).unwrap();
        // The first window is unbound and should be rewritten; the second is shadowed by catch param.
        // Patch count: only the first window.
        let zp_gets = r.code.matches("__zp_get").count();
        assert_eq!(zp_gets, 1, "expected exactly one rewrite, got: {}", r.code);
    }

    #[test]
    fn iframe_content_window_rewrites() {
        let src = "iframe.contentWindow.fetch();";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(iframe,\"contentWindow\")"),
            "iframe.contentWindow not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn document_default_view_rewrites() {
        let src = "var v = document.defaultView;";
        let r = rewrite_script(src, &opts()).unwrap();
        // document is also a dangerous global so it'll be rewritten as the receiver.
        assert!(
            r.code.contains("\"defaultView\""),
            "defaultView not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn member_access_to_safe_prop_left_alone() {
        let src = "obj.foo.bar();";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_get"),
            "safe member must not be rewritten: {}",
            r.code
        );
    }

    #[test]
    fn obj_location_member_access_rewrites() {
        let src = "var u = obj.location;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_get(obj,\"location\")"),
            "obj.location not rewritten: {}",
            r.code
        );
    }

    #[test]
    fn patches_returned_for_post_processing() {
        let src = "var u = location;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert_eq!(r.patches.len(), 1, "expected 1 patch for one location ref");
        assert_eq!(r.patches[0].start, 8);
        assert_eq!(r.patches[0].end, 16);
    }

    #[test]
    fn large_source_with_few_changes_returns_few_patches() {
        // Simulate "90% of code unchanged": one tiny rewrite in a large source.
        let mut src = String::with_capacity(10_000);
        for _ in 0..200 {
            src.push_str("function a(){ return 42; }\n");
        }
        src.push_str("var u = location.href;\n");
        let r = rewrite_script(&src, &opts()).unwrap();
        // Exactly the two patches the changed region requires: the bare
        // `location` identifier (global-get patch, recursively applied
        // inside the receiver substring by apply_patches' `rewrite_range`)
        // and the outer `location.href` member access (MEMBER_GET marker,
        // chosen for emission). 200 unchanged `function a(){…}` lines
        // contribute zero patches — exercise the patch-mode contract that
        // the rewriter does not re-emit clean source.
        assert_eq!(
            r.patches.len(),
            2,
            "patch-mode should emit only changed regions, got {} patches",
            r.patches.len()
        );
    }

    #[test]
    fn location_assign_call_routed() {
        let src = "location.assign('https://example.com/');";
        let r = rewrite_script(src, &opts()).unwrap();
        // location is dangerous global -> __zp_get; .assign is dangerous method -> __zp_call.
        assert!(
            r.code
                .contains("__zp_call(__zp_get(globalThis,\"location\"),\"assign\","),
            "location.assign() not routed: {}",
            r.code
        );
    }

    #[test]
    fn location_replace_call_routed() {
        let src = "var p = 'x'; location.replace(p);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(r.code.contains("__zp_call("), "no call rewrite: {}", r.code);
        assert!(
            r.code.contains("\"replace\","),
            "method name missing: {}",
            r.code
        );
    }

    #[test]
    fn iframe_post_message_routed() {
        let src = "iframe.contentWindow.postMessage(payload, '*');";
        let r = rewrite_script(src, &opts()).unwrap();
        // contentWindow member -> __zp_get wrap + postMessage method -> __zp_call.
        assert!(r.code.contains("__zp_call("), "no call rewrite: {}", r.code);
        assert!(
            r.code.contains("__zp_get(iframe,\"contentWindow\")"),
            "iframe wrap missing: {}",
            r.code
        );
    }

    #[test]
    fn window_location_assignment_routed() {
        let src = "window.location = 'https://target/';";
        let r = rewrite_script(src, &opts()).unwrap();
        // window is dangerous global -> wrapped; .location = ... is dangerous member set.
        assert!(r.code.contains("__zp_set("), "no set rewrite: {}", r.code);
        assert!(
            r.code.contains("\"location\","),
            "set property name missing: {}",
            r.code
        );
    }

    #[test]
    fn safe_method_call_left_alone() {
        let src = "obj.someMethod(arg);";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_call"),
            "safe call must not be rewritten: {}",
            r.code
        );
    }

    #[test]
    fn compound_assignment_not_rewritten() {
        // Compound `+=` etc. preserved as native; the read goes through __zp_get
        // and the membrane setter handles the write side effect.
        let src = "obj.location += 'x';";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("__zp_set"),
            "compound assignment must not use __zp_set: {}",
            r.code
        );
    }

    #[test]
    fn reflect_get_window_location_routed() {
        let src = "var x = Reflect.get(window, 'location');";
        let r = rewrite_script(src, &opts()).unwrap();
        // The Reflect.get(...) call site is replaced by __zp_get(window, 'location').
        // The `window` arg is itself rewritten to __zp_get(globalThis,'window').
        assert!(
            r.code
                .contains("__zp_get(__zp_get(globalThis,\"window\"),\"location\")"),
            "Reflect.get not routed: {}",
            r.code
        );
        assert!(
            !r.code.contains("Reflect.get"),
            "stale Reflect.get remained: {}",
            r.code
        );
    }

    #[test]
    fn reflect_set_window_location_routed() {
        let src = "Reflect.set(window, 'location', 'https://x/');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("__zp_set("),
            "Reflect.set not routed: {}",
            r.code
        );
        assert!(
            r.code.contains("\"location\","),
            "prop name missing: {}",
            r.code
        );
        assert!(
            !r.code.contains("Reflect.set"),
            "stale Reflect.set remained: {}",
            r.code
        );
    }

    #[test]
    fn reflect_get_with_safe_prop_unchanged() {
        let src = "Reflect.get(obj, 'foo');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("Reflect.get"),
            "safe Reflect.get must pass through: {}",
            r.code
        );
    }

    #[test]
    fn reflect_shadowed_does_not_rewrite() {
        // If `Reflect` is locally bound, do not rewrite — it's not the native.
        let src = "function f(Reflect){ return Reflect.get(window, 'location'); }";
        let r = rewrite_script(src, &opts()).unwrap();
        // The Reflect.get(...) wrapper should NOT be applied (shadowed).
        assert!(
            r.code.contains("Reflect.get("),
            "shadowed Reflect must remain: {}",
            r.code
        );
    }

    #[test]
    fn get_own_property_descriptor_dangerous_diagnostic() {
        let src = "Object.getOwnPropertyDescriptor(window, 'location');";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.contains("getOwnPropertyDescriptor") && d.contains("location")),
            "expected diagnostic for descriptor access: {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn with_statement_emits_diagnostic() {
        // Use sloppy-mode classic — with statements are otherwise rejected.
        let src = "with (obj) { use(x); }";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.diagnostics.iter().any(|d| d.contains("with-statement")),
            "with-statement diagnostic missing: {:?}",
            r.diagnostics
        );
    }

    #[test]
    fn destructuring_binding_rhs_rewritten() {
        // Destructuring out of `window` reads from the rewritten window proxy.
        // The destructured local then holds the membrane-proxied location.
        let src = "const { location } = window; location.href;";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            r.code.contains("= __zp_get(globalThis,\"window\")"),
            "destructuring RHS not rewritten: {}",
            r.code
        );
        // The destructured `location` is locally bound → no further rewrite needed.
    }

    #[test]
    fn return_followed_by_parenthesized_method_call() {
        // NAVER kw-owner ch() function:
        //   function ch(e){return("string"==typeof e?e:""+e).replace(cd,"\n").replace(cf,"")}
        // The outer `.replace(cf,"")` METHOD_CALL replacement consumes the
        // leading `(` of `("string"==typeof e?e:""+e)`. Without leading paren
        // in our emitted replacement, the result becomes `return__zp_call(...)`
        // which JS parses as a single identifier → ReferenceError.
        let src = "function ch(e){return(\"string\"==typeof e?e:\"\"+e).replace(cd,\"\\n\").replace(cf,\"\")}";
        let r = rewrite_script(src, &opts()).unwrap();
        assert!(
            !r.code.contains("return__zp_"),
            "rewriter glued __zp_call to return keyword: {}",
            r.code
        );
    }

    #[test]
    fn new_global_member_constructor_preserved() {
        // Regression: NAVER comic.naver.com (kw-owner/index.js) does
        // `new globalThis.Request("https://empty.invalid", {body:...})`.
        // Without parentheses around our globalThis patch, `new` would bind to
        // `__zp_get(globalThis,"globalThis")` (consuming those arguments) and
        // `.Request(args)` would degenerate to a function call →
        // `Failed to construct 'Request': Please use the 'new' operator`.
        let src = r#"new globalThis.Request("https://empty.invalid", {body:null});"#;
        let r = rewrite_script(src, &opts()).unwrap();
        // The crucial property: between `new` and the next `(`, the patched
        // globalThis must be parenthesised so the `new MemberExpression
        // Arguments` rule consumes `.Request(...)` as a single member-call.
        assert!(
            r.code
                .contains("new (__zp_get(globalThis,\"globalThis\")).Request("),
            "new globalThis.Request(...) not preserved as constructor: {}",
            r.code
        );
    }

    #[test]
    fn iframe_clean_realm_fetch_routed() {
        // window.frames[0].fetch is a typical iframe clean-realm escape.
        // We only rewrite the `window` and `frames` properties; the call
        // surface (`fetch(...)`) is captured by the service worker.
        let src = "window.frames;";
        let r = rewrite_script(src, &opts()).unwrap();
        // `window` is dangerous global -> wrapped; `.frames` is also a
        // dangerous member -> outer __zp_get wraps the wrapped window.
        assert!(
            r.code
                .contains("__zp_get(__zp_get(globalThis,\"window\"),\"frames\")"),
            "nested rewrite missing: {}",
            r.code
        );
    }
}
