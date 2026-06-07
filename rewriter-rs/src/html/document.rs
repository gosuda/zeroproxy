use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

use lol_html::{
    element, end, html_content::ContentType, rewrite_str, text, HtmlRewriter, RewriteStrSettings,
    Settings,
};

use crate::{
    css, import_map, js, rewrite_wrapped_source, share_url, RewriteContext, RewriteOutput,
};

use super::{attr_policy_kind, fetch_url, link_rel_kind, srcset, target_url as resolve_target_url};
use super::{blocked_element_kind, event_handler_attr_kind, meta_policy_kind, script_type_kind};

pub struct DocumentOptions<'a> {
    pub target_url: &'a str,
    pub control_prefix: &'a str,
    pub servers: &'a [String],
    pub runtime_prelude: &'a str,
    pub tab_id: &'a str,
    pub runtime_token: &'a str,
}

struct RawTextState {
    kind: RawTextKind,
    text: String,
}

enum RawTextKind {
    Script(String),
    Style,
    ImportMap,
    Pass,
}

pub fn rewrite_document(source: &str, opt: DocumentOptions<'_>) -> Result<String, String> {
    rewrite_str(source, document_rewrite_settings(opt)).map_err(|err| err.to_string())
}

type StreamingHtmlRewriter = HtmlRewriter<'static, Box<dyn FnMut(&[u8])>>;

pub struct StreamingDocumentRewriter {
    rewriter: Option<StreamingHtmlRewriter>,
    output: Rc<RefCell<Vec<u8>>>,
    pending_utf8: Vec<u8>,
}

impl StreamingDocumentRewriter {
    pub fn new(opt: DocumentOptions<'_>) -> Self {
        let output = Rc::new(RefCell::new(Vec::new()));
        let sink_output = Rc::clone(&output);
        let settings: Settings<'static, 'static> = document_rewrite_settings(opt).into();
        let rewriter = HtmlRewriter::new(
            settings,
            Box::new(move |chunk: &[u8]| sink_output.borrow_mut().extend_from_slice(chunk))
                as Box<dyn FnMut(&[u8])>,
        );
        Self {
            rewriter: Some(rewriter),
            output,
            pending_utf8: Vec::new(),
        }
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<String, String> {
        let rewriter = self
            .rewriter
            .as_mut()
            .ok_or_else(|| "HTML_DOCUMENT_STREAM_CLOSED".to_string())?;
        rewriter.write(chunk).map_err(|err| err.to_string())?;
        self.take_output(false)
    }

    pub fn end(&mut self) -> Result<String, String> {
        let rewriter = self
            .rewriter
            .take()
            .ok_or_else(|| "HTML_DOCUMENT_STREAM_CLOSED".to_string())?;
        rewriter.end().map_err(|err| err.to_string())?;
        self.take_output(true)
    }

    fn take_output(&mut self, final_chunk: bool) -> Result<String, String> {
        let mut bytes = Vec::new();
        bytes.append(&mut self.pending_utf8);
        {
            let mut output = self.output.borrow_mut();
            bytes.extend_from_slice(&output);
            output.clear();
        }
        match String::from_utf8(bytes) {
            Ok(text) => Ok(text),
            Err(err) => split_utf8_output(err.into_bytes(), final_chunk, &mut self.pending_utf8),
        }
    }
}

fn split_utf8_output(
    bytes: Vec<u8>,
    final_chunk: bool,
    pending_utf8: &mut Vec<u8>,
) -> Result<String, String> {
    match std::str::from_utf8(&bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(err) => {
            if err.error_len().is_some() || final_chunk {
                return Err("HTML_DOCUMENT_STREAM_UTF8".to_string());
            }
            let split = err.valid_up_to();
            pending_utf8.extend_from_slice(&bytes[split..]);
            Ok(std::str::from_utf8(&bytes[..split])
                .map_err(|_| "HTML_DOCUMENT_STREAM_UTF8".to_string())?
                .to_string())
        }
    }
}

fn document_rewrite_settings(opt: DocumentOptions<'_>) -> RewriteStrSettings<'static, 'static> {
    let target_url = opt.target_url.to_string();
    let control_prefix = if opt.control_prefix.is_empty() {
        "/zp/".to_string()
    } else {
        opt.control_prefix.to_string()
    };
    let servers = opt.servers.to_vec();
    let runtime_prelude = opt.runtime_prelude.to_string();
    let tab_id = opt.tab_id.to_string();
    let runtime_token = opt.runtime_token.to_string();
    let injected = Rc::new(Cell::new(runtime_prelude.is_empty()));
    let raw_text = Rc::new(RefCell::new(VecDeque::<RawTextState>::new()));
    let head_injected = Rc::clone(&injected);
    let body_injected = Rc::clone(&injected);
    let script_injected = Rc::clone(&injected);
    let end_injected = Rc::clone(&injected);
    let head_prelude = runtime_prelude.clone();
    let body_prelude = runtime_prelude.clone();
    let script_prelude = runtime_prelude.clone();
    let attr_prelude = runtime_prelude.clone();
    let attr_tab_id = tab_id.clone();
    let attr_runtime_token = runtime_token.clone();
    let end_prelude = runtime_prelude;
    let script_target_url = target_url.clone();
    let script_control_prefix = control_prefix.clone();
    let script_tab_id = tab_id.clone();
    let script_runtime_token = runtime_token.clone();
    let style_target_url = target_url.clone();
    let style_control_prefix = control_prefix.clone();
    let text_target_url = target_url.clone();
    let text_control_prefix = control_prefix.clone();
    let text_tab_id = tab_id.clone();
    let text_runtime_token = runtime_token.clone();
    let raw_text_for_script = Rc::clone(&raw_text);
    let raw_text_for_style = Rc::clone(&raw_text);
    let raw_text_for_text = Rc::clone(&raw_text);
    RewriteStrSettings {
        element_content_handlers: vec![
            element!("head", move |el| {
                if !head_injected.replace(true) {
                    el.prepend(&head_prelude, ContentType::Html);
                }
                Ok(())
            }),
            element!("body", move |el| {
                if !body_injected.replace(true) {
                    el.before(&body_prelude, ContentType::Html);
                }
                Ok(())
            }),
            element!("script", move |el| {
                if !script_injected.replace(true) {
                    el.before(&script_prelude, ContentType::Html);
                }
                rewrite_script_attrs(
                    el,
                    &script_target_url,
                    &script_control_prefix,
                    &script_tab_id,
                    &script_runtime_token,
                )?;
                if let Some(kind) = script_raw_text_kind(el) {
                    raw_text_for_script.borrow_mut().push_back(RawTextState {
                        kind,
                        text: String::new(),
                    });
                }
                Ok(())
            }),
            element!("style", move |el| {
                rewrite_style_attrs(el, &style_target_url, &style_control_prefix)?;
                raw_text_for_style.borrow_mut().push_back(RawTextState {
                    kind: RawTextKind::Style,
                    text: String::new(),
                });
                Ok(())
            }),
            text!("script, style", move |txt| {
                rewrite_raw_text_chunk(
                    txt,
                    &raw_text_for_text,
                    &text_target_url,
                    &text_control_prefix,
                    &text_tab_id,
                    &text_runtime_token,
                )
            }),
            element!("*", move |el| {
                if matches!(el.tag_name().as_str(), "script" | "style") {
                    return Ok(());
                }
                rewrite_element_attrs(
                    el,
                    &target_url,
                    &control_prefix,
                    &servers,
                    &attr_prelude,
                    &attr_tab_id,
                    &attr_runtime_token,
                )?;
                Ok(())
            }),
        ],
        document_content_handlers: vec![end!(move |doc| {
            if !end_injected.replace(true) {
                doc.append(&end_prelude, ContentType::Html);
            }
            Ok(())
        })],
        ..RewriteStrSettings::new()
    }
}

fn rewrite_element_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
    servers: &[String],
    runtime_prelude: &str,
    tab_id: &str,
    runtime_token: &str,
) -> lol_html::HandlerResult {
    let tag = el.tag_name();
    drop_control_attrs(el);
    if tag == "a" {
        el.remove_attribute("ping");
    }
    if tag == "link" {
        backup_masked_attrs(el, false)?;
    }
    rewrite_event_handler_attrs(el, target_url, control_prefix)?;
    if tag == "base" {
        rewrite_base_element(el, target_url, control_prefix)?;
        return Ok(());
    }
    if rewrite_meta_or_blocked_element(el, &tag)? {
        return Ok(());
    }
    if tag == "link" {
        rewrite_link_attrs(el, target_url, control_prefix)?;
        return Ok(());
    }
    rewrite_inline_style_attr(el, target_url, control_prefix)?;
    rewrite_srcdoc_attr(
        el,
        &tag,
        target_url,
        control_prefix,
        runtime_prelude,
        tab_id,
        runtime_token,
    )?;
    for attr in ["href", "xlink:href", "src", "poster"] {
        if attr_policy_kind(&tag, attr) == "passive" {
            rewrite_passive_attr(el, attr, target_url, control_prefix)?;
        }
    }
    for attr in ["href", "action", "formaction", "src"] {
        if attr_policy_kind(&tag, attr) == "navigation" {
            rewrite_navigation_attr(el, attr, target_url, control_prefix, servers)?;
        }
    }
    if attr_policy_kind(&tag, "srcset") == "srcset" {
        rewrite_srcset_attr(el, target_url, control_prefix)?;
    }
    Ok(())
}

fn rewrite_base_element<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let href = el.get_attribute("href").unwrap_or_default();
    let target = resolve_target_url(&href, target_url, control_prefix);
    if !target.ok {
        el.remove();
        return Ok(());
    }
    let json = serde_json::to_string(&target.target).unwrap_or_else(|_| "\"\"".to_string());
    el.replace(
        &format!(
            r#"<script nonce=zp>window.__ZP_SET_BASE&&window.__ZP_SET_BASE({json});</script>"#
        ),
        ContentType::Html,
    );
    Ok(())
}

fn rewrite_event_handler_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let handlers = attr_names(el)
        .into_iter()
        .filter(|name| event_handler_attr_kind(name) == "block")
        .collect::<Vec<_>>();
    for name in handlers {
        let value = el.get_attribute(&name).unwrap_or_default();
        el.remove_attribute(&name);
        let rewritten = rewrite_event_handler(&value, target_url, control_prefix);
        if rewritten.ok {
            el.set_attribute(&format!("data-zp-event-{name}"), &rewritten.code)?;
        } else {
            el.set_attribute(&format!("data-zp-blocked-{name}"), &value)?;
        }
    }
    Ok(())
}

fn rewrite_event_handler(source: &str, target_url: &str, control_prefix: &str) -> RewriteOutput {
    let ctx = RewriteContext::new(target_url, control_prefix, "", "");
    rewrite_wrapped_source(
        source,
        "function __zp_event__(event){\n",
        "\n}",
        false,
        ctx.without_runtime_context(),
        true,
    )
}

fn rewrite_inline_style_attr<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let Some(style) = el.get_attribute("style") else {
        return Ok(());
    };
    el.set_attribute(
        "style",
        &rewrite_inline_style(&style, target_url, control_prefix),
    )?;
    Ok(())
}

fn rewrite_srcdoc_attr<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    tag: &str,
    target_url: &str,
    control_prefix: &str,
    runtime_prelude: &str,
    tab_id: &str,
    runtime_token: &str,
) -> lol_html::HandlerResult {
    if tag != "iframe" && tag != "frame" {
        return Ok(());
    }
    let Some(srcdoc) = el.get_attribute("srcdoc") else {
        return Ok(());
    };
    let rewritten = rewrite_document(
        &srcdoc,
        DocumentOptions {
            target_url,
            control_prefix,
            servers: &[],
            runtime_prelude,
            tab_id,
            runtime_token,
        },
    )?;
    el.set_attribute("srcdoc", &rewritten)?;
    Ok(())
}

fn attr_names<H: lol_html::HandlerTypes>(
    el: &lol_html::html_content::Element<'_, '_, H>,
) -> Vec<String> {
    el.attributes().iter().map(|attr| attr.name()).collect()
}

fn rewrite_script_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> lol_html::HandlerResult {
    drop_control_attrs(el);
    backup_masked_attrs(el, true)?;
    let script_kind = script_type_kind(&el.get_attribute("type").unwrap_or_default());
    if script_kind == "speculationrules" {
        el.remove();
        return Ok(());
    }
    if let Some(src) = el.get_attribute("src") {
        if matches!(script_kind, "classic" | "module") {
            let rewritten = js::module_urls::script_url(
                &src,
                script_kind,
                target_url,
                control_prefix,
                tab_id,
                runtime_token,
            );
            el.set_attribute("src", &rewritten.url)?;
            if rewritten.ok {
                el.set_attribute("data-zp-target-url", &rewritten.target)?;
            } else if !src.trim().is_empty() {
                el.set_attribute("data-zp-blocked-url", src.trim())?;
            }
        }
    }
    if matches!(script_kind, "classic" | "module") {
        el.set_attribute("nonce", "zp")?;
        if el.get_attribute("src").unwrap_or_default().is_empty() {
            el.set_attribute("data-zp-static-script", "1")?;
        }
    }
    Ok(())
}

fn rewrite_style_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    drop_control_attrs(el);
    backup_masked_attrs(el, false)?;
    if let Some(style) = el.get_attribute("style") {
        el.set_attribute(
            "style",
            &rewrite_inline_style(&style, target_url, control_prefix),
        )?;
    }
    Ok(())
}

fn backup_masked_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    script: bool,
) -> lol_html::HandlerResult {
    if let Some(value) = el.get_attribute("integrity") {
        el.remove_attribute("integrity");
        el.set_attribute("data-zp-integrity", &value)?;
    }
    if script {
        if let Some(value) = el.get_attribute("nonce") {
            el.remove_attribute("nonce");
            if !value.trim().is_empty() && value != "zp" {
                el.set_attribute("data-zp-target-nonce", &value)?;
            }
        }
    }
    Ok(())
}

fn script_body_kind<H: lol_html::HandlerTypes>(
    el: &lol_html::html_content::Element<'_, '_, H>,
) -> RawTextKind {
    if !el.get_attribute("src").unwrap_or_default().is_empty() {
        return RawTextKind::Pass;
    }
    match script_type_kind(&el.get_attribute("type").unwrap_or_default()) {
        "classic" => RawTextKind::Script("classic".to_string()),
        "module" => RawTextKind::Script("module".to_string()),
        "importmap" => RawTextKind::ImportMap,
        _ => RawTextKind::Pass,
    }
}

fn script_raw_text_kind<H: lol_html::HandlerTypes>(
    el: &lol_html::html_content::Element<'_, '_, H>,
) -> Option<RawTextKind> {
    let kind = script_body_kind(el);
    if matches!(kind, RawTextKind::Pass) {
        None
    } else {
        Some(kind)
    }
}

fn rewrite_raw_text_chunk(
    txt: &mut lol_html::html_content::TextChunk<'_>,
    states: &Rc<RefCell<VecDeque<RawTextState>>>,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> lol_html::HandlerResult {
    let mut states = states.borrow_mut();
    let Some(state) = states.front_mut() else {
        return Ok(());
    };
    if matches!(state.kind, RawTextKind::Pass) {
        if txt.last_in_text_node() {
            states.pop_front();
        }
        return Ok(());
    }
    state.text.push_str(txt.as_str());
    if !txt.last_in_text_node() {
        txt.remove();
        return Ok(());
    }
    let rewritten = match &state.kind {
        RawTextKind::Script(kind) => rewrite_inline_script(
            &state.text,
            kind,
            target_url,
            control_prefix,
            tab_id,
            runtime_token,
        ),
        RawTextKind::Style => rewrite_inline_style(&state.text, target_url, control_prefix),
        RawTextKind::ImportMap => import_map::rewrite(
            &state.text,
            target_url,
            tab_id,
            runtime_token,
            control_prefix,
        ),
        RawTextKind::Pass => state.text.clone(),
    };
    txt.replace(&rewritten, ContentType::Html);
    states.pop_front();
    Ok(())
}

fn rewrite_inline_script(
    source: &str,
    kind: &str,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> String {
    if source.trim().is_empty() {
        return String::new();
    }
    let module = kind == "module";
    let ctx = RewriteContext::new(target_url, control_prefix, tab_id, runtime_token);
    match js::swc_rewriter::rewrite_script(source, module, ctx) {
        Ok(code) => escape_inline_script_sentinel(&code),
        Err(_) => block_script_source(),
    }
}

fn rewrite_inline_style(source: &str, target_url: &str, control_prefix: &str) -> String {
    if source.trim().is_empty() {
        return String::new();
    }
    css::rewrite(source, target_url, control_prefix).unwrap_or_default()
}

fn block_script_source() -> String {
    "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');".to_string()
}

fn escape_inline_script_sentinel(code: &str) -> String {
    let mut out = String::new();
    let lower = code.to_ascii_lowercase();
    let mut start = 0usize;
    while let Some(offset) = lower[start..].find("</script") {
        let pos = start + offset;
        out.push_str(&code[start..pos]);
        out.push_str("<\\/script");
        start = pos + "</script".len();
    }
    if start == 0 {
        return code.to_string();
    }
    out.push_str(&code[start..]);
    out
}

fn drop_control_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
) {
    for attr in attr_names(el) {
        if attr.to_ascii_lowercase().starts_with("data-zp-event-") {
            el.remove_attribute(&attr);
        }
    }
    for attr in [
        "data-zp-target-url",
        "data-zp-target-srcset",
        "data-zp-blocked-url",
        "data-zp-blocked-rel",
        "data-zp-integrity",
        "data-zp-target-nonce",
        "data-zp-blocked-srcset",
    ] {
        el.remove_attribute(attr);
    }
}

fn rewrite_meta_or_blocked_element<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    tag: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    if tag == "meta"
        && meta_policy_kind(&el.get_attribute("http-equiv").unwrap_or_default()) == "drop"
    {
        el.remove();
        return Ok(true);
    }
    match blocked_element_kind(tag) {
        "object" | "embed" => {
            el.replace(&blocked_placeholder(tag), ContentType::Html);
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn blocked_placeholder(kind: &str) -> String {
    format!(
        r#"<div class="zp-blocked-embed" data-zp-blocked="{}">ZeroProxy blocked {} content</div>"#,
        escape_html_attr(kind),
        escape_html_text(kind)
    )
}

fn escape_html_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&#34;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn rewrite_link_attrs<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let rel = el.get_attribute("rel").unwrap_or_default();
    match link_rel_kind(&rel) {
        "blocked" => rewrite_blocked_link(el, &rel),
        "icon" => rewrite_icon_link(el, target_url, control_prefix),
        "stylesheet" => rewrite_stylesheet_link(el, target_url, control_prefix),
        _ => Ok(()),
    }
}

fn rewrite_blocked_link<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    rel: &str,
) -> lol_html::HandlerResult {
    let href = el.get_attribute("href").unwrap_or_default();
    el.remove_attribute("rel");
    el.remove_attribute("href");
    el.set_attribute("data-zp-blocked-rel", rel)?;
    if !href.trim().is_empty() {
        el.set_attribute("data-zp-blocked-url", href.trim())?;
    }
    Ok(())
}

fn rewrite_icon_link<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let Some(raw) = el.get_attribute("href") else {
        return Ok(());
    };
    let target = resolve_target_url(&raw, target_url, control_prefix);
    el.set_attribute("href", "data:application/x-zeroproxy-icon,1")?;
    if target.ok {
        el.set_attribute("data-zp-target-url", &target.target)?;
        return Ok(());
    }
    if !raw.trim().is_empty() {
        el.set_attribute("data-zp-blocked-url", raw.trim())?;
    }
    Ok(())
}

fn rewrite_stylesheet_link<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let Some(raw) = el.get_attribute("href") else {
        return Ok(());
    };
    let out = fetch_url(&raw, target_url, control_prefix);
    if out.ok {
        el.set_attribute("href", &out.url)?;
        el.set_attribute("data-zp-target-url", &out.target)?;
        return Ok(());
    }
    if !raw.trim().is_empty() {
        el.set_attribute("href", &out.url)?;
        el.set_attribute("data-zp-blocked-url", raw.trim())?;
    }
    Ok(())
}

fn rewrite_passive_attr<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    attr: &str,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let Some(raw) = el.get_attribute(attr) else {
        return Ok(());
    };
    let out = fetch_url(&raw, target_url, control_prefix);
    if out.ok {
        el.set_attribute(attr, &out.url)?;
        el.set_attribute("data-zp-target-url", &out.target)?;
        return Ok(());
    }
    el.set_attribute(attr, &out.url)?;
    el.set_attribute("data-zp-blocked-url", &raw)?;
    Ok(())
}

fn rewrite_navigation_attr<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    attr: &str,
    target_url: &str,
    control_prefix: &str,
    servers: &[String],
) -> lol_html::HandlerResult {
    let Some(raw) = el.get_attribute(attr) else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Ok(());
    }
    let target = resolve_target_url(&raw, target_url, control_prefix);
    if target.ok {
        match share_url::new_with_servers(&target.target, servers) {
            Ok(route) => {
                el.set_attribute(attr, &route)?;
                el.set_attribute("data-zp-target-url", &target.target)?;
            }
            Err(_) => {
                el.set_attribute(attr, "#")?;
                el.set_attribute("data-zp-blocked-url", trimmed)?;
            }
        }
        return Ok(());
    }
    el.set_attribute(attr, "#")?;
    el.set_attribute("data-zp-blocked-url", trimmed)?;
    Ok(())
}

fn rewrite_srcset_attr<H: lol_html::HandlerTypes>(
    el: &mut lol_html::html_content::Element<'_, '_, H>,
    target_url: &str,
    control_prefix: &str,
) -> lol_html::HandlerResult {
    let Some(raw) = el.get_attribute("srcset") else {
        return Ok(());
    };
    let out = srcset(&raw, target_url, control_prefix);
    if out.ok {
        el.set_attribute("srcset", &out.url)?;
        el.set_attribute("data-zp-target-srcset", &out.target)?;
        return Ok(());
    }
    el.set_attribute("srcset", &format!("{control_prefix}error/POLICY_BLOCKED"))?;
    el.set_attribute("data-zp-blocked-srcset", &raw)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, VecDeque};

    use lol_html::{element, rewrite_str, text, RewriteStrSettings};
    use serde_json::Value;

    use super::{rewrite_document, DocumentOptions, StreamingDocumentRewriter};

    const INJECTION_INVENTORY: &str =
        include_str!("../../../internal/htmltx/testdata/injection_inventory.json");

    struct Inventory {
        scripts: BTreeSet<String>,
        control_attrs: BTreeSet<String>,
        srcdocs: Vec<String>,
    }

    impl Inventory {
        fn new() -> Self {
            Self {
                scripts: BTreeSet::new(),
                control_attrs: BTreeSet::new(),
                srcdocs: Vec::new(),
            }
        }

        fn extend(&mut self, other: Inventory) {
            self.scripts.extend(other.scripts);
            self.control_attrs.extend(other.control_attrs);
            self.srcdocs.extend(other.srcdocs);
        }
    }

    fn collect_inventory(source: &str, scope: &str) -> Inventory {
        let scripts = std::rc::Rc::new(std::cell::RefCell::new(BTreeSet::new()));
        let attrs = std::rc::Rc::new(std::cell::RefCell::new(BTreeSet::new()));
        let srcdocs = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let script_text =
            std::rc::Rc::new(std::cell::RefCell::new(VecDeque::<Option<String>>::new()));
        let scope_for_script = scope.to_string();
        let scope_for_text = scope.to_string();
        let scope_for_attr = scope.to_string();
        let scripts_for_element = std::rc::Rc::clone(&scripts);
        let scripts_for_text = std::rc::Rc::clone(&scripts);
        let attrs_for_element = std::rc::Rc::clone(&attrs);
        let srcdocs_for_element = std::rc::Rc::clone(&srcdocs);
        let script_text_for_element = std::rc::Rc::clone(&script_text);
        let script_text_for_text = std::rc::Rc::clone(&script_text);

        rewrite_str(
            source,
            RewriteStrSettings {
                element_content_handlers: vec![
                    element!("script", move |el| {
                        if let Some(src) = el.get_attribute("src") {
                            if src == "/zp/assets/runtime-prelude.js" {
                                scripts_for_element
                                    .borrow_mut()
                                    .insert(format!("{scope_for_script}|src|{src}"));
                            }
                        } else {
                            script_text_for_element
                                .borrow_mut()
                                .push_back(Some(String::new()));
                        }
                        Ok(())
                    }),
                    text!("script", move |txt| {
                        let mut states = script_text_for_text.borrow_mut();
                        let Some(state) = states.front_mut() else {
                            return Ok(());
                        };
                        if let Some(buf) = state {
                            buf.push_str(txt.as_str());
                        }
                        if txt.last_in_text_node() {
                            if let Some(Some(body)) = states.pop_front() {
                                let inline = if body.contains("__ZP_BOOT") {
                                    Some("boot-config")
                                } else if body.contains("__ZP_SET_BASE") {
                                    Some("base-sync")
                                } else {
                                    None
                                };
                                if let Some(inline) = inline {
                                    scripts_for_text
                                        .borrow_mut()
                                        .insert(format!("{scope_for_text}|inline|{inline}"));
                                }
                            }
                        }
                        Ok(())
                    }),
                    element!("*", move |el| {
                        for attr in el.attributes() {
                            let name = attr.name();
                            if name.starts_with("data-zp-") {
                                attrs_for_element.borrow_mut().insert(format!(
                                    "{}|{}|{}|{}",
                                    scope_for_attr,
                                    el.tag_name(),
                                    name,
                                    attr.value()
                                ));
                            }
                        }
                        if matches!(el.tag_name().as_str(), "iframe" | "frame") {
                            if let Some(srcdoc) = el.get_attribute("srcdoc") {
                                srcdocs_for_element
                                    .borrow_mut()
                                    .push(srcdoc.replace("&quot;", "\""));
                            }
                        }
                        Ok(())
                    }),
                ],
                ..RewriteStrSettings::new()
            },
        )
        .expect("inventory scan should parse rewritten HTML");

        Inventory {
            scripts: std::rc::Rc::try_unwrap(scripts)
                .expect("scripts still shared")
                .into_inner(),
            control_attrs: std::rc::Rc::try_unwrap(attrs)
                .expect("attrs still shared")
                .into_inner(),
            srcdocs: std::rc::Rc::try_unwrap(srcdocs)
                .expect("srcdocs still shared")
                .into_inner(),
        }
    }

    fn expected_inventory() -> Inventory {
        let json: Value =
            serde_json::from_str(INJECTION_INVENTORY).expect("inventory JSON should be valid");
        let mut inv = Inventory::new();
        for item in json["scripts"].as_array().expect("scripts array") {
            let scope = item["scope"].as_str().expect("script scope");
            if let Some(src) = item["src"].as_str() {
                inv.scripts.insert(format!("{scope}|src|{src}"));
            } else {
                inv.scripts.insert(format!(
                    "{}|inline|{}",
                    scope,
                    item["inline"].as_str().expect("inline script label")
                ));
            }
        }
        for item in json["controlAttrs"].as_array().expect("controlAttrs array") {
            inv.control_attrs.insert(format!(
                "{}|{}|{}|{}",
                item["scope"].as_str().expect("attr scope"),
                item["tag"].as_str().expect("attr tag"),
                item["name"].as_str().expect("attr name"),
                item["value"].as_str().expect("attr value")
            ));
        }
        inv
    }

    #[test]
    fn streaming_rewriter_matches_string_rewriter_across_chunk_boundaries() {
        let source = r#"<html><head><title>한글</title></head><body><script>window.location.href="/next";</script><img src="/로고.png"><iframe srcdoc="<script>window.parent.location.href='/x'</script>"></iframe></body></html>"#;
        let prelude = r#"<script nonce=zp>boot()</script><script nonce=zp src="/zp/assets/runtime-prelude.js"></script>"#;
        let full = rewrite_document(
            source,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: prelude,
                tab_id: "tab-1",
                runtime_token: "rt-1",
            },
        )
        .expect("string document rewrite should succeed");
        let mut stream = StreamingDocumentRewriter::new(DocumentOptions {
            target_url: "https://example.com/app/page.html",
            control_prefix: "/zp/",
            servers: &[],
            runtime_prelude: prelude,
            tab_id: "tab-1",
            runtime_token: "rt-1",
        });
        let mut out = String::new();
        for chunk in source.as_bytes().chunks(7) {
            out.push_str(&stream.write(chunk).expect("stream chunk should rewrite"));
        }
        out.push_str(&stream.end().expect("stream end should rewrite"));
        assert_eq!(out, full);
        assert!(out.contains("runtime-prelude.js"));
        assert!(out.contains("__zp_set"));
    }
    #[test]
    fn rewrites_passive_subresources_with_lol_html() {
        let out = rewrite_document(
            r#"<body><img src="/logo.png" srcset="/small.png 1x, ../large.png 2x"><video poster="poster.jpg"><source src="../media.webm"></video><svg><use href="/icons.svg#icon-a"></use></svg><img src="data:image/png;base64,AAAA"></body>"#,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: "",
                tab_id: "",
                runtime_token: "",
            },
        )
        .expect("document rewrite should succeed");

        for want in [
            r#"src="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flogo.png""#,
            r#"data-zp-target-url="https://example.com/logo.png""#,
            r#"srcset="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fsmall.png 1x, /zp/api/fetch?url=https%3A%2F%2Fexample.com%2Flarge.png 2x""#,
            r#"data-zp-target-srcset="https://example.com/small.png 1x, https://example.com/large.png 2x""#,
            r#"poster="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fapp%2Fposter.jpg""#,
            r#"src="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fmedia.webm""#,
            r#"href="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Ficons.svg#icon-a""#,
            r#"data-zp-target-url="https://example.com/icons.svg#icon-a""#,
            r#"src="/zp/error/POLICY_BLOCKED""#,
            r#"data-zp-blocked-url="data:image/png;base64,AAAA""#,
        ] {
            assert!(out.contains(want), "missing {want} in {out}");
        }

        for forbidden in [
            r#"src="/logo.png""#,
            r#"poster="poster.jpg""#,
            r#"src="../media.webm""#,
        ] {
            assert!(!out.contains(forbidden), "raw attribute survived in {out}");
        }
    }

    #[test]
    fn rewrites_link_policy_with_lol_html() {
        let out = rewrite_document(
            r#"<head><link rel="preconnect" href="https://cdn.example/"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="touch.png"><link rel="stylesheet" media="print" onload="this.media='all'; this.onload=null;" href="/app.css"><link rel="stylesheet" href="data:text/css,x"></head>"#,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: "",
                tab_id: "",
                runtime_token: "",
            },
        )
        .expect("document rewrite should succeed");

        for want in [
            r#"data-zp-blocked-rel="preconnect""#,
            r#"data-zp-blocked-url="https://cdn.example/""#,
            r#"href="data:application/x-zeroproxy-icon,1""#,
            r#"data-zp-target-url="https://example.com/favicon.ico""#,
            r#"data-zp-target-url="https://example.com/app/touch.png""#,
            r#"href="/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fapp.css""#,
            r#"data-zp-target-url="https://example.com/app.css""#,
            r#"data-zp-event-onload=""#,
            r#"__zp_runEvent"#,
            r#"href="/zp/error/POLICY_BLOCKED""#,
            r#"data-zp-blocked-url="data:text/css,x""#,
        ] {
            assert!(out.contains(want), "missing {want} in {out}");
        }

        for forbidden in [
            r#"<link rel="preconnect""#,
            r#"<link href="https://cdn.example/""#,
            r#"href="/favicon.ico""#,
            r#"href="touch.png""#,
            r#"href="/app.css""#,
            r#" onload="#,
            r#"data-zp-blocked-onload"#,
        ] {
            assert!(
                !out.contains(forbidden),
                "raw link policy survived {forbidden} in {out}"
            );
        }
    }

    #[test]
    fn drops_meta_policy_and_blocks_embeds_with_lol_html() {
        let out = rewrite_document(
            r#"<head><meta http-equiv="refresh" content="0;url=https://evil.test/"><meta http-equiv="Content-Security-Policy" content="script-src https://policy.example"><meta name="viewport" content="width=device-width"></head><body><object data="/movie.swf"><param name="x" value="y"></object><embed src="/movie.swf"><p>after</p></body>"#,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: "",
                tab_id: "",
                runtime_token: "",
            },
        )
        .expect("document rewrite should succeed");

        for want in [
            r#"<meta name="viewport" content="width=device-width">"#,
            r#"data-zp-blocked="object""#,
            "ZeroProxy blocked object content",
            r#"data-zp-blocked="embed""#,
            "ZeroProxy blocked embed content",
            "<p>after</p>",
        ] {
            assert!(out.contains(want), "missing {want} in {out}");
        }

        for forbidden in [
            "http-equiv=\"refresh\"",
            "Content-Security-Policy",
            "policy.example",
            "<object",
            "<param",
            "<embed",
            "movie.swf",
        ] {
            assert!(
                !out.contains(forbidden),
                "dropped or blocked element survived {forbidden} in {out}"
            );
        }
    }

    #[test]
    fn rewrites_navigation_attrs_with_lol_html() {
        let out = rewrite_document(
            r##"<body><a href="/next" data-zp-target-url="https://attacker.test/">n</a><a href="#x">hash</a><form action="submit"><button formaction="/alt">go</button></form><iframe src="/child"></iframe><a href="javascript:alert(1)">bad</a><iframe src="data:text/html,frame"></iframe></body>"##,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: "",
                tab_id: "",
                runtime_token: "",
            },
        )
        .expect("document rewrite should succeed");

        for want in [
            r#"href="/zp/p/"#,
            r#"action="/zp/p/"#,
            r#"formaction="/zp/p/"#,
            r#"src="/zp/p/"#,
            "#k=",
            r#"data-zp-target-url="https://example.com/next""#,
            r#"data-zp-target-url="https://example.com/app/submit""#,
            r#"data-zp-target-url="https://example.com/alt""#,
            r#"data-zp-target-url="https://example.com/child""#,
            r##"href="#x""##,
            r##"href="#" data-zp-blocked-url="javascript:alert(1)""##,
            r##"src="#" data-zp-blocked-url="data:text/html,frame""##,
        ] {
            assert!(out.contains(want), "missing {want} in {out}");
        }

        for forbidden in [
            r#"https://attacker.test/"#,
            r#"href="/next""#,
            r#"action="submit""#,
            r#"formaction="/alt""#,
            r#"src="/child""#,
            r#"href="javascript:"#,
            r#"src="data:"#,
        ] {
            assert!(
                !out.contains(forbidden),
                "raw navigation policy survived {forbidden} in {out}"
            );
        }
    }

    #[test]
    fn injects_runtime_prelude_once_with_lol_html() {
        let prelude = r#"<script nonce=zp src="/zp/assets/runtime-prelude.js"></script>"#;
        for source in [
            "<html><head><title>x</title></head><body>ok</body></html>",
            "<html><body>ok</body></html>",
            "<p>fragment</p>",
        ] {
            let out = rewrite_document(
                source,
                DocumentOptions {
                    target_url: "https://example.com/app/page.html",
                    control_prefix: "/zp/",
                    servers: &[],
                    runtime_prelude: prelude,
                    tab_id: "",
                    runtime_token: "",
                },
            )
            .expect("document rewrite should succeed");
            assert_eq!(
                out.matches(prelude).count(),
                1,
                "bad prelude count in {out}"
            );
        }
    }

    #[test]
    fn injection_inventory_matches_lol_html_document_snapshot() {
        let prelude = r#"<script nonce=zp>globalThis.__ZP_BOOT={};document.currentScript.remove();</script><script nonce=zp src="/zp/assets/runtime-prelude.js"></script>"#;
        let out = rewrite_document(
            r#"<html><head><base href="/base/"><link rel="preconnect" href="https://cdn.example/"><link rel="icon" href="/favicon.ico"><script src="/early.js" integrity="sha384-i" nonce="targetnonce"></script></head><body><a href="/next">next</a><form action="/dir/submit"><button formaction="/alt">go</button></form><object data="/movie.swf"></object><iframe src="/child" srcdoc="<p>child</p>"></iframe></body></html>"#,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: prelude,
                tab_id: "",
                runtime_token: "",
            },
        )
        .expect("document rewrite should succeed");

        let mut observed = collect_inventory(&out, "document");
        for srcdoc in observed.srcdocs.clone() {
            observed.extend(collect_inventory(&srcdoc, "document/srcdoc"));
        }

        let expected = expected_inventory();
        assert_eq!(
            observed.scripts, expected.scripts,
            "injected script inventory changed in {out}"
        );
        assert_eq!(
            observed.control_attrs, expected.control_attrs,
            "control attribute inventory changed in {out}"
        );
    }

    #[test]
    fn rewrites_script_style_importmap_and_srcdoc_with_lol_html() {
        let prelude = r#"<script nonce=zp>boot()</script><script nonce=zp src="/zp/assets/runtime-prelude.js"></script>"#;
        let out = rewrite_document(
            r#"<body onload="location.href='/boot'"><script src="/app.js" integrity="sha384-i" nonce="target-nonce"></script><script type="module" src="/entry.js"></script><script>window.location.href="<\/script>";</script><script type="module">import "./dep.js"; window.location.href;</script><script type="importmap">{"imports":{"a":"./a.js"}}</script><style>body{background:url("/bg.png")}</style><button onclick="return location.href"></button><iframe srcdoc="<p>x</p><script src='/child.js'></script>"></iframe></body>"#,
            DocumentOptions {
                target_url: "https://example.com/app/page.html",
                control_prefix: "/zp/",
                servers: &[],
                runtime_prelude: prelude,
                tab_id: "tab-1",
                runtime_token: "rt-1",
            },
        )
        .expect("document rewrite should succeed");

        for want in [
            r#"src="/zp/api/script?kind=classic&u=https%3A%2F%2Fexample.com%2Fapp.js&tab=tab-1&rt=rt-1""#,
            r#"src="/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fentry.js&tab=tab-1&rt=rt-1""#,
            r#"data-zp-target-url="https://example.com/app.js""#,
            r#"data-zp-target-url="https://example.com/entry.js""#,
            r#"data-zp-integrity="sha384-i""#,
            r#"data-zp-target-nonce="target-nonce""#,
            r#"nonce="zp""#,
            r#"data-zp-static-script="1""#,
            r#"<\/script>"#,
            r#"/zp/api/script?kind=module&u=https%3A%2F%2Fexample.com%2Fapp%2Fdep.js&tab=tab-1&rt=rt-1"#,
            r#""a":"/zp/api/script?kind=module\u0026rt=rt-1\u0026tab=tab-1\u0026u=https%3A%2F%2Fexample.com%2Fapp%2Fa.js""#,
            r#"url("/zp/api/fetch?url=https%3A%2F%2Fexample.com%2Fbg.png")"#,
            r#"data-zp-event-onload=""#,
            r#"data-zp-event-onclick=""#,
            r#"__zp_runEvent"#,
            r#"srcdoc="<p>x</p><script nonce=zp>boot()</script><script nonce=zp src=&quot;/zp/assets/runtime-prelude.js&quot;></script>"#,
            r#"/zp/api/script?kind=classic&u=https%3A%2F%2Fexample.com%2Fchild.js&tab=tab-1&rt=rt-1&quot; data-zp-target-url=&quot;https://example.com/child.js&quot; nonce=&quot;zp&quot;"#,
        ] {
            assert!(out.contains(want), "missing {want} in {out}");
        }

        for forbidden in [
            r#" onload="#,
            r#" onclick="#,
            r#"data-zp-blocked-onload"#,
            r#"data-zp-blocked-onclick"#,
            r#" integrity="sha384-i""#,
            r#" nonce="target-nonce""#,
            r#"src="/app.js""#,
            r#"href="</script>""#,
        ] {
            assert!(
                !out.contains(forbidden),
                "raw script/style policy survived {forbidden} in {out}"
            );
        }
    }
}
