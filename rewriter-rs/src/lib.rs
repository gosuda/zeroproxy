use wasm_bindgen::prelude::*;

mod css;
pub mod html;
mod import_map;
mod js;
mod share_url;

#[wasm_bindgen]
pub struct RewriteOutput {
    ok: bool,
    code: String,
    error: String,
}

#[wasm_bindgen]
pub struct URLRewriteOutput {
    ok: bool,
    url: String,
    target: String,
    error: String,
}

#[wasm_bindgen]
impl URLRewriteOutput {
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.ok
    }
    #[wasm_bindgen(getter)]
    pub fn url(&self) -> String {
        self.url.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn target(&self) -> String {
        self.target.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> String {
        self.error.clone()
    }
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
    rewrite_script_with_context(source, kind, target_url, control_prefix, "", "")
}

#[wasm_bindgen]
pub fn rewrite_script_with_context(
    source: &str,
    kind: &str,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> RewriteOutput {
    let ctx = RewriteContext::new(target_url, control_prefix, tab_id, runtime_token);
    match normalize_kind(kind) {
        "module" => rewrite_program_source(source, true, ctx),
        "event-handler" => rewrite_wrapped_source(
            source,
            "function __zp_event__(event){\n",
            "\n}",
            false,
            ctx.without_runtime_context(),
            true,
        ),
        "function" => rewrite_wrapped_source(
            source,
            "function __zp_dynamic__(){\n",
            "\n}",
            false,
            ctx.without_runtime_context(),
            false,
        ),
        _ => rewrite_program_source(source, false, ctx.without_runtime_context()),
    }
}

#[wasm_bindgen]
pub fn rewrite_css(source: &str, base_url: &str, control_prefix: &str) -> RewriteOutput {
    match css::rewrite(source, base_url, control_prefix) {
        Ok(code) => RewriteOutput {
            ok: true,
            code,
            error: String::new(),
        },
        Err(error) => RewriteOutput {
            ok: false,
            code: String::new(),
            error,
        },
    }
}

#[wasm_bindgen]
pub fn rewrite_import_map(
    source: &str,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) -> String {
    import_map::rewrite(source, base_url, tab_id, runtime_token, control_prefix)
}

#[wasm_bindgen]
pub fn rewrite_html_document(
    source: &str,
    target_url: &str,
    control_prefix: &str,
    servers_json: &str,
    runtime_prelude: &str,
    tab_id: &str,
    runtime_token: &str,
) -> RewriteOutput {
    let servers = serde_json::from_str::<Vec<String>>(servers_json).unwrap_or_default();
    match html::document::rewrite_document(
        source,
        html::document::DocumentOptions {
            target_url,
            control_prefix,
            servers: &servers,
            runtime_prelude,
            tab_id,
            runtime_token,
        },
    ) {
        Ok(code) => RewriteOutput {
            ok: true,
            code,
            error: String::new(),
        },
        Err(error) => RewriteOutput {
            ok: false,
            code: String::new(),
            error,
        },
    }
}

#[wasm_bindgen]
pub fn make_share_url(target: &str, servers_json: &str) -> RewriteOutput {
    let servers = serde_json::from_str::<Vec<String>>(servers_json).unwrap_or_default();
    match share_url::new_with_servers(target, &servers) {
        Ok(code) => RewriteOutput {
            ok: true,
            code,
            error: String::new(),
        },
        Err(error) => RewriteOutput {
            ok: false,
            code: String::new(),
            error,
        },
    }
}

#[wasm_bindgen]
pub fn rewrite_script_url(
    raw: &str,
    kind: &str,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> URLRewriteOutput {
    let out = js::module_urls::script_url(
        raw,
        normalize_kind(kind),
        target_url,
        RewriteContext::new(target_url, control_prefix, tab_id, runtime_token).control_prefix,
        tab_id,
        runtime_token,
    );
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn rewrite_fetch_url(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::fetch_url(
        raw,
        target_url,
        RewriteContext::new(target_url, control_prefix, "", "").control_prefix,
    );
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn rewrite_srcset(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::srcset(
        raw,
        target_url,
        RewriteContext::new(target_url, control_prefix, "", "").control_prefix,
    );
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn resolve_target_url(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::target_url(
        raw,
        target_url,
        RewriteContext::new(target_url, control_prefix, "", "").control_prefix,
    );
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn classify_link_rel(rel: &str) -> String {
    html::link_rel_kind(rel).to_string()
}

#[wasm_bindgen]
pub fn classify_blocked_element(tag: &str) -> String {
    html::blocked_element_kind(tag).to_string()
}

#[wasm_bindgen]
pub fn classify_meta_policy(http_equiv: &str) -> String {
    html::meta_policy_kind(http_equiv).to_string()
}

#[wasm_bindgen]
pub fn classify_attr_policy(tag: &str, key: &str) -> String {
    html::attr_policy_kind(tag, key).to_string()
}

#[wasm_bindgen]
pub fn classify_script_type(script_type: &str) -> String {
    html::script_type_kind(script_type).to_string()
}

#[wasm_bindgen]
pub fn classify_event_handler_attr(attr_name: &str) -> String {
    html::event_handler_attr_kind(attr_name).to_string()
}

fn normalize_kind(kind: &str) -> &'static str {
    match kind {
        "module" => "module",
        "event-handler" | "event" => "event-handler",
        "function" => "function",
        _ => "classic",
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RewriteContext<'a> {
    pub(crate) target_url: &'a str,
    pub(crate) control_prefix: &'a str,
    pub(crate) tab_id: &'a str,
    pub(crate) runtime_token: &'a str,
}

impl<'a> RewriteContext<'a> {
    pub(crate) fn new(
        target_url: &'a str,
        control_prefix: &'a str,
        tab_id: &'a str,
        runtime_token: &'a str,
    ) -> Self {
        Self {
            target_url,
            control_prefix: if control_prefix.is_empty() {
                "/zp/"
            } else {
                control_prefix
            },
            tab_id,
            runtime_token,
        }
    }

    pub(crate) fn without_runtime_context(self) -> Self {
        Self {
            tab_id: "",
            runtime_token: "",
            ..self
        }
    }
}

fn rewrite_program_source(source: &str, module: bool, ctx: RewriteContext<'_>) -> RewriteOutput {
    match js::swc_rewriter::rewrite_script(source, module, ctx) {
        Ok(code) => RewriteOutput {
            ok: true,
            code,
            error: String::new(),
        },
        Err(error) => RewriteOutput {
            ok: false,
            code: String::new(),
            error,
        },
    }
}

pub(crate) fn rewrite_wrapped_source(
    source: &str,
    prefix: &str,
    suffix: &str,
    module: bool,
    ctx: RewriteContext<'_>,
    event_handler: bool,
) -> RewriteOutput {
    let mut wrapped = String::with_capacity(prefix.len() + source.len() + suffix.len());
    wrapped.push_str(prefix);
    wrapped.push_str(source);
    wrapped.push_str(suffix);
    let out = rewrite_program_source(&wrapped, module, ctx);
    if !out.ok {
        return out;
    }
    let Some(inner) = generated_function_body(&out.code) else {
        return RewriteOutput {
            ok: false,
            code: String::new(),
            error: "REWRITE_FAILED".to_string(),
        };
    };
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

fn generated_function_body(code: &str) -> Option<&str> {
    let start = code.find('{')? + 1;
    let end = code.rfind('}')?;
    (start <= end).then_some(&code[start..end])
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
        assert!(code
            .contains("/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js"));
        assert!(code.contains(
            "__zp_module_url(\"./chunks/\"+name+\".js\",\"https://example.com/assets/main.js\")"
        ));
        assert!(code.contains("\"https://example.com/assets/main.js\""));
    }

    #[test]
    fn rewrites_module_urls_with_runtime_context_when_supplied() {
        let out = rewrite_script_with_context(
            "import './dep.js'; export async function load() { return import('./chunk.js'); }",
            "module",
            "https://example.com/assets/main.js",
            "/zp/",
            "tab-1",
            "rt-1",
        );
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert!(out.code.contains(
            "/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fdep.js&tab=tab-1&rt=rt-1"
        ));
        assert!(out.code.contains(
            "import(\"/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fassets%2Fchunk.js&tab=tab-1&rt=rt-1\")"
        ));
    }

    #[test]
    fn rewrites_calls_and_constructors() {
        let code = rewrite_ok(
            "window.location = '/next'; const ws = new WebSocket('/ws', ['chat']); Object.getOwnPropertyDescriptor(window, 'location'); Object.assign(target, ...sources); new WebSocket(...wsArgs);",
            "classic",
            "https://example.com/app.js",
        );
        assert!(code.contains("__zp_set(__zp_get(globalThis,\"window\"),\"location\",\"/next\")"));
        assert!(code
            .contains("__zp_construct(__zp_get(globalThis,\"WebSocket\"),[\"/ws\",[\"chat\"]])"));
        assert!(code.contains("__zp_construct(__zp_get(globalThis,\"WebSocket\"),[...wsArgs])"));
        assert!(code.contains("__zp_call(Object,\"getOwnPropertyDescriptor\",[__zp_get(globalThis,\"window\"),\"location\"])"));
        assert!(code.contains("__zp_call(Object,\"assign\",[target,...sources])"));
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
