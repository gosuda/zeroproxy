use wasm_bindgen::prelude::*;

mod css;
pub mod html;
mod import_map;
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
    _source: &str,
    _kind: &str,
    _target_url: &str,
    _control_prefix: &str,
) -> RewriteOutput {
    unsupported_target_js_rewrite()
}

#[wasm_bindgen]
pub fn rewrite_script_with_context(
    _source: &str,
    _kind: &str,
    _target_url: &str,
    _control_prefix: &str,
    _tab_id: &str,
    _runtime_token: &str,
) -> RewriteOutput {
    unsupported_target_js_rewrite()
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
pub struct HtmlDocumentRewriter {
    inner: html::document::StreamingDocumentRewriter,
}

#[wasm_bindgen]
impl HtmlDocumentRewriter {
    pub fn write_chunk(&mut self, chunk: &[u8]) -> RewriteOutput {
        match self.inner.write(chunk) {
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

    pub fn end(&mut self) -> RewriteOutput {
        match self.inner.end() {
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
}

#[wasm_bindgen]
pub fn create_html_document_rewriter(
    target_url: &str,
    control_prefix: &str,
    servers_json: &str,
    runtime_prelude: &str,
    tab_id: &str,
    runtime_token: &str,
) -> HtmlDocumentRewriter {
    let servers = serde_json::from_str::<Vec<String>>(servers_json).unwrap_or_default();
    HtmlDocumentRewriter {
        inner: html::document::StreamingDocumentRewriter::new(html::document::DocumentOptions {
            target_url,
            control_prefix,
            servers: &servers,
            runtime_prelude,
            tab_id,
            runtime_token,
        }),
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
    _raw: &str,
    _kind: &str,
    _target_url: &str,
    control_prefix: &str,
    _tab_id: &str,
    _runtime_token: &str,
) -> URLRewriteOutput {
    URLRewriteOutput {
        ok: false,
        url: format!(
            "{}error/POLICY_BLOCKED",
            normalized_control_prefix(control_prefix)
        ),
        target: String::new(),
        error: "POLICY_BLOCKED".to_string(),
    }
}

#[wasm_bindgen]
pub fn rewrite_fetch_url(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::fetch_url(raw, target_url, normalized_control_prefix(control_prefix));
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn rewrite_srcset(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::srcset(raw, target_url, normalized_control_prefix(control_prefix));
    URLRewriteOutput {
        ok: out.ok,
        url: out.url,
        target: out.target,
        error: out.error,
    }
}

#[wasm_bindgen]
pub fn resolve_target_url(raw: &str, target_url: &str, control_prefix: &str) -> URLRewriteOutput {
    let out = html::target_url(raw, target_url, normalized_control_prefix(control_prefix));
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

fn normalized_control_prefix(control_prefix: &str) -> &str {
    if control_prefix.is_empty() {
        "/zp/"
    } else {
        control_prefix
    }
}

fn unsupported_target_js_rewrite() -> RewriteOutput {
    RewriteOutput {
        ok: false,
        code: String::new(),
        error: "UNSUPPORTED_TARGET_JS_REWRITE".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_js_rewrite_exports_fail_closed_after_quickjs_cutover() {
        let out = rewrite_script(
            "window.location.href",
            "classic",
            "https://example.com/app.js",
            "/zp/",
        );
        assert!(!out.ok);
        assert_eq!(out.error, "UNSUPPORTED_TARGET_JS_REWRITE");

        let with_context = rewrite_script_with_context(
            "import './dep.js';",
            "module",
            "https://example.com/assets/main.js",
            "/zp/",
            "tab-1",
            "rt-1",
        );
        assert!(!with_context.ok);
        assert_eq!(with_context.error, "UNSUPPORTED_TARGET_JS_REWRITE");
    }

    #[test]
    fn script_url_rewrite_export_fails_closed() {
        let out = rewrite_script_url(
            "./app.js",
            "classic",
            "https://example.com/page.html",
            "/zp/",
            "tab-1",
            "rt-1",
        );
        assert!(!out.ok);
        assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
        assert_eq!(out.error, "POLICY_BLOCKED");
    }
}
