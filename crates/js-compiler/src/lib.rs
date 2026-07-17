use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use error_authority::{ErrorCode, ErrorStage, specification as error_specification};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use swc_common::{
    DUMMY_SP, FileName, GLOBALS, Globals, Mark, SourceMap, Span, Spanned, SyntaxContext,
    comments::SingleThreadedComments, sync::Lrc,
};
use swc_ecma_ast::*;
use swc_ecma_parser::{
    Context, Parser, StringInput, Syntax,
    error::{Error as ParserError, SyntaxError},
    lexer::Lexer,
};
use swc_ecma_transforms_base::resolver;
use swc_ecma_visit::{Visit, VisitMut, VisitMutWith, VisitWith};
use thiserror::Error;

pub const ABI_PLACEHOLDER: &str = "__zp_abi_000000000000000000000000000000000000000000000000";
include!(concat!(env!("OUT_DIR"), "/grammar_profile.rs"));
include!("generated_owned_globals.rs");
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParserGoal {
    Script,
    Module,
    FunctionBody,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StrictnessSource {
    SourceDirective,
    Module,
    DirectEvalCaller,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FunctionHost {
    None,
    Ordinary,
    Async,
    Generator,
    AsyncGenerator,
    EventHandler,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GrammarProfile {
    goal: ParserGoal,
    strictness_source: StrictnessSource,
    function_host: FunctionHost,
}

impl GrammarProfile {
    fn strict(self, caller_strict: bool) -> bool {
        match self.strictness_source {
            StrictnessSource::SourceDirective => false,
            StrictnessSource::Module => true,
            StrictnessSource::DirectEvalCaller => caller_strict,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SourceKind {
    ClassicScriptExternal,
    ClassicScriptInline,
    ModuleScript,
    DirectEvalScript,
    IndirectEvalScript,
    TimerString,
    FunctionBody,
    AsyncFunctionBody,
    GeneratorFunctionBody,
    AsyncGeneratorFunctionBody,
    EventHandler,
    JavaScriptURL,
    ClassicWorker,
    ModuleWorker,
    SharedClassicWorker,
    SharedModuleWorker,
    TargetServiceWorkerClassic,
    TargetServiceWorkerModule,
    WorkletModule,
}
impl SourceKind {
    #[cfg(test)]
    fn parser_goal(self) -> ParserGoal {
        self.grammar_profile().goal
    }

    fn grammar_profile(self) -> GrammarProfile {
        match self {
            Self::ClassicScriptExternal
            | Self::ClassicScriptInline
            | Self::IndirectEvalScript
            | Self::TimerString
            | Self::JavaScriptURL
            | Self::ClassicWorker
            | Self::SharedClassicWorker
            | Self::TargetServiceWorkerClassic => GrammarProfile {
                goal: ParserGoal::Script,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::None,
            },
            Self::DirectEvalScript => GrammarProfile {
                goal: ParserGoal::Script,
                strictness_source: StrictnessSource::DirectEvalCaller,
                function_host: FunctionHost::None,
            },
            Self::ModuleScript
            | Self::ModuleWorker
            | Self::SharedModuleWorker
            | Self::TargetServiceWorkerModule
            | Self::WorkletModule => GrammarProfile {
                goal: ParserGoal::Module,
                strictness_source: StrictnessSource::Module,
                function_host: FunctionHost::None,
            },
            Self::FunctionBody => GrammarProfile {
                goal: ParserGoal::FunctionBody,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::Ordinary,
            },
            Self::AsyncFunctionBody => GrammarProfile {
                goal: ParserGoal::FunctionBody,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::Async,
            },
            Self::GeneratorFunctionBody => GrammarProfile {
                goal: ParserGoal::FunctionBody,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::Generator,
            },
            Self::AsyncGeneratorFunctionBody => GrammarProfile {
                goal: ParserGoal::FunctionBody,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::AsyncGenerator,
            },
            Self::EventHandler => GrammarProfile {
                goal: ParserGoal::FunctionBody,
                strictness_source: StrictnessSource::SourceDirective,
                function_host: FunctionHost::EventHandler,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditKind {
    OwnedGlobalReference,
    OwnedGlobalTarget,
    OwnedGlobalShorthand,
    ThisExpression,
    DirectEvalArgument,
    DynamicImport,
    ImportMeta,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Edit {
    pub kind: EditKind,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
    abi_offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GeneratedSpan {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SpanMap {
    pub original_start: usize,
    pub original_end: usize,
    pub generated_start: usize,
    pub generated_end: usize,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModuleSpecifier {
    pub original_start: usize,
    pub original_end: usize,
    pub generated_start: usize,
    pub generated_end: usize,
    pub specifier: String,
    pub module_type: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RewriteResult {
    pub code: String,
    pub edits: Vec<Edit>,
    pub edit_map: Vec<SpanMap>,
    pub source_map: serde_json::Value,
    pub module_specifiers: Vec<ModuleSpecifier>,
    pub source_url: Option<String>,
    pub source_mapping_url: Option<String>,
    #[serde(default)]
    pub abi_identifiers: Vec<String>,
    #[serde(default)]
    pub abi_slots: Vec<GeneratedSpan>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DynamicFunctionRewriteResult {
    pub parameters: Vec<RewriteResult>,
    pub body: RewriteResult,
}
#[derive(Clone, Debug, Error, Eq, PartialEq, Serialize, Deserialize)]
pub enum Error {
    #[error("INVALID_SOURCE_KIND")]
    InvalidSourceKind,
    #[error("PARSE_FAILED")]
    ParseFailed,
    #[error("UNSUPPORTED_BROWSER_SYNTAX")]
    UnsupportedBrowserSyntax,
    #[error("UNSUPPORTED_DYNAMIC_SCOPE")]
    UnsupportedDynamicScope,
    #[error("UNSUPPORTED_DIRECT_EVAL_BINDING")]
    UnsupportedDirectEvalBinding,
    #[error("UNSUPPORTED_IMPORT_SCRIPTS_SHAPE")]
    UnsupportedImportScriptsShape,
    #[error("UNSUPPORTED_DIRECT_EVAL_SHAPE")]
    UnsupportedDirectEvalShape,
    #[error("ABI_IDENTIFIER_COLLISION")]
    AbiIdentifierCollision,
    #[error("RESOLUTION_FAILED")]
    ResolutionFailed,
    #[error("TRANSFORM_FAILED")]
    TransformFailed,
    #[error("CODEGEN_FAILED")]
    CodegenFailed,
    #[error("ABI_VERSION_MISMATCH")]
    AbiVersionMismatch,
    #[error("RESOURCE_TOO_LARGE")]
    ResourceTooLarge,
    #[error("POLICY_BLOCKED")]
    PolicyBlocked,
}

pub const COMPILER_RESULT_SCHEMA_VERSION: u16 = 1;
pub const COMPILER_ABI_VERSION: u16 = 1;
pub const COMPILER_CACHE_SCHEMA_VERSION: u16 = 1;
pub const MAX_COMPILER_CACHE_CONTEXT_BYTES: usize = 64 * 1024;
pub const MAX_COMPILER_SOURCE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
struct CompilerSuccess<'a> {
    schema_version: u16,
    ok: bool,
    code: &'a str,
    edits: &'a [Edit],
    edit_map: &'a [SpanMap],
    source_map: &'a serde_json::Value,
    module_specifiers: &'a [ModuleSpecifier],
    source_url: Option<&'a str>,
    source_mapping_url: Option<&'a str>,
    diagnostics: Vec<serde_json::Value>,
    abi_identifiers: &'a [String],
    abi_slots: &'a [GeneratedSpan],
}

impl<'a> CompilerSuccess<'a> {
    fn new(result: &'a RewriteResult) -> Self {
        Self {
            schema_version: COMPILER_RESULT_SCHEMA_VERSION,
            ok: true,
            code: &result.code,
            edits: &result.edits,
            edit_map: &result.edit_map,
            source_map: &result.source_map,
            module_specifiers: &result.module_specifiers,
            source_url: result.source_url.as_deref(),
            source_mapping_url: result.source_mapping_url.as_deref(),
            diagnostics: Vec::new(),
            abi_identifiers: &result.abi_identifiers,
            abi_slots: &result.abi_slots,
        }
    }
}

#[derive(Serialize)]
struct CompilerErrorRecord<'a> {
    code: &'static str,
    source_kind: &'a str,
    stage: &'static str,
    recoverability: &'static str,
}

#[derive(Serialize)]
struct CompilerFailure<'a> {
    schema_version: u16,
    ok: bool,
    code: Option<String>,
    edits: Vec<Edit>,
    edit_map: Vec<SpanMap>,
    source_map: Option<serde_json::Value>,
    module_specifiers: Vec<ModuleSpecifier>,
    source_url: Option<String>,
    source_mapping_url: Option<String>,
    error: CompilerErrorRecord<'a>,
    diagnostics: Vec<serde_json::Value>,
}

impl Error {
    fn authority_code(&self) -> ErrorCode {
        match self {
            Self::InvalidSourceKind => ErrorCode::InvalidSourceKind,
            Self::ParseFailed => ErrorCode::ParseFailed,
            Self::UnsupportedBrowserSyntax => ErrorCode::UnsupportedBrowserSyntax,
            Self::UnsupportedDynamicScope => ErrorCode::UnsupportedDynamicScope,
            Self::UnsupportedDirectEvalBinding => ErrorCode::UnsupportedDirectEvalBinding,
            Self::UnsupportedDirectEvalShape => ErrorCode::UnsupportedDirectEvalShape,
            Self::UnsupportedImportScriptsShape => ErrorCode::UnsupportedImportScriptsShape,
            Self::AbiIdentifierCollision => ErrorCode::AbiIdentifierCollision,
            Self::ResolutionFailed => ErrorCode::ResolutionFailed,
            Self::TransformFailed => ErrorCode::TransformFailed,
            Self::CodegenFailed => ErrorCode::CodegenFailed,
            Self::AbiVersionMismatch => ErrorCode::AbiVersionMismatch,
            Self::ResourceTooLarge => ErrorCode::ResourceTooLarge,
            Self::PolicyBlocked => ErrorCode::PolicyBlocked,
        }
    }

    fn validate_authority(&self) {
        let specification = error_specification(self.authority_code());
        assert!(specification.stages.contains(&ErrorStage::RewriteJs));
        assert!(!specification.retryable);
    }

    fn code(&self) -> &'static str {
        match self {
            Self::InvalidSourceKind => "INVALID_SOURCE_KIND",
            Self::ParseFailed => "PARSE_FAILED",
            Self::UnsupportedBrowserSyntax => "UNSUPPORTED_BROWSER_SYNTAX",
            Self::UnsupportedDynamicScope => "UNSUPPORTED_DYNAMIC_SCOPE",
            Self::UnsupportedDirectEvalBinding => "UNSUPPORTED_DIRECT_EVAL_BINDING",
            Self::UnsupportedDirectEvalShape => "UNSUPPORTED_DIRECT_EVAL_SHAPE",
            Self::UnsupportedImportScriptsShape => "UNSUPPORTED_IMPORT_SCRIPTS_SHAPE",
            Self::AbiIdentifierCollision => "ABI_IDENTIFIER_COLLISION",
            Self::ResolutionFailed => "RESOLUTION_FAILED",
            Self::TransformFailed => "TRANSFORM_FAILED",
            Self::CodegenFailed => "CODEGEN_FAILED",
            Self::AbiVersionMismatch => "ABI_VERSION_MISMATCH",
            Self::ResourceTooLarge => "RESOURCE_TOO_LARGE",
            Self::PolicyBlocked => "POLICY_BLOCKED",
        }
    }

    fn stage(&self) -> &'static str {
        match self {
            Self::InvalidSourceKind | Self::AbiVersionMismatch | Self::ResourceTooLarge => {
                "validation"
            }
            Self::ParseFailed | Self::UnsupportedBrowserSyntax => "parse",
            Self::UnsupportedDynamicScope
            | Self::UnsupportedDirectEvalBinding
            | Self::UnsupportedDirectEvalShape
            | Self::UnsupportedImportScriptsShape
            | Self::AbiIdentifierCollision => "analysis",
            Self::ResolutionFailed => "resolve",
            Self::TransformFailed => "transform",
            Self::CodegenFailed => "codegen",
            Self::PolicyBlocked => "policy",
        }
    }
}
fn validate_abi_identifier(abi_identifier: &str) -> Result<(), Error> {
    let Some(version) = abi_identifier.strip_prefix("__zp_abi_") else {
        return Err(Error::AbiVersionMismatch);
    };
    if version.len() != 48
        || !version
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(Error::AbiVersionMismatch);
    }
    Ok(())
}

impl<'a> CompilerFailure<'a> {
    fn new(error: &Error, source_kind: &'a str) -> Self {
        error.validate_authority();
        Self {
            schema_version: COMPILER_RESULT_SCHEMA_VERSION,
            ok: false,
            code: None,
            edits: Vec::new(),
            edit_map: Vec::new(),
            source_map: None,
            module_specifiers: Vec::new(),
            source_url: None,
            source_mapping_url: None,
            error: CompilerErrorRecord {
                code: error.code(),
                source_kind: if matches!(error, Error::InvalidSourceKind) {
                    "Unknown"
                } else {
                    source_kind
                },
                stage: error.stage(),
                recoverability: "none",
            },
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Serialize)]
struct DynamicCompilerSuccess<'a> {
    schema_version: u16,
    ok: bool,
    parameters: Vec<CompilerSuccess<'a>>,
    body: CompilerSuccess<'a>,
    diagnostics: Vec<serde_json::Value>,
}

fn source_kind_from_wire(source_kind: &str) -> Result<SourceKind, Error> {
    serde_json::from_value(serde_json::Value::String(source_kind.to_owned()))
        .map_err(|_| Error::InvalidSourceKind)
}

fn encode_compiler_result(
    result: Result<RewriteResult, Error>,
    source_kind: &str,
) -> Result<String, Error> {
    match result {
        Ok(result) => serde_json::to_string(&CompilerSuccess::new(&result)),
        Err(error) => serde_json::to_string(&CompilerFailure::new(&error, source_kind)),
    }
    .map_err(|_| Error::CodegenFailed)
}

fn encode_dynamic_compiler_result(
    result: Result<DynamicFunctionRewriteResult, Error>,
    source_kind: &str,
) -> Result<String, Error> {
    match result {
        Ok(result) => {
            let success = DynamicCompilerSuccess {
                schema_version: COMPILER_RESULT_SCHEMA_VERSION,
                ok: true,
                parameters: result.parameters.iter().map(CompilerSuccess::new).collect(),
                body: CompilerSuccess::new(&result.body),
                diagnostics: Vec::new(),
            };
            serde_json::to_string(&success)
        }
        Err(error) => serde_json::to_string(&CompilerFailure::new(&error, source_kind)),
    }
    .map_err(|_| Error::CodegenFailed)
}

pub fn compile_result_json(
    source: &str,
    source_kind: &str,
    abi_identifier: &str,
) -> Result<String, Error> {
    let result = source_kind_from_wire(source_kind)
        .and_then(|kind| compile_for_abi(source, kind, abi_identifier));
    encode_compiler_result(result, source_kind)
}

pub fn compile_result_json_with_direct_eval_strictness(
    source: &str,
    source_kind: &str,
    abi_identifier: &str,
    caller_strict: bool,
) -> Result<String, Error> {
    let result = source_kind_from_wire(source_kind).and_then(|kind| {
        compile_for_abi_with_direct_eval_strictness(source, kind, abi_identifier, caller_strict)
    });
    encode_compiler_result(result, source_kind)
}

pub fn compile_dynamic_function_result_json(
    parameters_json: &str,
    body: &str,
    source_kind: &str,
    abi_identifier: &str,
) -> Result<String, Error> {
    let result = source_kind_from_wire(source_kind).and_then(|kind| {
        serde_json::from_str::<Vec<String>>(parameters_json)
            .map_err(|_| Error::ParseFailed)
            .and_then(|parameters| {
                compile_dynamic_function_for_abi(&parameters, body, kind, abi_identifier)
            })
    });
    encode_dynamic_compiler_result(result, source_kind)
}

pub fn compile_template_result_json(source: &str, source_kind: &str) -> Result<String, Error> {
    let result = source_kind_from_wire(source_kind).and_then(|kind| compile_template(source, kind));
    encode_compiler_result(result, source_kind)
}

struct Collision<'a> {
    found: bool,
    name: &'a str,
}
impl Visit for Collision<'_> {
    fn visit_ident(&mut self, node: &Ident) {
        if node.sym == self.name {
            self.found = true;
        }
    }
}

#[derive(Default)]
struct AbiIdentifierCollector {
    identifiers: BTreeSet<String>,
}
impl Visit for AbiIdentifierCollector {
    fn visit_ident(&mut self, node: &Ident) {
        let identifier = node.sym.as_ref();
        if identifier.len() == ABI_PLACEHOLDER.len()
            && identifier.starts_with("__zp_abi_")
            && identifier[9..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            self.identifiers.insert(identifier.to_owned());
        }
    }
}

struct PendingModuleSpecifier {
    original_start: usize,
    original_end: usize,
    specifier: String,
    module_type: String,
}

fn property_name_matches(name: &PropName, expected: &str) -> bool {
    match name {
        PropName::Ident(identifier) => identifier.sym == expected,
        PropName::Str(value) => value.value == expected,
        _ => false,
    }
}

fn key_value_property<'a>(object: &'a ObjectLit, name: &str) -> Option<&'a Expr> {
    object.props.iter().find_map(|property| {
        let PropOrSpread::Prop(property) = property else {
            return None;
        };
        let Prop::KeyValue(property) = property.as_ref() else {
            return None;
        };
        property_name_matches(&property.key, name).then_some(property.value.as_ref())
    })
}

fn module_type_from_attributes(attributes: Option<&ObjectLit>) -> String {
    let Some(Expr::Lit(Lit::Str(module_type))) =
        attributes.and_then(|object| key_value_property(object, "type"))
    else {
        return "javascript".to_owned();
    };
    module_type.value.to_string_lossy().into_owned()
}

fn dynamic_import_module_type(arguments: &[ExprOrSpread]) -> Option<String> {
    match arguments {
        [_] => Some("javascript".to_owned()),
        [_, options] if options.spread.is_none() => {
            let Expr::Object(options) = options.expr.as_ref() else {
                return None;
            };
            if options
                .props
                .iter()
                .any(|property| matches!(property, PropOrSpread::Spread(_)))
            {
                return None;
            }
            let Some(attributes) = key_value_property(options, "with") else {
                return Some("javascript".to_owned());
            };
            let Expr::Object(attributes) = attributes else {
                return None;
            };
            if attributes
                .props
                .iter()
                .any(|property| matches!(property, PropOrSpread::Spread(_)))
            {
                return None;
            }
            Some(module_type_from_attributes(Some(attributes)))
        }
        _ => None,
    }
}

fn has_use_strict_directive(statements: &[Stmt]) -> bool {
    for statement in statements {
        let Stmt::Expr(expression) = statement else {
            break;
        };
        let Expr::Lit(Lit::Str(value)) = expression.expr.as_ref() else {
            break;
        };
        if matches!(
            value.raw.as_deref(),
            Some("\"use strict\"" | "'use strict'")
        ) {
            return true;
        }
    }
    false
}
const NO_ABI_OFFSET: usize = usize::MAX;

fn strict_resolver_marker() -> Stmt {
    Stmt::Expr(ExprStmt {
        span: DUMMY_SP,
        expr: Box::new(Expr::Lit(Lit::Str(Str {
            span: DUMMY_SP,
            value: "use strict".into(),
            raw: Some("\"use strict\"".into()),
        }))),
    })
}

fn is_strict_resolver_marker(statement: &Stmt) -> bool {
    statement.span() == DUMMY_SP
}

struct StrictResolverMarkers {
    force_root_strict: bool,
}

impl VisitMut for StrictResolverMarkers {
    fn visit_mut_script(&mut self, script: &mut Script) {
        if self.force_root_strict || has_use_strict_directive(&script.body) {
            script.body.insert(0, strict_resolver_marker());
        }
        script.visit_mut_children_with(self);
    }

    fn visit_mut_function(&mut self, function: &mut Function) {
        if let Some(body) = function.body.as_mut()
            && has_use_strict_directive(&body.stmts)
        {
            body.stmts.insert(0, strict_resolver_marker());
        }
        function.visit_mut_children_with(self);
    }

    fn visit_mut_arrow_expr(&mut self, arrow: &mut ArrowExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = arrow.body.as_mut()
            && has_use_strict_directive(&body.stmts)
        {
            body.stmts.insert(0, strict_resolver_marker());
        }
        arrow.visit_mut_children_with(self);
    }
}

struct RemoveStrictResolverMarkers;

impl VisitMut for RemoveStrictResolverMarkers {
    fn visit_mut_script(&mut self, script: &mut Script) {
        script
            .body
            .retain(|statement| !is_strict_resolver_marker(statement));
        script.visit_mut_children_with(self);
    }

    fn visit_mut_function(&mut self, function: &mut Function) {
        if let Some(body) = function.body.as_mut() {
            body.stmts
                .retain(|statement| !is_strict_resolver_marker(statement));
        }
        function.visit_mut_children_with(self);
    }

    fn visit_mut_arrow_expr(&mut self, arrow: &mut ArrowExpr) {
        if let BlockStmtOrExpr::BlockStmt(body) = arrow.body.as_mut() {
            body.stmts
                .retain(|statement| !is_strict_resolver_marker(statement));
        }
        arrow.visit_mut_children_with(self);
    }
}

struct AnnexBFunctionCollector {
    allowed_spans: Vec<Span>,
    strict_stack: Vec<bool>,
}

impl AnnexBFunctionCollector {
    fn strict(&self) -> bool {
        self.strict_stack.last().copied().unwrap_or(false)
    }

    fn visit_if_clause(&mut self, statement: &Stmt) {
        if let Stmt::Decl(Decl::Fn(declaration)) = statement {
            if !self.strict()
                && !declaration.function.is_async
                && !declaration.function.is_generator
            {
                self.allowed_spans.push(declaration.function.span);
            }
            declaration.function.visit_with(self);
        } else {
            statement.visit_with(self);
        }
    }
}

impl Visit for AnnexBFunctionCollector {
    fn visit_script(&mut self, script: &Script) {
        let strict = self.strict() || has_use_strict_directive(&script.body);
        self.strict_stack.push(strict);
        for statement in &script.body {
            statement.visit_with(self);
        }
        self.strict_stack.pop();
    }

    fn visit_module(&mut self, module: &Module) {
        self.strict_stack.push(true);
        module.visit_children_with(self);
        self.strict_stack.pop();
    }

    fn visit_function(&mut self, function: &Function) {
        let strict = self.strict()
            || function
                .body
                .as_ref()
                .is_some_and(|body| has_use_strict_directive(&body.stmts));
        self.strict_stack.push(strict);
        function.visit_children_with(self);
        self.strict_stack.pop();
    }

    fn visit_arrow_expr(&mut self, arrow: &ArrowExpr) {
        let strict = self.strict()
            || match arrow.body.as_ref() {
                BlockStmtOrExpr::BlockStmt(body) => has_use_strict_directive(&body.stmts),
                BlockStmtOrExpr::Expr(_) => false,
            };
        self.strict_stack.push(strict);
        arrow.visit_children_with(self);
        self.strict_stack.pop();
    }

    fn visit_class(&mut self, class: &Class) {
        self.strict_stack.push(true);
        class.visit_children_with(self);
        self.strict_stack.pop();
    }

    fn visit_if_stmt(&mut self, statement: &IfStmt) {
        statement.test.visit_with(self);
        self.visit_if_clause(&statement.cons);
        if let Some(alternate) = statement.alt.as_deref() {
            self.visit_if_clause(alternate);
        }
    }
}

fn parser_errors_are_only_sloppy_annex_b(
    errors: &[ParserError],
    program: &Program,
    root_strict: bool,
) -> bool {
    let mut collector = AnnexBFunctionCollector {
        allowed_spans: Vec::new(),
        strict_stack: vec![root_strict],
    };
    program.visit_with(&mut collector);
    !errors.is_empty()
        && errors.iter().all(|error| {
            matches!(error.kind(), SyntaxError::DeclNotAllowed)
                && collector.allowed_spans.iter().any(|span| {
                    let error_span = error.span();
                    error_span.lo >= span.lo && error_span.hi <= span.hi
                })
        })
}

fn collect_bound_names(pattern: &Pat, names: &mut Vec<String>) {
    match pattern {
        Pat::Ident(identifier) => names.push(identifier.id.sym.to_string()),
        Pat::Array(array) => {
            for element in array.elems.iter().flatten() {
                collect_bound_names(element, names);
            }
        }
        Pat::Rest(rest) => collect_bound_names(&rest.arg, names),
        Pat::Object(object) => {
            for property in &object.props {
                match property {
                    ObjectPatProp::KeyValue(property) => {
                        collect_bound_names(&property.value, names);
                    }
                    ObjectPatProp::Assign(property) => {
                        names.push(property.key.id.sym.to_string());
                    }
                    ObjectPatProp::Rest(rest) => collect_bound_names(&rest.arg, names),
                }
            }
        }
        Pat::Assign(assign) => collect_bound_names(&assign.left, names),
        Pat::Invalid(_) | Pat::Expr(_) => {}
    }
}

fn collect_declarator_names(declarations: &[VarDeclarator], names: &mut Vec<String>) {
    for declaration in declarations {
        collect_bound_names(&declaration.name, names);
    }
}

fn collect_declaration_bound_names(declaration: &Decl, names: &mut Vec<String>) {
    match declaration {
        Decl::Var(declaration) => collect_declarator_names(&declaration.decls, names),
        Decl::Using(declaration) => collect_declarator_names(&declaration.decls, names),
        Decl::Class(declaration) => names.push(declaration.ident.sym.to_string()),
        Decl::Fn(declaration) => names.push(declaration.ident.sym.to_string()),
        Decl::TsInterface(_) | Decl::TsTypeAlias(_) | Decl::TsEnum(_) | Decl::TsModule(_) => {}
    }
}

fn module_export_name(name: &ModuleExportName) -> Option<String> {
    match name {
        ModuleExportName::Ident(identifier) => Some(identifier.sym.to_string()),
        ModuleExportName::Str(string) => string.value.as_str().map(str::to_owned),
    }
}

fn insert_module_exported_name(
    exported: &mut BTreeSet<String>,
    name: &ModuleExportName,
    invalid: &mut bool,
) {
    match module_export_name(name) {
        Some(name) => insert_exported_name(exported, name, invalid),
        None => *invalid = true,
    }
}

fn insert_exported_name(exported: &mut BTreeSet<String>, name: String, invalid: &mut bool) {
    if !exported.insert(name) {
        *invalid = true;
    }
}

#[derive(Default)]
struct VarDeclaredNameCollector {
    names: BTreeSet<String>,
}

impl Visit for VarDeclaredNameCollector {
    fn visit_var_decl(&mut self, declaration: &VarDecl) {
        if declaration.kind == VarDeclKind::Var {
            let mut names = Vec::new();
            collect_declarator_names(&declaration.decls, &mut names);
            self.names.extend(names);
        }
    }

    fn visit_function(&mut self, _function: &Function) {}

    fn visit_arrow_expr(&mut self, _arrow: &ArrowExpr) {}

    fn visit_class(&mut self, _class: &Class) {}

    fn visit_fn_decl(&mut self, _function: &FnDecl) {}
}

#[derive(Default)]
struct DirectEvalVarDeclaredNameCollector {
    names: BTreeSet<String>,
}

impl Visit for DirectEvalVarDeclaredNameCollector {
    fn visit_var_decl(&mut self, declaration: &VarDecl) {
        if declaration.kind == VarDeclKind::Var {
            let mut names = Vec::new();
            collect_declarator_names(&declaration.decls, &mut names);
            self.names.extend(names);
        }
    }

    fn visit_fn_decl(&mut self, declaration: &FnDecl) {
        if !declaration.function.is_async && !declaration.function.is_generator {
            self.names.insert(declaration.ident.sym.to_string());
        }
    }

    fn visit_function(&mut self, _function: &Function) {}
    fn visit_arrow_expr(&mut self, _arrow: &ArrowExpr) {}
    fn visit_class(&mut self, _class: &Class) {}
}

fn direct_eval_var_declared_names(program: &Program) -> BTreeSet<String> {
    let Program::Script(script) = program else {
        return BTreeSet::new();
    };
    let mut collector = DirectEvalVarDeclaredNameCollector::default();
    for statement in &script.body {
        if let Stmt::Decl(Decl::Fn(declaration)) = statement {
            collector.names.insert(declaration.ident.sym.to_string());
        } else {
            statement.visit_with(&mut collector);
        }
    }
    collector.names
}

fn cannot_be_intrinsic_eval(expression: &Expr) -> bool {
    match expression {
        Expr::Lit(_)
        | Expr::Fn(_)
        | Expr::Arrow(_)
        | Expr::Class(_)
        | Expr::Object(_)
        | Expr::Array(_)
        | Expr::Tpl(_)
        | Expr::Unary(_)
        | Expr::Update(_) => true,
        Expr::Paren(paren) => cannot_be_intrinsic_eval(&paren.expr),
        Expr::Seq(sequence) => sequence
            .exprs
            .last()
            .is_some_and(|expression| cannot_be_intrinsic_eval(expression)),
        Expr::Cond(conditional) => {
            cannot_be_intrinsic_eval(&conditional.cons)
                && cannot_be_intrinsic_eval(&conditional.alt)
        }
        _ => false,
    }
}

#[derive(Default)]
struct SafeEvalBindingCollector {
    contexts: Vec<SyntaxContext>,
}

impl SafeEvalBindingCollector {
    fn record(&mut self, identifier: &Ident) {
        if identifier.sym == "eval" && !self.contexts.contains(&identifier.ctxt) {
            self.contexts.push(identifier.ctxt);
        }
    }
}

impl Visit for SafeEvalBindingCollector {
    fn visit_var_decl(&mut self, declaration: &VarDecl) {
        if declaration.kind == VarDeclKind::Const {
            for declarator in &declaration.decls {
                if let Pat::Ident(binding) = &declarator.name
                    && declarator
                        .init
                        .as_deref()
                        .is_some_and(cannot_be_intrinsic_eval)
                {
                    self.record(&binding.id);
                }
            }
        }
        declaration.visit_children_with(self);
    }

    fn visit_fn_expr(&mut self, expression: &FnExpr) {
        if let Some(identifier) = &expression.ident {
            self.record(identifier);
        }
        expression.visit_children_with(self);
    }

    fn visit_class_expr(&mut self, expression: &ClassExpr) {
        if let Some(identifier) = &expression.ident {
            self.record(identifier);
        }
        expression.visit_children_with(self);
    }
}

fn insert_lexical_name(lexical: &mut BTreeSet<String>, name: String, invalid: &mut bool) {
    if !lexical.insert(name) {
        *invalid = true;
    }
}

fn add_direct_declaration_names(
    declaration: &Decl,
    functions_are_lexical: bool,
    lexical: &mut BTreeSet<String>,
    vars: &mut BTreeSet<String>,
    invalid: &mut bool,
) {
    match declaration {
        Decl::Var(declaration) => {
            let mut names = Vec::new();
            collect_declarator_names(&declaration.decls, &mut names);
            if declaration.kind == VarDeclKind::Var {
                vars.extend(names);
            } else {
                for name in names {
                    insert_lexical_name(lexical, name, invalid);
                }
            }
        }
        Decl::Using(declaration) => {
            let mut names = Vec::new();
            collect_declarator_names(&declaration.decls, &mut names);
            for name in names {
                insert_lexical_name(lexical, name, invalid);
            }
        }
        Decl::Class(declaration) => {
            insert_lexical_name(lexical, declaration.ident.sym.to_string(), invalid);
        }
        Decl::Fn(declaration) if functions_are_lexical => {
            insert_lexical_name(lexical, declaration.ident.sym.to_string(), invalid);
        }
        Decl::Fn(declaration) => {
            vars.insert(declaration.ident.sym.to_string());
        }
        Decl::TsInterface(_) | Decl::TsTypeAlias(_) | Decl::TsEnum(_) | Decl::TsModule(_) => {
            *invalid = true;
        }
    }
}

fn validate_statement_list<'a>(
    statements: impl IntoIterator<Item = &'a Stmt>,
    functions_are_lexical: bool,
    invalid: &mut bool,
) -> BTreeSet<String> {
    let mut lexical = BTreeSet::new();
    let mut vars = BTreeSet::new();
    for statement in statements {
        if let Stmt::Decl(declaration) = statement {
            add_direct_declaration_names(
                declaration,
                functions_are_lexical,
                &mut lexical,
                &mut vars,
                invalid,
            );
        }
        let mut collector = VarDeclaredNameCollector::default();
        statement.visit_with(&mut collector);
        vars.extend(collector.names);
    }
    if lexical.iter().any(|name| vars.contains(name)) {
        *invalid = true;
    }
    lexical
}

fn validate_parameter_list<'a>(
    parameters: impl IntoIterator<Item = &'a Pat>,
    strict: bool,
    has_strict_directive: bool,
    body_lexical_names: &BTreeSet<String>,
    invalid: &mut bool,
) {
    let mut bound_names = BTreeSet::new();
    let mut duplicate = false;
    let mut simple = true;
    for parameter in parameters {
        simple &= matches!(parameter, Pat::Ident(_));
        let mut names = Vec::new();
        collect_bound_names(parameter, &mut names);
        for name in names {
            duplicate |= !bound_names.insert(name);
        }
    }
    if (strict || !simple) && duplicate {
        *invalid = true;
    }
    if has_strict_directive && !simple {
        *invalid = true;
    }
    if strict
        && bound_names
            .iter()
            .any(|name| name == "eval" || name == "arguments")
    {
        *invalid = true;
    }
    if bound_names
        .iter()
        .any(|name| body_lexical_names.contains(name))
    {
        *invalid = true;
    }
}

struct EarlyErrorValidator {
    invalid: bool,
    strict_stack: Vec<bool>,
}

impl EarlyErrorValidator {
    fn strict(&self) -> bool {
        self.strict_stack.last().copied().unwrap_or(false)
    }
}

impl Visit for EarlyErrorValidator {
    fn visit_script(&mut self, script: &Script) {
        let strict = self.strict() || has_use_strict_directive(&script.body);
        validate_statement_list(&script.body, false, &mut self.invalid);
        self.strict_stack.push(strict);
        for statement in &script.body {
            statement.visit_with(self);
        }
        self.strict_stack.pop();
    }

    fn visit_module(&mut self, module: &Module) {
        let mut lexical = BTreeSet::new();
        let mut vars = BTreeSet::new();
        let mut exported = BTreeSet::new();
        let mut local_exports = Vec::new();
        for item in &module.body {
            match item {
                ModuleItem::Stmt(statement) => {
                    if let Stmt::Decl(declaration) = statement {
                        add_direct_declaration_names(
                            declaration,
                            true,
                            &mut lexical,
                            &mut vars,
                            &mut self.invalid,
                        );
                    }
                    let mut collector = VarDeclaredNameCollector::default();
                    statement.visit_with(&mut collector);
                    vars.extend(collector.names);
                }
                ModuleItem::ModuleDecl(ModuleDecl::Import(declaration)) => {
                    for specifier in &declaration.specifiers {
                        insert_lexical_name(
                            &mut lexical,
                            specifier.local().sym.to_string(),
                            &mut self.invalid,
                        );
                        if let ImportSpecifier::Named(named) = specifier
                            && named
                                .imported
                                .as_ref()
                                .is_some_and(|name| module_export_name(name).is_none())
                        {
                            self.invalid = true;
                        }
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(export)) => {
                    let mut names = Vec::new();
                    collect_declaration_bound_names(&export.decl, &mut names);
                    for name in names {
                        insert_exported_name(&mut exported, name, &mut self.invalid);
                    }
                    add_direct_declaration_names(
                        &export.decl,
                        true,
                        &mut lexical,
                        &mut vars,
                        &mut self.invalid,
                    );
                    let mut collector = VarDeclaredNameCollector::default();
                    export.decl.visit_with(&mut collector);
                    vars.extend(collector.names);
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(export)) => {
                    insert_exported_name(&mut exported, "default".to_owned(), &mut self.invalid);
                    let identifier = match &export.decl {
                        DefaultDecl::Class(class) => class.ident.as_ref(),
                        DefaultDecl::Fn(function) => function.ident.as_ref(),
                        DefaultDecl::TsInterfaceDecl(_) => {
                            self.invalid = true;
                            None
                        }
                    };
                    if let Some(identifier) = identifier {
                        insert_lexical_name(
                            &mut lexical,
                            identifier.sym.to_string(),
                            &mut self.invalid,
                        );
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => {
                    insert_exported_name(&mut exported, "default".to_owned(), &mut self.invalid);
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(export)) => {
                    for specifier in &export.specifiers {
                        match specifier {
                            ExportSpecifier::Namespace(namespace) => {
                                insert_module_exported_name(
                                    &mut exported,
                                    &namespace.name,
                                    &mut self.invalid,
                                );
                                if export.src.is_none() {
                                    self.invalid = true;
                                }
                            }
                            ExportSpecifier::Default(default) => {
                                insert_exported_name(
                                    &mut exported,
                                    default.exported.sym.to_string(),
                                    &mut self.invalid,
                                );
                                if export.src.is_none() {
                                    self.invalid = true;
                                }
                            }
                            ExportSpecifier::Named(named) => {
                                if module_export_name(&named.orig).is_none() {
                                    self.invalid = true;
                                }
                                insert_module_exported_name(
                                    &mut exported,
                                    named.exported.as_ref().unwrap_or(&named.orig),
                                    &mut self.invalid,
                                );
                                if export.src.is_none() {
                                    match &named.orig {
                                        ModuleExportName::Ident(identifier) => {
                                            local_exports.push(identifier.sym.to_string());
                                        }
                                        ModuleExportName::Str(_) => self.invalid = true,
                                    }
                                }
                            }
                        }
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportAll(_)) => {}
                ModuleItem::ModuleDecl(
                    ModuleDecl::TsImportEquals(_)
                    | ModuleDecl::TsExportAssignment(_)
                    | ModuleDecl::TsNamespaceExport(_),
                ) => {
                    self.invalid = true;
                }
            }
        }
        if lexical.iter().any(|name| vars.contains(name))
            || local_exports
                .iter()
                .any(|name| !lexical.contains(name) && !vars.contains(name))
        {
            self.invalid = true;
        }
        self.strict_stack.push(true);
        for item in &module.body {
            item.visit_with(self);
        }
        self.strict_stack.pop();
    }

    fn visit_block_stmt(&mut self, block: &BlockStmt) {
        validate_statement_list(&block.stmts, true, &mut self.invalid);
        for statement in &block.stmts {
            statement.visit_with(self);
        }
    }

    fn visit_switch_stmt(&mut self, switch: &SwitchStmt) {
        validate_statement_list(
            switch.cases.iter().flat_map(|case| case.cons.iter()),
            true,
            &mut self.invalid,
        );
        switch.discriminant.visit_with(self);
        for case in &switch.cases {
            if let Some(test) = &case.test {
                test.visit_with(self);
            }
            for statement in &case.cons {
                statement.visit_with(self);
            }
        }
    }

    fn visit_function(&mut self, function: &Function) {
        let has_strict_directive = function
            .body
            .as_ref()
            .is_some_and(|body| has_use_strict_directive(&body.stmts));
        let strict = self.strict() || has_strict_directive;
        let lexical = function
            .body
            .as_ref()
            .map(|body| validate_statement_list(&body.stmts, false, &mut self.invalid))
            .unwrap_or_default();
        validate_parameter_list(
            function.params.iter().map(|parameter| &parameter.pat),
            strict,
            has_strict_directive,
            &lexical,
            &mut self.invalid,
        );
        self.strict_stack.push(strict);
        for parameter in &function.params {
            parameter.visit_with(self);
        }
        if let Some(body) = &function.body {
            for statement in &body.stmts {
                statement.visit_with(self);
            }
        }
        self.strict_stack.pop();
    }

    fn visit_arrow_expr(&mut self, arrow: &ArrowExpr) {
        let has_strict_directive = match arrow.body.as_ref() {
            BlockStmtOrExpr::BlockStmt(body) => has_use_strict_directive(&body.stmts),
            BlockStmtOrExpr::Expr(_) => false,
        };
        let strict = self.strict() || has_strict_directive;
        let lexical = match arrow.body.as_ref() {
            BlockStmtOrExpr::BlockStmt(body) => {
                validate_statement_list(&body.stmts, false, &mut self.invalid)
            }
            BlockStmtOrExpr::Expr(_) => BTreeSet::new(),
        };
        validate_parameter_list(
            arrow.params.iter(),
            strict,
            has_strict_directive,
            &lexical,
            &mut self.invalid,
        );
        self.strict_stack.push(strict);
        for parameter in &arrow.params {
            parameter.visit_with(self);
        }
        match arrow.body.as_ref() {
            BlockStmtOrExpr::BlockStmt(body) => {
                for statement in &body.stmts {
                    statement.visit_with(self);
                }
            }
            BlockStmtOrExpr::Expr(expression) => expression.visit_with(self),
        }
        self.strict_stack.pop();
    }

    fn visit_var_decl(&mut self, declaration: &VarDecl) {
        if declaration.kind != VarDeclKind::Var {
            let mut bound_names = BTreeSet::new();
            let mut names = Vec::new();
            collect_declarator_names(&declaration.decls, &mut names);
            if names.into_iter().any(|name| !bound_names.insert(name)) {
                self.invalid = true;
            }
        }
        declaration.visit_children_with(self);
    }

    fn visit_using_decl(&mut self, declaration: &UsingDecl) {
        let mut bound_names = BTreeSet::new();
        let mut names = Vec::new();
        collect_declarator_names(&declaration.decls, &mut names);
        if names.into_iter().any(|name| !bound_names.insert(name)) {
            self.invalid = true;
        }
        declaration.visit_children_with(self);
    }

    fn visit_catch_clause(&mut self, clause: &CatchClause) {
        let lexical = validate_statement_list(&clause.body.stmts, true, &mut self.invalid);
        if let Some(parameter) = &clause.param {
            let mut bound_names = BTreeSet::new();
            let mut duplicate = false;
            let mut names = Vec::new();
            collect_bound_names(parameter, &mut names);
            for name in names {
                duplicate |= !bound_names.insert(name);
            }
            if duplicate || bound_names.iter().any(|name| lexical.contains(name)) {
                self.invalid = true;
            }
            parameter.visit_with(self);
        }
        for statement in &clause.body.stmts {
            statement.visit_with(self);
        }
    }

    fn visit_class(&mut self, class: &Class) {
        self.strict_stack.push(true);
        class.visit_children_with(self);
        self.strict_stack.pop();
    }
}

fn has_early_errors(program: &Program, root_strict: bool) -> bool {
    let mut validator = EarlyErrorValidator {
        invalid: false,
        strict_stack: vec![root_strict],
    };
    program.visit_with(&mut validator);
    validator.invalid
}

struct Planner<'a> {
    unresolved: SyntaxContext,
    start: u32,
    abi_identifier: &'a str,
    edits: Vec<Edit>,
    module_specifiers: Vec<PendingModuleSpecifier>,
    unsafe_with: bool,
    unsupported_eval: bool,
    unsupported_eval_binding: bool,
    safe_eval_bindings: Vec<SyntaxContext>,
    inside_with: usize,
    preserve_literal_dynamic_import: bool,
    preserve_literal_import_scripts: bool,
    direct_import_scripts_reference: bool,
    unsupported_import_scripts: bool,
    strict_stack: Vec<bool>,
}
impl Planner<'_> {
    fn span(&self, span: Span) -> (usize, usize) {
        (
            (span.lo.0 - self.start) as usize,
            (span.hi.0 - self.start) as usize,
        )
    }
    fn add(&mut self, kind: EditKind, span: Span, replacement: String) {
        let (start, end) = self.span(span);
        let abi_offset = if replacement.starts_with(self.abi_identifier) {
            0
        } else {
            replacement
                .find(&format!(": {}", self.abi_identifier))
                .map(|offset| offset + 2)
                .expect("compiler replacement must contain ABI slot")
        };
        self.add_range(kind, start, end, replacement, abi_offset);
    }

    fn add_insertion(&mut self, kind: EditKind, offset: usize, replacement: String) {
        self.add_range(kind, offset, offset, replacement, 0);
    }

    fn add_plain_insertion(&mut self, kind: EditKind, offset: usize, replacement: String) {
        self.add_range(kind, offset, offset, replacement, NO_ABI_OFFSET);
    }

    fn add_range(
        &mut self,
        kind: EditKind,
        start: usize,
        end: usize,
        replacement: String,
        abi_offset: usize,
    ) {
        self.edits.push(Edit {
            kind,
            start,
            end,
            replacement,
            abi_offset,
        });
        if self.inside_with > 0 {
            self.unsafe_with = true;
        }
    }
    fn add_module_specifier(&mut self, specifier: &Str, module_type: String) {
        let (start, end) = self.span(specifier.span);
        self.module_specifiers.push(PendingModuleSpecifier {
            original_start: start,
            original_end: end,
            specifier: specifier.value.to_string_lossy().into_owned(),
            module_type,
        });
    }
    fn owned(&self, ident: &Ident) -> bool {
        ident.ctxt == self.unresolved && is_owned_global(ident.sym.as_ref())
    }
    fn eval_callee_identifier<'a>(&self, expression: &'a Expr) -> Option<&'a Ident> {
        match expression {
            Expr::Ident(ident) if ident.sym == "eval" => Some(ident),
            Expr::Paren(paren) => self.eval_callee_identifier(&paren.expr),
            _ => None,
        }
    }
    fn import_scripts_callee(&self, expression: &Expr) -> bool {
        match expression {
            Expr::Ident(ident) => ident.ctxt == self.unresolved && ident.sym == "importScripts",
            Expr::Member(member) => {
                let property_matches = match &member.prop {
                    MemberProp::Ident(ident) => ident.sym == "importScripts",
                    MemberProp::Computed(computed) => matches!(
                        computed.expr.as_ref(),
                        Expr::Lit(Lit::Str(value)) if value.value == "importScripts"
                    ),
                    MemberProp::PrivateName(_) => false,
                };
                property_matches
                    && matches!(
                        member.obj.as_ref(),
                        Expr::Ident(ident)
                            if ident.ctxt == self.unresolved
                                && (ident.sym == "self" || ident.sym == "globalThis")
                    )
            }
            Expr::Paren(paren) => self.import_scripts_callee(&paren.expr),
            _ => false,
        }
    }
    fn safe_local_eval_binding(&self, identifier: &Ident) -> bool {
        self.safe_eval_bindings.contains(&identifier.ctxt)
    }
    fn add_target(&mut self, ident: &Ident) {
        self.add(
            EditKind::OwnedGlobalTarget,
            ident.span,
            format!("{}.scope.{}", self.abi_identifier, ident.sym),
        );
    }
    fn rewrite_owned_target_expr(&mut self, expression: &Expr) -> bool {
        match expression {
            Expr::Ident(ident) if self.owned(ident) => {
                self.add_target(ident);
                true
            }
            Expr::Paren(paren) => self.rewrite_owned_target_expr(&paren.expr),
            _ => false,
        }
    }
    fn rewrite_simple_target(&mut self, target: &SimpleAssignTarget) -> bool {
        match target {
            SimpleAssignTarget::Ident(binding) if self.owned(&binding.id) => {
                self.add_target(&binding.id);
                true
            }
            SimpleAssignTarget::Paren(paren) => self.rewrite_owned_target_expr(&paren.expr),
            _ => false,
        }
    }
    fn rewrite_pat(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(binding) => {
                if self.owned(&binding.id) {
                    self.add_target(&binding.id)
                }
            }
            Pat::Array(array) => {
                for element in array.elems.iter().flatten() {
                    self.rewrite_pat(element)
                }
            }
            Pat::Object(object) => {
                for property in &object.props {
                    match property {
                        ObjectPatProp::KeyValue(key_value) => {
                            key_value.key.visit_with(self);
                            self.rewrite_pat(&key_value.value)
                        }
                        ObjectPatProp::Assign(assign) => {
                            if self.owned(&assign.key.id) {
                                self.add(
                                    EditKind::OwnedGlobalTarget,
                                    assign.key.id.span,
                                    format!(
                                        "{}: {}.scope.{}",
                                        assign.key.id.sym, self.abi_identifier, assign.key.id.sym
                                    ),
                                )
                            };
                            assign.value.visit_with(self)
                        }
                        ObjectPatProp::Rest(rest) => self.rewrite_pat(&rest.arg),
                    }
                }
            }
            Pat::Assign(assign) => {
                self.rewrite_pat(&assign.left);
                assign.right.visit_with(self)
            }
            Pat::Rest(rest) => self.rewrite_pat(&rest.arg),
            Pat::Expr(expr) => {
                if !self.rewrite_owned_target_expr(expr) {
                    expr.visit_with(self)
                }
            }
            Pat::Invalid(_) => {}
        }
    }
    fn rewrite_target(&mut self, target: &AssignTarget) {
        match target {
            AssignTarget::Simple(simple) => {
                if !self.rewrite_simple_target(simple) {
                    simple.visit_children_with(self)
                }
            }
            AssignTarget::Pat(AssignTargetPat::Array(array)) => {
                self.rewrite_pat(&Pat::Array(array.clone()))
            }
            AssignTarget::Pat(AssignTargetPat::Object(object)) => {
                self.rewrite_pat(&Pat::Object(object.clone()))
            }
            AssignTarget::Pat(AssignTargetPat::Invalid(invalid)) => {
                invalid.visit_children_with(self)
            }
        }
    }
    fn caller_strict(&self) -> bool {
        *self
            .strict_stack
            .last()
            .expect("planner has a root strictness context")
    }

    fn visit_in_strict_context(&mut self, strict: bool, visit: impl FnOnce(&mut Self)) {
        self.strict_stack.push(strict);
        visit(self);
        self.strict_stack.pop();
    }
}
impl Visit for Planner<'_> {
    fn visit_function(&mut self, node: &Function) {
        let strict = self.caller_strict()
            || node
                .body
                .as_ref()
                .is_some_and(|body| has_use_strict_directive(&body.stmts));
        self.visit_in_strict_context(strict, |planner| node.visit_children_with(planner));
    }

    fn visit_arrow_expr(&mut self, node: &ArrowExpr) {
        let strict = self.caller_strict()
            || matches!(
                node.body.as_ref(),
                BlockStmtOrExpr::BlockStmt(body) if has_use_strict_directive(&body.stmts)
            );
        self.visit_in_strict_context(strict, |planner| node.visit_children_with(planner));
    }

    fn visit_class(&mut self, node: &Class) {
        self.visit_in_strict_context(true, |planner| node.visit_children_with(planner));
    }
    fn visit_module_decl(&mut self, node: &ModuleDecl) {
        match node {
            ModuleDecl::Import(import) => self.add_module_specifier(
                &import.src,
                module_type_from_attributes(import.with.as_deref()),
            ),
            ModuleDecl::ExportAll(export) => self.add_module_specifier(
                &export.src,
                module_type_from_attributes(export.with.as_deref()),
            ),
            ModuleDecl::ExportNamed(export) => {
                if let Some(specifier) = &export.src {
                    self.add_module_specifier(
                        specifier,
                        module_type_from_attributes(export.with.as_deref()),
                    );
                }
            }
            _ => {}
        }
        node.visit_children_with(self);
    }
    fn visit_meta_prop_expr(&mut self, node: &MetaPropExpr) {
        if node.kind == MetaPropKind::ImportMeta {
            self.add(
                EditKind::ImportMeta,
                node.span,
                format!("{}.importMeta", self.abi_identifier),
            );
            return;
        }
        node.visit_children_with(self);
    }
    fn visit_with_stmt(&mut self, node: &WithStmt) {
        self.inside_with += 1;
        node.obj.visit_with(self);
        node.body.visit_with(self);
        self.inside_with -= 1;
    }
    fn visit_prop(&mut self, node: &Prop) {
        if let Prop::Shorthand(ident) = node
            && self.owned(ident)
        {
            self.add(
                EditKind::OwnedGlobalShorthand,
                ident.span,
                format!("{}: {}.scope.{}", ident.sym, self.abi_identifier, ident.sym),
            );
            return;
        }
        node.visit_children_with(self);
    }
    fn visit_assign_expr(&mut self, node: &AssignExpr) {
        self.rewrite_target(&node.left);
        node.right.visit_with(self);
    }
    fn visit_update_expr(&mut self, node: &UpdateExpr) {
        if !self.rewrite_owned_target_expr(&node.arg) {
            node.arg.visit_with(self);
        }
    }
    fn visit_unary_expr(&mut self, node: &UnaryExpr) {
        if node.op != UnaryOp::Delete || !self.rewrite_owned_target_expr(&node.arg) {
            node.arg.visit_with(self);
        }
    }
    fn visit_for_of_stmt(&mut self, node: &ForOfStmt) {
        match &node.left {
            ForHead::Pat(pattern) => self.rewrite_pat(pattern),
            other => other.visit_children_with(self),
        }
        node.right.visit_with(self);
        node.body.visit_with(self);
    }
    fn visit_for_in_stmt(&mut self, node: &ForInStmt) {
        match &node.left {
            ForHead::Pat(pattern) => self.rewrite_pat(pattern),
            other => other.visit_children_with(self),
        }
        node.right.visit_with(self);
        node.body.visit_with(self);
    }
    fn visit_call_expr(&mut self, node: &CallExpr) {
        if let Callee::Import(import) = &node.callee {
            if self.preserve_literal_dynamic_import
                && let Some(argument) = node.args.first()
                && let Expr::Lit(Lit::Str(specifier)) = argument.expr.as_ref()
                && let Some(module_type) = dynamic_import_module_type(&node.args)
            {
                self.add_module_specifier(specifier, module_type);
            } else {
                self.add(
                    EditKind::DynamicImport,
                    import.span,
                    format!("{}.importModule", self.abi_identifier),
                );
            }
            for argument in &node.args {
                argument.expr.visit_with(self);
            }
            return;
        }
        let Callee::Expr(callee) = &node.callee else {
            node.visit_children_with(self);
            return;
        };
        if self.preserve_literal_import_scripts && self.import_scripts_callee(callee) {
            for argument in &node.args {
                if argument.spread.is_some() {
                    self.unsupported_import_scripts = true;
                } else if let Expr::Lit(Lit::Str(specifier)) = argument.expr.as_ref() {
                    self.add_module_specifier(specifier, "javascript".to_owned());
                } else {
                    self.unsupported_import_scripts = true;
                }
            }
            self.direct_import_scripts_reference = true;
            callee.visit_with(self);
            self.direct_import_scripts_reference = false;
            for argument in &node.args {
                argument.expr.visit_with(self);
            }
            return;
        }
        let Some(eval_identifier) = self.eval_callee_identifier(callee) else {
            node.visit_children_with(self);
            return;
        };
        if eval_identifier.ctxt != self.unresolved {
            if !self.safe_local_eval_binding(eval_identifier) {
                self.unsupported_eval_binding = true;
                return;
            }
            node.visit_children_with(self);
            return;
        }
        if node.args.is_empty() {
            return;
        }
        if node.args.len() != 1 || node.args[0].spread.is_some() {
            self.unsupported_eval = true;
            return;
        }
        let argument = &node.args[0].expr;
        let (start, end) = self.span(argument.span());
        self.add_insertion(
            EditKind::DirectEvalArgument,
            start,
            format!("{}.evalSource(", self.abi_identifier),
        );
        argument.visit_with(self);
        self.add_plain_insertion(
            EditKind::DirectEvalArgument,
            end,
            format!(",{{caller_strict:{}}})", self.caller_strict()),
        );
    }
    fn visit_expr(&mut self, node: &Expr) {
        if self.preserve_literal_import_scripts
            && !self.direct_import_scripts_reference
            && self.import_scripts_callee(node)
        {
            self.unsupported_import_scripts = true;
        }
        match node {
            Expr::Ident(ident) if ident.sym == "eval" && ident.ctxt != self.unresolved => {
                if !self.safe_local_eval_binding(ident) {
                    self.unsupported_eval_binding = true;
                }
                return;
            }
            Expr::Ident(ident)
                if ident.ctxt == self.unresolved && is_owned_global(ident.sym.as_ref()) =>
            {
                self.add(
                    EditKind::OwnedGlobalReference,
                    ident.span,
                    format!("{}.scope.{}", self.abi_identifier, ident.sym),
                );
                return;
            }
            Expr::This(this) => {
                self.add(
                    EditKind::ThisExpression,
                    this.span,
                    format!("{}.thisValue(this)", self.abi_identifier),
                );
                return;
            }
            _ => {}
        }
        node.visit_children_with(self);
    }
}

pub fn compile(source: &str, kind: SourceKind) -> Result<RewriteResult, Error> {
    compile_for_abi(source, kind, ABI_PLACEHOLDER)
}
fn build_edit_map(edits: &[Edit]) -> Vec<SpanMap> {
    let mut delta = 0_isize;
    edits
        .iter()
        .map(|edit| {
            let generated_start = edit.start.saturating_add_signed(delta);
            let generated_end = generated_start + edit.replacement.len();
            delta += edit.replacement.len() as isize - (edit.end - edit.start) as isize;
            SpanMap {
                original_start: edit.start,
                original_end: edit.end,
                generated_start,
                generated_end,
            }
        })
        .collect()
}
fn generated_offset(original_offset: usize, edits: &[Edit]) -> Result<usize, Error> {
    let mut delta = 0_isize;
    for edit in edits {
        if edit.end <= original_offset {
            delta += edit.replacement.len() as isize - (edit.end - edit.start) as isize;
            continue;
        }
        if edit.start < original_offset {
            return Err(Error::ResolutionFailed);
        }
        break;
    }
    Ok(original_offset.saturating_add_signed(delta))
}
fn directive_value(text: &str, name: &str) -> Option<String> {
    let text = text.trim();
    let directive = text
        .strip_prefix('#')
        .or_else(|| text.strip_prefix('@'))?
        .trim_start();
    let value = directive.strip_prefix(name)?.strip_prefix('=')?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn source_directives(comments: &SingleThreadedComments) -> (Option<String>, Option<String>) {
    let (leading, trailing) = comments.borrow_all();
    let mut comments: Vec<_> = leading
        .values()
        .chain(trailing.values())
        .flatten()
        .collect();
    comments.sort_by_key(|comment| comment.span.lo);
    let mut source_url = None;
    let mut source_mapping_url = None;
    for comment in comments {
        if let Some(value) = directive_value(&comment.text, "sourceURL") {
            source_url = Some(value);
        }
        if let Some(value) = directive_value(&comment.text, "sourceMappingURL") {
            source_mapping_url = Some(value);
        }
    }
    (source_url, source_mapping_url)
}

fn generated_offsets_to_original(
    generated_offsets: &[usize],
    prefix_len: usize,
    spans: &[SpanMap],
    original_len: usize,
) -> Vec<usize> {
    let mut originals = Vec::with_capacity(generated_offsets.len());
    let mut span_index = 0;
    let mut delta = 0_isize;
    for &generated in generated_offsets {
        if generated <= prefix_len {
            originals.push(0);
            continue;
        }
        let local = generated - prefix_len;
        while span_index < spans.len() && local > spans[span_index].generated_end {
            delta =
                spans[span_index].generated_end as isize - spans[span_index].original_end as isize;
            span_index += 1;
        }
        let original = spans.get(span_index).map_or_else(
            || local.saturating_add_signed(-delta).min(original_len),
            |span| {
                if local < span.generated_start {
                    local.saturating_add_signed(-delta).min(original_len)
                } else if span.generated_start == span.generated_end || local == span.generated_end
                {
                    span.original_end
                } else {
                    span.original_start
                }
            },
        );
        originals.push(original);
    }
    originals
}

fn line_start_offsets(value: &str) -> Vec<usize> {
    let mut starts = vec![0];
    let mut characters = value.char_indices().peekable();
    while let Some((offset, character)) = characters.next() {
        let next = match character {
            '\r' => {
                if characters.peek().is_some_and(|(_, next)| *next == '\n') {
                    let (line_feed_offset, _) = characters.next().expect("peeked line feed");
                    line_feed_offset + 1
                } else {
                    offset + 1
                }
            }
            '\n' => offset + 1,
            '\u{2028}' | '\u{2029}' => offset + character.len_utf8(),
            _ => continue,
        };
        starts.push(next);
    }
    starts
}

#[cfg(test)]
fn utf16_line_column(value: &str, offset: usize) -> (usize, usize) {
    let mut line = 0;
    let mut column = 0;
    let mut previous_was_carriage_return = false;
    for character in value[..offset].chars() {
        if previous_was_carriage_return && character == '\n' {
            previous_was_carriage_return = false;
            continue;
        }
        previous_was_carriage_return = false;
        match character {
            '\r' => {
                line += 1;
                column = 0;
                previous_was_carriage_return = true;
            }
            '\n' | '\u{2028}' | '\u{2029}' => {
                line += 1;
                column = 0;
            }
            _ => column += character.len_utf16(),
        }
    }
    (line, column)
}

fn positions_at_offsets(value: &str, offsets: &[usize]) -> Result<Vec<(usize, usize)>, Error> {
    if offsets.windows(2).any(|pair| pair[0] > pair[1])
        || offsets
            .iter()
            .any(|&offset| offset > value.len() || !value.is_char_boundary(offset))
    {
        return Err(Error::TransformFailed);
    }
    let mut positions = Vec::with_capacity(offsets.len());
    let mut target = 0;
    let mut line = 0;
    let mut column = 0;
    let mut previous_was_carriage_return = false;
    for (offset, character) in value.char_indices() {
        while offsets.get(target) == Some(&offset) {
            positions.push((line, column));
            target += 1;
        }
        if previous_was_carriage_return && character == '\n' {
            previous_was_carriage_return = false;
            continue;
        }
        previous_was_carriage_return = false;
        match character {
            '\r' => {
                line += 1;
                column = 0;
                previous_was_carriage_return = true;
            }
            '\n' | '\u{2028}' | '\u{2029}' => {
                line += 1;
                column = 0;
            }
            _ => column += character.len_utf16(),
        }
    }
    while offsets.get(target) == Some(&value.len()) {
        positions.push((line, column));
        target += 1;
    }
    if target != offsets.len() {
        return Err(Error::TransformFailed);
    }
    Ok(positions)
}

fn mapping_point_offsets(value: &str) -> Vec<usize> {
    let mut points = Vec::new();
    let mut previous = None;
    for (offset, character) in value.char_indices() {
        let separator = |value: char| {
            value.is_whitespace()
                || !(value.is_alphanumeric() || matches!(value, '_' | '$') || !value.is_ascii())
        };
        if offset == 0 || separator(character) || previous.is_some_and(separator) {
            points.push(offset);
        }
        previous = Some(character);
    }
    points.push(value.len());
    points
}

fn vlq(value: isize) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = if value < 0 {
        ((-value) as usize) << 1 | 1
    } else {
        (value as usize) << 1
    };
    let mut output = String::new();
    loop {
        let mut digit = encoded & 31;
        encoded >>= 5;
        if encoded != 0 {
            digit |= 32;
        }
        output.push(DIGITS[digit] as char);
        if encoded == 0 {
            return output;
        }
    }
}

fn source_map_value(
    original: &str,
    generated: &str,
    prefix_len: usize,
    source_url: &str,
    spans: &[SpanMap],
    original_source_mapping_url: Option<&str>,
) -> Result<serde_json::Value, Error> {
    if prefix_len > generated.len() || !generated.is_char_boundary(prefix_len) {
        return Err(Error::CodegenFailed);
    }
    let mut points = BTreeMap::new();
    if prefix_len > 0 {
        points.insert(0_usize, false);
    }
    for next in line_start_offsets(generated).into_iter().skip(1) {
        if next <= prefix_len {
            points.insert(next, false);
        }
    }
    points.insert(prefix_len, true);
    for offset in mapping_point_offsets(generated) {
        if offset >= prefix_len {
            points.insert(offset, true);
        }
    }
    for span in spans {
        points.insert(prefix_len + span.generated_start, true);
        points.insert(prefix_len + span.generated_end, true);
    }
    let generated_offsets: Vec<_> = points.keys().copied().collect();
    let generated_positions = positions_at_offsets(generated, &generated_offsets)?;
    let mapped_generated_offsets: Vec<_> = points
        .iter()
        .filter_map(|(&offset, &mapped)| mapped.then_some(offset))
        .collect();
    let original_offsets =
        generated_offsets_to_original(&mapped_generated_offsets, prefix_len, spans, original.len());
    let original_positions = positions_at_offsets(original, &original_offsets)?;
    let mut original_positions = original_positions.into_iter();
    type SourcePosition = (usize, usize);
    type MappingSegment = (usize, Option<SourcePosition>);
    let mut lines: Vec<Vec<MappingSegment>> = Vec::new();
    for ((_, mapped), (generated_line, generated_column)) in
        points.into_iter().zip(generated_positions)
    {
        let original_position = if mapped {
            Some(original_positions.next().ok_or(Error::CodegenFailed)?)
        } else {
            None
        };
        lines.resize_with(generated_line + 1, Vec::new);
        lines[generated_line].push((generated_column, original_position));
    }
    if original_positions.next().is_some() {
        return Err(Error::CodegenFailed);
    }
    let mut mappings = String::new();
    let mut previous_original_line = 0_isize;
    let mut previous_original_column = 0_isize;
    for (line_index, segments) in lines.iter().enumerate() {
        if line_index != 0 {
            mappings.push(';');
        }
        let mut previous_generated_column = 0_isize;
        for (segment_index, &(generated_column, original_position)) in segments.iter().enumerate() {
            if segment_index != 0 {
                mappings.push(',');
            }
            mappings.push_str(&vlq(generated_column as isize - previous_generated_column));
            previous_generated_column = generated_column as isize;
            if let Some((original_line, original_column)) = original_position {
                mappings.push_str(&vlq(0));
                mappings.push_str(&vlq(original_line as isize - previous_original_line));
                mappings.push_str(&vlq(original_column as isize - previous_original_column));
                previous_original_line = original_line as isize;
                previous_original_column = original_column as isize;
            }
        }
    }
    Ok(serde_json::json!({
        "version": 3,
        "file": source_url,
        "sources": [source_url],
        "sourcesContent": [original],
        "names": [],
        "mappings": mappings,
        "x_zeroproxy_original_source_mapping_url": original_source_mapping_url,
    }))
}

pub fn inline_source_map(
    original: &str,
    generated: &str,
    prefix_len: usize,
    source_url: &str,
    spans: &[SpanMap],
    original_source_mapping_url: Option<&str>,
) -> Result<String, Error> {
    let map = source_map_value(
        original,
        generated,
        prefix_len,
        source_url,
        spans,
        original_source_mapping_url,
    )?;
    serde_json::to_vec(&map)
        .map(|bytes| BASE64.encode(bytes))
        .map_err(|_| Error::CodegenFailed)
}

pub fn compile_for_abi_with_direct_eval_strictness(
    source: &str,
    kind: SourceKind,
    abi_identifier: &str,
    caller_strict: bool,
) -> Result<RewriteResult, Error> {
    if kind != SourceKind::DirectEvalScript {
        return Err(Error::InvalidSourceKind);
    }
    compile_with_abi(source, kind, abi_identifier, true, caller_strict)
}

pub fn compile_for_abi(
    source: &str,
    kind: SourceKind,
    abi_identifier: &str,
) -> Result<RewriteResult, Error> {
    compile_with_abi(source, kind, abi_identifier, true, false)
}

pub fn compile_dynamic_function_for_abi(
    parameters: &[String],
    body: &str,
    kind: SourceKind,
    abi_identifier: &str,
) -> Result<DynamicFunctionRewriteResult, Error> {
    compile_dynamic_function(parameters, body, kind, abi_identifier, true)
}

pub fn compile_template(source: &str, kind: SourceKind) -> Result<RewriteResult, Error> {
    compile_with_abi(source, kind, ABI_PLACEHOLDER, false, false)
}

struct ParsedProgram {
    program: Program,
    comments: SingleThreadedComments,
    start: u32,
}

fn parse_once(
    source: &str,
    profile: GrammarProfile,
    caller_strict: bool,
) -> Result<ParsedProgram, Error> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        FileName::Custom("target.js".into()).into(),
        source.to_owned(),
    );
    let comments = SingleThreadedComments::default();
    let lexer = Lexer::new(
        Syntax::Es(ECMASCRIPT_SWC_SYNTAX),
        ECMASCRIPT_SWC_TARGET,
        StringInput::from(&*fm),
        Some(&comments),
    );
    let mut parser = Parser::new_from(lexer);
    if profile.strict(caller_strict) {
        parser.set_ctx(parser.ctx() | Context::Strict);
    }
    let program = match profile.goal {
        ParserGoal::Script => parser.parse_script().map(Program::Script),
        ParserGoal::Module => parser.parse_module().map(Program::Module),
        ParserGoal::FunctionBody => unreachable!("function bodies use a fixed host wrapper"),
    }
    .map_err(|_| Error::ParseFailed)?;
    let parser_errors = parser.take_errors();
    let root_strict = profile.strict(caller_strict)
        || match &program {
            Program::Module(_) => true,
            Program::Script(script) => has_use_strict_directive(&script.body),
        };
    if !parser_errors.is_empty()
        && !parser_errors_are_only_sloppy_annex_b(&parser_errors, &program, root_strict)
    {
        return Err(Error::ParseFailed);
    }
    Ok(ParsedProgram {
        program,
        comments,
        start: fm.start_pos.0,
    })
}

fn finish_compilation(
    source: &str,
    kind: SourceKind,
    profile: GrammarProfile,
    abi_identifier: &str,
    check_abi_collision: bool,
    caller_strict: bool,
    mut parsed: ParsedProgram,
    clear_wrapper_parameters_after_resolution: bool,
) -> Result<RewriteResult, Error> {
    let root_strict = profile.strict(caller_strict)
        || match &parsed.program {
            Program::Module(_) => true,
            Program::Script(script) => has_use_strict_directive(&script.body),
        };
    if has_early_errors(&parsed.program, root_strict) {
        return Err(Error::ParseFailed);
    }
    if kind == SourceKind::DirectEvalScript
        && !root_strict
        && direct_eval_var_declared_names(&parsed.program)
            .iter()
            .any(|name| name == "eval" || is_owned_global(name))
    {
        return Err(Error::UnsupportedDirectEvalBinding);
    }
    let (source_url, source_mapping_url) = source_directives(&parsed.comments);
    let globals = Globals::new();
    GLOBALS.set(&globals, || {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        let mut strict_markers = StrictResolverMarkers {
            force_root_strict: kind == SourceKind::DirectEvalScript && caller_strict,
        };
        parsed.program.visit_mut_with(&mut strict_markers);
        parsed
            .program
            .visit_mut_with(&mut resolver(unresolved_mark, top_level_mark, false));
        parsed
            .program
            .visit_mut_with(&mut RemoveStrictResolverMarkers);
        if clear_wrapper_parameters_after_resolution {
            wrapper_function_mut(&mut parsed.program)
                .ok_or(Error::TransformFailed)?
                .params
                .clear();
        }
        let mut abi_identifier_collector = AbiIdentifierCollector::default();
        parsed.program.visit_with(&mut abi_identifier_collector);
        if check_abi_collision {
            let mut collision = Collision {
                found: false,
                name: abi_identifier,
            };
            parsed.program.visit_with(&mut collision);
            if collision.found {
                return Err(Error::AbiIdentifierCollision);
            }
        }
        let mut safe_eval_bindings = SafeEvalBindingCollector::default();
        parsed.program.visit_with(&mut safe_eval_bindings);
        let unresolved = SyntaxContext::empty().apply_mark(unresolved_mark);
        let mut planner = Planner {
            unresolved,
            start: parsed.start,
            abi_identifier,
            edits: Vec::new(),
            module_specifiers: Vec::new(),
            unsafe_with: false,
            unsupported_eval: false,
            unsupported_eval_binding: false,
            safe_eval_bindings: safe_eval_bindings.contexts,
            inside_with: 0,
            preserve_literal_import_scripts: kind == SourceKind::TargetServiceWorkerClassic,
            direct_import_scripts_reference: false,
            unsupported_import_scripts: false,
            preserve_literal_dynamic_import: profile.goal == ParserGoal::Module,
            strict_stack: vec![root_strict],
        };
        parsed.program.visit_with(&mut planner);
        if planner.unsafe_with {
            return Err(Error::UnsupportedDynamicScope);
        }
        if planner.unsupported_eval {
            return Err(Error::UnsupportedDirectEvalShape);
        }
        if planner.unsupported_eval_binding {
            return Err(Error::UnsupportedDirectEvalBinding);
        }
        if planner.unsupported_import_scripts {
            return Err(Error::UnsupportedImportScriptsShape);
        }
        planner.edits.sort_by_key(|edit| edit.start);
        for pair in planner.edits.windows(2) {
            if pair[0].end > pair[1].start {
                return Err(Error::TransformFailed);
            }
        }
        let module_specifiers = planner
            .module_specifiers
            .iter()
            .map(|specifier| {
                Ok(ModuleSpecifier {
                    original_start: specifier.original_start,
                    original_end: specifier.original_end,
                    generated_start: generated_offset(specifier.original_start, &planner.edits)?,
                    generated_end: generated_offset(specifier.original_end, &planner.edits)?,
                    specifier: specifier.specifier.clone(),
                    module_type: specifier.module_type.clone(),
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut code = source.to_owned();
        for edit in planner.edits.iter().rev() {
            code.replace_range(edit.start..edit.end, &edit.replacement);
        }
        let edit_map = build_edit_map(&planner.edits);
        let source_map = source_map_value(
            source,
            &code,
            0,
            source_url
                .as_deref()
                .unwrap_or("zeroproxy://compiler/source"),
            &edit_map,
            source_mapping_url.as_deref(),
        )?;
        let abi_slots = edit_map
            .iter()
            .zip(&planner.edits)
            .filter_map(|(span, edit)| {
                if edit.abi_offset == NO_ABI_OFFSET {
                    None
                } else {
                    let start = span.generated_start + edit.abi_offset;
                    Some(GeneratedSpan {
                        start,
                        end: start + abi_identifier.len(),
                    })
                }
            })
            .collect();
        Ok(RewriteResult {
            code,
            edits: planner.edits,
            edit_map,
            source_map,
            module_specifiers,
            source_url,
            source_mapping_url,
            abi_identifiers: abi_identifier_collector.identifiers.into_iter().collect(),
            abi_slots,
        })
    })
}

fn compile_with_abi(
    source: &str,
    kind: SourceKind,
    abi_identifier: &str,
    check_abi_collision: bool,
    caller_strict: bool,
) -> Result<RewriteResult, Error> {
    validate_abi_identifier(abi_identifier)?;
    if source.len() > MAX_COMPILER_SOURCE_BYTES {
        return Err(Error::ResourceTooLarge);
    }
    let profile = kind.grammar_profile();
    if profile.goal == ParserGoal::FunctionBody {
        return compile_function_body(source, profile, abi_identifier, check_abi_collision);
    }
    let parsed = parse_once(source, profile, caller_strict)?;
    finish_compilation(
        source,
        kind,
        profile,
        abi_identifier,
        check_abi_collision,
        caller_strict,
        parsed,
        false,
    )
}

fn range_contains_edit(start: usize, end: usize, edit: &Edit) -> bool {
    edit.start >= start
        && edit.end <= end
        && (edit.start < end || (start == end && edit.start == start))
}

fn project_rewrite_segment(
    wrapper: &str,
    start: usize,
    end: usize,
    result: &RewriteResult,
) -> Result<RewriteResult, Error> {
    let mut edits = result
        .edits
        .iter()
        .filter(|edit| range_contains_edit(start, end, edit))
        .map(|edit| Edit {
            kind: edit.kind,
            start: edit.start - start,
            end: edit.end - start,
            replacement: edit.replacement.clone(),
            abi_offset: edit.abi_offset,
        })
        .collect::<Vec<_>>();
    edits.sort_by_key(|edit| edit.start);
    let original = wrapper.get(start..end).ok_or(Error::TransformFailed)?;
    let mut code = original.to_owned();
    for edit in edits.iter().rev() {
        code.replace_range(edit.start..edit.end, &edit.replacement);
    }
    let edit_map = build_edit_map(&edits);
    let source_map = source_map_value(
        original,
        &code,
        0,
        result
            .source_url
            .as_deref()
            .unwrap_or("zeroproxy://compiler/source"),
        &edit_map,
        result.source_mapping_url.as_deref(),
    )?;
    let abi_slots = edit_map
        .iter()
        .zip(&edits)
        .filter_map(|(span, edit)| {
            if edit.abi_offset == NO_ABI_OFFSET {
                None
            } else {
                let start = span.generated_start + edit.abi_offset;
                Some(GeneratedSpan {
                    start,
                    end: start
                        + edit.replacement[edit.abi_offset..]
                            .find(|character: char| {
                                !character.is_ascii_alphanumeric() && character != '_'
                            })
                            .unwrap_or(edit.replacement.len() - edit.abi_offset),
                })
            }
        })
        .collect();
    let module_specifiers = result
        .module_specifiers
        .iter()
        .filter(|specifier| specifier.original_start >= start && specifier.original_end <= end)
        .map(|specifier| {
            let original_start = specifier.original_start - start;
            let original_end = specifier.original_end - start;
            Ok(ModuleSpecifier {
                original_start,
                original_end,
                generated_start: generated_offset(original_start, &edits)?,
                generated_end: generated_offset(original_end, &edits)?,
                specifier: specifier.specifier.clone(),
                module_type: specifier.module_type.clone(),
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(RewriteResult {
        code,
        edits,
        edit_map,
        source_map,
        module_specifiers,
        source_url: result.source_url.clone(),
        source_mapping_url: result.source_mapping_url.clone(),
        abi_identifiers: result.abi_identifiers.clone(),
        abi_slots,
    })
}

fn wrapper_function_from_expression(expression: &mut Expr) -> Option<&mut Function> {
    match expression {
        Expr::Fn(function) => Some(&mut function.function),
        Expr::Paren(parenthesized) => wrapper_function_from_expression(&mut parenthesized.expr),
        _ => None,
    }
}

fn wrapper_function_mut(program: &mut Program) -> Option<&mut Function> {
    let Program::Script(script) = program else {
        return None;
    };
    let Stmt::Expr(statement) = script.body.first_mut()? else {
        return None;
    };
    wrapper_function_from_expression(&mut statement.expr)
}

fn dynamic_function_prefix(host: FunctionHost) -> Result<&'static str, Error> {
    match host {
        FunctionHost::Ordinary => Ok("(function("),
        FunctionHost::Async => Ok("(async function("),
        FunctionHost::Generator => Ok("(function*("),
        FunctionHost::AsyncGenerator => Ok("(async function*("),
        FunctionHost::EventHandler | FunctionHost::None => Err(Error::InvalidSourceKind),
    }
}

fn compile_dynamic_function(
    parameters: &[String],
    body: &str,
    kind: SourceKind,
    abi_identifier: &str,
    check_abi_collision: bool,
) -> Result<DynamicFunctionRewriteResult, Error> {
    validate_abi_identifier(abi_identifier)?;
    if body.len() > MAX_COMPILER_SOURCE_BYTES {
        return Err(Error::ResourceTooLarge);
    }
    let prefix = dynamic_function_prefix(kind.grammar_profile().function_host)?;
    let before_body = "\n){\n";
    let suffix = "\n})";
    let parameter_bytes = parameters
        .iter()
        .try_fold(body.len(), |size, parameter| {
            size.checked_add(parameter.len())
                .and_then(|value| value.checked_add(1))
        })
        .filter(|&size| size <= MAX_COMPILER_SOURCE_BYTES)
        .ok_or(Error::ResourceTooLarge)?;
    let parameter_capacity = prefix
        .len()
        .checked_add(parameter_bytes - body.len())
        .and_then(|value| value.checked_add(before_body.len()))
        .and_then(|value| value.checked_add(suffix.len()))
        .ok_or(Error::ResourceTooLarge)?;
    let mut parameter_wrapper = String::with_capacity(parameter_capacity);
    parameter_wrapper.push_str(prefix);
    let mut parameter_ranges = Vec::with_capacity(parameters.len());
    for (index, parameter) in parameters.iter().enumerate() {
        if index != 0 {
            parameter_wrapper.push(',');
        }
        let start = parameter_wrapper.len();
        parameter_wrapper.push_str(parameter);
        parameter_ranges.push((start, parameter_wrapper.len()));
    }
    parameter_wrapper.push_str(before_body);
    parameter_wrapper.push_str(suffix);

    let wrapper_profile = SourceKind::ClassicScriptInline.grammar_profile();
    let mut parsed_parameters = parse_once(&parameter_wrapper, wrapper_profile, false)?;
    let parameter_bindings = wrapper_function_mut(&mut parsed_parameters.program)
        .ok_or(Error::TransformFailed)?
        .params
        .clone();
    let parameter_result = finish_compilation(
        &parameter_wrapper,
        kind,
        wrapper_profile,
        abi_identifier,
        check_abi_collision,
        false,
        parsed_parameters,
        false,
    )?;
    if parameter_result.edits.iter().any(|edit| {
        !parameter_ranges
            .iter()
            .any(|&(start, end)| range_contains_edit(start, end, edit))
    }) {
        return Err(Error::TransformFailed);
    }
    let parameters = parameter_ranges
        .into_iter()
        .map(|(start, end)| {
            project_rewrite_segment(&parameter_wrapper, start, end, &parameter_result)
        })
        .collect::<Result<Vec<_>, Error>>()?;

    let body_capacity = prefix
        .len()
        .checked_add(before_body.len())
        .and_then(|value| value.checked_add(body.len()))
        .and_then(|value| value.checked_add(suffix.len()))
        .ok_or(Error::ResourceTooLarge)?;
    let mut body_wrapper = String::with_capacity(body_capacity);
    body_wrapper.push_str(prefix);
    body_wrapper.push_str(before_body);
    let body_start = body_wrapper.len();
    body_wrapper.push_str(body);
    let body_end = body_wrapper.len();
    body_wrapper.push_str(suffix);
    let mut parsed_body = parse_once(&body_wrapper, wrapper_profile, false)?;
    wrapper_function_mut(&mut parsed_body.program)
        .ok_or(Error::TransformFailed)?
        .params = parameter_bindings;
    let body_result = finish_compilation(
        &body_wrapper,
        kind,
        wrapper_profile,
        abi_identifier,
        check_abi_collision,
        false,
        parsed_body,
        true,
    )?;
    if body_result
        .edits
        .iter()
        .any(|edit| !range_contains_edit(body_start, body_end, edit))
    {
        return Err(Error::TransformFailed);
    }
    let body = project_rewrite_segment(&body_wrapper, body_start, body_end, &body_result)?;
    Ok(DynamicFunctionRewriteResult { parameters, body })
}

fn compile_function_body(
    source: &str,
    profile: GrammarProfile,
    abi_identifier: &str,
    check_abi_collision: bool,
) -> Result<RewriteResult, Error> {
    let prefix = match profile.function_host {
        FunctionHost::Ordinary => "(function(){\n",
        FunctionHost::Async => "(async function(){\n",
        FunctionHost::Generator => "(function*(){\n",
        FunctionHost::AsyncGenerator => "(async function*(){\n",
        FunctionHost::EventHandler => "(function(event){\n",
        FunctionHost::None => return Err(Error::InvalidSourceKind),
    };
    let suffix = "\n})";
    let body_start = prefix.len();
    let body_end = body_start
        .checked_add(source.len())
        .ok_or(Error::TransformFailed)?;
    let mut wrapper = String::with_capacity(
        body_end
            .checked_add(suffix.len())
            .ok_or(Error::TransformFailed)?,
    );
    wrapper.push_str(prefix);
    wrapper.push_str(source);
    wrapper.push_str(suffix);
    let result = compile_with_abi(
        &wrapper,
        SourceKind::ClassicScriptInline,
        abi_identifier,
        check_abi_collision,
        false,
    )?;
    if result
        .edits
        .iter()
        .any(|edit| !range_contains_edit(body_start, body_end, edit))
    {
        return Err(Error::TransformFailed);
    }
    project_rewrite_segment(&wrapper, body_start, body_end, &result)
}

pub fn compiler_versions_result_json() -> Result<String, Error> {
    let browser_versions = ECMASCRIPT_BROWSER_TUPLES
        .iter()
        .map(|tuple| format!("{}:{}:{}", tuple.family, tuple.exact_build, tuple.platform))
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({
        "abi_version": COMPILER_ABI_VERSION,
        "browser_versions": browser_versions,
        "cache_schema_version": COMPILER_CACHE_SCHEMA_VERSION,
        "compiler_version": env!("CARGO_PKG_VERSION"),
        "parser_version": ECMASCRIPT_GRAMMAR_VERSION,
        "result_schema_version": COMPILER_RESULT_SCHEMA_VERSION,
    }))
    .map_err(|_| Error::CodegenFailed)
}

pub fn compiler_cache_key(source: &str, context_json: &str) -> Result<String, Error> {
    if context_json.len() > MAX_COMPILER_CACHE_CONTEXT_BYTES {
        return Err(Error::ResourceTooLarge);
    }
    let context: serde_json::Value =
        serde_json::from_str(context_json).map_err(|_| Error::PolicyBlocked)?;
    if !context.is_object() {
        return Err(Error::PolicyBlocked);
    }
    let mut digest = Sha256::new();
    digest.update(b"zeroproxy-compiler-cache-v1\0");
    digest.update((source.len() as u64).to_be_bytes());
    digest.update(source.as_bytes());
    digest.update((context_json.len() as u64).to_be_bytes());
    digest.update(context_json.as_bytes());
    let digest = digest.finalize();
    let mut key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(key, "{byte:02x}").map_err(|_| Error::CodegenFailed)?;
    }
    Ok(key)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = compiler_versions_json)]
pub fn compiler_versions_json_wasm() -> Result<String, wasm_bindgen::JsValue> {
    compiler_versions_result_json().map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name = compiler_cache_key)]
pub fn compiler_cache_key_wasm(
    source: &str,
    context_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    compiler_cache_key(source, context_json)
        .map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn compile_json(
    source: &str,
    source_kind: &str,
    abi_identifier: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    compile_result_json(source, source_kind, abi_identifier)
        .map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn compile_dynamic_function_json(
    parameters_json: &str,
    body: &str,
    source_kind: &str,
    abi_identifier: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    compile_dynamic_function_result_json(parameters_json, body, source_kind, abi_identifier)
        .map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn compile_json_with_direct_eval_strictness(
    source: &str,
    source_kind: &str,
    abi_identifier: &str,
    caller_strict: bool,
) -> Result<String, wasm_bindgen::JsValue> {
    compile_result_json_with_direct_eval_strictness(
        source,
        source_kind,
        abi_identifier,
        caller_strict,
    )
    .map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn compile_template_json(
    source: &str,
    source_kind: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    compile_template_result_json(source, source_kind)
        .map_err(|error| wasm_bindgen::JsValue::from_str(error.code()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn source_map_base64(
    original: &str,
    generated: &str,
    prefix_len: usize,
    source_url: &str,
    spans_json: &str,
    original_source_mapping_url: Option<String>,
) -> Result<String, wasm_bindgen::JsValue> {
    let spans: Vec<SpanMap> = serde_json::from_str(spans_json)
        .map_err(|_| wasm_bindgen::JsValue::from_str("INVALID_SOURCE_MAP_SPANS"))?;
    inline_source_map(
        original,
        generated,
        prefix_len,
        source_url,
        &spans,
        original_source_mapping_url.as_deref(),
    )
    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn policy_decide_json(
    context: &str,
    descriptor: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    policy_core::decide_json(context, descriptor)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn policy_csp_allows_connect_json(
    context: &str,
    target: &str,
) -> Result<bool, wasm_bindgen::JsValue> {
    policy_core::csp_allows_connect_json(context, target)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn policy_canonicalize_json(
    raw: &str,
    base: Option<String>,
) -> Result<String, wasm_bindgen::JsValue> {
    policy_core::canonicalize_json(raw, base)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn policy_attribute_kind_json(
    namespace: &str,
    element: &str,
    attribute: &str,
    link_rel: Option<String>,
    http_equiv: Option<String>,
    type_essence: Option<String>,
) -> Result<String, wasm_bindgen::JsValue> {
    serde_json::to_string(
        &policy_core::html_attribute_inventory(
            namespace,
            element,
            attribute,
            link_rel.as_deref(),
            http_equiv.as_deref(),
            type_essence.as_deref(),
        )
        .and_then(|entry| entry.resource_kind),
    )
    .map_err(|_| wasm_bindgen::JsValue::from_str("attribute policy failure"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_owned_global_registry_is_closed_and_versioned() {
        assert_eq!(OWNED_GLOBAL_REGISTRY_VERSION, 1);
        for name in ["window", "fetch", "Function", "setTimeout", "postMessage"] {
            assert!(is_owned_global(name), "{name} must be owned");
        }
        for name in ["Math", "Array", "console", "navigator"] {
            assert!(!is_owned_global(name), "{name} must remain native");
        }
        assert!(OWNED_GLOBALS.is_sorted());
    }

    fn decode_vlq(segment: &str) -> Vec<isize> {
        let mut values = Vec::new();
        let mut value = 0_usize;
        let mut shift = 0;
        for byte in segment.bytes() {
            let digit = match byte {
                b'A'..=b'Z' => (byte - b'A') as usize,
                b'a'..=b'z' => (byte - b'a' + 26) as usize,
                b'0'..=b'9' => (byte - b'0' + 52) as usize,
                b'+' => 62,
                b'/' => 63,
                _ => panic!("invalid VLQ digit"),
            };
            value |= (digit & 31) << shift;
            if digit & 32 == 0 {
                let negative = value & 1 == 1;
                let magnitude = (value >> 1) as isize;
                values.push(if negative { -magnitude } else { magnitude });
                value = 0;
                shift = 0;
            } else {
                shift += 5;
            }
        }
        assert_eq!(shift, 0, "unterminated VLQ");
        values
    }

    fn source_map_lookup(
        mappings: &str,
        target_line: usize,
        target_column: usize,
    ) -> Option<(usize, usize)> {
        let mut previous_original_line = 0_isize;
        let mut previous_original_column = 0_isize;
        for (line, encoded_line) in mappings.split(';').enumerate() {
            let mut generated_column = 0_isize;
            let mut found = None;
            for encoded_segment in encoded_line
                .split(',')
                .filter(|segment| !segment.is_empty())
            {
                let values = decode_vlq(encoded_segment);
                generated_column += values[0];
                let position = if values.len() == 1 {
                    None
                } else {
                    assert_eq!(values.len(), 4);
                    previous_original_line += values[2];
                    previous_original_column += values[3];
                    Some((
                        previous_original_line as usize,
                        previous_original_column as usize,
                    ))
                };
                if line == target_line && generated_column as usize <= target_column {
                    found = position;
                }
            }
            if line == target_line {
                return found;
            }
        }
        None
    }

    #[test]
    fn module_graph_boundaries_preserve_literal_imports_and_mediate_computed_imports() {
        let source = "import value from './dependency.js'; export { value } from './export.js'; const name='./computed.js'; import('./dynamic.js',{with:{type:'json'}}); import(name); import.meta.url";
        let result = compile(source, SourceKind::ModuleWorker).unwrap();
        assert_eq!(
            result
                .module_specifiers
                .iter()
                .map(|specifier| specifier.specifier.as_str())
                .collect::<Vec<_>>(),
            vec!["./dependency.js", "./export.js", "./dynamic.js"]
        );
        assert_eq!(
            result
                .module_specifiers
                .iter()
                .map(|specifier| specifier.module_type.as_str())
                .collect::<Vec<_>>(),
            vec!["javascript", "javascript", "json"]
        );
        for specifier in &result.module_specifiers {
            assert_eq!(
                &result.code[specifier.generated_start..specifier.generated_end],
                &source[specifier.original_start..specifier.original_end],
            );
        }
        assert!(
            result
                .code
                .contains("import('./dynamic.js',{with:{type:'json'}})")
        );
        assert!(
            result
                .code
                .contains(&format!("{ABI_PLACEHOLDER}.importModule(name)"))
        );
        assert!(
            result
                .code
                .contains(&format!("{ABI_PLACEHOLDER}.importMeta.url"))
        );
        let shifted = compile("self; import './shifted.js'", SourceKind::ModuleWorker).unwrap();
        let shifted_specifier = shifted.module_specifiers.first().unwrap();
        let generated_literal_start = shifted.code.find("'./shifted.js'").unwrap();
        assert_eq!(shifted_specifier.generated_start, generated_literal_start);
        let deferred = compile(
            "import('./deferred.js',{with:attributes})",
            SourceKind::ModuleWorker,
        )
        .unwrap();
        assert!(deferred.module_specifiers.is_empty());
        assert!(deferred.code.contains(&format!(
            "{ABI_PLACEHOLDER}.importModule('./deferred.js',{{with:attributes}})"
        )));
    }
    #[test]
    fn target_worker_source_kinds_select_their_required_grammar() {
        for kind in [SourceKind::ClassicWorker, SourceKind::SharedClassicWorker] {
            let result = compile("self; importScripts('./ordered.js')", kind).unwrap();
            assert!(
                result
                    .code
                    .contains(&format!("{ABI_PLACEHOLDER}.scope.self"))
            );
            assert!(
                result
                    .code
                    .contains(&format!("{ABI_PLACEHOLDER}.scope.importScripts"))
            );
            assert_eq!(
                compile("export const value = 1", kind),
                Err(Error::ParseFailed)
            );
        }
        for kind in [
            SourceKind::ModuleWorker,
            SourceKind::SharedModuleWorker,
            SourceKind::WorkletModule,
        ] {
            assert!(compile("export const value = 1", kind).is_ok());
        }
    }
    #[test]
    fn target_service_worker_classic_reports_literal_import_scripts() {
        let imported = compile(
            "importScripts('./first.js', './second.js'); self.importScripts('./third.js')",
            SourceKind::TargetServiceWorkerClassic,
        )
        .unwrap();
        assert_eq!(
            imported
                .module_specifiers
                .iter()
                .map(|specifier| specifier.specifier.as_str())
                .collect::<Vec<_>>(),
            vec!["./first.js", "./second.js", "./third.js"],
        );
        assert_eq!(
            compile(
                "const load = importScripts; load('./dynamic.js')",
                SourceKind::TargetServiceWorkerClassic,
            ),
            Err(Error::UnsupportedImportScriptsShape),
        );
    }
    #[test]
    fn every_source_kind_has_one_explicit_parser_goal() {
        assert_eq!(ECMASCRIPT_GRAMMAR_VERSION, "ECMA-262-2026");
        assert_eq!(
            ECMASCRIPT_BROWSER_TUPLES,
            &[
                BrowserGrammarTuple {
                    family: "chromium",
                    exact_build: "150.0.7871.124",
                    platform: "darwin-arm64",
                },
                BrowserGrammarTuple {
                    family: "firefox",
                    exact_build: "152.0.6",
                    platform: "darwin-arm64",
                },
            ]
        );
        for kind in [
            SourceKind::ClassicScriptExternal,
            SourceKind::ClassicScriptInline,
            SourceKind::DirectEvalScript,
            SourceKind::IndirectEvalScript,
            SourceKind::TimerString,
            SourceKind::JavaScriptURL,
            SourceKind::ClassicWorker,
            SourceKind::SharedClassicWorker,
            SourceKind::TargetServiceWorkerClassic,
        ] {
            assert_eq!(kind.parser_goal(), ParserGoal::Script);
            assert_eq!(
                kind.grammar_profile().strictness_source,
                if kind == SourceKind::DirectEvalScript {
                    StrictnessSource::DirectEvalCaller
                } else {
                    StrictnessSource::SourceDirective
                }
            );
        }
        for kind in [
            SourceKind::ModuleScript,
            SourceKind::ModuleWorker,
            SourceKind::SharedModuleWorker,
            SourceKind::TargetServiceWorkerModule,
            SourceKind::WorkletModule,
        ] {
            assert_eq!(kind.parser_goal(), ParserGoal::Module);
            assert_eq!(
                kind.grammar_profile().strictness_source,
                StrictnessSource::Module
            );
            assert_eq!(kind.grammar_profile().function_host, FunctionHost::None);
        }
        for (kind, host) in [
            (SourceKind::FunctionBody, FunctionHost::Ordinary),
            (SourceKind::AsyncFunctionBody, FunctionHost::Async),
            (SourceKind::GeneratorFunctionBody, FunctionHost::Generator),
            (
                SourceKind::AsyncGeneratorFunctionBody,
                FunctionHost::AsyncGenerator,
            ),
            (SourceKind::EventHandler, FunctionHost::EventHandler),
        ] {
            assert_eq!(kind.parser_goal(), ParserGoal::FunctionBody);
            assert_eq!(
                kind.grammar_profile().strictness_source,
                StrictnessSource::SourceDirective
            );
            assert_eq!(kind.grammar_profile().function_host, host);
        }
    }
    #[test]
    fn grammar_profiles_apply_only_required_host_strictness() {
        assert!(SourceKind::ModuleScript.grammar_profile().strict(false));
        assert!(SourceKind::ModuleWorker.grammar_profile().strict(false));
        assert!(
            SourceKind::TargetServiceWorkerModule
                .grammar_profile()
                .strict(false)
        );
        assert!(
            !SourceKind::ClassicScriptExternal
                .grammar_profile()
                .strict(false)
        );
        assert!(!SourceKind::DirectEvalScript.grammar_profile().strict(false));
        assert!(SourceKind::DirectEvalScript.grammar_profile().strict(true));
    }
    #[test]
    fn direct_eval_honors_caller_strictness_without_goal_retry() {
        let abi = "__zp_abi_222222222222222222222222222222222222222222222222";
        assert_eq!(
            compile_for_abi_with_direct_eval_strictness(
                "with (scope) {}",
                SourceKind::DirectEvalScript,
                abi,
                true,
            ),
            Err(Error::ParseFailed)
        );
        assert!(
            compile_for_abi_with_direct_eval_strictness(
                "with (scope) {}",
                SourceKind::DirectEvalScript,
                abi,
                false,
            )
            .is_ok()
        );
    }
    #[test]
    fn strict_eval_and_late_strict_directives_disable_annex_b_function_hoisting() {
        let abi = "__zp_abi_222222222222222222222222222222222222222222222222";
        let source = "{ function window() {} } window";
        let strict = compile_for_abi_with_direct_eval_strictness(
            source,
            SourceKind::DirectEvalScript,
            abi,
            true,
        )
        .unwrap();
        assert!(strict.code.ends_with(&format!("}} {abi}.scope.window")));

        assert_eq!(
            compile_for_abi_with_direct_eval_strictness(
                source,
                SourceKind::DirectEvalScript,
                abi,
                false,
            ),
            Err(Error::UnsupportedDirectEvalBinding)
        );

        let source_strict = "\"use asm\"; \"use strict\"; { function window() {} } window";
        let source_result =
            compile_for_abi(source_strict, SourceKind::ClassicScriptInline, abi).unwrap();
        assert!(
            source_result
                .code
                .ends_with(&format!("}} {abi}.scope.window"))
        );
    }
    #[test]
    fn browser_annex_b_if_functions_are_host_and_strictness_scoped() {
        let abi = "__zp_abi_666666666666666666666666666666666666666666666666";
        let source = "if (true) function window() {} window";
        let sloppy = compile_for_abi(source, SourceKind::ClassicScriptInline, abi).unwrap();
        assert!(sloppy.code.ends_with("} window"));
        assert!(!sloppy.code.contains(&format!("{abi}.scope.window")));
        assert_eq!(
            compile_for_abi(
                "\"use strict\"; if (true) function window() {} window",
                SourceKind::ClassicScriptInline,
                abi,
            ),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile_for_abi(source, SourceKind::ModuleScript, abi),
            Err(Error::ParseFailed)
        );
        assert!(compile_for_abi(source, SourceKind::FunctionBody, abi).is_ok());
        assert_eq!(
            compile_for_abi(
                "\"use strict\"; if (true) function window() {} window",
                SourceKind::FunctionBody,
                abi,
            ),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile_for_abi(
                "while (false) function window() {}",
                SourceKind::ClassicScriptInline,
                abi,
            ),
            Err(Error::ParseFailed)
        );
    }
    #[test]
    fn direct_eval_strictness_metadata_is_rejected_for_other_source_kinds() {
        assert_eq!(
            compile_for_abi_with_direct_eval_strictness(
                "self",
                SourceKind::ClassicScriptInline,
                ABI_PLACEHOLDER,
                true,
            ),
            Err(Error::InvalidSourceKind)
        );
    }
    #[test]
    fn parser_goals_accept_only_their_host_grammar() {
        assert!(
            compile(
                "export const value = await Promise.resolve(1)",
                SourceKind::ModuleScript
            )
            .is_ok()
        );
        assert_eq!(
            compile("export const value = 1", SourceKind::ClassicScriptExternal),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("import value from './value.js'", SourceKind::FunctionBody),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("export const value = 1", SourceKind::EventHandler),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("await 0;", SourceKind::ClassicScriptInline),
            Err(Error::ParseFailed)
        );
        assert!(compile("await 0;", SourceKind::AsyncFunctionBody).is_ok());
        assert_eq!(
            compile("await 0;", SourceKind::FunctionBody),
            Err(Error::ParseFailed)
        );
        assert!(compile("yield 0;", SourceKind::GeneratorFunctionBody).is_ok());
        assert_eq!(
            compile("yield 0;", SourceKind::FunctionBody),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("yield 0;", SourceKind::AsyncFunctionBody),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("await 0;", SourceKind::GeneratorFunctionBody),
            Err(Error::ParseFailed)
        );
        assert!(compile("await 0; yield 1;", SourceKind::AsyncGeneratorFunctionBody).is_ok());
        assert!(compile("return event;", SourceKind::EventHandler).is_ok());
    }
    #[test]
    fn hashbang_and_strictness_follow_the_selected_host_goal() {
        assert!(
            compile(
                "#!/usr/bin/env node\nself",
                SourceKind::ClassicScriptExternal
            )
            .is_ok()
        );
        assert!(
            compile(
                "#!/usr/bin/env node\nexport const value = 1",
                SourceKind::ModuleScript
            )
            .is_ok()
        );
        assert_eq!(
            compile("#!/usr/bin/env node\nself", SourceKind::FunctionBody),
            Err(Error::ParseFailed)
        );
        assert!(compile("with (scope) {}", SourceKind::ClassicScriptInline).is_ok());
        assert_eq!(
            compile(
                "\"use strict\"; with (scope) {}",
                SourceKind::ClassicScriptInline
            ),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile("\"use strict\"; with (scope) {}", SourceKind::FunctionBody),
            Err(Error::ParseFailed)
        );
    }
    #[test]
    fn reviewed_tuple_profile_drives_closed_swc_feature_flags() {
        assert_eq!(ECMASCRIPT_SWC_TARGET, EsVersion::EsNext);
        assert!(!ECMASCRIPT_SWC_SYNTAX.jsx);
        assert!(!ECMASCRIPT_SWC_SYNTAX.fn_bind);
        assert!(!ECMASCRIPT_SWC_SYNTAX.decorators);
        assert!(!ECMASCRIPT_SWC_SYNTAX.decorators_before_export);
        assert!(!ECMASCRIPT_SWC_SYNTAX.export_default_from);
        assert!(ECMASCRIPT_SWC_SYNTAX.import_attributes);
        assert!(!ECMASCRIPT_SWC_SYNTAX.allow_super_outside_method);
        assert!(!ECMASCRIPT_SWC_SYNTAX.allow_return_outside_function);
        assert!(!ECMASCRIPT_SWC_SYNTAX.auto_accessors);
        assert!(!ECMASCRIPT_SWC_SYNTAX.explicit_resource_management);
        for source in [
            "const view = <div/>",
            "@sealed class Value {}",
            "const bound = value::method",
            "class Value { accessor field }",
            "using resource = acquire()",
        ] {
            assert_eq!(
                compile(source, SourceKind::ClassicScriptInline),
                Err(Error::ParseFailed),
                "{source}"
            );
        }
        assert!(
            compile(
                "import value from './value.json' with { type: 'json' }",
                SourceKind::ModuleScript
            )
            .is_ok()
        );
    }

    #[test]
    fn bom_and_legacy_html_comments_follow_exact_host_grammar() {
        for kind in [
            SourceKind::ClassicScriptExternal,
            SourceKind::ClassicScriptInline,
            SourceKind::DirectEvalScript,
            SourceKind::IndirectEvalScript,
            SourceKind::TimerString,
            SourceKind::FunctionBody,
            SourceKind::AsyncFunctionBody,
            SourceKind::GeneratorFunctionBody,
            SourceKind::AsyncGeneratorFunctionBody,
            SourceKind::EventHandler,
            SourceKind::JavaScriptURL,
            SourceKind::ClassicWorker,
            SourceKind::SharedClassicWorker,
            SourceKind::TargetServiceWorkerClassic,
        ] {
            assert!(
                compile("<!-- legacy open\nself\n--> legacy close", kind).is_ok(),
                "{kind:?}"
            );
            assert!(compile("\u{feff}self", kind).is_ok(), "{kind:?}");
        }
        for kind in [
            SourceKind::ModuleScript,
            SourceKind::ModuleWorker,
            SourceKind::SharedModuleWorker,
            SourceKind::TargetServiceWorkerModule,
            SourceKind::WorkletModule,
        ] {
            assert_eq!(
                compile("<!-- not a module comment\nexport const value = 1", kind),
                Err(Error::ParseFailed),
                "{kind:?}"
            );
            assert!(
                compile("\u{feff}export const value = 1", kind).is_ok(),
                "{kind:?}"
            );
        }
    }
    #[test]
    fn function_body_wrapper_preserves_source_offsets_and_abi_slots() {
        let abi = "__zp_abi_222222222222222222222222222222222222222222222222";
        let source = "if (ready) { self; }\n";
        let result = compile_for_abi(source, SourceKind::FunctionBody, abi).unwrap();
        assert!(result.code.starts_with("if (ready) { "));
        assert!(result.code.ends_with(" }\n"));
        assert_eq!(result.edits.len(), result.edit_map.len());
        assert_eq!(result.abi_slots.len(), result.edits.len());
        for (edit, map) in result.edits.iter().zip(&result.edit_map) {
            assert_eq!(&source[edit.start..edit.end], "self");
            assert_eq!(&source[map.original_start..map.original_end], "self");
        }
        for slot in &result.abi_slots {
            assert_eq!(&result.code[slot.start..slot.end], abi);
        }
    }
    #[test]
    fn dynamic_function_formals_bind_body_and_preserve_each_argument() {
        let abi = "__zp_abi_333333333333333333333333333333333333333333333333";
        let parameters = vec!["fetch".to_owned(), "value = self".to_owned()];
        let result = compile_dynamic_function_for_abi(
            &parameters,
            "return [fetch, value, window]",
            SourceKind::FunctionBody,
            abi,
        )
        .unwrap();
        assert_eq!(result.parameters[0].code, "fetch");
        assert_eq!(
            result.parameters[1].code,
            format!("value = {abi}.scope.self")
        );
        assert_eq!(
            result.body.code,
            format!("return [fetch, value, {abi}.scope.window]")
        );
        assert!(result.body.code.contains("fetch"));
        assert!(!result.body.code.contains(".scope.fetch"));
        for segment in result
            .parameters
            .iter()
            .chain(std::iter::once(&result.body))
        {
            for slot in &segment.abi_slots {
                assert_eq!(&segment.code[slot.start..slot.end], abi);
            }
        }
    }

    #[test]
    fn dynamic_function_enforces_cross_part_early_errors_and_body_line_endings() {
        let abi = "__zp_abi_444444444444444444444444444444444444444444444444";
        assert!(
            compile_dynamic_function_for_abi(
                &["name".to_owned(), "name".to_owned()],
                "return name // trailing comment",
                SourceKind::FunctionBody,
                abi,
            )
            .is_ok()
        );
        let commented_parameter = compile_dynamic_function_for_abi(
            &["name // trailing parameter comment".to_owned()],
            "return name",
            SourceKind::FunctionBody,
            abi,
        )
        .unwrap();
        assert_eq!(
            commented_parameter.parameters[0].code,
            "name // trailing parameter comment"
        );
        assert_eq!(
            compile_dynamic_function_for_abi(
                &["name".to_owned(), "name".to_owned()],
                "\"use strict\"; return name",
                SourceKind::FunctionBody,
                abi,
            ),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile_dynamic_function_for_abi(
                &["name = 1".to_owned()],
                "\"use strict\"; return name",
                SourceKind::FunctionBody,
                abi,
            ),
            Err(Error::ParseFailed)
        );
        assert_eq!(
            compile_dynamic_function_for_abi(&[], "return 1", SourceKind::EventHandler, abi,),
            Err(Error::InvalidSourceKind)
        );
        assert_eq!(
            compile("return 1 // trailing comment", SourceKind::FunctionBody)
                .unwrap()
                .code,
            "return 1 // trailing comment"
        );
    }

    #[test]
    fn dynamic_function_utf8_offsets_are_relative_to_author_inputs() {
        let abi = "__zp_abi_555555555555555555555555555555555555555555555555";
        let parameters = vec!["café = self".to_owned()];
        let result = compile_dynamic_function_for_abi(
            &parameters,
            "return café + window",
            SourceKind::FunctionBody,
            abi,
        )
        .unwrap();
        assert_eq!(
            &parameters[0][result.parameters[0].edits[0].start..result.parameters[0].edits[0].end],
            "self"
        );
        assert_eq!(
            &"return café + window"[result.body.edits[0].start..result.body.edits[0].end],
            "window"
        );
    }

    #[test]
    fn semantic_early_errors_reject_without_rewrite_output() {
        for source in [
            "let value; let value",
            "var value; let value",
            "{ let value; var value; }",
            "switch (0) { case 0: let value; case 1: let value; }",
            "function value(){} let value",
            "function outer(parameter){ let parameter; }",
            "for (let value, value;;) {}",
            "try {} catch (value) { let value; }",
        ] {
            assert_eq!(
                compile(source, SourceKind::ClassicScriptInline),
                Err(Error::ParseFailed),
                "{source}"
            );
        }
        assert!(compile("var value; var value", SourceKind::ClassicScriptInline).is_ok());
        assert!(
            compile(
                "{ let value; } { let value; }",
                SourceKind::ClassicScriptInline
            )
            .is_ok()
        );
        assert!(
            compile(
                "try {} catch (value) { var value; }",
                SourceKind::ClassicScriptInline
            )
            .is_ok()
        );
        assert_eq!(
            compile(
                "import {value} from './a.js'; let value",
                SourceKind::ModuleScript
            ),
            Err(Error::ParseFailed)
        );
        for source in [
            "let value; export { value }; export { value };",
            "export default 1; export default 2;",
            "export { missing };",
            "const value = 1; export { value as \"\\uD800\" };",
            "export { \"\\uD800\" as ok } from './m.js';",
            "import { \"\\uD800\" as ok } from './m.js';",
        ] {
            assert_eq!(
                compile(source, SourceKind::ModuleScript),
                Err(Error::ParseFailed),
                "{source}"
            );
        }
        for source in [
            "export { value }; const value = 1;",
            "const value = 1; export { value as first }; export { value as second };",
            "export * from './a.js'; export * from './b.js';",
        ] {
            assert!(
                compile(source, SourceKind::ModuleScript).is_ok(),
                "{source}"
            );
        }
    }
    #[test]
    fn retired_worker_source_kind_names_are_invalid() {
        for source_kind in [
            "\"TargetWorkerClassic\"",
            "\"TargetWorkerModule\"",
            "\"TargetSharedWorkerClassic\"",
            "\"TargetSharedWorkerModule\"",
            "\"TargetWorkletModule\"",
        ] {
            assert!(serde_json::from_str::<SourceKind>(source_kind).is_err());
        }
    }
    #[test]
    fn rewrites_owned_reads_and_this_but_preserves_source() {
        let source = "/*keep*/ function f(fetch){ return fetch }\nwindow; this; obj?.m?.()";
        let result = compile(source, SourceKind::ClassicScriptInline).unwrap();
        assert!(result.code.starts_with("/*keep*/"));
        assert!(result.code.contains("return fetch"));
        assert!(result.code.contains(".scope.window"));
        assert!(result.code.contains(".thisValue(this)"));
        assert!(result.code.contains("obj?.m?.()"));
        assert_eq!(result.edits.len(), result.edit_map.len());
        for (edit, mapping) in result.edits.iter().zip(&result.edit_map) {
            assert_eq!(
                &source[mapping.original_start..mapping.original_end],
                &source[edit.start..edit.end]
            );
            assert_eq!(
                &result.code[mapping.generated_start..mapping.generated_end],
                edit.replacement
            );
        }
    }
    #[test]
    fn never_transform_syntax_is_byte_identical_without_owned_leaves() {
        let source = "let ordinary=1;ordinary+=2;ordinary++;const object={key:ordinary,method(value){return value}};object.key;object?.method?.(ordinary);delete object.key;'key' in object;typeof ordinary;class Base{method(){return 1}}class Child extends Base{#value=1;method(){super.method();return #value in object}}function meta(){return new.target}label:for(const item of [1]){if(item)break label}String.raw`x${ordinary}`;/x/u.test('x')";
        let result = compile(source, SourceKind::ClassicScriptInline).unwrap();
        assert_eq!(result.code, source);
        assert!(result.edits.is_empty());
    }

    #[test]
    fn every_planned_edit_has_one_closed_transform_kind() {
        let source = "const source='x';window;({fetch});fetch=1;fetch++;({open}=value);this;eval(source);import(source);import.meta";
        let result = compile(source, SourceKind::ModuleScript).unwrap();
        assert_eq!(
            result
                .edits
                .iter()
                .map(|edit| edit.kind)
                .collect::<Vec<_>>(),
            vec![
                EditKind::OwnedGlobalReference,
                EditKind::OwnedGlobalShorthand,
                EditKind::OwnedGlobalTarget,
                EditKind::OwnedGlobalTarget,
                EditKind::OwnedGlobalTarget,
                EditKind::ThisExpression,
                EditKind::DirectEvalArgument,
                EditKind::DirectEvalArgument,
                EditKind::DynamicImport,
                EditKind::ImportMeta,
            ]
        );
        assert_eq!(
            serde_json::to_value(&result.edits[0]).unwrap()["kind"],
            "owned_global_reference"
        );

        let operations = compile(
            "fetch++;delete open;typeof origin",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert_eq!(
            operations
                .edits
                .iter()
                .map(|edit| edit.kind)
                .collect::<Vec<_>>(),
            vec![
                EditKind::OwnedGlobalTarget,
                EditKind::OwnedGlobalTarget,
                EditKind::OwnedGlobalReference,
            ]
        );
    }
    #[test]
    fn rejects_unsafe_with_without_output() {
        assert_eq!(
            compile("with(o){fetch()}", SourceKind::ClassicScriptInline),
            Err(Error::UnsupportedDynamicScope)
        );
    }
    #[test]
    fn abi_collision_fails() {
        assert_eq!(
            compile(
                &format!("let {ABI_PLACEHOLDER}=1"),
                SourceKind::ClassicScriptInline
            ),
            Err(Error::AbiIdentifierCollision)
        );
    }
    #[test]
    fn template_compilation_records_abi_shaped_identifiers_without_reserving_placeholder_text() {
        let source = format!("let {ABI_PLACEHOLDER}=1; window");
        let result = compile_template(&source, SourceKind::ClassicScriptInline).unwrap();
        assert_eq!(result.abi_identifiers, vec![ABI_PLACEHOLDER.to_owned()]);
        assert!(result.code.contains(&format!("let {ABI_PLACEHOLDER}=1")));
        assert!(
            result
                .code
                .contains(&format!("{ABI_PLACEHOLDER}.scope.window"))
        );
        assert_eq!(result.abi_slots.len(), 1);
        let slot = &result.abi_slots[0];
        assert_eq!(&result.code[slot.start..slot.end], ABI_PLACEHOLDER);
    }
    #[test]
    fn direct_eval_wraps_one_argument_once_with_strictness_metadata() {
        let result = compile("eval(sideEffect())", SourceKind::ClassicScriptInline).unwrap();
        assert!(result.code.starts_with("eval("));
        assert!(
            result
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:false})")
        );
        let strict = compile(
            "\"use strict\"; eval(sideEffect())",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(
            strict
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:true})")
        );
        let escaped = compile(
            "\"use\\x20strict\"; eval(sideEffect())",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(
            escaped
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:false})")
        );
        let strict_function = compile(
            "function nested(){ \"use strict\"; eval(sideEffect()) }",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(
            strict_function
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:true})")
        );
        let strict_class = compile(
            "class Example { method(){ eval(sideEffect()) } }",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(
            strict_class
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:true})")
        );
    }
    #[test]
    fn direct_eval_accepts_only_bare_or_parenthesized_certified_calls() {
        let parenthesized = compile(
            "((/*callee*/eval/*end*/))(sideEffect())",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(parenthesized.code.starts_with("((/*callee*/eval/*end*/))("));
        assert!(
            parenthesized
                .code
                .contains(".evalSource(sideEffect(),{caller_strict:false})")
        );
        assert!(!parenthesized.code.contains(".scope.eval"));

        let zero_argument = "((eval))()";
        let zero = compile(zero_argument, SourceKind::ClassicScriptInline).unwrap();
        assert_eq!(zero.code, zero_argument);
        assert!(zero.edits.is_empty());

        for source in ["(eval)('a','b')", "((eval))(...['a'])"] {
            assert_eq!(
                compile(source, SourceKind::ClassicScriptInline),
                Err(Error::UnsupportedDirectEvalShape)
            );
        }

        let indirect = compile(
            "(0,eval)('a');eval?.('b');eval.call(null,'c')",
            SourceKind::ClassicScriptInline,
        )
        .unwrap();
        assert!(!indirect.code.contains(".evalSource("));
        assert_eq!(
            indirect
                .edits
                .iter()
                .map(|edit| edit.kind)
                .collect::<Vec<_>>(),
            vec![
                EditKind::OwnedGlobalReference,
                EditKind::OwnedGlobalReference,
                EditKind::OwnedGlobalReference,
            ]
        );
    }
    #[test]
    fn non_strict_direct_eval_rejects_escaping_owned_bindings() {
        let abi = "__zp_abi_777777777777777777777777777777777777777777777777";
        for source in [
            "var fetch",
            "var {open}=source",
            "function window(){}",
            "async function fetch(){}",
            "function* open(){}",
            "{function eval(){}}",
            "if(true) function postMessage(){}",
        ] {
            assert_eq!(
                compile_for_abi_with_direct_eval_strictness(
                    source,
                    SourceKind::DirectEvalScript,
                    abi,
                    false,
                ),
                Err(Error::UnsupportedDirectEvalBinding),
                "{source}"
            );
        }

        for source in ["var ordinary", "let fetch", "{async function window(){}}"] {
            assert!(
                compile_for_abi_with_direct_eval_strictness(
                    source,
                    SourceKind::DirectEvalScript,
                    abi,
                    false,
                )
                .is_ok(),
                "{source}"
            );
        }
        assert!(
            compile_for_abi_with_direct_eval_strictness(
                "var fetch",
                SourceKind::DirectEvalScript,
                abi,
                true,
            )
            .is_ok()
        );
        assert!(
            compile_for_abi_with_direct_eval_strictness(
                "\"use strict\";var fetch",
                SourceKind::DirectEvalScript,
                abi,
                false,
            )
            .is_ok()
        );
    }

    #[test]
    fn local_eval_references_require_non_intrinsic_binding_proof() {
        for source in [
            "function run(eval){return eval('source')}run(value=>value)",
            "function run(eval){const alias=eval;return alias('source')}",
            "function run(eval){return eval?.('source')}",
            "const eval=globalThis.eval;eval('source')",
            "{const eval=value=>value;eval('safe')}{let eval=globalThis.eval;eval('unsafe')}",
        ] {
            assert_eq!(
                compile(source, SourceKind::ClassicScriptInline),
                Err(Error::UnsupportedDirectEvalBinding),
                "{source}"
            );
        }

        for source in [
            "const eval=value=>value;eval('source')",
            "const eval=null;eval('source')",
            "const run=function eval(value){return eval(value)};run('source')",
        ] {
            let result = compile(source, SourceKind::ClassicScriptInline).unwrap();
            assert_eq!(result.code, source, "{source}");
            assert!(result.edits.is_empty(), "{source}");
        }
    }
    #[test]
    fn direct_eval_rewrites_owned_argument_references_without_overlapping_edits() {
        let result = compile("eval(fetch + this)", SourceKind::ClassicScriptInline).unwrap();
        assert!(
            result
                .code
                .contains(".evalSource(__zp_abi_000000000000000000000000000000000000000000000000.scope.fetch + __zp_abi_000000000000000000000000000000000000000000000000.thisValue(this),{caller_strict:false})")
        );
        assert_eq!(result.abi_slots.len(), 3);
        assert_eq!(
            compile("eval('a','b')", SourceKind::ClassicScriptInline),
            Err(Error::UnsupportedDirectEvalShape)
        );
    }
    #[test]
    fn writes_shorthand_patterns_and_loops_target_scope_members() {
        let abi = "__zp_abi_111111111111111111111111111111111111111111111111";
        let source = "({fetch}); fetch += 1; fetch++; ({fetch} = obj); [fetch] = arr; for (fetch of values) {}";
        let result = compile_for_abi(source, SourceKind::ClassicScriptInline, abi).unwrap();
        assert!(result.code.contains(&format!("fetch: {abi}.scope.fetch")));
        assert!(result.code.contains(&format!("{abi}.scope.fetch += 1")));
        assert!(result.code.contains(&format!("{abi}.scope.fetch++")));
        assert!(result.code.contains(&format!("[{abi}.scope.fetch] = arr")));
        assert!(
            result
                .code
                .contains(&format!("for ({abi}.scope.fetch of values)"))
        );
    }
    #[test]
    fn placeholder_text_in_literals_and_comments_is_byte_preserved() {
        let source = format!("/* {ABI_PLACEHOLDER} */ const value='{ABI_PLACEHOLDER}'; window");
        let abi = "__zp_abi_222222222222222222222222222222222222222222222222";
        let result = compile_for_abi(&source, SourceKind::ClassicScriptInline, abi).unwrap();
        assert!(result.code.starts_with(&format!("/* {ABI_PLACEHOLDER} */")));
        assert!(result.code.contains(&format!("'{ABI_PLACEHOLDER}'")));
        assert!(result.code.ends_with(&format!("{abi}.scope.window")));
    }
    #[test]
    fn source_directives_come_only_from_parsed_comments_and_last_wins() {
        let source = r#"const a="//# sourceURL=decoy.js";
const b=`/*# sourceMappingURL=decoy.map */`;
//# sourceURL=first.js
/*# sourceMappingURL=target.map */
//@ sourceURL=last.js"#;
        let result = compile(source, SourceKind::ClassicScriptInline).unwrap();
        assert_eq!(result.source_url.as_deref(), Some("last.js"));
        assert_eq!(result.source_mapping_url.as_deref(), Some("target.map"));
    }
    #[test]
    fn source_map_preserves_utf16_geometry_and_authored_mapping_identity() {
        let source = "const icon='😀';\nwindow;";
        let result = compile(source, SourceKind::ClassicScriptExternal).unwrap();
        let generated = format!("prefix;{}", result.code);
        let encoded = inline_source_map(
            source,
            &generated,
            "prefix;".len(),
            "https://example.test/app.js",
            &result.edit_map,
            Some("app.js.map"),
        )
        .unwrap();
        let decoded = BASE64.decode(encoded).unwrap();
        let map: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(map["sourcesContent"][0], source);
        assert_eq!(map["sources"][0], "https://example.test/app.js");
        assert_eq!(map["x_zeroproxy_original_source_mapping_url"], "app.js.map");
        assert!(
            map["mappings"]
                .as_str()
                .is_some_and(|value| value.contains(';'))
        );
        let mappings = map["mappings"].as_str().unwrap();
        assert_eq!(source_map_lookup(mappings, 0, 0), None);
        assert_eq!(
            source_map_lookup(mappings, 0, "prefix;".len()),
            Some((0, 0))
        );
        let generated_window = generated.find("__zp_abi_").unwrap();
        let (_, generated_window_column) = utf16_line_column(&generated, generated_window);
        assert_eq!(
            source_map_lookup(mappings, 1, generated_window_column),
            Some((1, 0))
        );
    }
    #[test]
    fn source_geometry_handles_all_ecmascript_line_terminators() {
        let source = "😀x\r\ny\rz\u{2028}w\u{2029}q";
        assert_eq!(line_start_offsets(source), vec![0, 7, 9, 13, 17]);
        assert_eq!(utf16_line_column(source, "😀x".len()), (0, 3));
        assert_eq!(utf16_line_column(source, 7), (1, 0));
        assert_eq!(utf16_line_column(source, 9), (2, 0));
        assert_eq!(utf16_line_column(source, 13), (3, 0));
        assert_eq!(utf16_line_column(source, 17), (4, 0));
    }
    #[test]
    fn one_megabyte_identity_map_has_bounded_runtime_and_size() {
        let source = "const value=1;\n".repeat(65_536);
        let started = std::time::Instant::now();
        let encoded = inline_source_map(
            &source,
            &source,
            0,
            "https://example.test/large.js",
            &[],
            None,
        )
        .unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "source-map generation regressed beyond the quadratic-work guard"
        );
        assert!(encoded.len() < source.len() * 12);
    }
    #[test]
    fn wire_results_are_versioned_source_preserving_envelopes() {
        let success: serde_json::Value = serde_json::from_str(
            &compile_result_json(
                "window",
                "ClassicScriptExternal",
                "__zp_abi_888888888888888888888888888888888888888888888888",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(success["schema_version"], COMPILER_RESULT_SCHEMA_VERSION);
        assert_eq!(success["ok"], true);
        assert!(success["code"].as_str().unwrap().contains("__zp_abi_"));
        assert!(success["edit_map"].is_array());
        assert_eq!(success["source_map"]["version"], 3);
        assert_eq!(success["source_map"]["sourcesContent"][0], "window");
        assert!(success["source_map"]["mappings"].is_string());
        assert_eq!(success["edits"].as_array().unwrap().len(), 1);
        assert!(success["module_specifiers"].as_array().unwrap().is_empty());
        assert!(success["diagnostics"].as_array().unwrap().is_empty());

        for (source, source_kind, code, stage) in [
            ("return 1", "ClassicScriptExternal", "PARSE_FAILED", "parse"),
            (
                "window",
                "UnknownSourceKind",
                "INVALID_SOURCE_KIND",
                "validation",
            ),
        ] {
            let failure: serde_json::Value = serde_json::from_str(
                &compile_result_json(
                    source,
                    source_kind,
                    "__zp_abi_888888888888888888888888888888888888888888888888",
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(failure["schema_version"], COMPILER_RESULT_SCHEMA_VERSION);
            assert_eq!(failure["ok"], false);
            assert!(failure["code"].is_null());
            assert!(failure["edits"].as_array().unwrap().is_empty());
            assert!(failure["edit_map"].as_array().unwrap().is_empty());
            assert!(failure["source_map"].is_null());
            assert!(failure["module_specifiers"].as_array().unwrap().is_empty());
            assert!(failure["source_url"].is_null());
            assert!(failure["source_mapping_url"].is_null());
            assert_eq!(failure["error"]["code"], code);
            assert_eq!(
                failure["error"]["source_kind"],
                if code == "INVALID_SOURCE_KIND" {
                    "Unknown"
                } else {
                    source_kind
                }
            );
            assert_eq!(failure["error"]["stage"], stage);
            assert_eq!(failure["error"]["recoverability"], "none");
            assert!(failure["diagnostics"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn dynamic_function_wire_results_structure_every_source_fragment() {
        let result: serde_json::Value = serde_json::from_str(
            &compile_dynamic_function_result_json(
                r#"["window"]"#,
                "return fetch",
                "FunctionBody",
                "__zp_abi_999999999999999999999999999999999999999999999999",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["schema_version"], COMPILER_RESULT_SCHEMA_VERSION);
        assert_eq!(result["ok"], true);
        assert_eq!(result["parameters"][0]["ok"], true);
        assert!(result["parameters"][0]["edit_map"].is_array());
        assert_eq!(result["parameters"][0]["source_map"]["version"], 3);
        assert_eq!(result["body"]["ok"], true);
        assert!(result["body"]["edit_map"].is_array());
        assert_eq!(result["body"]["source_map"]["version"], 3);
    }
    #[test]
    fn stable_failures_have_exhaustive_codes_and_stages() {
        for (error, code, stage) in [
            (
                Error::InvalidSourceKind,
                "INVALID_SOURCE_KIND",
                "validation",
            ),
            (Error::ParseFailed, "PARSE_FAILED", "parse"),
            (
                Error::UnsupportedBrowserSyntax,
                "UNSUPPORTED_BROWSER_SYNTAX",
                "parse",
            ),
            (
                Error::UnsupportedDynamicScope,
                "UNSUPPORTED_DYNAMIC_SCOPE",
                "analysis",
            ),
            (
                Error::UnsupportedDirectEvalBinding,
                "UNSUPPORTED_DIRECT_EVAL_BINDING",
                "analysis",
            ),
            (
                Error::UnsupportedDirectEvalShape,
                "UNSUPPORTED_DIRECT_EVAL_SHAPE",
                "analysis",
            ),
            (
                Error::AbiIdentifierCollision,
                "ABI_IDENTIFIER_COLLISION",
                "analysis",
            ),
            (Error::ResolutionFailed, "RESOLUTION_FAILED", "resolve"),
            (Error::TransformFailed, "TRANSFORM_FAILED", "transform"),
            (Error::CodegenFailed, "CODEGEN_FAILED", "codegen"),
            (
                Error::AbiVersionMismatch,
                "ABI_VERSION_MISMATCH",
                "validation",
            ),
            (Error::ResourceTooLarge, "RESOURCE_TOO_LARGE", "validation"),
            (Error::PolicyBlocked, "POLICY_BLOCKED", "policy"),
        ] {
            assert_eq!(error.code(), code);
            assert_eq!(error.stage(), stage);
            let failure =
                serde_json::to_value(CompilerFailure::new(&error, "ClassicScriptExternal"))
                    .unwrap();
            assert_eq!(failure["error"]["code"], code);
            assert_eq!(failure["error"]["stage"], stage);
            assert_eq!(failure["error"]["recoverability"], "none");
            assert!(failure["code"].is_null());
            assert!(failure["edits"].as_array().unwrap().is_empty());
            assert!(failure["source_map"].is_null());
        }
    }

    #[test]
    fn abi_versions_and_source_size_are_validated_before_parsing() {
        let abi_failure: serde_json::Value = serde_json::from_str(
            &compile_result_json("window", "ClassicScriptExternal", "__zp_abi_ABCDEF").unwrap(),
        )
        .unwrap();
        assert_eq!(abi_failure["error"]["code"], "ABI_VERSION_MISMATCH");
        assert_eq!(abi_failure["error"]["stage"], "validation");

        let oversized = "x".repeat(MAX_COMPILER_SOURCE_BYTES + 1);
        let size_failure: serde_json::Value = serde_json::from_str(
            &compile_result_json(
                &oversized,
                "ClassicScriptExternal",
                "__zp_abi_888888888888888888888888888888888888888888888888",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(size_failure["error"]["code"], "RESOURCE_TOO_LARGE");
        assert_eq!(size_failure["error"]["stage"], "validation");
    }

    #[test]
    fn failure_envelopes_redact_source_urls_and_invalid_source_kinds() {
        let secret_source =
            "} //# sourceURL=https://user:password@example.test/app.js?token=secret-cookie";
        let failure = compile_result_json(
            secret_source,
            "ClassicScriptExternal",
            "__zp_abi_888888888888888888888888888888888888888888888888",
        )
        .unwrap();
        assert!(!failure.contains("example.test"));
        assert!(!failure.contains("password"));
        assert!(!failure.contains("secret-cookie"));

        let invalid_kind = compile_result_json(
            "window",
            "https://example.test/?token=secret",
            "__zp_abi_bad",
        )
        .unwrap();
        let invalid_kind: serde_json::Value = serde_json::from_str(&invalid_kind).unwrap();
        assert_eq!(invalid_kind["error"]["code"], "INVALID_SOURCE_KIND");
        assert_eq!(invalid_kind["error"]["source_kind"], "Unknown");
        assert!(!invalid_kind.to_string().contains("example.test"));

        let dynamic = compile_dynamic_function_result_json(
            "{malformed",
            "return 1",
            "https://example.test/?token=dynamic-secret",
            "__zp_abi_bad",
        )
        .unwrap();
        let dynamic: serde_json::Value = serde_json::from_str(&dynamic).unwrap();
        assert_eq!(dynamic["error"]["code"], "INVALID_SOURCE_KIND");
        assert_eq!(dynamic["error"]["source_kind"], "Unknown");
        assert!(!dynamic.to_string().contains("example.test"));
        assert!(!dynamic.to_string().contains("dynamic-secret"));
    }

    #[test]
    fn compiler_cache_keys_are_versioned_bounded_sha256_digests() {
        let context = r#"{"abi_version":1,"family":"FunctionBody","realm":"realm-1"}"#;
        let first = compiler_cache_key("return window", context).unwrap();
        assert_eq!(first.len(), 64);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        assert_eq!(first, compiler_cache_key("return window", context).unwrap());
        assert_ne!(first, compiler_cache_key("return fetch", context).unwrap());
        assert_ne!(
            first,
            compiler_cache_key(
                "return window",
                r#"{"abi_version":1,"family":"FunctionBody","realm":"realm-2"}"#,
            )
            .unwrap()
        );
        assert_eq!(
            compiler_cache_key("source", "[]"),
            Err(Error::PolicyBlocked)
        );
        assert_eq!(
            compiler_cache_key(
                "source",
                &format!(
                    r#"{{"padding":"{}"}}"#,
                    "x".repeat(MAX_COMPILER_CACHE_CONTEXT_BYTES)
                ),
            ),
            Err(Error::ResourceTooLarge)
        );

        let versions: serde_json::Value =
            serde_json::from_str(&compiler_versions_result_json().unwrap()).unwrap();
        assert_eq!(versions["abi_version"], COMPILER_ABI_VERSION);
        assert_eq!(
            versions["cache_schema_version"],
            COMPILER_CACHE_SCHEMA_VERSION
        );
        assert_eq!(
            versions["result_schema_version"],
            COMPILER_RESULT_SCHEMA_VERSION
        );
        assert_eq!(versions["parser_version"], ECMASCRIPT_GRAMMAR_VERSION);
        assert_eq!(versions["compiler_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(versions["browser_versions"].as_array().unwrap().len(), 2);
        assert!(
            versions["browser_versions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|version| version.as_str().unwrap().starts_with("chromium:"))
        );
        assert!(
            versions["browser_versions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|version| version.as_str().unwrap().starts_with("firefox:"))
        );
    }
}
