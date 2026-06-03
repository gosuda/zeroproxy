use std::collections::HashSet;

use swc_common::{
    comments::SingleThreadedComments, sync::Lrc, FileName, Globals, Mark, SourceMap, SyntaxContext,
    DUMMY_SP, GLOBALS as SWC_GLOBALS,
};
use swc_ecma_ast::{
    op, ArrayLit, AssignOp, AssignTarget, BinaryOp, Callee, EsVersion, Expr, ExprOrSpread, Ident,
    IdentName, ImportDecl, Lit, MemberExpr, MemberProp, MetaPropKind, ModuleDecl, OptCall,
    OptChainBase, OptChainExpr, Pat, Program, Prop, PropName, Str, UpdateOp,
};
use swc_ecma_codegen::Config;
use swc_ecma_codegen::{text_writer::JsWriter, Emitter};
use swc_ecma_parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax};
use swc_ecma_transforms_base::resolver;
use swc_ecma_visit::{VisitMut, VisitMutWith};

use crate::RewriteContext;

use super::module_urls;

const GLOBAL_NAMES: &[&str] = &[
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

const WINDOW_ALIASES: &[&str] = &[
    "window",
    "self",
    "globalThis",
    "top",
    "parent",
    "opener",
    "frames",
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

pub(crate) fn rewrite_script(
    source: &str,
    module: bool,
    ctx: RewriteContext<'_>,
) -> Result<String, String> {
    SWC_GLOBALS.set(&Globals::new(), || {
        rewrite_script_in_globals(source, module, ctx)
    })
}

fn rewrite_script_in_globals(
    source: &str,
    module: bool,
    ctx: RewriteContext<'_>,
) -> Result<String, String> {
    let cm: Lrc<SourceMap> = Default::default();
    let comments = SingleThreadedComments::default();
    let fm = cm.new_source_file(
        FileName::Custom("zeroproxy-input.js".into()).into(),
        source.to_string(),
    );
    let lexer = Lexer::new(
        Syntax::Es(EsSyntax {
            jsx: true,
            import_attributes: true,
            ..Default::default()
        }),
        EsVersion::latest(),
        StringInput::from(&*fm),
        Some(&comments),
    );
    let mut parser = Parser::new_from(lexer);
    let mut program = if module {
        Program::Module(
            parser
                .parse_module()
                .map_err(|_| "PARSE_FAILED".to_string())?,
        )
    } else {
        Program::Script(
            parser
                .parse_script()
                .map_err(|_| "PARSE_FAILED".to_string())?,
        )
    };
    if !parser.take_errors().is_empty() {
        return Err("PARSE_FAILED".to_string());
    }

    let unresolved_mark = Mark::new();
    let top_level_mark = Mark::new();
    program.visit_mut_with(&mut resolver(unresolved_mark, top_level_mark, false));
    program.visit_mut_with(&mut SwcRewriter {
        ctx,
        module,
        unresolved_mark,
        window_aliases: HashSet::new(),
        document_aliases: HashSet::new(),
    });
    print_program(cm, &program, &comments)
}

fn print_program(
    cm: Lrc<SourceMap>,
    program: &Program,
    comments: &SingleThreadedComments,
) -> Result<String, String> {
    let mut out = Vec::new();
    {
        let wr = JsWriter::new(cm.clone(), "\n", &mut out, None);
        let mut emitter = Emitter {
            cfg: Config::default().with_minify(true),
            cm,
            comments: Some(comments),
            wr,
        };
        emitter
            .emit_program(program)
            .map_err(|_| "REWRITE_FAILED".to_string())?;
    }
    String::from_utf8(out).map_err(|_| "REWRITE_FAILED".to_string())
}

struct SwcRewriter<'a> {
    ctx: RewriteContext<'a>,
    module: bool,
    unresolved_mark: Mark,
    window_aliases: HashSet<(String, u32)>,
    document_aliases: HashSet<(String, u32)>,
}

impl VisitMut for SwcRewriter<'_> {
    fn visit_mut_import_decl(&mut self, decl: &mut ImportDecl) {
        *decl.src = rewritten_str_lit(&decl.src, self.ctx);
    }

    fn visit_mut_module_decl(&mut self, decl: &mut ModuleDecl) {
        match decl {
            ModuleDecl::ExportNamed(export) => {
                if let Some(src) = export.src.as_deref() {
                    export.src = Some(Box::new(rewritten_str_lit(src, self.ctx)));
                }
                decl.visit_mut_children_with(self);
            }
            ModuleDecl::ExportAll(export) => {
                *export.src = rewritten_str_lit(&export.src, self.ctx);
            }
            _ => decl.visit_mut_children_with(self),
        }
    }

    fn visit_mut_var_declarator(&mut self, decl: &mut swc_ecma_ast::VarDeclarator) {
        if let Some(init) = decl.init.as_mut() {
            if let Pat::Ident(binding) = &decl.name {
                self.track_alias_init(&binding.id, init);
            }
            init.visit_mut_with(self);
        }
    }

    fn visit_mut_call_expr(&mut self, call: &mut swc_ecma_ast::CallExpr) {
        if matches!(call.callee, Callee::Import(_)) {
            self.rewrite_dynamic_import(call);
            return;
        }
        if let Some((base, prop)) = self.call_target_parts(&call.callee, false) {
            for arg in &mut call.args {
                arg.expr.visit_mut_with(self);
            }
            let args = array_expr_from_args(call.args.clone());
            *call = call_expr("__zp_call", vec![base, prop, args]);
            return;
        }
        call.visit_mut_children_with(self);
    }

    fn visit_mut_prop(&mut self, prop: &mut Prop) {
        match prop {
            Prop::Shorthand(id) if self.is_global_ident(id) => {
                let key = PropName::Ident(IdentName::new(id.sym.clone(), id.span));
                *prop = Prop::KeyValue(swc_ecma_ast::KeyValueProp {
                    key,
                    value: Box::new(self.global_get_expr(id)),
                });
            }
            _ => prop.visit_mut_children_with(self),
        }
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        match expr {
            Expr::Member(member) => {
                if self.is_import_meta_url(member) {
                    *expr = str_expr(self.ctx.target_url);
                    return;
                }
                if let Some((base, prop)) = self.member_parts(member) {
                    *expr = call_helper("__zp_get", vec![base, prop]);
                    return;
                }
                expr.visit_mut_children_with(self);
            }
            Expr::Assign(assign) => {
                if assign.op == op!("=") {
                    if let AssignTarget::Simple(swc_ecma_ast::SimpleAssignTarget::Ident(binding)) =
                        &assign.left
                    {
                        self.track_alias_init(&binding.id, assign.right.as_mut());
                    }
                }
                if let Some((base, prop)) = self.assign_target_parts(&assign.left) {
                    assign.right.visit_mut_with(self);
                    *expr = self.assignment_helper(assign.op, base, prop, *assign.right.clone());
                    return;
                }
                assign.right.visit_mut_with(self);
            }
            Expr::Update(update) => {
                if let Some((base, prop)) = self.update_target_parts(&update.arg) {
                    *expr = call_helper(
                        "__zp_update",
                        vec![
                            base,
                            prop,
                            str_expr(update_operator_text(update.op)),
                            bool_expr(update.prefix),
                        ],
                    );
                    return;
                }
                expr.visit_mut_children_with(self);
            }
            Expr::Bin(bin) => {
                if bin.op == BinaryOp::In {
                    bin.left.visit_mut_with(self);
                    bin.right.visit_mut_with(self);
                    *expr = call_helper("__zp_has", vec![*bin.right.clone(), *bin.left.clone()]);
                    return;
                }
                expr.visit_mut_children_with(self);
            }
            Expr::New(new_expr) => {
                if let Some(callee) = self.construct_target(&new_expr.callee) {
                    if let Some(args) = new_expr.args.as_mut() {
                        for arg in args {
                            arg.expr.visit_mut_with(self);
                        }
                    }
                    let args = new_expr
                        .args
                        .as_ref()
                        .map(|args| array_expr_from_args(args.clone()))
                        .unwrap_or_else(|| array_expr(Vec::new()));
                    *expr = call_helper("__zp_construct", vec![callee, args]);
                    return;
                }
                expr.visit_mut_children_with(self);
            }
            Expr::OptChain(chain) => {
                if let Some(rewritten) = self.rewrite_optional_chain(chain) {
                    *expr = rewritten;
                    return;
                }
                expr.visit_mut_children_with(self);
            }
            Expr::Ident(id) if self.is_global_ident(id) => {
                *expr = self.global_get_expr(id);
            }
            _ => expr.visit_mut_children_with(self),
        }
    }
}

impl SwcRewriter<'_> {
    fn is_unresolved(&self, ctxt: SyntaxContext) -> bool {
        ctxt.has_mark(self.unresolved_mark)
    }

    fn alias_key(id: &Ident) -> (String, u32) {
        (id.sym.to_string(), id.ctxt.as_u32())
    }

    fn is_global_ident(&self, id: &Ident) -> bool {
        GLOBAL_NAMES.contains(&id.sym.as_ref()) && self.is_unresolved(id.ctxt)
    }

    fn global_get_expr(&self, id: &Ident) -> Expr {
        call_helper(
            "__zp_get",
            vec![global_this_expr(), str_expr(id.sym.as_ref())],
        )
    }

    fn track_alias_init(&mut self, id: &Ident, init: &mut Expr) {
        let key = Self::alias_key(id);
        if self.expression_is_window_alias_source(init) {
            self.window_aliases.insert(key.clone());
            self.document_aliases.remove(&key);
            *init = self.rewrite_window_alias_source(init.clone());
            return;
        }
        if self.expression_is_document_alias_source(init) {
            self.document_aliases.insert(key.clone());
            self.window_aliases.remove(&key);
            return;
        }
        self.window_aliases.remove(&key);
        self.document_aliases.remove(&key);
    }

    fn expression_is_window_alias_source(&self, expr: &Expr) -> bool {
        match expr {
            Expr::This(_) => false,
            Expr::Ident(id) => {
                (WINDOW_ALIASES.contains(&id.sym.as_ref()) && self.is_unresolved(id.ctxt))
                    || self.window_aliases.contains(&Self::alias_key(id))
            }
            Expr::Member(member) => self.is_window_like_expr(&member.obj),
            Expr::Bin(bin)
                if matches!(
                    bin.op,
                    BinaryOp::LogicalOr | BinaryOp::LogicalAnd | BinaryOp::NullishCoalescing
                ) =>
            {
                self.expression_is_window_alias_source(&bin.left)
                    || self.expression_is_window_alias_source(&bin.right)
            }
            Expr::Cond(cond) => {
                self.expression_is_window_alias_source(&cond.cons)
                    || self.expression_is_window_alias_source(&cond.alt)
            }
            Expr::Paren(paren) => self.expression_is_window_alias_source(&paren.expr),
            _ => false,
        }
    }

    fn expression_is_document_alias_source(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(id) => {
                id.sym == *"document" && self.is_unresolved(id.ctxt)
                    || self.document_aliases.contains(&Self::alias_key(id))
            }
            Expr::Member(member) => {
                self.member_prop_name(&member.prop) == Some("document")
                    && self.is_window_like_expr(&member.obj)
                    || matches!(member.prop, MemberProp::Computed(_))
                        && self.is_window_like_expr(&member.obj)
            }
            Expr::Bin(bin)
                if matches!(
                    bin.op,
                    BinaryOp::LogicalOr | BinaryOp::LogicalAnd | BinaryOp::NullishCoalescing
                ) =>
            {
                self.expression_is_document_alias_source(&bin.left)
                    || self.expression_is_document_alias_source(&bin.right)
            }
            Expr::Cond(cond) => {
                self.expression_is_document_alias_source(&cond.cons)
                    || self.expression_is_document_alias_source(&cond.alt)
            }
            Expr::Paren(paren) => self.expression_is_document_alias_source(&paren.expr),
            _ => false,
        }
    }

    fn rewrite_window_alias_source(&mut self, expr: Expr) -> Expr {
        match expr {
            Expr::This(_) => call_helper("__zp_get", vec![global_this_expr(), str_expr("window")]),
            Expr::Bin(mut bin)
                if matches!(
                    bin.op,
                    BinaryOp::LogicalOr | BinaryOp::LogicalAnd | BinaryOp::NullishCoalescing
                ) =>
            {
                *bin.left = self.rewrite_window_alias_source(*bin.left);
                *bin.right = self.rewrite_window_alias_source(*bin.right);
                Expr::Bin(bin)
            }
            Expr::Cond(mut cond) => {
                cond.test.visit_mut_with(self);
                *cond.cons = self.rewrite_window_alias_source(*cond.cons);
                *cond.alt = self.rewrite_window_alias_source(*cond.alt);
                Expr::Cond(cond)
            }
            Expr::Paren(mut paren) => {
                *paren.expr = self.rewrite_window_alias_source(*paren.expr);
                Expr::Paren(paren)
            }
            mut other => {
                other.visit_mut_with(self);
                other
            }
        }
    }

    fn member_prop_name<'a>(&self, prop: &'a MemberProp) -> Option<&'a str> {
        match prop {
            MemberProp::Ident(id) => Some(id.sym.as_ref()),
            _ => None,
        }
    }

    fn member_prop_expr(&mut self, prop: &MemberProp) -> Expr {
        match prop {
            MemberProp::Ident(id) => str_expr(id.sym.as_ref()),
            MemberProp::Computed(comp) => {
                let mut expr = *comp.expr.clone();
                expr.visit_mut_with(self);
                expr
            }
            MemberProp::PrivateName(private) => str_expr(private.name.as_ref()),
        }
    }

    fn transformed_expr(&mut self, expr: &Expr) -> Expr {
        let mut out = expr.clone();
        out.visit_mut_with(self);
        out
    }

    fn is_window_like_expr(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(id) => {
                (matches!(
                    id.sym.as_ref(),
                    "window"
                        | "self"
                        | "globalThis"
                        | "top"
                        | "parent"
                        | "opener"
                        | "frames"
                        | "document"
                ) && self.is_unresolved(id.ctxt))
                    || self.window_aliases.contains(&Self::alias_key(id))
                    || self.document_aliases.contains(&Self::alias_key(id))
            }
            Expr::Member(member) => {
                matches!(
                    self.member_prop_name(&member.prop),
                    Some(
                        "defaultView"
                            | "contentWindow"
                            | "window"
                            | "self"
                            | "globalThis"
                            | "top"
                            | "parent"
                            | "opener"
                            | "frames"
                    )
                ) && self.is_window_like_expr(&member.obj)
                    || matches!(member.prop, MemberProp::Computed(_))
                        && self.is_window_like_expr(&member.obj)
            }
            _ => false,
        }
    }

    fn is_virtual_location_expr(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Ident(id) => id.sym == *"location" && self.is_unresolved(id.ctxt),
            Expr::Member(member) => {
                self.member_prop_name(&member.prop) == Some("location")
                    && self.is_window_like_expr(&member.obj)
                    || matches!(member.prop, MemberProp::Computed(_))
                        && self.is_window_like_expr(&member.obj)
            }
            _ => false,
        }
    }

    fn member_needs_helper(&self, member: &MemberExpr) -> bool {
        match &member.prop {
            MemberProp::Ident(id) => {
                MEMBER_HELPER_PROPS.contains(&id.sym.as_ref())
                    || matches!(id.sym.as_ref(), "href" | "hash")
                        && self.is_virtual_location_expr(&member.obj)
            }
            MemberProp::Computed(_) => {
                self.is_window_like_expr(&member.obj) || self.is_virtual_location_expr(&member.obj)
            }
            MemberProp::PrivateName(_) => false,
        }
    }

    fn member_parts(&mut self, member: &MemberExpr) -> Option<(Expr, Expr)> {
        if !self.member_needs_helper(member) {
            return None;
        }
        let base = self.transformed_expr(&member.obj);
        let prop = self.member_prop_expr(&member.prop);
        Some((base, prop))
    }

    fn assign_target_parts(&mut self, target: &AssignTarget) -> Option<(Expr, Expr)> {
        let AssignTarget::Simple(simple) = target else {
            return None;
        };
        match simple {
            swc_ecma_ast::SimpleAssignTarget::Ident(binding)
                if matches!(binding.id.sym.as_ref(), "location" | "window")
                    && self.is_unresolved(binding.id.ctxt) =>
            {
                Some((global_this_expr(), str_expr(binding.id.sym.as_ref())))
            }
            swc_ecma_ast::SimpleAssignTarget::Member(member) => self.member_parts(member),
            swc_ecma_ast::SimpleAssignTarget::Paren(paren) => {
                self.assign_target_parts(&AssignTarget::try_from(paren.expr.clone()).ok()?)
            }
            _ => None,
        }
    }

    fn update_target_parts(&mut self, target: &Expr) -> Option<(Expr, Expr)> {
        match target {
            Expr::Ident(id)
                if matches!(id.sym.as_ref(), "location" | "window")
                    && self.is_unresolved(id.ctxt) =>
            {
                Some((global_this_expr(), str_expr(id.sym.as_ref())))
            }
            Expr::Member(member) => self.member_parts(member),
            Expr::Paren(paren) => self.update_target_parts(&paren.expr),
            _ => None,
        }
    }

    fn assignment_helper(&mut self, op: AssignOp, base: Expr, prop: Expr, rhs: Expr) -> Expr {
        if op == op!("=") {
            return call_helper("__zp_set", vec![base, prop, rhs]);
        }
        let value = if matches!(
            op,
            AssignOp::AndAssign | AssignOp::OrAssign | AssignOp::NullishAssign
        ) {
            Expr::Arrow(swc_ecma_ast::ArrowExpr {
                span: DUMMY_SP,
                ctxt: Default::default(),
                params: vec![],
                body: Box::new(swc_ecma_ast::BlockStmtOrExpr::Expr(Box::new(rhs))),
                is_async: false,
                is_generator: false,
                type_params: None,
                return_type: None,
            })
        } else {
            rhs
        };
        call_helper(
            "__zp_assign",
            vec![base, prop, str_expr(assign_operator_text(op)), value],
        )
    }

    fn call_target_parts(&mut self, callee: &Callee, optional: bool) -> Option<(Expr, Expr)> {
        let Callee::Expr(expr) = callee else {
            return None;
        };
        match &**expr {
            Expr::Member(member) => {
                let prop_name = self.member_prop_name(&member.prop);
                if prop_name
                    .map(|prop| CALL_HELPER_PROPS.contains(&prop))
                    .unwrap_or(false)
                    || self.member_needs_helper(member)
                    || optional
                {
                    let base = self.transformed_expr(&member.obj);
                    let prop = self.member_prop_expr(&member.prop);
                    Some((base, prop))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn construct_target(&mut self, callee: &Expr) -> Option<Expr> {
        match callee {
            Expr::Ident(id) if self.is_global_ident(id) => Some(self.global_get_expr(id)),
            Expr::Member(member)
                if self.is_window_like_expr(&member.obj) || self.member_needs_helper(member) =>
            {
                Some(self.transformed_expr(callee))
            }
            Expr::OptChain(chain) => self.rewrite_optional_chain(chain),
            _ => None,
        }
    }

    fn rewrite_dynamic_import(&mut self, call: &mut swc_ecma_ast::CallExpr) {
        let Some(first) = call.args.first_mut() else {
            return;
        };
        match &mut *first.expr {
            Expr::Lit(Lit::Str(spec)) => {
                *spec = rewritten_str_lit(spec, self.ctx);
            }
            expr => {
                expr.visit_mut_with(self);
                let source = expr.clone();
                *expr = call_helper(
                    "__zp_module_url",
                    vec![source, str_expr(self.ctx.target_url)],
                );
            }
        }
    }

    fn is_import_meta_url(&self, member: &MemberExpr) -> bool {
        self.module
            && self.member_prop_name(&member.prop) == Some("url")
            && matches!(&*member.obj, Expr::MetaProp(meta) if meta.kind == MetaPropKind::ImportMeta)
    }

    fn rewrite_optional_chain(&mut self, chain: &OptChainExpr) -> Option<Expr> {
        match &*chain.base {
            OptChainBase::Member(member) => {
                let base = self.transformed_expr(&member.obj);
                let prop = self.member_prop_expr(&member.prop);
                Some(call_helper("__zp_optionalGet", vec![base, prop]))
            }
            OptChainBase::Call(call) => self.rewrite_optional_call(call),
        }
    }

    fn rewrite_optional_call(&mut self, call: &OptCall) -> Option<Expr> {
        let (base, prop) = self.optional_call_target_parts(&call.callee)?;
        let args = array_expr_from_args(
            call.args
                .iter()
                .cloned()
                .map(|arg| self.transformed_arg(arg))
                .collect(),
        );
        Some(call_helper("__zp_optionalCall", vec![base, prop, args]))
    }

    fn optional_call_target_parts(&mut self, callee: &Expr) -> Option<(Expr, Expr)> {
        match callee {
            Expr::Member(member) => {
                let wrapped = Callee::Expr(Box::new(Expr::Member(member.clone())));
                self.call_target_parts(&wrapped, true)
            }
            Expr::OptChain(chain) => match &*chain.base {
                OptChainBase::Member(member) => {
                    let base = self.transformed_expr(&member.obj);
                    let prop = self.member_prop_expr(&member.prop);
                    Some((base, prop))
                }
                _ => None,
            },
            Expr::Paren(paren) => self.optional_call_target_parts(&paren.expr),
            _ => None,
        }
    }

    fn transformed_arg(&mut self, arg: ExprOrSpread) -> ExprOrSpread {
        let ExprOrSpread { spread, expr } = arg;
        let mut expr = *expr;
        expr.visit_mut_with(self);
        ExprOrSpread {
            spread,
            expr: Box::new(expr),
        }
    }
}

fn rewritten_str_lit(src: &Str, ctx: RewriteContext<'_>) -> Str {
    Str {
        span: src.span,
        value: module_urls::module_specifier(
            src.value.to_string_lossy().as_ref(),
            ctx.target_url,
            ctx.control_prefix,
            ctx.tab_id,
            ctx.runtime_token,
        )
        .into(),
        raw: None,
    }
}

fn helper_ident(name: &str) -> Ident {
    Ident::new(name.into(), DUMMY_SP, SyntaxContext::empty())
}

fn global_this_expr() -> Expr {
    Expr::Ident(helper_ident("globalThis"))
}

fn str_expr(value: &str) -> Expr {
    Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: value.into(),
        raw: None,
    }))
}

fn bool_expr(value: bool) -> Expr {
    Expr::Lit(Lit::Bool(swc_ecma_ast::Bool {
        span: DUMMY_SP,
        value,
    }))
}

fn array_expr(values: Vec<Expr>) -> Expr {
    Expr::Array(ArrayLit {
        span: DUMMY_SP,
        elems: values
            .into_iter()
            .map(|expr| {
                Some(ExprOrSpread {
                    spread: None,
                    expr: Box::new(expr),
                })
            })
            .collect(),
    })
}

fn array_expr_from_args(args: Vec<ExprOrSpread>) -> Expr {
    Expr::Array(ArrayLit {
        span: DUMMY_SP,
        elems: args.into_iter().map(Some).collect(),
    })
}

fn call_expr(name: &str, args: Vec<Expr>) -> swc_ecma_ast::CallExpr {
    swc_ecma_ast::CallExpr {
        span: DUMMY_SP,
        ctxt: Default::default(),
        callee: Callee::Expr(Box::new(Expr::Ident(helper_ident(name)))),
        args: args
            .into_iter()
            .map(|expr| ExprOrSpread {
                spread: None,
                expr: Box::new(expr),
            })
            .collect(),
        type_args: None,
    }
}

fn call_helper(name: &str, args: Vec<Expr>) -> Expr {
    Expr::Call(call_expr(name, args))
}

fn assign_operator_text(op: AssignOp) -> &'static str {
    match op {
        AssignOp::Assign => "=",
        AssignOp::AddAssign => "+=",
        AssignOp::SubAssign => "-=",
        AssignOp::MulAssign => "*=",
        AssignOp::DivAssign => "/=",
        AssignOp::ModAssign => "%=",
        AssignOp::ExpAssign => "**=",
        AssignOp::LShiftAssign => "<<=",
        AssignOp::RShiftAssign => ">>=",
        AssignOp::ZeroFillRShiftAssign => ">>>=",
        AssignOp::BitOrAssign => "|=",
        AssignOp::BitXorAssign => "^=",
        AssignOp::BitAndAssign => "&=",
        AssignOp::OrAssign => "||=",
        AssignOp::AndAssign => "&&=",
        AssignOp::NullishAssign => "??=",
    }
}

fn update_operator_text(op: UpdateOp) -> &'static str {
    match op {
        UpdateOp::PlusPlus => "++",
        UpdateOp::MinusMinus => "--",
    }
}

#[cfg(test)]
mod tests {
    use super::rewrite_script;
    use crate::RewriteContext;

    fn ctx() -> RewriteContext<'static> {
        RewriteContext::new("https://example.com/assets/main.js", "/zp/", "tab", "rt")
    }

    #[test]
    fn parses_and_rewrites_module_specifiers_with_swc() {
        let out = rewrite_script("import './dep.js'; export * from './x.js';", true, ctx())
            .expect("swc rewrite should succeed");
        assert!(out.contains(
            "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js&tab=tab&rt=rt"
        ));
        assert!(out.contains(
            "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fx.js&tab=tab&rt=rt"
        ));
    }

    #[test]
    fn rewrites_free_globals_with_swc_ast() {
        let out = rewrite_script("window.location.href; document.title;", false, ctx())
            .expect("swc rewrite should succeed");
        assert!(out.contains("__zp_get(globalThis,\"window\")"));
        assert!(out.contains("__zp_get(globalThis,\"document\")"));
    }

    #[test]
    fn preserves_local_bindings_with_swc_resolver() {
        let out = rewrite_script(
            "const location = { href: 'local' }; window.location.href; location.href;",
            false,
            ctx(),
        )
        .expect("swc rewrite should succeed");
        assert!(out.contains("location.href;"));
        assert!(out.contains("__zp_get(globalThis,\"window\")"));
        assert!(!out.contains("__zp_get(globalThis, \"location\").href"));
    }

    #[test]
    fn preserves_function_body_block_comments_for_to_string_templates() {
        let out = rewrite_script(
            r#"const html = parseTemplate(function () {
/*!@preserve
<div class="legacy-template">뉴스</div>
*/
return true;
});"#,
            false,
            ctx(),
        )
        .expect("swc rewrite should succeed");
        assert!(out.contains("/*!@preserve"));
        assert!(out.contains("<div class=\"legacy-template\">뉴스</div>"));
    }

    #[test]
    fn reports_parse_failures() {
        let err = rewrite_script("if (", false, ctx()).expect_err("parse should fail");
        assert_eq!(err, "PARSE_FAILED");
    }
}
