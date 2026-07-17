use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use css_rewriter::{Error as CssError, rewrite_declaration_list, rewrite_stylesheet};
use html5gum::{Token, Tokenizer};
use js_compiler::{SourceKind, compile_for_abi, inline_source_map};
use lol_html::{
    HtmlRewriter, MemorySettings, Settings, element, end_tag, html_content::ContentType, text,
};
use parking_lot::Mutex;
use policy_core::{
    Context, Decision, InventoryDisposition, InventoryParsing, ResourceDescriptor, ResourceKind,
    canonicalize, csp_allows_inline, decide, html_attribute_inventory,
};
use serde::Serialize;
use std::{collections::BTreeMap, sync::Arc};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("HTML rewrite failed")]
    Rewrite,
    #[error("URL policy failed")]
    Policy,
    #[error("runtime already injected")]
    DuplicateRuntime,
}

const TOKENIZER_MAX_MEMORY_BYTES: usize = 2 << 20;
const STYLE_METADATA_ATTRIBUTE: &str = "data-zp-style-v2";
const CSS_PROJECTION_FRAGMENT: &str = "#zp-css-v2=";

fn css_projection_route(route: &str, raw: &str, target: &str) -> Result<String, Error> {
    if route.contains('#') {
        return Err(Error::Policy);
    }
    let payload = serde_json::to_vec(&serde_json::json!({"raw": raw, "target": target}))
        .map_err(|_| Error::Rewrite)?;
    Ok(format!(
        "{route}{CSS_PROJECTION_FRAGMENT}{}",
        URL_SAFE_NO_PAD.encode(payload)
    ))
}

fn style_metadata_value(source: &str) -> String {
    URL_SAFE_NO_PAD.encode(source.as_bytes())
}
fn decode_html_attribute_value(value: &str) -> Result<String, Error> {
    let mut source = String::with_capacity(value.len() + 20);
    source.push_str("<i data=\"");
    for character in value.chars() {
        if character == '"' {
            source.push_str("&quot;");
        } else {
            source.push(character);
        }
    }
    source.push_str("\">");
    for token in Tokenizer::new(source.as_str()) {
        let token = token.map_err(|_| Error::Rewrite)?;
        if let Token::StartTag(tag) = token {
            for (name, attribute) in tag.attributes {
                if name.as_ref() == b"data" {
                    return String::from_utf8(attribute.value.as_ref().to_vec())
                        .map_err(|_| Error::Rewrite);
                }
            }
        }
    }
    Err(Error::Rewrite)
}

fn inline_script_source_kind(type_attribute: Option<String>) -> Result<Option<SourceKind>, Error> {
    let type_essence = type_attribute
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match type_essence.as_str() {
        ""
        | "text/javascript"
        | "application/javascript"
        | "text/ecmascript"
        | "application/ecmascript"
        | "text/jscript"
        | "text/livescript" => Ok(Some(SourceKind::ClassicScriptInline)),
        "module" => Ok(Some(SourceKind::ModuleScript)),
        "importmap" => Ok(None),
        "speculationrules" => Err(Error::Policy),
        _ => Ok(None),
    }
}

const RUNTIME_LOAD_GUARD: &str = r#"(()=>{const pending="data-zp-runtime-pending",bootstrap="data-zp-cookie-bootstrap",guardAttribute="data-zp-runtime-guard",key=__RUNTIME_GUARD_KEY__;let active=true;const cleanup=()=>{removeEventListener("error",resource,true);removeEventListener("error",runtime)},fail=()=>{if(!active)return;active=false;const script=document.querySelector(`script[${pending}]`);script?.removeAttribute(bootstrap);script?.removeAttribute(pending);script?.removeAttribute(guardAttribute);cleanup();delete globalThis[key];document.open();document.write("<!doctype html><title>ZeroProxy blocked</title><body>ZeroProxy blocked this document because its privacy runtime could not be loaded.</body>");document.close()},resource=event=>{if(event.target?.tagName==="SCRIPT"&&event.target.hasAttribute(pending))fail()},runtime=event=>{if(event.target===window)fail()};addEventListener("error",resource,true);addEventListener("error",runtime);Object.defineProperty(globalThis,key,{configurable:true,value:Object.freeze({complete(){if(!active)return;active=false;cleanup();delete globalThis[key]}})});document.currentScript.remove()})()"#;

fn runtime_bootstrap(runtime_url: &str) -> Result<(String, String), Error> {
    let Some(index) = runtime_url.rfind("&bootstrap=") else {
        return Ok((runtime_url.to_owned(), String::new()));
    };
    let value = &runtime_url[index + "&bootstrap=".len()..];
    if value.is_empty()
        || value.len() > 4 << 20
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(Error::Policy);
    }
    Ok((runtime_url[..index].to_owned(), value.to_owned()))
}

fn inventory_namespace(namespace_uri: &str) -> &str {
    match namespace_uri {
        "http://www.w3.org/2000/svg" => "svg",
        "http://www.w3.org/1998/Math/MathML" => "mathml",
        _ => "html",
    }
}

fn srcdoc_attribute_value(source: &str) -> String {
    source
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

type Route = dyn Fn(
        &str,
        ResourceKind,
        Option<&str>,
        Option<&str>,
        Option<&str>,
        Option<&str>,
    ) -> Result<String, Error>
    + Send
    + Sync;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ExtractedImportMap {
    pub source: String,
    pub base_url: String,
    pub module_graph_started: bool,
}

pub fn extract_import_maps(
    source: &str,
    document_url: &str,
) -> Result<Vec<ExtractedImportMap>, Error> {
    let document_url = canonicalize(document_url, None)
        .map_err(|_| Error::Policy)?
        .visible;
    let maps = Arc::new(Mutex::new(Vec::new()));
    let active = Arc::new(Mutex::new(None::<ExtractedImportMap>));
    let current_base = Arc::new(Mutex::new(document_url));
    let first_base_seen = Arc::new(Mutex::new(false));
    let module_graph_started = Arc::new(Mutex::new(false));

    let base_for_element = Arc::clone(&current_base);
    let first_base_for_element = Arc::clone(&first_base_seen);
    let maps_for_element = Arc::clone(&maps);
    let active_for_element = Arc::clone(&active);
    let base_for_script = Arc::clone(&current_base);
    let module_graph_for_script = Arc::clone(&module_graph_started);
    let module_graph_for_import_map = Arc::clone(&module_graph_started);
    let module_graph_for_preload = Arc::clone(&module_graph_started);
    let active_for_text = Arc::clone(&active);
    let settings = Settings::new()
        .with_memory_settings(
            MemorySettings::new().with_max_allowed_memory_usage(TOKENIZER_MAX_MEMORY_BYTES),
        )
        .append_element_content_handler(element!("base[href]", move |element| {
            let mut first_base_seen = first_base_for_element.lock();
            if *first_base_seen {
                return Ok(());
            }
            *first_base_seen = true;
            let fallback = base_for_element.lock().clone();
            if let Some(href) = element.get_attribute("href")
                && let Ok(base) = canonicalize(&href, Some(&fallback))
            {
                *base_for_element.lock() = base.visible;
            }
            Ok(())
        }))
        .append_element_content_handler(element!("script[type]", move |element| {
            let type_essence = element
                .get_attribute("type")
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if type_essence == "module" {
                *module_graph_for_script.lock() = true;
            }
            Ok(())
        }))
        .append_element_content_handler(element!("link[rel]", move |element| {
            let module_preload = element
                .get_attribute("rel")
                .unwrap_or_default()
                .split_ascii_whitespace()
                .any(|token| token.eq_ignore_ascii_case("modulepreload"));
            if module_preload {
                *module_graph_for_preload.lock() = true;
            }
            Ok(())
        }))
        .append_element_content_handler(element!("script:not([src])[type]", move |element| {
            let type_essence = element
                .get_attribute("type")
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if type_essence != "importmap" {
                *active_for_element.lock() = None;
                return Ok(());
            }
            *active_for_element.lock() = Some(ExtractedImportMap {
                source: String::new(),
                base_url: base_for_script.lock().clone(),
                module_graph_started: *module_graph_for_import_map.lock(),
            });
            let active_for_end = Arc::clone(&active_for_element);
            let maps_for_end = Arc::clone(&maps_for_element);
            element.on_end_tag(end_tag!(move |_| {
                if let Some(map) = active_for_end.lock().take() {
                    maps_for_end.lock().push(map);
                }
                Ok(())
            }))?;
            Ok(())
        }))
        .append_element_content_handler(text!("script:not([src])[type]", move |chunk| {
            let mut active = active_for_text.lock();
            let Some(map) = active.as_mut() else {
                return Ok(());
            };
            if map.source.len().saturating_add(chunk.as_str().len()) > 1 << 20 {
                return Err(Error::Policy.into());
            }
            map.source.push_str(chunk.as_str());
            Ok(())
        }));
    let mut ignored = Vec::new();
    let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| ignored.extend_from_slice(chunk));
    for chunk in source.as_bytes().chunks(8192) {
        rewriter.write(chunk).map_err(|_| Error::Rewrite)?;
    }
    rewriter.end().map_err(|_| Error::Rewrite)?;
    Ok(maps.lock().clone())
}

pub fn extract_meta_csp(source: &str) -> Result<Vec<String>, Error> {
    let policies = Arc::new(Mutex::new(Vec::new()));
    let policies_for_element = Arc::clone(&policies);
    let settings = Settings::new()
        .with_memory_settings(
            MemorySettings::new().with_max_allowed_memory_usage(TOKENIZER_MAX_MEMORY_BYTES),
        )
        .append_element_content_handler(element!(
            "head meta[http-equiv][content]",
            move |element| {
                if !element
                    .get_attribute("http-equiv")
                    .unwrap_or_default()
                    .trim()
                    .eq_ignore_ascii_case("content-security-policy")
                {
                    return Ok(());
                }
                let content = element.get_attribute("content").unwrap_or_default();
                let mut policies = policies_for_element.lock();
                if content.len() > 64 << 10 || policies.len() >= 16 {
                    return Err(Error::Policy.into());
                }
                policies.push(content);
                Ok(())
            }
        ));
    let mut ignored = Vec::new();
    let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| ignored.extend_from_slice(chunk));
    for chunk in source.as_bytes().chunks(8192) {
        rewriter.write(chunk).map_err(|_| Error::Rewrite)?;
    }
    rewriter.end().map_err(|_| Error::Rewrite)?;
    Ok(policies.lock().clone())
}
pub fn rewrite_document<F>(
    source: &str,
    context: &Context,
    runtime_url: &str,
    virtual_base_url: &str,
    abi_identifier: &str,
    nonce: &str,
    route: F,
) -> Result<String, Error>
where
    F: Fn(
            &str,
            ResourceKind,
            Option<&str>,
            Option<&str>,
            Option<&str>,
            Option<&str>,
        ) -> Result<String, Error>
        + Send
        + Sync
        + 'static,
{
    rewrite_document_inner(
        source,
        context,
        runtime_url,
        virtual_base_url,
        abi_identifier,
        nonce,
        Arc::new(route),
    )
}

fn rewrite_document_inner(
    source: &str,
    context: &Context,
    runtime_url: &str,
    virtual_base_url: &str,
    abi_identifier: &str,
    nonce: &str,
    route: Arc<Route>,
) -> Result<String, Error> {
    if source.contains("data-zp-runtime-v2")
        || source.contains("data-zp-m-v2")
        || source.contains(STYLE_METADATA_ATTRIBUTE)
    {
        return Err(Error::DuplicateRuntime);
    }
    if !valid_abi_identifier(abi_identifier) {
        return Err(Error::Policy);
    }
    let base = Arc::new(Mutex::new(context.effective_base_url.clone()));
    let base_seen = Arc::new(Mutex::new(false));
    let injected = Arc::new(Mutex::new(false));
    let policy_failed = Arc::new(Mutex::new(false));
    let policy_context = Arc::new(context.clone());

    let base_handler = Arc::clone(&base);
    let seen_handler = Arc::clone(&base_seen);
    let inject_state = Arc::clone(&injected);
    let policy_failed_handler = Arc::clone(&policy_failed);
    let policy_context_handler = Arc::clone(&policy_context);
    let base_policy_context = Arc::clone(&policy_context);
    let base_policy_failed = Arc::clone(&policy_failed);
    let base_nonce = nonce.to_owned();
    let base_abi = abi_identifier.to_owned();
    let virtual_base = virtual_base_url.to_owned();
    let inline_script_kind = Arc::new(Mutex::new(None));
    let inline_script_buffer = Arc::new(Mutex::new(String::new()));
    let inline_script_kind_element = Arc::clone(&inline_script_kind);
    let inline_script_kind_text = Arc::clone(&inline_script_kind);
    let inline_script_buffer_text = Arc::clone(&inline_script_buffer);
    let inline_script_nonce = Arc::new(Mutex::new(None::<String>));
    let inline_script_nonce_element = Arc::clone(&inline_script_nonce);
    let inline_script_nonce_text = Arc::clone(&inline_script_nonce);
    let inline_script_context = Arc::clone(&policy_context);
    let inline_script_base_text = Arc::clone(&base);
    let inline_script_element_failed = Arc::clone(&policy_failed);
    let inline_script_text_failed = Arc::clone(&policy_failed);
    let inline_script_abi = abi_identifier.to_owned();
    let inline_script_sequence = Arc::new(Mutex::new(0_u64));
    let inline_script_sequence_text = Arc::clone(&inline_script_sequence);
    let inline_script_target_url = script_source_url(&context.target_url);
    let inline_style_buffer = Arc::new(Mutex::new(String::new()));
    let inline_style_buffer_text = Arc::clone(&inline_style_buffer);
    let inline_style_failed = Arc::clone(&policy_failed);
    let inline_style_context = Arc::clone(&policy_context);
    let inline_style_base = Arc::clone(&base);
    let inline_style_route = Arc::clone(&route);
    let inline_style_id = Arc::new(Mutex::new(None::<String>));
    let inline_style_id_element = Arc::clone(&inline_style_id);
    let inline_style_id_text = Arc::clone(&inline_style_id);
    let inline_style_nonce = Arc::new(Mutex::new(None::<String>));
    let inline_style_nonce_element = Arc::clone(&inline_style_nonce);
    let inline_style_nonce_text = Arc::clone(&inline_style_nonce);
    let inline_style_metadata = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));
    let inline_style_metadata_element = Arc::clone(&inline_style_metadata);
    let inline_style_metadata_text = Arc::clone(&inline_style_metadata);
    let inline_style_sequence = Arc::new(Mutex::new(0_u64));
    let inline_style_sequence_element = Arc::clone(&inline_style_sequence);
    let inline_module_route = Arc::clone(&route);
    let recursive_route = Arc::clone(&route);
    let recursive_context = Arc::clone(&policy_context);
    let recursive_base = Arc::clone(&base);
    let recursive_runtime_url = runtime_url.to_owned();
    let recursive_virtual_base_url = virtual_base_url.to_owned();
    let recursive_abi_identifier = abi_identifier.to_owned();
    let recursive_nonce = nonce.to_owned();
    let (runtime, runtime_bootstrap) = runtime_bootstrap(runtime_url)?;
    let nonce = nonce.to_owned();
    let runtime_guard_key = format!("__zp_runtime_guard_{nonce}");
    let runtime_guard_key_json =
        serde_json::to_string(&runtime_guard_key).map_err(|_| Error::Policy)?;
    let runtime_load_guard =
        RUNTIME_LOAD_GUARD.replace("__RUNTIME_GUARD_KEY__", &runtime_guard_key_json);
    let settings = Settings::new().with_memory_settings(
        MemorySettings::new().with_max_allowed_memory_usage(TOKENIZER_MAX_MEMORY_BYTES),
    )
        .append_element_content_handler(element!("base[href]", move |element| {
            let Some(raw) = element.get_attribute("href") else {
                return Ok(());
            };
            let is_first = !*seen_handler.lock();
            let mut local_context = (*base_policy_context).clone();
            local_context.effective_base_url = if is_first {
                base_handler.lock().clone()
            } else {
                base_policy_context.target_url.clone()
            };
            let descriptor = ResourceDescriptor {
                source_boundary: "html".into(),
                element_namespace: Some(element.namespace_uri().to_owned()),
                element_name: Some("base".into()),
                attribute_name: Some("href".into()),
                resource_kind: ResourceKind::Document,
                raw_value: raw,
                parser_inserted: true,
                request_destination: None,
                script_kind: None,
                worker_kind: None,
                integrity: None,
                nonce: None,
                credentials_mode: None,
            };
            match decide(&local_context, &descriptor) {
                Ok(Decision::VirtualBase { canonical_target }) => {
                    if is_first {
                        *seen_handler.lock() = true;
                        *base_handler.lock() = canonical_target.clone();
                    }
                    element.set_attribute("href", &virtual_base)?;
                    let visible = script_json_string(&canonical_target)?;
                    let metadata = format!(
                        "<script nonce=\"{}\">{}.registerBase(document.currentScript.previousElementSibling,{});document.currentScript.remove()</script>",
                        escape_attr(&base_nonce),
                        base_abi,
                        visible
                    );
                    element.after(&metadata, ContentType::Html);
                    Ok(())
                }
                _ => {
                    *base_policy_failed.lock() = true;
                    Err(Error::Policy.into())
                }
            }
        }))
        .append_element_content_handler(element!("script:not([src])[type]", move |element| {
            let type_essence = element
                .get_attribute("type")
                .unwrap_or_default()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if type_essence == "importmap" {
                element.remove();
            }
            Ok(())
        }))
        .append_element_content_handler(element!("script:not([src])", move |element| {
            *inline_script_nonce_element.lock() = element.get_attribute("nonce");
            match inline_script_source_kind(element.get_attribute("type")) {
                Ok(kind) => *inline_script_kind_element.lock() = kind,
                Err(error) => {
                    *inline_script_element_failed.lock() = true;
                    return Err(error.into());
                }
            }
            Ok(())
        }))
        .append_element_content_handler(text!("script:not([src])", move |chunk| {
            let Some(kind) = *inline_script_kind_text.lock() else {
                return Ok(());
            };
            let mut buffer = inline_script_buffer_text.lock();
            if buffer.len().saturating_add(chunk.as_str().len()) > 1 << 20 {
                *inline_script_text_failed.lock() = true;
                return Err(Error::Policy.into());
            }
            buffer.push_str(chunk.as_str());
            chunk.remove();
            if chunk.last_in_text_node() {
                let source = std::mem::take(&mut *buffer);
                drop(buffer);
                let source_nonce = inline_script_nonce_text.lock().take();
                if !csp_allows_inline(
                    &inline_script_context,
                    "script-src-elem",
                    &source,
                    source_nonce.as_deref(),
                    false,
                ) {
                    *inline_script_text_failed.lock() = true;
                    return Err(Error::Policy.into());
                }
                let compiled = compile_for_abi(&source, kind, &inline_script_abi)
                    .map_err(|_| Error::Policy)?;
                let prefix = if kind == SourceKind::ClassicScriptInline {
                    format!(
                        "{}.registerScript(document.currentScript,{});",
                        inline_script_abi,
                        script_json_string(&source)?
                    )
                } else {
                    let mut sequence = inline_script_sequence_text.lock();
                    let identifier = format!("{}:{}", inline_script_abi, *sequence);
                    *sequence += 1;
                    format!(
                        "{}.registerModuleScript({},{});",
                        inline_script_abi,
                        script_json_string(&identifier)?,
                        script_json_string(&source)?
                    )
                };
                let mut code = compiled.code;
                if kind == SourceKind::ModuleScript {
                    let module_referrer = inline_script_base_text.lock().clone();
                    let mut specifiers = compiled.module_specifiers;
                    specifiers.sort_by_key(|record| std::cmp::Reverse(record.generated_start));
                    let mut previous_start = code.len();
                    for record in specifiers {
                        if record.generated_start > record.generated_end
                            || record.generated_end > previous_start
                            || !code.is_char_boundary(record.generated_start)
                            || !code.is_char_boundary(record.generated_end)
                        {
                            return Err(Error::Policy.into());
                        }
                        let routed = inline_module_route(
                            &record.specifier,
                            ResourceKind::Module,
                            None,
                            None,
                            Some(&record.module_type),
                            Some(&module_referrer),
                        )?;
                        code.replace_range(
                            record.generated_start..record.generated_end,
                            &script_json_string(&routed)?,
                        );
                        previous_start = record.generated_start;
                    }
                }
                let executable = format!("{prefix}{code}");
                let effective_source_url = compiled
                    .source_url
                    .as_deref()
                    .map(script_source_url)
                    .unwrap_or_else(|| inline_script_target_url.clone());
                let source_map = inline_source_map(
                    &source,
                    &executable,
                    prefix.len(),
                    &effective_source_url,
                    &compiled.edit_map,
                    compiled.source_mapping_url.as_deref(),
                )
                .map_err(|_| Error::Rewrite)?;
                let output = format!(
                    "{executable}\n//# sourceURL={effective_source_url}\n//# sourceMappingURL=data:application/json;base64,{source_map}"
                );
                let safe = script_data_safe(&output)?;
                chunk.replace(safe, ContentType::Html);
            }
            Ok(())
        }))
        .append_element_content_handler(element!("style", move |element| {
            *inline_style_nonce_element.lock() = element.get_attribute("nonce");
            let mut sequence = inline_style_sequence_element.lock();
            let id = format!("style-{}", *sequence);
            *sequence = sequence.checked_add(1).ok_or(Error::Policy)?;
            *inline_style_id_element.lock() = Some(id.clone());
            inline_style_metadata_element
                .lock()
                .insert(id.clone(), String::new());
            element.set_attribute(STYLE_METADATA_ATTRIBUTE, &id)?;
            Ok(())
        }))
        .append_element_content_handler(text!("style", move |chunk| {
            let mut buffer = inline_style_buffer_text.lock();
            if buffer.len().saturating_add(chunk.as_str().len()) > 1 << 20 {
                *inline_style_failed.lock() = true;
                return Err(Error::Policy.into());
            }
            buffer.push_str(chunk.as_str());
            chunk.remove();
            if chunk.last_in_text_node() {
                let source = std::mem::take(&mut *buffer);
                drop(buffer);
                let source_nonce = inline_style_nonce_text.lock().take();
                if !csp_allows_inline(
                    &inline_style_context,
                    "style-src-elem",
                    &source,
                    source_nonce.as_deref(),
                    false,
                ) {
                    *inline_style_failed.lock() = true;
                    return Err(Error::Policy.into());
                }
                let id = inline_style_id_text.lock().take().ok_or(Error::Policy)?;
                inline_style_metadata_text
                    .lock()
                    .insert(id, style_metadata_value(&source));
                let mut context = (*inline_style_context).clone();
                context.effective_base_url = inline_style_base.lock().clone();
                let rewritten = rewrite_stylesheet(&source, |raw| {
                    let descriptor = ResourceDescriptor {
                        source_boundary: "html-style-block".into(),
                        element_namespace: Some("http://www.w3.org/1999/xhtml".into()),
                        element_name: Some("style".into()),
                        attribute_name: None,
                        resource_kind: ResourceKind::Image,
                        raw_value: raw.into(),
                        parser_inserted: true,
                        request_destination: None,
                        script_kind: None,
                        worker_kind: None,
                        integrity: None,
                        nonce: None,
                        credentials_mode: None,
                    };
                    let target = match decide(&context, &descriptor) {
                        Ok(Decision::Fetch {
                            canonical_target, ..
                        }) => canonical_target,
                        Ok(Decision::Pass) => return Ok(raw.into()),
                        _ => return Err(CssError::Blocked),
                    };
                    let routed = inline_style_route(
                        &target,
                        ResourceKind::Image,
                        None,
                        None,
                        None,
                        None,
                    )
                    .map_err(|_| CssError::Blocked)?;
                    css_projection_route(&routed, raw, &target).map_err(|_| CssError::Blocked)
                })
                .map_err(|_| Error::Policy)?;
                chunk.replace(&rewritten.0, ContentType::Text);
            }
            Ok(())
        }))
        .append_element_content_handler(element!("*", move |element| {
                if element.tag_name() == "head" && !*inject_state.lock() {
                    let bootstrap_attribute = if runtime_bootstrap.is_empty() {
                        String::new()
                    } else {
                        format!(" data-zp-cookie-bootstrap=\"{}\"", escape_attr(&runtime_bootstrap))
                    };
                    let boot = format!("<script nonce=\"{}\" data-zp-runtime-v2>{}</script><script nonce=\"{}\" data-zp-runtime-pending data-zp-runtime-guard=\"{}\" src=\"{}\"{}></script>", escape_attr(&nonce), runtime_load_guard, escape_attr(&nonce), escape_attr(&runtime_guard_key), escape_attr(&runtime), bootstrap_attribute);
                    element.prepend(&boot, ContentType::Html);
                    *inject_state.lock() = true;
                }
                let name = element.tag_name();
                let attributes: Vec<_> = element
                    .attributes()
                    .iter()
                    .map(|attribute| {
                        decode_html_attribute_value(&attribute.value())
                            .map(|value| (attribute.name(), value))
                    })
                    .collect::<Result<_, _>>()?;
                let attribute_value = |target: &str| {
                    attributes
                        .iter()
                        .find(|(attribute, _)| attribute == target)
                        .map(|(_, value)| value.clone())
                };
                let link_rel = if name == "link" {
                    attribute_value("rel")
                } else {
                    None
                };
                let internal_script_nonce =
                    if name == "script" && attribute_value("src").is_none() {
                        match inline_script_source_kind(attribute_value("type")) {
                            Ok(Some(_)) => true,
                            Ok(None) => false,
                            Err(error) => {
                                *policy_failed_handler.lock() = true;
                                return Err(error.into());
                            }
                        }
                    } else {
                        false
                    };
                let blocked_refresh = name == "meta"
                    && attributes.iter().any(|(attribute, value)| {
                        attribute == "http-equiv" && value.trim().eq_ignore_ascii_case("refresh")
                    });
                let http_equiv = attributes
                    .iter()
                    .find(|(attribute, _)| attribute == "http-equiv")
                    .map(|(_, value)| value.clone());
                if name == "meta"
                    && http_equiv.as_deref().is_some_and(|value| {
                        value.trim().eq_ignore_ascii_case("content-security-policy")
                            || value.trim().eq_ignore_ascii_case("content-security-policy-report-only")
                    })
                {
                    element.remove();
                    return Ok(());
                }
                let type_essence = attributes
                    .iter()
                    .find(|(attribute, _)| attribute == "type")
                    .map(|(_, value)| value.split(';').next().unwrap_or_default().trim().to_owned());
                let integrity = if matches!(name.as_str(), "script" | "link") {
                    attributes
                        .iter()
                        .find(|(attribute, _)| attribute == "integrity")
                        .map(|(_, value)| value.clone())
                } else {
                    None
                };
                let crossorigin = if matches!(name.as_str(), "script" | "link") {
                    attributes
                        .iter()
                        .find(|(attribute, _)| attribute == "crossorigin")
                        .map(|(_, value)| value.clone())
                } else {
                    None
                };
                let mut visible_metadata = serde_json::Map::new();
                for (attr, value) in attributes.iter().cloned() {
                    if attr == "http-equiv" && blocked_refresh {
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value, "url": null}),
                        );
                        element.remove_attribute(&attr);
                        continue;
                    }
                    if attr == "nonce" && internal_script_nonce {
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value, "url": null}),
                        );
                        continue;
                    }
                    if attr == "integrity" && matches!(name.as_str(), "script" | "link") {
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value, "url": null}),
                        );
                        element.remove_attribute(&attr);
                        continue;
                    }
                    let inventory = html_attribute_inventory(
                        inventory_namespace(element.namespace_uri()),
                        &name,
                        &attr,
                        link_rel.as_deref(),
                        http_equiv.as_deref(),
                        type_essence.as_deref(),
                    );
                    if matches!(
                        inventory,
                        Some(policy_core::InventoryEntry {
                            disposition: InventoryDisposition::RemoveHint,
                            ..
                        })
                    ) {
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value, "url": null}),
                        );
                        element.remove_attribute(&attr);
                        if name == "link" {
                            element.remove_attribute("rel");
                        }
                        continue;
                    }
                    if matches!(
                        inventory,
                        Some(policy_core::InventoryEntry {
                            disposition: InventoryDisposition::VirtualBase,
                            ..
                        })
                    ) {
                        continue;
                    }
                    if matches!(
                        inventory,
                        Some(policy_core::InventoryEntry {
                            parsing: InventoryParsing::Srcdoc,
                            disposition: InventoryDisposition::RecursiveDocument,
                            ..
                        })
                    ) {
                        let mut nested_context = (*recursive_context).clone();
                        nested_context.effective_base_url = recursive_base.lock().clone();
                        let nested_route = Arc::clone(&recursive_route);
                        let nested_source = format!(
                            "<html><head></head><body>{}</body></html>",
                            value.clone()
                        );
                        let rewritten = rewrite_document(
                            &nested_source,
                            &nested_context,
                            &recursive_runtime_url,
                            &recursive_virtual_base_url,
                            &recursive_abi_identifier,
                            &recursive_nonce,
                            move |target, kind, integrity, crossorigin, module_type, module_referrer| {
                                nested_route(target, kind, integrity, crossorigin, module_type, module_referrer)
                            },
                        )?;
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value.clone(), "url": null}),
                        );
                        element.set_attribute(&attr, &srcdoc_attribute_value(&rewritten))?;
                        continue;
                    }
                    if attr.starts_with("on") {
                        if !csp_allows_inline(
                            &policy_context_handler,
                            "script-src-attr",
                            &value,
                            None,
                            true,
                        ) {
                            *policy_failed_handler.lock() = true;
                            return Err(Error::Policy.into());
                        }
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({"attribute": value.clone(), "url": null}),
                        );
                        let compiled = match compile_for_abi(
                            &value,
                            SourceKind::EventHandler,
                            abi_identifier,
                        ) {
                            Ok(result) => result.code,
                            Err(_) => {
                                *policy_failed_handler.lock() = true;
                                return Err(Error::Policy.into());
                            }
                        };
                        element.set_attribute(&attr, &compiled)?;
                        continue;
                    }
                    if attr == "style" {
                        if !csp_allows_inline(
                            &policy_context_handler,
                            "style-src-attr",
                            &value,
                            None,
                            true,
                        ) {
                            *policy_failed_handler.lock() = true;
                            return Err(Error::Policy.into());
                        }
                        let css_urls = Mutex::new(serde_json::Map::new());
                        let mut css_context = (*policy_context_handler).clone();
                        css_context.effective_base_url = base.lock().clone();
                        let rewritten = match rewrite_declaration_list(&value, |raw| {
                                let descriptor = ResourceDescriptor {
                                    source_boundary: "html-style-attribute".into(),
                                    element_namespace: Some(element.namespace_uri().to_owned()),
                                    element_name: Some(name.clone()),
                                    attribute_name: Some("style".into()),
                                    resource_kind: ResourceKind::Image,
                                    raw_value: raw.into(),
                                    parser_inserted: true,
                                    request_destination: None,
                                    script_kind: None,
                                    worker_kind: None,
                                    integrity: None,
                                    nonce: None,
                                    credentials_mode: None,
                                };
                                let target = match decide(&css_context, &descriptor) {
                                    Ok(Decision::Fetch {
                                        canonical_target, ..
                                    }) => canonical_target,
                                    Ok(Decision::Pass) => return Ok(raw.into()),
                                    _ => return Err(CssError::Blocked),
                                };
                                let routed =
                                    route(&target, ResourceKind::Image, None, None, None, None)
                                        .map_err(|_| CssError::Blocked)?;
                                let projected = css_projection_route(&routed, raw, &target)
                                    .map_err(|_| CssError::Blocked)?;
                                css_urls
                                    .lock()
                                    .insert(projected.clone(), serde_json::Value::String(target));
                                Ok(projected)
                        }) {
                            Ok((output, _)) => output,
                            Err(_) => {
                                *policy_failed_handler.lock() = true;
                                return Err(Error::Policy.into());
                            }
                        };
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({
                                "attribute": value.clone(),
                                "url": null,
                                "css_urls": css_urls.lock().clone()
                            }),
                        );
                        element.set_attribute(&attr, &rewritten)?;
                        continue;
                    }
                    if matches!(
                        inventory,
                        Some(policy_core::InventoryEntry {
                            parsing: InventoryParsing::Srcset,
                            ..
                        })
                    ) {
                        let resource_urls = Mutex::new(serde_json::Map::new());
                        let mut srcset_context = (*policy_context_handler).clone();
                        srcset_context.effective_base_url = base.lock().clone();
                        let rewritten = rewrite_srcset(&value, |raw| {
                            let descriptor = ResourceDescriptor {
                                source_boundary: "html-srcset".into(),
                                element_namespace: Some(element.namespace_uri().to_owned()),
                                element_name: Some(name.clone()),
                                attribute_name: Some(attr.clone()),
                                resource_kind: inventory
                                    .and_then(|entry| entry.resource_kind)
                                    .ok_or(Error::Policy)?,
                                raw_value: raw.into(),
                                parser_inserted: true,
                                request_destination: None,
                                script_kind: None,
                                worker_kind: None,
                                integrity: None,
                                nonce: None,
                                credentials_mode: None,
                            };
                            match decide(&srcset_context, &descriptor) {
                                Ok(Decision::Pass) => Ok(raw.into()),
                                Ok(Decision::Fetch {
                                    canonical_target, ..
                                }) => {
                                    let routed = route(
                                        &canonical_target,
                                        inventory
                                            .and_then(|entry| entry.resource_kind)
                                            .ok_or(Error::Policy)?,
                                        None,
                                        None,
                                        None,
                                        None,
                                    )?;
                                    resource_urls.lock().insert(
                                        routed.clone(),
                                        serde_json::Value::String(canonical_target),
                                    );
                                    Ok(routed)
                                }
                                _ => Err(Error::Policy),
                            }
                        });
                        visible_metadata.insert(
                            attr.clone(),
                            serde_json::json!({
                                "attribute": value.clone(),
                                "url": null,
                                "resource_urls": resource_urls.lock().clone()
                            }),
                        );
                        element.set_attribute(&attr, &rewritten)?;
                        continue;
                    }
                    let Some(inventory) = inventory else {
                        continue;
                    };
                    if matches!(inventory.disposition, InventoryDisposition::Block) {
                        *policy_failed_handler.lock() = true;
                        return Err(Error::Policy.into());
                    }
                    let Some(kind) = inventory.resource_kind else {
                        continue;
                    };
                    let raw_value = value.clone();
                    let current = base.lock().clone();
                    let mut local_context = (*policy_context_handler).clone();
                    local_context.effective_base_url = current;
                    let descriptor = ResourceDescriptor {
                        source_boundary: "html".into(),
                        element_namespace: Some(element.namespace_uri().to_owned()),
                        element_name: Some(name.clone()),
                        attribute_name: Some(attr.clone()),
                        resource_kind: kind,
                        raw_value: value,
                        parser_inserted: true,
                        request_destination: None,
                        script_kind: None,
                        worker_kind: None,
                        integrity: integrity.clone(),
                        nonce: attribute_value("nonce"),
                        credentials_mode: None,
                    };
                    let target = match decide(&local_context, &descriptor) {
                        Ok(Decision::Fetch {
                            canonical_target, ..
                        })
                        | Ok(Decision::Script {
                            canonical_target, ..
                        })
                        | Ok(Decision::Navigate { canonical_target, .. }) => canonical_target,
                        Ok(Decision::Pass) => continue,
                        _ => {
                            *policy_failed_handler.lock() = true;
                            return Err(Error::Policy.into());
                        }
                    };
                    visible_metadata.insert(
                        attr.clone(),
                        serde_json::json!({"attribute": raw_value, "url": target.clone()}),
                    );
                    let routed = match route(
                        &target,
                        kind,
                        if (name == "script" && attr == "src")
                            || (name == "link" && attr == "href")
                        {
                            integrity.as_deref()
                        } else {
                            None
                        },
                        if (name == "script" && attr == "src")
                            || (name == "link" && attr == "href")
                        {
                            crossorigin.as_deref()
                        } else {
                            None
                        },
                        None,
                        None,
                    ) {
                        Ok(route) => route,
                        Err(error) => {
                            *policy_failed_handler.lock() = true;
                            return Err(error.into());
                        }
                    };
                    element.set_attribute(&attr, &routed)?;
                }
                if internal_script_nonce {
                    if !visible_metadata.contains_key("nonce") {
                        visible_metadata.insert(
                            "nonce".into(),
                            serde_json::json!({"attribute": null, "url": null}),
                        );
                    }
                        if let Some(record) = visible_metadata
                            .get_mut("nonce")
                            .and_then(serde_json::Value::as_object_mut)
                        {
                            record.insert("order".into(), serde_json::json!(attributes.len()));
                        }
                    element.set_attribute("nonce", &nonce)?;
                }
                for (order, (attribute, _)) in attributes.iter().enumerate() {
                    if let Some(record) = visible_metadata
                        .get_mut(attribute)
                        .and_then(serde_json::Value::as_object_mut)
                    {
                        record.insert("order".into(), serde_json::json!(order));
                    }
                }
                if !visible_metadata.is_empty() {
                    let metadata = URL_SAFE_NO_PAD
                        .encode(serde_json::to_vec(&visible_metadata).map_err(|_| Error::Rewrite)?);
                    element.set_attribute("data-zp-m-v2", &metadata)?;
                }
                Ok(())
            }));
    let mut output = Vec::with_capacity(source.len());
    {
        let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| {
            output.extend_from_slice(chunk);
        });
        for chunk in source.as_bytes().chunks(8192) {
            rewriter.write(chunk).map_err(|_| {
                if *policy_failed.lock() {
                    Error::Policy
                } else {
                    Error::Rewrite
                }
            })?;
        }
        rewriter.end().map_err(|_| {
            if *policy_failed.lock() {
                Error::Policy
            } else {
                Error::Rewrite
            }
        })?;
    }
    let mut output = String::from_utf8(output).map_err(|_| Error::Rewrite)?;
    for (id, encoded) in inline_style_metadata.lock().iter() {
        let placeholder = format!("{STYLE_METADATA_ATTRIBUTE}=\"{id}\"");
        let replacement = format!("{STYLE_METADATA_ATTRIBUTE}=\"{encoded}\"");
        if !output.contains(&placeholder) {
            return Err(Error::Rewrite);
        }
        output = output.replacen(&placeholder, &replacement, 1);
    }
    if !*injected.lock() {
        return Err(Error::Rewrite);
    }
    Ok(output)
}
fn rewrite_srcset<F>(source: &str, mut route: F) -> String
where
    F: FnMut(&str) -> Result<String, Error>,
{
    fn whitespace(byte: u8) -> bool {
        matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
    }
    let bytes = source.as_bytes();
    let mut position = 0;
    let mut edits = Vec::new();
    while position < bytes.len() {
        while position < bytes.len() && (whitespace(bytes[position]) || bytes[position] == b',') {
            position += 1;
        }
        if position == bytes.len() {
            break;
        }
        let start = position;
        while position < bytes.len() && !whitespace(bytes[position]) {
            position += 1;
        }
        let mut end = position;
        while end > start && bytes[end - 1] == b',' {
            end -= 1;
        }
        let ended_with_separator = end < position;
        if end > start {
            let replacement = route(&source[start..end]).unwrap_or_else(|_| "data:,".into());
            edits.push((start, end, replacement));
        }
        if ended_with_separator {
            continue;
        }
        if position < bytes.len() && bytes[position] == b',' {
            position += 1;
            continue;
        }
        let mut parentheses = 0_u32;
        while position < bytes.len() {
            match bytes[position] {
                b'(' => parentheses = parentheses.saturating_add(1),
                b')' => parentheses = parentheses.saturating_sub(1),
                b',' if parentheses == 0 => {
                    position += 1;
                    break;
                }
                _ => {}
            }
            position += 1;
        }
    }
    let mut output = source.to_owned();
    for (start, end, replacement) in edits.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    output
}

fn script_data_safe(source: &str) -> Result<&str, Error> {
    let blocked = source
        .as_bytes()
        .windows(8)
        .any(|window| window.eq_ignore_ascii_case(b"</script"));
    if blocked {
        Err(Error::Policy)
    } else {
        Ok(source)
    }
}

fn script_json_string(value: &str) -> Result<String, Error> {
    serde_json::to_string(value)
        .map(|encoded| {
            encoded
                .replace('<', "\\u003c")
                .replace('>', "\\u003e")
                .replace('&', "\\u0026")
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029")
        })
        .map_err(|_| Error::Rewrite)
}
fn script_source_url(value: &str) -> String {
    value
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
        .replace('\u{2028}', "%E2%80%A8")
        .replace('\u{2029}', "%E2%80%A9")
}

fn valid_abi_identifier(value: &str) -> bool {
    value.strip_prefix("__zp_abi_").is_some_and(|suffix| {
        suffix.len() == 48 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}
fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn rewrite_html(
    source: &str,
    context_json: &str,
    runtime_url: &str,
    virtual_base_url: &str,
    abi_identifier: &str,
    nonce: &str,
    route: &js_sys::Function,
) -> Result<String, wasm_bindgen::JsValue> {
    let context: Context = serde_json::from_str(context_json)
        .map_err(|_| wasm_bindgen::JsValue::from_str("invalid HTML context"))?;
    let route = route.clone();
    rewrite_document(
        source,
        &context,
        runtime_url,
        virtual_base_url,
        abi_identifier,
        nonce,
        move |url, kind, integrity, crossorigin, module_type, module_referrer| {
            route
                .call6(
                    &wasm_bindgen::JsValue::NULL,
                    &wasm_bindgen::JsValue::from_str(url),
                    &wasm_bindgen::JsValue::from_str(&format!("{kind:?}")),
                    integrity
                        .map(wasm_bindgen::JsValue::from_str)
                        .as_ref()
                        .unwrap_or(&wasm_bindgen::JsValue::NULL),
                    crossorigin
                        .map(wasm_bindgen::JsValue::from_str)
                        .as_ref()
                        .unwrap_or(&wasm_bindgen::JsValue::NULL),
                    module_type
                        .map(wasm_bindgen::JsValue::from_str)
                        .as_ref()
                        .unwrap_or(&wasm_bindgen::JsValue::NULL),
                    module_referrer
                        .map(wasm_bindgen::JsValue::from_str)
                        .as_ref()
                        .unwrap_or(&wasm_bindgen::JsValue::NULL),
                )
                .map_err(|_| Error::Policy)?
                .as_string()
                .ok_or(Error::Policy)
        },
    )
    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn extract_import_maps_json(
    source: &str,
    document_url: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    serde_json::to_string(
        &extract_import_maps(source, document_url)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?,
    )
    .map_err(|_| wasm_bindgen::JsValue::from_str("import map serialization failed"))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn extract_meta_csp_json(source: &str) -> Result<String, wasm_bindgen::JsValue> {
    serde_json::to_string(
        &extract_meta_csp(source)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?,
    )
    .map_err(|_| wasm_bindgen::JsValue::from_str("CSP metadata serialization failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL};
    fn encoded_attribute_values(source: &str, expected_name: &[u8]) -> Vec<String> {
        let mut values = Vec::new();
        for token in Tokenizer::new(source) {
            let Token::StartTag(tag) = token.unwrap() else {
                continue;
            };
            for (name, attribute) in tag.attributes {
                if name.as_ref() == expected_name {
                    values.push(String::from_utf8(attribute.value.as_ref().to_vec()).unwrap());
                }
            }
        }
        values
    }
    fn static_metadata(source: &str) -> Vec<serde_json::Value> {
        encoded_attribute_values(source, b"data-zp-m-v2")
            .into_iter()
            .map(|encoded| serde_json::from_slice(&BASE64_URL.decode(encoded).unwrap()).unwrap())
            .collect()
    }
    fn css_projection_payloads(source: &str) -> Vec<serde_json::Value> {
        source
            .match_indices(CSS_PROJECTION_FRAGMENT)
            .map(|(index, _)| {
                let encoded = source[index + CSS_PROJECTION_FRAGMENT.len()..]
                    .chars()
                    .take_while(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                    })
                    .collect::<String>();
                serde_json::from_slice(&BASE64_URL.decode(encoded).unwrap()).unwrap()
            })
            .collect()
    }
    fn csp_context(target_csp: Vec<String>) -> Context {
        Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/index.html".into(),
            effective_base_url: "https://example.test/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp,
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        }
    }

    #[test]
    fn first_base_changes_later_resolution_and_injects_once() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/a".into(),
            effective_base_url: "https://example.test/a/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head><base href='/b/'></head><body><img src='x.png'></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/{}", url.replace("https://example.test/", ""))),
        )
        .unwrap();
        assert!(output.contains("data-zp-runtime-v2"));
        assert!(output.contains("href=\"https://proxy.test/_zp/vbase/document/\""));
        assert!(output.contains("src=\"/_zp/b/x.png\""));
        assert_eq!(output.matches("data-zp-runtime-v2").count(), 1);
    }

    #[test]
    fn extracts_inline_import_maps_without_reading_non_maps() {
        let maps = extract_import_maps(
            "<script type=importmap>{\"imports\":{\"pkg\":\"/pkg.js\"}}</script><script>ignored()</script><script type='importmap; charset=utf-8'>{\"imports\":{\"other\":\"/other.js\"}}</script>",
            "https://example.test/app/index.html",
        )
        .unwrap();
        assert_eq!(
            maps,
            vec![
                ExtractedImportMap {
                    source: "{\"imports\":{\"pkg\":\"/pkg.js\"}}".into(),
                    base_url: "https://example.test/app/index.html".into(),
                    module_graph_started: false,
                },
                ExtractedImportMap {
                    source: "{\"imports\":{\"other\":\"/other.js\"}}".into(),
                    base_url: "https://example.test/app/index.html".into(),
                    module_graph_started: false,
                },
            ]
        );
    }

    #[test]
    fn import_maps_capture_parser_time_base_and_module_graph_state() {
        let maps = extract_import_maps(
            "<script type=importmap>{\"imports\":{\"early\":\"./early.js\"}}</script>\
             <base href='/assets/'>\
             <script type=importmap>{\"imports\":{\"late\":\"./late.js\"}}</script>\
             <base href='/ignored/'>\
             <link rel='stylesheet MODULEPRELOAD' href='./preload.mjs'>\
             <script type=importmap></script>",
            "https://example.test/app/index.html",
        )
        .unwrap();
        assert_eq!(
            maps,
            vec![
                ExtractedImportMap {
                    source: "{\"imports\":{\"early\":\"./early.js\"}}".into(),
                    base_url: "https://example.test/app/index.html".into(),
                    module_graph_started: false,
                },
                ExtractedImportMap {
                    source: "{\"imports\":{\"late\":\"./late.js\"}}".into(),
                    base_url: "https://example.test/assets/".into(),
                    module_graph_started: false,
                },
                ExtractedImportMap {
                    source: String::new(),
                    base_url: "https://example.test/assets/".into(),
                    module_graph_started: true,
                },
            ]
        );
    }
    #[test]
    fn base_metadata_cannot_break_out_of_trusted_script() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head><base href='https://example.test/?q=</script><img id=escape>'></head><body></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(!output.contains("</script><img id=escape>"));
        assert!(!output.contains("<img id=escape>"));
        assert_eq!(output.matches(".registerBase(").count(), 1);
    }
    #[test]
    fn later_base_cannot_activate_real_target_after_first_is_removed() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head><base href='/first/'><base href='https://escape.test/second/'></head><body><img src='x.png'></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/{}", url.replace("https://example.test/", ""))),
        )
        .unwrap();
        assert_eq!(
            output
                .matches("href=\"https://proxy.test/_zp/vbase/document/\"")
                .count(),
            2
        );
        assert!(!output.contains("href=\"https://escape.test"));
        assert!(output.contains("src=\"/_zp/first/x.png\""));
    }
    #[test]
    fn inline_script_handler_and_css_share_rewrite_boundaries() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/path/index.html".into(),
            effective_base_url: "https://example.test/path/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let source = format!(
            "<html><head><style>{}.a{{background:url('/a.png')}}</style></head><body><div style=\"background:url(b.png)\" onclick=\"window\"></div><script>window; obj?.x && (()=>1)()</script></body></html>",
            " ".repeat(8191)
        );
        let output = rewrite_document(
            &source,
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_111111111111111111111111111111111111111111111111",
            "nonce",
            |url, _, _, _, _, _| Ok(format!("/route/{url}")),
        )
        .unwrap();
        assert!(output.contains("/route/https://example.test/a.png"));
        assert!(output.contains("/route/https://example.test/path/b.png"));
        let metadata = static_metadata(&output);
        assert!(metadata.iter().any(|record| {
            record
                .get("style")
                .and_then(|style| style.get("css_urls"))
                .and_then(serde_json::Value::as_object)
                .is_some_and(|urls| {
                    urls.iter().any(|(internal, target)| {
                        internal.starts_with("/route/https://example.test/path/b.png#zp-css-v2=")
                            && target.as_str() == Some("https://example.test/path/b.png")
                    })
                })
        }));
        assert!(css_projection_payloads(&output).iter().any(|payload| {
            payload.get("raw").and_then(serde_json::Value::as_str) == Some("b.png")
                && payload.get("target").and_then(serde_json::Value::as_str)
                    == Some("https://example.test/path/b.png")
        }));
        assert!(
            output
                .contains("__zp_abi_111111111111111111111111111111111111111111111111.scope.window")
        );
        assert!(output.contains("obj?.x"));
        assert!(output.contains("&&"));
        assert!(output.contains("=>"));
        assert!(!output.contains("&amp;&amp;"));
        assert!(!output.contains("=&gt;"));
        assert!(output.matches("nonce=\"nonce\"").count() >= 3);
        let oversized = format!(
            "<html><head><{}",
            "x".repeat(TOKENIZER_MAX_MEMORY_BYTES + 1)
        );
        assert!(matches!(
            rewrite_document(
                &oversized,
                &context,
                "/_zp/runtime.js",
                "https://proxy.test/_zp/vbase/document/",
                "__zp_abi_111111111111111111111111111111111111111111111111",
                "nonce",
                |url, _, _, _, _, _| Ok(format!("/route/{url}")),
            ),
            Err(Error::Rewrite)
        ));
    }

    #[test]
    fn external_integrity_is_routed_but_not_browser_enforced() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/index.html".into(),
            effective_base_url: "https://example.test/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let route_calls = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured_calls = route_calls.clone();
        let output = rewrite_document(

            "<html><head><script src='/app.js' integrity='sha384-AAAA' crossorigin='use-credentials'></script><link rel='stylesheet' href='/app.css' integrity='sha512-BBBB' crossorigin></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_111111111111111111111111111111111111111111111111",
            "nonce",
            move |url, _, integrity, crossorigin, _, _| {
                captured_calls.lock().push((
                    url.to_owned(),
                    integrity.map(str::to_owned),
                    crossorigin.map(str::to_owned),
                ));
                Ok(format!("/route/{url}"))
            },
        )
        .unwrap();
        assert_eq!(
            route_calls.lock().clone(),
            vec![
                (
                    "https://example.test/app.js".into(),
                    Some("sha384-AAAA".into()),
                    Some("use-credentials".into())
                ),
                (
                    "https://example.test/app.css".into(),
                    Some("sha512-BBBB".into()),
                    Some("".into())
                )
            ]
        );
        assert!(!output.contains(" integrity="));
        let metadata = static_metadata(&output);
        let integrity_values = metadata.iter().filter_map(|record| {
            record
                .get("integrity")
                .and_then(|integrity| integrity.get("attribute"))
                .and_then(serde_json::Value::as_str)
        });
        assert_eq!(
            integrity_values.collect::<Vec<_>>(),
            vec!["sha384-AAAA", "sha512-BBBB"]
        );
    }
    #[test]
    fn inline_nonce_keeps_original_value_out_of_execution_attribute() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/index.html".into(),
            effective_base_url: "https://example.test/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head></head><body><script id='absent'>1</script><script id='empty' nonce=''>2</script><script id='value' nonce='target-nonce'>3</script></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_111111111111111111111111111111111111111111111111",
            "internal-nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(!output.contains("nonce=\"target-nonce\""));
        assert!(!output.contains("<script id=\"absent\">"));
        assert_eq!(output.matches("nonce=\"internal-nonce\"").count(), 5);
        let metadata = static_metadata(&output);
        assert!(metadata.iter().any(|record| {
            record
                .get("nonce")
                .and_then(|nonce| nonce.get("attribute"))
                .is_some_and(serde_json::Value::is_null)
        }));
        assert!(metadata.iter().any(|record| {
            record
                .get("nonce")
                .and_then(|nonce| nonce.get("attribute"))
                .and_then(serde_json::Value::as_str)
                == Some("target-nonce")
        }));
    }

    #[test]
    fn script_data_serialization_fails_closed_on_end_tags() {
        assert!(matches!(
            script_data_safe("const a='</ScRiPt><img src=x onerror=escape()>'"),
            Err(Error::Policy)
        ));
        assert_eq!(
            script_data_safe("const value = 1 && (()=>2)()").unwrap(),
            "const value = 1 && (()=>2)()"
        );
    }
    #[test]
    fn srcset_rewrites_candidates_independently_and_preserves_descriptors() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/path/index.html".into(),
            effective_base_url: "https://example.test/path/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head></head><body><img srcset='ok.png 1x, https://example.test:8443/blocked.png 2x, data:image/png;base64,AAAA 3x'></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_111111111111111111111111111111111111111111111111",
            "nonce",
            |url, _, _, _, _, _| Ok(format!("/route/{url}")),
        )
        .unwrap();
        assert!(output.contains("/route/https://example.test/path/ok.png 1x"));
        assert!(output.contains("data:, 2x"));
        assert!(output.contains("data:image/png;base64,AAAA 3x"));
        let metadata = static_metadata(&output);
        assert!(metadata.iter().any(|record| {
            record
                .get("srcset")
                .and_then(|srcset| srcset.get("resource_urls"))
                .and_then(|urls| urls.get("/route/https://example.test/path/ok.png"))
                .and_then(serde_json::Value::as_str)
                == Some("https://example.test/path/ok.png")
        }));
    }

    #[test]
    fn srcset_parser_rewrites_url_spans_only() {
        let output = rewrite_srcset(
            "  first.png 1x, data:image/svg+xml,%3Csvg,%3E 2x, blocked.png calc(100vw - 1px)",
            |url| {
                if url == "blocked.png" {
                    Err(Error::Policy)
                } else if url.starts_with("data:") {
                    Ok(url.into())
                } else {
                    Ok(format!("/route/{url}"))
                }
            },
        );
        assert_eq!(
            output,
            "  /route/first.png 1x, data:image/svg+xml,%3Csvg,%3E 2x, data:, calc(100vw - 1px)"
        );
    }

    #[test]
    fn srcset_parser_keeps_internal_commas_in_url_tokens() {
        let output = rewrite_srcset("image,name.png 1x, next.png 2x", |url| {
            Ok(format!("/route/{url}"))
        });
        assert_eq!(output, "/route/image,name.png 1x, /route/next.png 2x");
    }

    #[test]
    fn srcset_parser_starts_a_candidate_after_a_trailing_comma() {
        let output = rewrite_srcset("a.png, b.png 2x", |url| Ok(format!("/route/{url}")));
        assert_eq!(output, "/route/a.png, /route/b.png 2x");
    }
    #[test]
    fn blocked_base_cannot_influence_later_urls() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let result = rewrite_document(
            "<html><head><base href='https://example.test:8443/private/'></head><body><img src='x.png'></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        );
        assert!(matches!(result, Err(Error::Policy)));
    }
    #[test]
    fn blocked_port_aborts_document_rewrite() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let result = rewrite_document(
            "<html><head></head><body><img src='https://example.test:8443/x'></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        );
        assert!(matches!(result, Err(Error::Policy)));
    }
    #[test]
    fn refresh_is_inert_and_speculation_rules_fail_closed() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let output = rewrite_document(
            "<html><head><meta http-equiv='refresh' content='0;url=https://escape.test/'></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(!output.contains("http-equiv=\"refresh\""));
        assert!(static_metadata(&output).iter().any(|record| {
            record
                .get("http-equiv")
                .and_then(|http_equiv| http_equiv.get("attribute"))
                .and_then(serde_json::Value::as_str)
                == Some("refresh")
        }));
        let speculation = rewrite_document(
            "<html><head><script type='speculationrules'>{}</script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        );
        assert!(matches!(speculation, Err(Error::Policy)));
        for source in [
            "<a attributionsrc='https://escape.test/report'>link</a>",
            "<img attributionsrc='https://escape.test/report'>",
            "<script attributionsrc='https://escape.test/report'></script>",
            "<portal src='https://escape.test/'></portal>",
            "<fencedframe src='https://escape.test/'></fencedframe>",
        ] {
            let result = rewrite_document(
                source,
                &context,
                "/_zp/runtime.js",
                "https://proxy.test/_zp/vbase/document/",
                "__zp_abi_000000000000000000000000000000000000000000000000",
                "nonce",
                |url, _, _, _, _, _| Ok(url.into()),
            );
            assert!(matches!(result, Err(Error::Policy)), "{source}");
        }
        let import_map = rewrite_document(
            "<html><head><script type='importmap'>{\"imports\":{\"pkg\":\"https://escape.test/pkg.js\"}}</script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(!import_map.contains("escape.test/pkg.js"));
        assert!(!import_map.contains("type=\"importmap\""));
        let nested = rewrite_document(
            "<html><head><link rel='preconnect' href='https://escape.test/'></head><body><iframe srcdoc=\"&lt;img src='https://example.test/nested.png'&gt;\"></iframe></body></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, kind, _, _, _, _| Ok(format!("/_zp/{kind:?}/{url}")),
        )
        .unwrap();
        assert!(!nested.contains("preconnect"));
        assert!(nested.contains("data-zp-runtime-v2"));
        assert!(nested.contains("&lt;html"));
        assert!(nested.contains("/_zp/Image/"), "{nested}");
        assert!(static_metadata(&nested).iter().any(|record| {
            record
                .get("srcdoc")
                .and_then(|srcdoc| srcdoc.get("attribute"))
                .and_then(serde_json::Value::as_str)
                == Some("<img src='https://example.test/nested.png'>")
        }));
    }
    #[test]
    fn source_url_directive_cannot_be_terminated() {
        assert_eq!(
            script_source_url("https://example.test/<x>/%3C\nalert(1)\r\u{2028}\u{2029}"),
            "https://example.test/%3Cx%3E/%3C%0Aalert(1)%0D%E2%80%A8%E2%80%A9"
        );
    }
    #[test]
    fn inline_source_map_preserves_parsed_directives_and_original_source() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/index.html".into(),
            effective_base_url: "https://example.test/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let script = "const decoy='//# sourceURL=decoy.js';\n//# sourceURL=authored.js\n//# sourceMappingURL=authored.map";
        let output = rewrite_document(
            &format!("<html><head></head><body><script>{script}</script></body></html>"),
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(output.contains("//# sourceURL=authored.js"));
        let marker = "//# sourceMappingURL=data:application/json;base64,";
        let encoded = output
            .rsplit_once(marker)
            .unwrap()
            .1
            .split('<')
            .next()
            .unwrap();
        let map: serde_json::Value =
            serde_json::from_slice(&BASE64.decode(encoded).unwrap()).unwrap();
        assert_eq!(map["sources"][0], "authored.js");
        assert_eq!(map["sourcesContent"][0], script);
        assert_eq!(
            map["x_zeroproxy_original_source_mapping_url"],
            "authored.map"
        );
        assert!(!map["mappings"].as_str().unwrap().is_empty());
    }
    #[test]
    fn inline_modules_replace_every_literal_specifier_with_routed_identity() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/index.html".into(),
            effective_base_url: "https://example.test/index.html".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let routed = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&routed);
        let output = rewrite_document(
            "<html><head><base href='/assets/'><script type='module'>import value from './dep.js';import data from './data.json' with {type:'json'};globalThis.result=[value,data];</script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            move |url, kind, _, _, module_type, module_referrer| {
                captured.lock().push((
                    url.to_owned(),
                    kind,
                    module_type.map(str::to_owned),
                    module_referrer.map(str::to_owned),
                ));
                Ok(format!(
                    "/module/{}/{}.mjs",
                    module_type.unwrap_or("resource"),
                    captured.lock().len()
                ))
            },
        )
        .unwrap();
        assert!(output.contains("\"/module/javascript/2.mjs\""));
        assert!(output.contains("\"/module/json/1.mjs\" with {type:'json'}"));
        assert_eq!(
            *routed.lock(),
            vec![
                (
                    "./data.json".into(),
                    ResourceKind::Module,
                    Some("json".into()),
                    Some("https://example.test/assets/".into())
                ),
                (
                    "./dep.js".into(),
                    ResourceKind::Module,
                    Some("javascript".into()),
                    Some("https://example.test/assets/".into())
                ),
            ]
        );
    }
    #[test]
    fn runtime_bootstrap_is_carried_outside_the_script_source_url() {
        let context = Context {
            profile_id: "p".into(),
            tab_id: "t".into(),
            document_id: "d".into(),
            virtual_origin: "https://example.test:443".into(),
            virtual_site: "https://example.test".into(),
            target_url: "https://example.test/".into(),
            effective_base_url: "https://example.test/".into(),
            referrer_url: None,
            referrer_policy: "strict-origin-when-cross-origin".into(),
            document_charset: "utf-8".into(),
            target_csp: vec![],
            target_csp_report_only: vec![],
            relay_profile: "test-relay-profile".into(),
            approved_target_ports: vec![80, 443],
            policy_version: 2,
        };
        let secret = "c2VjcmV0";
        let output = rewrite_document(
            "<html><head></head><body></body></html>",
            &context,
            &format!("/_zp/runtime.js#abi=a&bootstrap={secret}"),
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "nonce",
            |url, _, _, _, _, _| Ok(url.into()),
        )
        .unwrap();
        assert!(output.contains("src=\"/_zp/runtime.js#abi=a\""));
        assert!(output.contains(&format!("data-zp-cookie-bootstrap=\"{secret}\"")));
        assert!(!output.contains(&format!("src=\"/_zp/runtime.js#abi=a&bootstrap={secret}\"")));
        assert!(output.contains(
            "data-zp-runtime-pending data-zp-runtime-guard=\"__zp_runtime_guard_nonce\""
        ));
        assert!(output.contains("key=\"__zp_runtime_guard_nonce\""));
        assert!(!output.contains("__RUNTIME_GUARD_KEY__"));
        assert!(!output.contains("__zeroproxyRuntimeLoadGuardV2"));
        let boot = output.find("data-zp-runtime-v2").unwrap();
        let runtime = output.find("data-zp-runtime-pending").unwrap();
        assert!(
            boot < runtime,
            "inline boot record must precede parser-blocking runtime"
        );
        let runtime_tag = &output[runtime..output[runtime..].find('>').unwrap() + runtime + 1];
        assert!(!runtime_tag.contains("async"));
        assert!(!runtime_tag.contains("defer"));
        assert!(output.contains("document.currentScript.remove()"));
        assert!(output.contains("delete globalThis[key]"));
    }
    #[test]
    fn extracts_and_removes_target_meta_csp_before_native_synthetic_enforcement() {
        let source = "<html><head><meta http-equiv='Content-Security-Policy' content=\"script-src 'nonce-target'\">\
            <meta http-equiv='Content-Security-Policy-Report-Only' content=\"default-src 'none'\">\
            <script nonce='target'>globalThis.allowed=true</script></head></html>";
        let policies = extract_meta_csp(source).unwrap();
        assert_eq!(policies, vec!["script-src 'nonce-target'"]);
        assert!(extract_meta_csp("<html><body><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\"></body></html>").unwrap().is_empty());
        let output = rewrite_document(
            source,
            &csp_context(policies),
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "internal-nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/routed?url={url}")),
        )
        .unwrap();
        assert!(
            !output
                .to_ascii_lowercase()
                .contains("content-security-policy")
        );
        assert!(output.contains("nonce=\"internal-nonce\""));
        assert!(output.contains("globalThis.allowed=true"));
    }

    #[test]
    fn target_csp_blocks_disallowed_static_executable_before_route_allocation() {
        let context = csp_context(vec!["default-src 'none'; script-src 'self'".into()]);
        let result = rewrite_document(
            "<html><head><script src='https://cdn.example.test/app.js'></script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "internal-nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/routed?url={url}")),
        );
        assert!(matches!(result, Err(Error::Policy)));
    }

    #[test]
    fn strict_dynamic_requires_parser_script_trust_before_route_allocation() {
        let context = csp_context(vec![
            "script-src 'nonce-trusted' 'strict-dynamic' https://cdn.example.test".into(),
        ]);
        let blocked = rewrite_document(
            "<html><head><script src='https://cdn.example.test/app.js'></script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "internal-nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/routed?url={url}")),
        );
        assert!(matches!(blocked, Err(Error::Policy)));
        let allowed = rewrite_document(
            "<html><head><script nonce='trusted' src='https://unlisted.example.test/app.js'></script></head></html>",
            &context,
            "/_zp/runtime.js",
            "https://proxy.test/_zp/vbase/document/",
            "__zp_abi_000000000000000000000000000000000000000000000000",
            "internal-nonce",
            |url, _, _, _, _, _| Ok(format!("/_zp/routed?url={url}")),
        )
        .unwrap();
        assert!(allowed.contains("/_zp/routed?url=https://unlisted.example.test/app.js"));
    }
}
