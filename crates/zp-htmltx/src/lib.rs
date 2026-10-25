//! ZeroProxy HTML transformer.
//!
//! Uses `lol_html` (Cloudflare's streaming HTML rewriter) to:
//! - rewrite inline `<script>` bodies via `zp-rewriter::rewrite_script` (classic
//!   and module both go through the same parser; module-source-type is selected
//!   by the `<script type="module">` attribute)
//! - rewrite inline `on*` event handler attribute bodies via `zp-rewriter`
//!   with `ScriptKind::EventHandler`
//! - in strict mode, fail-closed: a script that fails to parse is replaced
//!   with a safe `throw new DOMException(...)` (callable from the original
//!   call sites), and event handler attributes are removed.

use lol_html::{doc_text, element, end, html_content::ContentType, text, HtmlRewriter, Settings};
use std::cell::RefCell;
use std::rc::Rc;
use zp_rewriter::{rewrite_script, RewriteOpts, ScriptKind};

/// Boxed output sink for the streaming rewriters. `Box<dyn FnMut(&[u8])>`
/// implements `lol_html::OutputSink` via the blanket `FnMut(&[u8])` impl, so it
/// can be stored as the rewriter's `O` type parameter inside [`HtmlTxn`].
type Sink = Box<dyn FnMut(&[u8])>;

fn tokenizer_err(e: impl std::fmt::Display) -> TransformError {
    TransformError::Tokenizer(e.to_string())
}

#[derive(Debug, Clone)]
pub struct TransformOptions {
    pub target_url: String,
    pub strict: bool,
    /// Emit target scripts as `text/zp-pending` so prelude can execute them
    /// post-OXC-init. Currently unused (scripts execute inline after rewrite).
    pub pending_gate: bool,
    /// Proxy origin (e.g. `http://proxy.localhost:18080`) used to build
    /// absolute SW-routable URLs for subresources. Empty falls back to a
    /// root-relative path, which only works when the page's virtual baseURI
    /// is not overridden; production callers MUST supply this.
    pub proxy_origin: String,
}

#[derive(Debug, Default)]
pub struct TransformResult {
    pub html: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum TransformError {
    #[error("tokenizer error: {0}")]
    Tokenizer(String),
    #[error("rewrite failed for script kind {kind:?}: {reason}")]
    ScriptRewrite { kind: ScriptKind, reason: String },
}

const BLOCKED_SCRIPT: &str =
    "throw new DOMException('Blocked by ZeroProxy rewrite policy','NotSupportedError');";

/// Streaming `Settings` for the attribute / URL pass (Pass 1). Holds the single
/// `element!("*")` handler that rewrites href/src/action/formaction URLs and
/// `on*` / `javascript:` handler bodies. Shared by the buffered `transform`
/// path and the streaming [`HtmlTxn`] so both apply byte-identical rewrites.
fn attr_settings(
    target: String,
    proxy_origin: String,
    strict: bool,
    diagnostics: Rc<RefCell<Vec<String>>>,
) -> Settings<'static, 'static> {
    let diags_for_attr = diagnostics;
    let target_for_attr = target;
    // Real origins that serve frames of other sites (loopback proxies only); a target's `<meta>` CSP must not block them.
    let site_frames = zp_shared::csp::site_frame_source(&proxy_origin);
    // `<base href>` sets the base URL for all subsequent relative URLs in document
    // order. `lol_html` streams in document order, so `<base>` in `<head>` arrives
    // before body subresources, matching the HTML specification.
    let base_for_attr = Rc::new(RefCell::new(target_for_attr.clone()));
    Settings {
        element_content_handlers: vec![
                // on* event handler attributes + javascript: URL attributes.
                // <a href="javascript:CODE">, <form action="javascript:...">,
                // <iframe src="javascript:..."> become harmless `javascript:void(0)`
                // with `data-zp-jsurl` carrying the OXC-rewritten body, executed
                // later by runtime-prelude's delegated click/submit handler.
                element!("*", move |el| {
                    // `tag_name()` is already lowercase per lol_html guarantee
                    // (it normalizes element names). Cache once per element
                    // instead of recomputing inside the per-attribute loop.
                    let tag = el.tag_name();
                    // Leave `<base href>` untouched in the markup so the page realm's
                    // `updateVirtualBase` can read the original value, while recording
                    // the resolved URL as the base for subsequent relative URLs here.
                    if tag == "base" {
                        if let Some(href) = el.get_attribute("href") {
                            let h = href.trim().to_string();
                            if !h.is_empty() {
                                if let Some(abs) = absolute_target_url(&h, &target_for_attr) {
                                    *base_for_attr.borrow_mut() = abs;
                                }
                            }
                        }
                    }
                    // Strip `integrity` (SRI) and back it up to `data-zp-integrity`.
                    // Because scripts and stylesheets are rewritten by the proxy, their
                    // byte contents differ from the original digest and browser SRI checks
                    // would block the resource at parse time before any page-realm sweep runs.
                    // Backing up to `data-zp-integrity` lets `el.integrity` return the
                    // author-supplied value.
                    if matches!(tag.as_str(), "script" | "link") {
                        if let Some(integrity) = el.get_attribute("integrity") {
                            let _ = el.set_attribute("data-zp-integrity", &integrity);
                            let _ = el.remove_attribute("integrity");
                        }
                    }
                    let attr_base = base_for_attr.borrow().clone();
                    // Filter or neutralize target `<meta http-equiv="Content-Security-Policy">`
                    // tags. Unlike response headers, `<meta>` CSP tags in markup would be enforced
                    // by the browser alongside the proxy header policy, blocking rewritten inline
                    // scripts and membrane `eval` calls when the target specifies a nonce or omits
                    // `'unsafe-eval'`. Original values are preserved in `data-zp-blocked-*` attributes
                    // for page scripts that inspect the DOM.
                    if tag == "meta" {
                        let equiv = el
                            .get_attribute("http-equiv")
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase();
                        if equiv == "content-security-policy"
                            || equiv == "content-security-policy-report-only"
                        {
                            // Intersect the meta CSP with required proxy infrastructure sources via
                            // `filter_meta_csp`, or strip `http-equiv`/`content` if no directives remain.
                            // `get_attribute` returns raw attribute text with unescaped HTML entities
                            // (e.g. `default-src &#39;none&#39;;`), so decode entities before filtering
                            // to avoid splitting directives on the `;` inside `&#39;`.
                            let content = decode_url_html_entities(&el.get_attribute("content").unwrap_or_default()).into_owned();
                            let _ = el.set_attribute("data-zp-blocked-http-equiv", &equiv);
                            let _ = el.set_attribute("data-zp-blocked-content", &content);
                            let filtered = zp_shared::csp::filter_meta_csp_with(&content, &site_frames);
                            if filtered.is_empty() {
                                let _ = el.remove_attribute("http-equiv");
                                let _ = el.remove_attribute("content");
                            } else {
                                let _ = el.set_attribute("content", &filtered);
                            }
                        } else if equiv == "origin-trial" {
                            // Neutralize `origin-trial` meta tags so a target cannot enable
                            // origin trials signed for the proxy origin inside our realm.
                            let content = el.get_attribute("content").unwrap_or_default();
                            let _ = el.remove_attribute("http-equiv");
                            let _ = el.set_attribute("data-zp-blocked-http-equiv", &equiv);
                            let _ = el.set_attribute("data-zp-blocked-content", &content);
                            let _ = el.remove_attribute("content");
                        }
                    }
                    // Move `srcdoc` to `data-zp-srcdoc` so the browser parser does not
                    // instantiate an uninstrumented child document before the page-realm
                    // hook runs. The page-realm backstop re-applies the value through the
                    // hooked `srcdoc` setter, which injects the prelude and transforms the HTML.
                    if (tag == "iframe" || tag == "frame") && el.has_attribute("srcdoc") {
                        let doc = el.get_attribute("srcdoc").unwrap_or_default();
                        let _ = el.set_attribute("data-zp-srcdoc", &doc);
                        let _ = el.remove_attribute("srcdoc");
                    }
                    // Move `iframe`/`frame` `src` to `data-zp-frame-src`. Rewriting frame `src`
                    // to `/zp/api/fetch?url=` would bypass the document pipeline and create a
                    // frame without the prelude membrane. The page realm activates the frame
                    // through the share route using its session state.
                    if tag == "iframe" || tag == "frame" {
                        if let Some(src) = el.get_attribute("src") {
                            let t = src.trim();
                            if !t.is_empty() && !starts_with_ascii_ci(t, "about:") {
                                let _ = el.set_attribute("data-zp-frame-src", &src);
                                let _ = el.remove_attribute("src");
                            }
                        }
                    }
                    // `<meta http-equiv="refresh" content="0;url=...">` triggers a top-level
                    // navigation that CSP cannot block. Rewrite the `url=` target to the
                    // proxy `?via=` navigation route.
                    if tag == "meta" {
                        let is_refresh = el
                            .get_attribute("http-equiv")
                            .map(|v| v.trim().eq_ignore_ascii_case("refresh"))
                            .unwrap_or(false);
                        if is_refresh {
                            if let Some(content) = el.get_attribute("content") {
                                if let Some(next) = proxied_meta_refresh(
                                    &content,
                                    &proxy_origin,
                                    "/zp/",
                                    &attr_base,
                                ) {
                                    let _ = el.set_attribute("data-zp-target-url", &content);
                                    let _ = el.set_attribute("content", &next);
                                }
                            }
                        }
                    }
                    // Strip `ping` hyperlink auditing attributes so the browser never issues
                    // direct background POST beacons on click; preserve the value in
                    // `data-zp-blocked-ping` for diagnostics.
                    if tag == "a" || tag == "area" {
                        if let Some(ping) = el.get_attribute("ping") {
                            let _ = el.set_attribute("data-zp-blocked-ping", &ping);
                            let _ = el.remove_attribute("ping");
                        }
                    }
                    // Lazy filter: only snapshot attributes we care about
                    // (URL-bearing href/src/action/formaction or on* handlers).
                    // Avoids cloning all attributes on elements that have neither.
                    // Attribute names from lol_html are already lowercase for HTML.
                    let attrs_snapshot: Vec<(String, String)> = el
                        .attributes()
                        .iter()
                        .filter_map(|a| {
                            let name = a.name();
                            let lower_view = name.as_str();
                            let is_url_attr = matches!(
                                lower_view,
                                "href"
                                    | "xlink:href"
                                    | "src"
                                    | "action"
                                    | "formaction"
                                    | "srcset"
                                    | "imagesrcset"
                                    | "poster"
                                    | "background"
                                    | "data"
                                    | "style"
                            );
                            let is_on_handler =
                                lower_view.starts_with("on") && lower_view.len() > 2;
                            if is_url_attr || is_on_handler {
                                Some((name, a.value()))
                            } else {
                                None
                            }
                        })
                        .collect();
                    for (name, value) in attrs_snapshot {
                        let lower = name.as_str();
                        let is_on_handler = lower.starts_with("on") && lower.len() > 2;
                        // Must match the attribute list in the lazy filter above.
                        let is_url_attr = matches!(
                            lower,
                            "href"
                                | "xlink:href"
                                | "src"
                                | "action"
                                | "formaction"
                                | "srcset"
                                | "imagesrcset"
                                | "poster"
                                | "background"
                                | "data"
                                | "style"
                        );
                        if !is_on_handler && !is_url_attr {
                            continue;
                        }
                        if is_url_attr {
                            // `lol_html` 2.x `Attribute::value()` returns raw attribute text
                            // with literal HTML entities (`&amp;`, `&lt;`, etc.). Decode
                            // entities before percent-encoding so `&amp;` in query strings is
                            // not double-encoded into `%26amp%3B`. Returns `Cow::Borrowed`
                            // when no `&` is present.
                            let decoded = decode_url_html_entities(&value);
                            let trimmed = decoded.trim_start();
                            if !starts_with_ascii_ci(trimmed, "javascript:") {
                                // Subresource URLs must be rewritten to a same-origin SW route
                                // so strict CSP does not block external origins before SW interception.
                                let is_subresource = matches!(
                                    (tag.as_str(), lower),
                                    ("link", "href")
                                        | ("script", "src")
                                        | ("img", "src")
                                        | ("source", "src")
                                        | ("video", "src")
                                        | ("audio", "src")
                                        | ("track", "src")
                                        | ("embed", "src")
                                        // Rewrite `object[data]` so raw target URLs do not remain in
                                        // the DOM; actual plugin loading remains blocked by CSP `object-src 'none'`.
                                        | ("object", "data")
                                        // `<input type=image src>` and `<image>` (tokenized as `image`
                                        // before the parser normalizes it to `img`) issue image requests.
                                        | ("input", "src")
                                        | ("image", "src")
                                        | ("image", "href")
                                        | ("image", "xlink:href")
                                        | ("use", "href")
                                        | ("use", "xlink:href")
                                        // SVG `<script>` loads external scripts via `href` / `xlink:href`.
                                        | ("script", "href")
                                        | ("script", "xlink:href")
                                        | ("feimage", "href")
                                        | ("feimage", "xlink:href")
                                        | ("video", "poster")
                                        | ("body", "background")
                                        | ("table", "background")
                                        | ("td", "background")
                                        | ("th", "background")
                                        | ("tr", "background")
                                );
                                // Rewrite anchor / form / input / button navigation URLs to a
                                // proxy-origin `?via=` URL so browser-native UI actions (hover
                                // status bar, middle-click, ctrl-click, `target="_blank"`, context
                                // menu open/copy) stay inside the proxy. `data-zp-target-url`
                                // stores the resolved target URL for the prelude click handler's
                                // fast path.
                                let is_navigation = matches!(
                                    (tag.as_str(), lower),
                                    ("a", "href")
                                        | ("a", "xlink:href")
                                        | ("area", "href")
                                        | ("form", "action")
                                        | ("input", "formaction")
                                        | ("button", "formaction")
                                );
                                // Inline `style` attributes contain a CSS declaration list rather
                                // than a full stylesheet; wrap in `a{...}` for `rewrite_css` and
                                // strip the wrapper afterward.
                                if lower == "style" {
                                    let wrapped = format!("a{{{}}}", trimmed);
                                    let res = zp_css::rewrite_css(
                                        &wrapped,
                                        &attr_base,
                                        "/zp/",
                                        &proxy_origin,
                                    );
                                    if res.ok {
                                        if let Some(inner) = res
                                            .code
                                            .strip_prefix("a{")
                                            .and_then(|s| s.strip_suffix('}'))
                                        {
                                            if inner != trimmed {
                                                // Stash the author literal so `getAttribute('style')`
                                                // returns the original text.
                                                let _ = el.set_attribute(
                                                    &format!("data-zp-lit-{lower}"),
                                                    &decoded,
                                                );
                                                let _ = el.set_attribute(&name, inner);
                                            }
                                        }
                                    }
                                    continue;
                                }
                                if matches!(
                                    (tag.as_str(), lower),
                                    ("img", "srcset")
                                        | ("source", "srcset")
                                        | ("link", "imagesrcset")
                                ) {
                                    if let Some(next) = proxied_srcset(
                                        trimmed,
                                        &proxy_origin,
                                        "/zp/",
                                        &attr_base,
                                    ) {
                                        let _ = el.set_attribute(
                                            &format!("data-zp-lit-{lower}"),
                                            &decoded,
                                        );
                                        let _ = el.set_attribute(&name, &next);
                                    }
                                    continue;
                                }
                                if is_subresource {
                                    // Encode module script kind into the proxy URL (`/zp/api/script?u=...&kind=module`).
                                    // A Service Worker cannot distinguish module scripts from `crossorigin`
                                    // classic scripts by request headers or mode alone, and `parse_for_kind`
                                    // only detects module syntax when `import`/`export` tokens are present.
                                    // Using the same canonical URL shape as static `import` and `importmap`
                                    // also ensures `modulepreload` and module imports share a single module
                                    // map entry.
                                    let module_fetch = match (tag.as_str(), lower) {
                                        ("script", "src") => el
                                            .get_attribute("type")
                                            .is_some_and(|t| is_module_type(&t)),
                                        ("link", "href") => el.get_attribute("rel").is_some_and(|r| {
                                            r.split_ascii_whitespace()
                                                .any(|t| t.eq_ignore_ascii_case("modulepreload"))
                                        }),
                                        _ => false,
                                    };
                                    let next = if module_fetch {
                                        proxied_module_script_url(trimmed, &attr_base, &proxy_origin)
                                    } else {
                                        proxied_subresource_url(
                                            trimmed,
                                            &proxy_origin,
                                            "/zp/",
                                            &attr_base,
                                        )
                                    };
                                    if let Some(next) = next {
                                        // Replace icon link `href` with an inert data URI so the browser
                                        // parser does not initiate a direct tab-icon download before the
                                        // prelude observer runs. The original URL remains readable via
                                        // the stashes below.
                                        let icon = tag.as_str() == "link"
                                            && lower == "href"
                                            && el.get_attribute("rel").is_some_and(|r| is_icon_link_rel(&r));
                                        let _ = el.set_attribute(&name, if icon { HIDDEN_ICON_HREF } else { &next });
                                        // Stash the author literal so `getAttribute` returns the unrewritten value.
                                        let _ = el.set_attribute(
                                            &format!("data-zp-lit-{lower}"),
                                            &decoded,
                                        );
                                        // Stash the resolved absolute URL so the runtime-prelude can
                                        // return it when target code reads `script.src` or `link.href`
                                        // (e.g. webpack's automatic `publicPath` detection from `currentScript.src`).
                                        if matches!(tag.as_str(), "script" | "link") {
                                            if let Some(abs) =
                                                absolute_target_url(trimmed, &attr_base)
                                            {
                                                let _ =
                                                    el.set_attribute("data-zp-target-url", &abs);
                                            }
                                        }
                                    }
                                } else if is_navigation {
                                    if let Some(abs) =
                                        absolute_target_url(trimmed, &attr_base)
                                    {
                                        if let Some(next) =
                                            proxied_navigation_url(&abs, &proxy_origin, "/zp/")
                                        {
                                            let _ = el.set_attribute(&name, &next);
                                            let _ = el.set_attribute("data-zp-target-url", &abs);
                                            let _ = el.set_attribute(
                                                &format!("data-zp-lit-{lower}"),
                                                &decoded,
                                            );
                                        }
                                    }
                                }
                                continue;
                            }
                            // Extract body after `javascript:` prefix.
                            let prefix_end =
                                trimmed.find(':').map(|i| i + 1).unwrap_or(trimmed.len());
                            let body = trimmed[prefix_end..].to_string();
                            // URL-decode the body (target sites often percent-encode).
                            let body = percent_decode(&body);
                            let opts = RewriteOpts {
                                kind: ScriptKind::EventHandler,
                                target_url: target_for_attr.clone(),
                                strict,
                                proxy_origin: proxy_origin.clone(),
                            };
                            match rewrite_script(&body, &opts) {
                                Ok(r) => {
                                    // Stash rewritten body in data-zp-jsurl; the
                                    // href/action/src becomes the harmless noop
                                    // so native navigation does nothing.
                                    let _ = el.set_attribute(&name, "javascript:void(0)");
                                    let kind_attr = match lower {
                                        "href" => "anchor",
                                        "action" | "formaction" => "form",
                                        "src" => "frame",
                                        _ => "other",
                                    };
                                    let _ = el.set_attribute("data-zp-jsurl", &r.code);
                                    let _ = el.set_attribute("data-zp-jsurl-kind", kind_attr);
                                    // The author's literal, so `getAttribute` still answers with the `javascript:` URL.
                                    let _ = el.set_attribute(&format!("data-zp-lit-{lower}"), &decoded);
                                }
                                Err(e) => {
                                    diags_for_attr.borrow_mut().push(format!(
                                        "javascript: URL rewrite failed for {}: {}",
                                        name, e
                                    ));
                                    let _ = el.set_attribute(&name, "javascript:void(0)");
                                    el.remove_attribute("data-zp-jsurl");
                                }
                            }
                            continue;
                        }
                        // Inline on* event handler attribute body.
                        let opts = RewriteOpts {
                            kind: ScriptKind::EventHandler,
                            target_url: target_for_attr.clone(),
                            strict,
                                proxy_origin: proxy_origin.clone(),
                        };
                        match rewrite_script(&value, &opts) {
                            Ok(r) => {
                                let _ = el.set_attribute(&name, &r.code);
                            }
                            Err(e) => {
                                diags_for_attr
                                    .borrow_mut()
                                    .push(format!("event handler {} rewrite failed: {}", name, e));
                                if strict {
                                    el.remove_attribute(&name);
                                } else {
                                    let _ = el.set_attribute(&name, BLOCKED_SCRIPT);
                                }
                            }
                        }
                    }
                    Ok(())
                }),
            ],
            ..Settings::new()
        }
}

/// Transform target HTML: rewrites inline scripts and `on*` event handlers
/// through `zp-rewriter`. In strict mode failures become safe placeholders.
///
/// Thin wrapper over the streaming [`HtmlTxn`]: it feeds the whole document as a
/// single chunk, so the buffered and streaming paths share one implementation.
/// `HtmlTxn`'s host test pins chunk-invariance.
pub fn transform(html: &str, opts: &TransformOptions) -> Result<TransformResult, TransformError> {
    let mut txn = HtmlTxn::new(opts, String::new());
    let mut out = txn.write(html.as_bytes())?;
    let (tail, diagnostics) = txn.end()?;
    out.extend_from_slice(&tail);
    Ok(TransformResult {
        html: String::from_utf8(out).map_err(tokenizer_err)?,
        diagnostics,
    })
}

/// Streaming `Settings` for the inline-script-body pass (Pass 2). Rewrites
/// `<script>` bodies via `zp-rewriter`. When `prelude` is non-empty it is
/// prepended into the document as raw HTML; `lol_html` does NOT re-tokenize
/// inserted content, so bootstrap `<script>` tags are never script-rewritten.
/// Shared by the buffered `transform` path and [`HtmlTxn`].
fn script_settings(
    target_url: String,
    proxy_origin: String,
    strict: bool,
    diagnostics: Rc<RefCell<Vec<String>>>,
    prelude: String,
) -> Settings<'static, 'static> {
    let target = target_url.clone();
    let diags = diagnostics.clone();
    // Per-element state for the current script: detect external src or non-JS type.
    let current_kind: Rc<RefCell<Option<InlineKind>>> = Rc::new(RefCell::new(None));
    let current_buffer: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let kind_for_el = current_kind.clone();
    let kind_for_text = current_kind.clone();
    let kind_for_end = current_kind.clone();
    let buf_for_text = current_buffer.clone();
    let buf_for_end = current_buffer.clone();
    let target_for_end = target.clone();
    // Dynamic-import URLs inside inline scripts must be proxy-origin absolute
    // (see RewriteOpts::proxy_origin); the end handler rewrites those too.
    let origin_for_end = proxy_origin.clone();
    let diags_for_end = diags.clone();
    // Buffer inline `<style>` text nodes and rewrite embedded URLs (such as
    // `@font-face` `src: url(...)`) at `last_in_text_node` so CSS rules are not
    // split across streaming chunks.
    let style_buffer: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let style_buf_for_text = style_buffer.clone();
    let style_target = target.clone();
    let style_origin = proxy_origin.clone();

    let mut doc_handlers = Vec::new();
    let mut handlers = vec![
                element!("script", move |el| {
                    if el.has_attribute("src") {
                        *kind_for_el.borrow_mut() = None;
                        return Ok(());
                    }
                    let kind = match el.get_attribute("type").as_deref() {
                        Some(t) if is_module_type(&t) => Some(InlineKind::Script(ScriptKind::Module)),
                        // `<script type="importmap">` and `speculationrules` carry
                        // JSON rather than executable code; rewrite their embedded URLs
                        // through the JSON URL rewriters instead of the JS rewriter.
                        Some(t) if t.trim().eq_ignore_ascii_case("importmap") => Some(InlineKind::Importmap),
                        Some(t) if t.trim().eq_ignore_ascii_case("speculationrules") => Some(InlineKind::Speculationrules),
                        Some(t) if !t.is_empty() && !is_javascript_type(t) => None,
                        _ => Some(InlineKind::Script(ScriptKind::Classic)),
                    };
                    *kind_for_el.borrow_mut() = kind;
                    Ok(())
                }),
                text!("style", move |chunk| {
                    style_buf_for_text.borrow_mut().push_str(chunk.as_str());
                    chunk.remove();
                    if chunk.last_in_text_node() {
                        let css = style_buf_for_text.borrow().clone();
                        style_buf_for_text.borrow_mut().clear();
                        // If CSS parsing fails, `rewrite_css` returns the original CSS
                        // (fail-open, matching external stylesheet handling).
                        let res = zp_css::rewrite_css(&css, &style_target, "/zp/", &style_origin);
                        let rewritten = if res.ok { res.code } else { css };
                        // Emit with `ContentType::Html` (raw passthrough) because `<style>` is raw
                        // text in HTML and does not entity-decode its contents; `ContentType::Text`
                        // would escape `>` child combinators and `<` media-query range operators into
                        // `&gt;`/`&lt;`, invalidating the CSS rules.
                        chunk.after(&rewritten, ContentType::Html);
                    }
                    Ok(())
                }),
                text!("script", move |chunk| {
                    if kind_for_text.borrow().is_some() {
                        buf_for_text.borrow_mut().push_str(chunk.as_str());
                        chunk.remove();
                    }
                    if chunk.last_in_text_node() {
                        if let Some(inline_kind) = *kind_for_end.borrow() {
                            let src = buf_for_end.borrow().clone();
                            buf_for_end.borrow_mut().clear();
                            // JSON-carrying script types are data rather than executable code;
                            // rewrite embedded URLs and emit raw JSON without a JS wrapper.
                            match inline_kind {
                                InlineKind::Importmap | InlineKind::Speculationrules => {
                                    let next = match inline_kind {
                                        InlineKind::Importmap => rewrite_importmap_json(&src, &target_for_end, &origin_for_end),
                                        _ => rewrite_speculationrules_json(&src, &target_for_end, &origin_for_end),
                                    };
                                    if let Some(json) = next {
                                        chunk.after(&json, ContentType::Html);
                                    } else {
                                        chunk.after(&src, ContentType::Html);
                                    }
                                    return Ok(());
                                }
                                _ => {}
                            }
                            let kind = match inline_kind {
                                InlineKind::Script(k) => k,
                                _ => unreachable!(),
                            };
                            let opts = RewriteOpts {
                                kind,
                                target_url: target_for_end.clone(),
                                strict,
                                proxy_origin: origin_for_end.clone(),
                            };
                            // Inline scripts up to `MAX_PAGE_REWRITE_INLINE_BYTES` are wrapped with
                            // their unrewritten source in `__ZP_EXEC_INLINE_SCRIPT` /
                            // `__ZP_EXEC_INLINE_MODULE` and rewritten by the page-side rewriter at
                            // execution time, preserving original source text for scripts that inspect
                            // their own `<script>` DOM nodes. Larger scripts are rewritten once here
                            // and wrapped in `__ZP_EXEC_INLINE_REWRITTEN` / `_MODULE` so the prelude
                            // executes them directly without a page-side rewrite.
                            let replacement = if src.len() <= MAX_PAGE_REWRITE_INLINE_BYTES {
                                let wrapper_name = match kind {
                                    ScriptKind::Module => "__ZP_EXEC_INLINE_MODULE",
                                    _ => "__ZP_EXEC_INLINE_SCRIPT",
                                };
                                format!("{}({});", wrapper_name, inline_script_payload(&src))
                            } else { match rewrite_script(&src, &opts) {
                                Ok(r) => {
                                    let payload = inline_script_payload(&r.code);
                                    let wrapper_name = match kind {
                                        ScriptKind::Module => "__ZP_EXEC_INLINE_REWRITTEN_MODULE",
                                        _ => "__ZP_EXEC_INLINE_REWRITTEN",
                                    };
                                    format!("{}({});", wrapper_name, payload)
                                }
                                Err(e) => {
                                    diags_for_end
                                        .borrow_mut()
                                        .push(format!("inline script rewrite failed: {}", e));
                                    if strict {
                                        BLOCKED_SCRIPT.to_string()
                                    } else {
                                        src
                                    }
                                }
                            } };
                            // Use `ContentType::Html` for raw passthrough without HTML escaping;
                            // `<script>` bodies are parsed as raw text and not entity-decoded by
                            // the browser, so escaping `&` into `&amp;` would cause a JS syntax error.
                            chunk.before(&replacement, ContentType::Html);
                        }
                    }
                    Ok(())
                }),
    ];
    if !prelude.is_empty() {
        // Inject the prelude once at the earliest valid anchor in the document:
        // inside `<html>` (before `<head>` and `<body>`), inside `<head>`, inside `<body>`,
        // before the first `<script>`, before the first element of any kind, before the
        // first non-whitespace text node, or at the end of the document if empty.
        // Prepending immediately after `<html>` places the prelude's CSP `<meta>` tag in
        // the implicit `<head>` even when the source HTML omits `<head>`, ensuring the
        // browser enforces the meta CSP before any `<body>` element or inline script runs.
        let injected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        for (selector, before_element) in [("html", false), ("head", false), ("body", false), ("script", true), ("*", true)] {
            let prelude = prelude.clone();
            let injected = injected.clone();
            handlers.push(element!(selector, move |el| {
                if injected.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return Ok(());
                }
                if before_element {
                    el.before(&prelude, ContentType::Html);
                } else {
                    el.prepend(&prelude, ContentType::Html);
                }
                Ok(())
            }));
        }
        let text_prelude = prelude.clone();
        let text_injected = injected.clone();
        doc_handlers.push(doc_text!(move |t| {
            if t.as_str().trim().is_empty() || text_injected.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Ok(());
            }
            t.before(&text_prelude, ContentType::Html);
            Ok(())
        }));
        let end_prelude = prelude.clone();
        doc_handlers.push(end!(move |end| {
            if !injected.swap(true, std::sync::atomic::Ordering::SeqCst) {
                end.append(&end_prelude, ContentType::Html);
            }
            Ok(())
        }));
    }
    Settings {
        element_content_handlers: handlers,
        document_content_handlers: doc_handlers,
        ..Settings::new()
    }
}

/// The streaming HTML transform: two chained `lol_html` rewriters (attribute
/// pass followed by inline-script-body pass) fed incrementally. `write` returns
/// the bytes produced so far; `end` flushes and returns the tail + collected
/// diagnostics. Byte output is independent of chunk boundaries (lol_html's
/// streaming guarantee + a full intermediate buffer between the two passes), so
/// it equals the whole-string `transform`.
pub struct HtmlTxn {
    r1: HtmlRewriter<'static, Sink>,
    r2: HtmlRewriter<'static, Sink>,
    /// Output of the attribute pass; drained into the script pass each `write`.
    mid: Rc<RefCell<Vec<u8>>>,
    /// Final output of the script pass; drained out to the caller each `write`.
    out: Rc<RefCell<Vec<u8>>>,
    diagnostics: Rc<RefCell<Vec<String>>>,
}

impl HtmlTxn {
    /// Build a streaming transform for `opts`. A non-empty `prelude` is injected
    /// at the start of the document (see [`script_settings`]); the buffered `transform`
    /// passes an empty prelude (the SW injects separately on that path).
    pub fn new(opts: &TransformOptions, prelude: String) -> Self {
        let diagnostics: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let mid: Rc<RefCell<Vec<u8>>> = Rc::new(RefCell::new(Vec::new()));
        let out: Rc<RefCell<Vec<u8>>> = Rc::new(RefCell::new(Vec::new()));

        let attr = attr_settings(
            opts.target_url.clone(),
            opts.proxy_origin.clone(),
            opts.strict,
            diagnostics.clone(),
        );
        let script = script_settings(
            opts.target_url.clone(),
            opts.proxy_origin.clone(),
            opts.strict,
            diagnostics.clone(),
            prelude,
        );

        let mid_sink = mid.clone();
        let r1 = HtmlRewriter::new(
            attr,
            Box::new(move |c: &[u8]| mid_sink.borrow_mut().extend_from_slice(c)) as Sink,
        );
        let out_sink = out.clone();
        let r2 = HtmlRewriter::new(
            script,
            Box::new(move |c: &[u8]| out_sink.borrow_mut().extend_from_slice(c)) as Sink,
        );
        HtmlTxn {
            r1,
            r2,
            mid,
            out,
            diagnostics,
        }
    }

    /// Feed a chunk; returns the rewritten bytes produced by it (may be empty
    /// while lol_html buffers an open element across the chunk boundary).
    pub fn write(&mut self, chunk: &[u8]) -> Result<Vec<u8>, TransformError> {
        self.r1.write(chunk).map_err(tokenizer_err)?;
        let mid_bytes = std::mem::take(&mut *self.mid.borrow_mut());
        if !mid_bytes.is_empty() {
            self.r2.write(&mid_bytes).map_err(tokenizer_err)?;
        }
        Ok(std::mem::take(&mut *self.out.borrow_mut()))
    }

    /// Flush both passes; returns the final tail bytes + collected diagnostics.
    /// Consumes self (lol_html's `end` takes the rewriter by value).
    pub fn end(self) -> Result<(Vec<u8>, Vec<String>), TransformError> {
        let HtmlTxn {
            r1,
            r2,
            mid,
            out,
            diagnostics,
        } = self;
        r1.end().map_err(tokenizer_err)?;
        let mid_bytes = std::mem::take(&mut *mid.borrow_mut());
        let mut r2 = r2;
        if !mid_bytes.is_empty() {
            r2.write(&mid_bytes).map_err(tokenizer_err)?;
        }
        r2.end().map_err(tokenizer_err)?;
        let tail = std::mem::take(&mut *out.borrow_mut());
        let diags = Rc::try_unwrap(diagnostics)
            .map(|c| c.into_inner())
            .unwrap_or_else(|rc| rc.borrow().clone());
        Ok((tail, diags))
    }
}

/// Maximum inline script size (256 KiB) wrapped raw for page-side rewriting.
/// Scripts at or below this threshold preserve their unrewritten text in the DOM;
/// larger scripts are rewritten once on the server/SW side.
const MAX_PAGE_REWRITE_INLINE_BYTES: usize = 256 * 1024;

/// Serialise a script body as a JSON string literal suitable for embedding as
/// the argument to `__ZP_EXEC_INLINE_SCRIPT(...)`. Escapes `<` to prevent
/// a closing `</script>` sequence from terminating the wrapper.
fn inline_script_payload(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 2);
    out.push('"');
    for ch in src.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '<' => out.push_str("\\u003c"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Fold `.` and `..` path segments per RFC 3986 section 5.2.4 so URLs resolved
/// here match the canonical URLs produced by `new URL()` and `url::Url::join` in
/// the page realm and Service Worker.
fn normalize_dot_segments(path: &str) -> String {
    // Only fold the path component; leave query and fragment untouched.
    let (path_part, tail) = match path.find(['?', '#']) {
        Some(i) => (&path[..i], &path[i..]),
        None => (path, ""),
    };
    if !path_part.contains("./") && !path_part.ends_with("/.") && !path_part.ends_with("/..") {
        return path.to_string();
    }
    let absolute = path_part.starts_with('/');
    let trailing_slash = path_part.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path_part.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let mut s = String::with_capacity(path.len());
    if absolute {
        s.push('/');
    }
    s.push_str(&out.join("/"));
    // Preserve directory trailing slash if the input ended with `/`, `/.`, or `/..`.
    if (trailing_slash || path_part.ends_with("/.") || path_part.ends_with("/.."))
        && !s.ends_with('/')
    {
        s.push('/');
    }
    s.push_str(tail);
    s
}

/// Resolve a relative URL against an absolute target base. Handles host-absolute
/// `/path`, query/fragment-only, and path-relative forms. Returns `None` when
/// the base is not `http(s)` absolute.
fn resolve_against_base(rel: &str, base: &str) -> Option<String> {
    // ASCII case-insensitive check on the scheme avoids allocating a lowercase copy.
    if !(starts_with_ascii_ci(base, "http://") || starts_with_ascii_ci(base, "https://")) {
        return None;
    }
    // Split base into scheme://host[:port] and path.
    let scheme_end = base.find("://")? + 3;
    let after_scheme = &base[scheme_end..];
    let path_start = after_scheme
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(base.len());
    let origin = &base[..path_start];
    let base_path_full = if path_start >= base.len() {
        "/"
    } else {
        &base[path_start..]
    };
    // Strip query/fragment from base path for path-relative resolution.
    let base_path = base_path_full
        .split(['?', '#'])
        .next()
        .unwrap_or(base_path_full);
    if rel.starts_with('?') || rel.starts_with('#') {
        let mut out = String::with_capacity(origin.len() + base_path.len() + rel.len());
        out.push_str(origin);
        out.push_str(base_path);
        out.push_str(rel);
        return Some(out);
    }
    if rel.starts_with('/') {
        let mut out = String::with_capacity(origin.len() + rel.len());
        out.push_str(origin);
        out.push_str(&normalize_dot_segments(rel));
        return Some(out);
    }
    // Path-relative: drop the last segment of base_path, append rel.
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..=i],
        None => "/",
    };
    let mut joined = String::with_capacity(dir.len() + rel.len());
    joined.push_str(dir);
    joined.push_str(rel);
    let mut out = String::with_capacity(origin.len() + joined.len());
    out.push_str(origin);
    out.push_str(&normalize_dot_segments(&joined));
    Some(out)
}

/// Decode decimal (`&#61;`) and hexadecimal (`&#x3D;`) numeric HTML character references.
fn numeric_entity_char(entity: &str) -> Option<char> {
    let body = entity.strip_prefix("&#")?.strip_suffix(';')?;
    if body.is_empty() {
        return None;
    }
    let code = match body.strip_prefix('x').or_else(|| body.strip_prefix('X')) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => body.parse::<u32>().ok()?,
    };
    char::from_u32(code)
}

/// Decode common named HTML entities and numeric character references in URL
/// attribute values. `lol_html` does not decode entities in `Attribute::value()`;
/// without this step `&amp;` or `&#x3D;` would be percent-encoded literally.
/// Returns `Cow::Borrowed` when `src` contains no `&`.
fn decode_url_html_entities(src: &str) -> std::borrow::Cow<'_, str> {
    if !src.contains('&') {
        return std::borrow::Cow::Borrowed(src);
    }
    let mut out = String::with_capacity(src.len());
    let mut rest = src;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let semi = tail
            .as_bytes()
            .iter()
            .enumerate()
            .skip(1)
            .take(8)
            .find(|(_, b)| **b == b';')
            .map(|(k, _)| k);
        if let Some(off) = semi {
            let entity = &tail[..off + 1];
            let replacement: Option<&str> = match entity {
                "&amp;" => Some("&"),
                "&lt;" => Some("<"),
                "&gt;" => Some(">"),
                "&quot;" => Some("\""),
                "&apos;" => Some("'"),
                "&#39;" => Some("'"),
                "&#x27;" => Some("'"),
                "&nbsp;" => Some("\u{00a0}"),
                "&sol;" => Some("/"),
                "&#47;" => Some("/"),
                "&#x2f;" | "&#x2F;" => Some("/"),
                _ => None,
            };
            if let Some(r) = replacement {
                out.push_str(r);
                rest = &tail[off + 1..];
                continue;
            }
            if let Some(ch) = numeric_entity_char(entity) {
                out.push(ch);
                rest = &tail[off + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// Percent-encoding set for `url=` and `via=` query values, shared via `zp-shared`.
/// Leaves RFC 3986 unreserved bytes (`-._~`) unescaped so CSS attribute selectors
/// (such as `script[src*="ncaptcha-api.js"]`, which match against the raw DOM
/// attribute below the JS membrane) continue to match.
use zp_shared::URL_PARAM_ENCODE;

/// What an inline `<script>` element contains: executable JS of a given
/// kind, or a JSON document type whose embedded URLs need rewriting but
/// which never goes through the script rewriter.
#[derive(Debug, Clone, Copy)]
enum InlineKind {
    Script(ScriptKind),
    Importmap,
    Speculationrules,
}

/// Rewrite `<script type="importmap">` JSON: every specifier target in `imports`
/// and `scopes` is rewritten to `/zp/api/script?u=...&kind=module` (matching
/// static `import` specifier rewriting), while `integrity` hashes stay untouched.
fn rewrite_importmap_json(raw: &str, target_url: &str, proxy_origin: &str) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut changed = false;
    let mut fix_map = |map: &mut serde_json::Map<String, serde_json::Value>| {
        for (_key, value) in map.iter_mut() {
            let Some(s) = value.as_str() else { continue };
            let Some(next) = proxied_module_script_url(s, target_url, proxy_origin) else { continue };
            *value = serde_json::Value::String(next);
            changed = true;
        }
    };
    if let Some(m) = doc.get_mut("imports").and_then(|v| v.as_object_mut()) {
        fix_map(m);
    }
    if let Some(scopes) = doc.get_mut("scopes").and_then(|v| v.as_object_mut()) {
        for (_scope, map) in scopes.iter_mut() {
            if let Some(m) = map.as_object_mut() {
                fix_map(m);
            }
        }
    }
    if changed {
        serde_json::to_string(&doc).ok()
    } else {
        None
    }
}

/// Rewrite `<script type="speculationrules">` JSON: `prefetch` `urls` lists are
/// rewritten to `/zp/api/fetch?url=...`, and `prerender` `urls` lists are
/// rewritten to the `?via=` navigation launcher route. Rules with `"source": "document"`
/// carry no URL list to rewrite.
fn rewrite_speculationrules_json(raw: &str, target_url: &str, proxy_origin: &str) -> Option<String> {
    let mut doc: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut changed = false;
    for (key, nav) in [("prefetch", false), ("prerender", true)] {
        let Some(rules) = doc.get_mut(key).and_then(|v| v.as_array_mut()) else { continue };
        for rule in rules.iter_mut() {
            let Some(urls) = rule.get_mut("urls").and_then(|v| v.as_array_mut()) else { continue };
            for u in urls.iter_mut() {
                let Some(s) = u.as_str() else { continue };
                let Some(abs) = absolute_target_url(s, target_url) else { continue };
                let next = if nav {
                    proxied_navigation_url(&abs, proxy_origin, "/zp/")
                } else {
                    Some(zp_shared::subresource_proxy_url(&abs, proxy_origin, "/zp/", None))
                };
                if let Some(n) = next {
                    *u = serde_json::Value::String(n);
                    changed = true;
                }
            }
        }
    }
    if changed {
        serde_json::to_string(&doc).ok()
    } else {
        None
    }
}

/// Resolve a module URL or importmap target to the proxy script route, matching
/// the exact URL shape emitted by the JS rewriter for static `import` specifiers
/// so both share the same module map entry and cache key.
fn proxied_module_script_url(raw: &str, target_url: &str, proxy_origin: &str) -> Option<String> {
    if proxy_origin.is_empty() {
        return None;
    }
    let abs = absolute_target_url(raw, target_url)?;
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Same encode set as zp-rewriter::proxied_module_url so the two forms
    // produce identical URLs.
    const QUERY_ENC: &AsciiSet = &CONTROLS
        .add(b' ').add(b'"').add(b'#').add(b'<').add(b'>').add(b'&').add(b'=')
        .add(b'+').add(b'%').add(b'?').add(b'/').add(b':').add(b';').add(b'\'')
        .add(b'\\').add(b'`').add(b'{').add(b'}').add(b'[').add(b']').add(b'^').add(b'|');
    let encoded = utf8_percent_encode(&abs, QUERY_ENC).to_string();
    Some(format!("{}/zp/api/script?u={encoded}&kind=module", proxy_origin.trim_end_matches('/')))
}

/// Rewrite every candidate URL in a `srcset` / `imagesrcset` list, keeping the
/// descriptors (`2x`, `640w`) and the list shape intact. Returns `None` when
/// nothing changed, so the caller can skip the attribute write.
///
/// Uses a dedicated scanner instead of `split(',')` because a candidate URL may
/// be a `data:` URI or query string containing commas. Per the HTML `srcset`
/// grammar, a URL is a non-whitespace run and only trailing commas act as
/// candidate separators.
fn proxied_srcset(
    raw: &str,
    proxy_origin: &str,
    control_prefix: &str,
    target_url: &str,
) -> Option<String> {
    let mut out = String::with_capacity(raw.len() + 64);
    let mut changed = false;
    for c in split_srcset_candidates(raw) {
        out.push_str(c.lead);
        match proxied_subresource_url(c.url, proxy_origin, control_prefix, target_url) {
            Some(next) => {
                out.push_str(&next);
                changed = true;
            }
            None => out.push_str(c.url),
        }
        out.push_str(c.tail);
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

/// One `srcset` candidate, split so the URL can be replaced without disturbing
/// a single byte of the surrounding text. `lead` is the separator run before
/// the URL (whitespace and stray commas), `tail` is the descriptor (`1x` /
/// `320w`) up to the next candidate. Concatenating `lead + url + tail` over
/// every candidate reproduces the input exactly.
pub(crate) struct SrcsetCandidate<'a> {
    pub lead: &'a str,
    pub url: &'a str,
    pub tail: &'a str,
}

/// Parse an HTML `srcset` attribute into `(lead, url, tail)` candidates.
/// Commas inside a URL (such as `data:` payloads or comma-separated query parameters)
/// do not split the URL; only whitespace or trailing commas terminate the URL token.
pub(crate) fn split_srcset_candidates(raw: &str) -> Vec<SrcsetCandidate<'_>> {
    let bytes = raw.as_bytes();
    let mut list = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let lead_start = i;
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        let lead = &raw[lead_start..i];
        if i >= bytes.len() {
            // Trailing separator run: emit it as an empty-URL candidate so the
            // round trip stays byte-exact.
            if !lead.is_empty() {
                list.push(SrcsetCandidate { lead, url: "", tail: "" });
            }
            break;
        }
        // In HTML `srcset` syntax, the URL is a non-whitespace run and only trailing
        // commas at the end of that token act as candidate separators.
        let url_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut url_end = i;
        while url_end > url_start && bytes[url_end - 1] == b',' {
            url_end -= 1;
        }
        let url = &raw[url_start..url_end];
        i = url_end;
        let desc_start = i;
        while i < bytes.len() && bytes[i] != b',' {
            i += 1;
        }
        list.push(SrcsetCandidate { lead, url, tail: &raw[desc_start..i] });
    }
    list
}

/// Inert href assigned to icon `<link>` elements in markup (matching the membrane's `hiddenIconHref`).
const HIDDEN_ICON_HREF: &str = "data:application/x-zeroproxy-icon,1";

/// Return true if `rel` contains an icon link relation token (matching the membrane's `isIconLinkRelValue`).
fn is_icon_link_rel(rel: &str) -> bool {
    rel.split(|c: char| c.is_ascii_whitespace() || c == ',').any(|t| {
        let t = t.to_ascii_lowercase();
        matches!(
            t.as_str(),
            "icon" | "mask-icon" | "apple-touch-icon" | "apple-touch-icon-precomposed" | "apple-touch-startup-image" | "fluid-icon"
        )
    })
}

/// Convert a subresource URL to the SW-routable `/zp/api/fetch?url=<encoded>`
/// form after resolving relative URLs against `target_url`. Returns `None` for
/// fragment-only references and inert schemes (`data:`, `blob:`, `about:`, `mailto:`).
fn proxied_subresource_url(
    raw: &str,
    proxy_origin: &str,
    control_prefix: &str,
    target_url: &str,
) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    if is_inert_scheme(s) {
        return None;
    }
    let absolute = if starts_with_ascii_ci(s, "http://") || starts_with_ascii_ci(s, "https://") {
        s.to_string()
    } else if s.starts_with("//") {
        // Avoid `format!` overhead on scheme-relative URLs.
        let mut a = String::with_capacity(6 + s.len());
        a.push_str("https:");
        a.push_str(s);
        a
    } else if let Some(abs) = resolve_against_base(s, target_url) {
        abs
    } else {
        return None;
    };
    if zp_shared::split_fragment(&absolute).0.is_empty() {
        return None;
    }
    Some(zp_shared::subresource_proxy_url(
        &absolute,
        proxy_origin,
        control_prefix,
        None,
    ))
}

/// Return the absolute http(s) form of a subresource URL, resolving relative
/// forms against `target_url` (mirrors `proxied_subresource_url`'s resolver
/// so the pair stays consistent).
fn absolute_target_url(raw: &str, target_url: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    if is_inert_scheme(s) {
        return None;
    }
    if starts_with_ascii_ci(s, "http://") || starts_with_ascii_ci(s, "https://") {
        return Some(s.to_string());
    }
    if s.starts_with("//") {
        let mut a = String::with_capacity(6 + s.len());
        a.push_str("https:");
        a.push_str(s);
        return Some(a);
    }
    resolve_against_base(s, target_url)
}

/// Rewrite the `url=` target of a `<meta http-equiv="refresh">` `content`
/// attribute (`<delay>[;[ ]url=<url>]`, case-insensitive, optionally quoted)
/// to the proxy navigation route. Delay-only values (`content="5"`) reload the
/// current document and return `None`.
fn proxied_meta_refresh(
    content: &str,
    proxy_origin: &str,
    control_prefix: &str,
    target_url: &str,
) -> Option<String> {
    let lower = content.to_ascii_lowercase();
    let at = lower.find("url=")?;
    let head = &content[..at];
    let mut raw = content[at + 4..].trim();
    // Strip surrounding quotes; the rewritten proxy URL contains no whitespace.
    if (raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2)
        || (raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2)
    {
        raw = &raw[1..raw.len() - 1];
    }
    let raw = raw.trim();
    if raw.is_empty() || starts_with_ascii_ci(raw, "javascript:") {
        return None;
    }
    let absolute = absolute_target_url(raw, target_url)?;
    let next = proxied_navigation_url(&absolute, proxy_origin, control_prefix)?;
    Some(format!("{head}url={next}"))
}

/// Build the proxy-origin `?via=` navigation URL used to rewrite anchor, form,
/// and `formaction` attributes:
///   `<proxy_origin><control_prefix>?via=<percent_encoded_absolute_target>`
///
/// Rewriting the raw attribute prevents browser-native UI actions (hover status
/// bar, middle-click, ctrl-click, `target="_blank"`, "open in new tab", "copy link
/// address") from exposing or navigating directly to the target origin. Normal
/// in-page left-clicks read `data-zp-target-url` first via `clickNavigationTarget`.
/// Returns `None` if `proxy_origin` is empty.
fn proxied_navigation_url(
    absolute: &str,
    proxy_origin: &str,
    control_prefix: &str,
) -> Option<String> {
    use percent_encoding::utf8_percent_encode;
    if proxy_origin.is_empty() {
        return None;
    }
    let mut out =
        String::with_capacity(proxy_origin.len() + control_prefix.len() + absolute.len() * 3 + 16);
    out.push_str(proxy_origin.trim_end_matches('/'));
    out.push_str(control_prefix);
    if !out.ends_with('/') {
        out.push('/');
    }
    out.push_str("?via=");
    for chunk in utf8_percent_encode(absolute, URL_PARAM_ENCODE) {
        out.push_str(chunk);
    }
    Some(out)
}

/// ASCII case-insensitive prefix check without allocating a lowercase copy.
/// Used in hot HTML rewrite paths where URLs may be 100B+ and the
/// `to_ascii_lowercase()` allocation dominates.
#[inline]
fn starts_with_ascii_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// True if `s` (already trimmed) starts with an inert URL scheme that the
/// page handles natively without server-side proxying.
#[inline]
fn is_inert_scheme(s: &str) -> bool {
    starts_with_ascii_ci(s, "data:")
        || starts_with_ascii_ci(s, "blob:")
        || starts_with_ascii_ci(s, "about:")
        || starts_with_ascii_ci(s, "mailto:")
        || starts_with_ascii_ci(s, "javascript:")
        || starts_with_ascii_ci(s, "vbscript:")
}

/// Minimal percent-decoder for URL bodies. Handles ASCII hex pairs (`%22`, `%20`,
/// `%3B`, etc.) while leaving non-decodable sequences intact so the rewriter
/// receives best-effort JavaScript text.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Match `"module"` after trimming ASCII whitespace and ignoring ASCII case per the HTML specification.
fn is_module_type(t: &str) -> bool {
    t.trim_matches(|c: char| c.is_ascii_whitespace()).eq_ignore_ascii_case("module")
}

fn is_javascript_type(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    let lower = lower.trim();
    matches!(
        lower,
        "" | "text/javascript"
            | "application/javascript"
            | "application/ecmascript"
            | "text/ecmascript"
            | "module"
    )
}

// Re-export so callers can construct RewriteOpts in-place.
pub use zp_rewriter::RewriteOpts as RewriteScriptOpts;

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn opts() -> TransformOptions {
        TransformOptions {
            target_url: "https://example.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        }
    }

    /// Strip `data-zp-lit-*` attribute stashes, which preserve the author's
    /// literal attribute value for `getAttribute` parity, before asserting that
    /// no unrewritten target URL remains in active attributes. `lol_html` escapes
    /// `"` inside attribute values as `&quot;`, so the stash spans up to the first
    /// closing quote.
    fn strip_lit(html: &str) -> String {
        let mut out = String::with_capacity(html.len());
        let mut rest = html;
        while let Some(i) = rest.find("data-zp-lit-") {
            let (head, tail) = rest.split_at(i);
            out.push_str(head);
            let Some(open) = tail.find('"') else { break };
            let Some(close) = tail[open + 1..].find('"') else { break };
            rest = &tail[open + 1 + close + 1..];
        }
        out.push_str(rest);
        out
    }

    #[test]
    fn parse_time_subresource_surfaces_are_rewritten() {
        let cases: &[(&str, &str)] = &[
            ("input-image", "<input type=\"image\" src=\"http://t.example/a.png\">"),
            ("video-poster", "<video poster=\"http://t.example/a.png\"></video>"),
            ("svg-image-href", "<svg><image href=\"http://t.example/a.png\"></image></svg>"),
            (
                "svg-image-xlink",
                "<svg><image xlink:href=\"http://t.example/a.png\"></image></svg>",
            ),
            // The HTML parser normalizes `<image>` to `<img>`, but the streaming
            // tokenizer sees the tag name `image`.
            ("legacy-image", "<image src=\"http://t.example/a.png\">"),
            (
                "td-background",
                "<table><tr><td background=\"http://t.example/a.png\">x</td></tr></table>",
            ),
            ("body-background", "<body background=\"http://t.example/a.png\">"),
        ];
        for (name, html) in cases {
            let r = transform(html, &opts()).unwrap();
            assert!(
                !strip_lit(&r.html).contains("t.example/a.png"),
                "{name}: original URL survived: {}",
                r.html
            );
            assert!(
                r.html.contains("/zp/api/fetch?url="),
                "{name}: was not rewritten to proxy path: {}",
                r.html
            );
        }
    }

    // Preserve URL fragments outside the encoded `?url=` parameter so SVG sprite
    // `<use href="...#icon">` references resolve the target fragment in the browser.
    #[test]
    fn subresource_fragment_survives_outside_the_proxy_url() {
        let r = transform(
            "<svg><use href=\"http://t.example/s.svg#icon\"></use></svg>",
            &opts(),
        )
        .unwrap();
        assert!(
            r.html.contains("api/fetch?url=http%3A%2F%2Ft.example%2Fs.svg#icon"),
            "fragment must remain outside the proxy URL: {}",
            r.html
        );
    }

    // `object[data]` is rewritten so raw target URLs do not remain in the DOM,
    // while plugin execution remains blocked by CSP `object-src 'none'`.
    #[test]
    fn plugin_surface_url_is_rewritten_but_load_stays_blocked() {
        let r = transform("<object data=\"http://t.example/a.png\"></object>", &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("data=\"http://t.example"),
            "original URL remained in data attribute: {}",
            r.html
        );
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "was not rewritten to proxy path: {}",
            r.html
        );
        let csp = zp_shared::build_proxied_csp("");
        assert!(csp.contains("object-src 'none'"), "object-src 'none' missing: {csp}");
    }

    #[test]
    fn meta_refresh_url_is_routed_through_proxy() {
        let r = transform(
            "<meta http-equiv=\"refresh\" content=\"0;url=http://t.example/next\">",
            &opts(),
        )
        .unwrap();
        assert!(
            !r.html.contains("content=\"0;url=http://t.example"),
            "original URL remained in content attribute: {}",
            r.html
        );
        assert!(r.html.contains("?via="), "expected proxy navigation path: {}", r.html);
        assert!(
            r.html.contains("data-zp-target-url"),
            "original content must be preserved for diagnostics: {}",
            r.html
        );
    }

    #[test]
    fn meta_refresh_variants() {
        for html in [
            "<meta http-equiv=\"REFRESH\" content=\"3; URL='http://t.example/a'\">",
            "<meta http-equiv=\"refresh\" content=\"0;url=/rel/path\">",
        ] {
            let r = transform(html, &opts()).unwrap();
            assert!(r.html.contains("?via="), "not rewritten: {} -> {}", html, r.html);
        }
        // Delay-only refresh reloads the current document and is left untouched.
        let r = transform("<meta http-equiv=\"refresh\" content=\"5\">", &opts()).unwrap();
        assert!(r.html.contains("content=\"5\""), "delay-only refresh was modified: {}", r.html);
        // Unrelated `http-equiv` values are left untouched.
        let r = transform(
            "<meta http-equiv=\"content-type\" content=\"text/html; charset=utf-8\">",
            &opts(),
        )
        .unwrap();
        assert!(r.html.contains("charset=utf-8"), "unrelated meta tag was modified: {}", r.html);
    }

    #[test]
    fn importmap_urls_are_rewritten_to_script_route() {
        let html = concat!(
            "<script type=\"importmap\">",
            "{\"imports\":{\"react\":\"https://cdn.example.com/react.js\",\"util\":\"/lib/util.js\"},",
            "\"scopes\":{\"/app/\":{\"dep\":\"./dep.js\"}},",
            "\"integrity\":{\"https://cdn.example.com/react.js\":\"sha384-abc\"}}",
            "</script>"
        );
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/script?u="),
            "importmap values did not route to script endpoint: {}",
            r.html
        );
        assert!(r.html.contains("kind=module"), "missing module kind parameter: {}", r.html);
        // SRI digest values in `integrity` must remain untouched.
        assert!(r.html.contains("sha384-abc"), "integrity hash was modified: {}", r.html);
        assert!(
            !r.html.contains("https://cdn.example.com/react.js") || r.html.contains("%3A%2F%2Fcdn.example.com"),
            "raw target URL survived: {}",
            r.html
        );
    }

    #[test]
    fn speculationrules_urls_are_rewritten() {
        let html = concat!(
            "<script type=\"speculationrules\">",
            "{\"prefetch\":[{\"urls\":[\"/a\",\"https://t.example/b\"]}],",
            "\"prerender\":[{\"urls\":[\"/next\"]}]}",
            "</script>"
        );
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "prefetch URL did not route to fetch endpoint: {}",
            r.html
        );
        assert!(r.html.contains("?via="), "prerender URL did not route to navigation endpoint: {}", r.html);
    }

    #[test]
    fn nonjson_script_types_still_pass_through() {
        let html = "<script type=\"text/x-handlebars\">{{location}}</script>";
        let r = transform(html, &opts()).unwrap();
        assert!(r.html.contains("{{location}}"), "template script was modified: {}", r.html);
        // Malformed JSON in `importmap` is left unchanged.
        let bad = "<script type=\"importmap\">{not json</script>";
        let r = transform(bad, &opts()).unwrap();
        assert!(r.html.contains("{not json"), "malformed JSON was modified: {}", r.html);
    }

    #[test]
    fn svg_feimage_href_rewritten() {
        let r = transform(
            "<svg><filter><feImage href=\"http://t.example/a.png\"></feImage></filter></svg>",
            &opts(),
        )
        .unwrap();
        assert!(!strip_lit(&r.html).contains("t.example/a.png"), "original URL survived: {}", r.html);
    }

    #[test]
    fn dot_segments_are_folded() {
        let cases: &[(&str, &str, &str)] = &[
            ("../../img/x.png", "https://h/a/b/c.html", "https://h/img/x.png"),
            ("./sibling/../../y.png", "https://h/a/b/c.html", "https://h/a/y.png"),
            ("/a/./b/../c.png", "https://h/deep/page", "https://h/a/c.png"),
            ("../x.png?q=../keep", "https://h/a/b/c.html", "https://h/a/x.png?q=../keep"),
            ("../../../../x.png", "https://h/a/b.html", "https://h/x.png"),
            ("d/e.png", "https://h/a/b.html", "https://h/a/d/e.png"),
        ];
        for (rel, base, want) in cases {
            let got = super::resolve_against_base(rel, base).expect("resolve");
            assert_eq!(&got, want, "rel={rel} base={base}");
        }
    }

    #[test]
    fn srcdoc_is_moved_to_data_attribute() {
        let html = r#"<html><body><iframe srcdoc="&lt;img src=&quot;/a.png&quot;&gt;"></iframe></body></html>"#;
        let r = transform(html, &opts()).expect("transform");
        assert!(
            r.html.contains("data-zp-srcdoc"),
            "srcdoc must be renamed, got: {}",
            &r.html[..r.html.len().min(400)]
        );
        assert!(
            !r.html.contains(" srcdoc="),
            "raw srcdoc must not survive, got: {}",
            &r.html[..r.html.len().min(400)]
        );
        assert!(
            r.html.contains("/a.png"),
            "srcdoc content must be preserved, got: {}",
            &r.html[..r.html.len().min(400)]
        );
    }

    #[test]
    fn ping_attribute_is_stripped() {
        let html = r#"<html><body><a href="/x" ping="https://t.example/a https://t.example/b">x</a></body></html>"#;
        let r = transform(html, &opts()).expect("transform");
        assert!(
            !r.html.contains(" ping="),
            "ping must not survive, got: {}",
            &r.html[..r.html.len().min(400)]
        );
        assert!(
            r.html.contains("data-zp-blocked-ping"),
            "ping value must be kept for diagnosis, got: {}",
            &r.html[..r.html.len().min(400)]
        );
    }

    // Representative document exercising Pass-1 and Pass-2 paths: head,
    // inline classic + module scripts, external script (src), stylesheet
    // link, absolute anchor, on* handler, and javascript: URL.
    const STREAM_SAMPLE: &str = concat!(
        "<!doctype html><html><head><meta charset=utf-8>",
        "<link rel=stylesheet href=\"https://cdn.example.com/app.css\">",
        "<script>var u = location.href; window.x = 1;</script>",
        "<script type=module>import('./m.js'); export const v = location.host;</script>",
        "</head><body onclick=\"window.alert(document.cookie)\">",
        "<a href=\"https://other.example.com/path?q=1&amp;r=2\">go</a>",
        "<a href=\"javascript:window.open('x')\">js</a>",
        "<script src=\"https://cdn.example.com/lib.js\"></script>",
        "<img src=\"https://cdn.example.com/p.png\">",
        "<p>plain text &amp; entities stay literal</p>",
        "</body></html>",
    );

    // Streaming `HtmlTxn` in N chunks must match the whole-string `transform`
    // for every chunk size, including size 1.
    #[test]
    fn streaming_htmltxn_is_chunk_invariant() {
        let o = opts();
        let whole = transform(STREAM_SAMPLE, &o).unwrap().html;
        for &chunk_size in &[1usize, 2, 3, 7, 13, 64, 256, 100_000] {
            let mut txn = HtmlTxn::new(&o, String::new());
            let mut out: Vec<u8> = Vec::new();
            for c in STREAM_SAMPLE.as_bytes().chunks(chunk_size) {
                out.extend_from_slice(&txn.write(c).unwrap());
            }
            let (tail, _diags) = txn.end().unwrap();
            out.extend_from_slice(&tail);
            assert_eq!(
                String::from_utf8(out).unwrap(),
                whole,
                "chunked output diverged at chunk_size={chunk_size}"
            );
        }
    }

    // Verify that XHTML documents (XHTML-1.0 doctype + xmlns + self-closing
    // `<meta/>`, such as NAVER's CrossDomainStorage helper frame) transform cleanly.
    #[test]
    fn naver_crossstorage_remote_frame_transforms() {
        let html = concat!(
            "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">\n",
            "<html xmlns=\"http://www.w3.org/1999/xhtml\" lang=\"ko\" xml:lang=\"ko\">\n",
            "<head><title>CrossStorage</title><meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\" /><meta http-equiv=\"Content-Script-Type\" content=\"text/javascript\"></head>\n",
            "<body>\n",
            "<script src=\"https://ssl.pstatic.net/sstatic/fe/sfe/cross-domain-storage/cross-domain-storage-remote-3.0.0.js\"></script>\n",
            "<script>new CrossDomainStorage.RemoteFrameStorage({bCheckDomain: true, aWhiteDomainList: [\"*.www.naver.com\"]}).ready();\n",
            "</script>\n",
            "<script type=\"text/javascript\">if(window.addEventListener){window.addEventListener(\"load\",function(){setTimeout(function(){var e=[{href:\"https://ssl.pstatic.net/gen/preconn\",rel:\"preconnect\"}];if(e)for(var t=0;t<e.length;t++){ if(!e[t].href || !e[t].rel) continue; var link = document.createElement(\"link\"); if(e[t].rel === \"preload\"){ if(!e[t].as) continue; link.as = e[t].as; } link.href = e[t].href; link.rel = e[t].rel; document.head.appendChild(link); }},200)},false)}</script>\n",
            "</body>\n</html>\n",
        );
        let o = opts();
        let r = transform(html, &o);
        assert!(r.is_ok(), "CrossStorage remote_frame failed to transform: {:?}", r.err());
        let out = r.unwrap().html;
        assert!(
            out.contains("/zp/api/script") || out.contains("__ZP_EXEC_INLINE"),
            "remote_frame not contained: {out}"
        );
    }

    // A non-empty prelude is injected once inside `<html>` before `<head>` and `<body>`,
    // and is not rewritten by Pass 2.
    #[test]
    fn streaming_htmltxn_injects_prelude_after_head_unrewritten() {
        let o = opts();
        let prelude = "<script nonce=zp>var __zp_boot = location.href;</script>";
        let mut txn = HtmlTxn::new(&o, prelude.to_string());
        let mut out: Vec<u8> = Vec::new();
        for c in STREAM_SAMPLE.as_bytes().chunks(5) {
            out.extend_from_slice(&txn.write(c).unwrap());
        }
        let (tail, _d) = txn.end().unwrap();
        out.extend_from_slice(&tail);
        let html = String::from_utf8(out).unwrap();
        assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1: {html}");
        let p_at = html.find(prelude).unwrap();
        let html_open = html.to_lowercase().find("<html").expect("html start");
        assert!(p_at > html_open, "prelude must be inside <html>: {html}");
        for later in ["<head", "<body"] {
            if let Some(i) = html.to_lowercase().find(later) {
                assert!(p_at < i, "prelude must precede {later}: {html}");
            }
        }
        // The prelude's own `location.href` must remain raw (bypassing Pass 2).
        assert!(
            html.contains("var __zp_boot = location.href;"),
            "prelude script was rewritten (must be verbatim): {html}"
        );
    }

    #[test]
    fn style_attribute_urls_are_rewritten() {
        let prelude = "<script nonce=zp></script>";
        let doc = "<html><body>\
<div style=\"position:absolute; background-image: url(https://cdn.test/bg.png)\">x</div>\
<div style=\"background-image: url(data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=)\">y</div>\
<div style=\"color: red\">z</div>\
</body></html>";
        let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
        let (tail, _d) = txn.end().unwrap();
        out.extend_from_slice(&tail);
        let html = String::from_utf8(out).unwrap();

        assert!(!strip_lit(&html).contains("url(https://cdn.test/bg.png)"), "style attr url raw: {html}");
        assert!(html.contains("/zp/api/fetch?url="), "no proxied url emitted: {html}");
        assert!(html.contains("position:absolute"), "sibling declaration lost: {html}");
        assert!(html.contains("color: red"), "unrelated style attr mangled: {html}");
        assert!(html.contains("data:image/gif;base64,"), "data: url touched: {html}");
    }

    #[test]
    fn inline_style_urls_are_rewritten() {
        let prelude = "<script nonce=zp></script>";
        let doc = "<html><head><style>\
@font-face { font-family: probe; src: url(https://cdn.test/probe.woff2) format('woff2'); }\
.hero { background-image: url('https://cdn.test/bg.png'); }\
.inert { background-image: url(data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=); }\
</style></head><body>x</body></html>";
        let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
        let (tail, _d) = txn.end().unwrap();
        out.extend_from_slice(&tail);
        let html = String::from_utf8(out).unwrap();

        assert!(!html.contains("https://cdn.test/probe.woff2"), "@font-face url raw: {html}");
        assert!(!html.contains("https://cdn.test/bg.png"), "background url raw: {html}");
        assert!(html.contains("/zp/api/fetch?url="), "no proxied url emitted: {html}");
        assert!(html.contains("@font-face"), "@font-face dropped: {html}");
        assert!(html.contains("format("), "declaration mangled: {html}");
        assert!(html.contains("data:image/gif;base64,"), "data: url touched: {html}");
    }

    #[test]
    fn srcset_candidates_are_rewritten() {
        let prelude = "<script nonce=zp></script>";
        let doc = "<html><body>\
<picture><source srcset=\"https://cdn.test/a.svg\" media=\"(prefers-color-scheme: dark)\"></picture>\
<img srcset=\"https://cdn.test/1x.png 1x, https://cdn.test/2x.png 2x\" src=\"https://cdn.test/f.png\">\
<img srcset=\"data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs= 1x\">\
</body></html>";
        let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
        let (tail, _d) = txn.end().unwrap();
        out.extend_from_slice(&tail);
        let html = String::from_utf8(out).unwrap();

        assert!(!strip_lit(&html).contains("\"https://cdn.test/a.svg\""), "source srcset raw: {html}");
        assert!(!strip_lit(&html).contains("https://cdn.test/1x.png 1x"), "img srcset raw: {html}");
        assert!(!strip_lit(&html).contains("https://cdn.test/2x.png 2x"), "img srcset 2x raw: {html}");
        assert!(html.contains(" 1x,"), "descriptor/comma lost: {html}");
        assert!(html.contains(" 2x\""), "descriptor lost: {html}");
        assert!(
            html.contains("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs= 1x"),
            "data: URL mangled: {html}"
        );
    }

    #[test]
    fn target_csp_meta_is_neutralised() {
        let prelude = "<script nonce=zp></script>";
        let doc = "<html><head>\
<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'nonce-abc'\">\
<meta http-equiv=\"content-security-policy-report-only\" content=\"default-src 'none'\">\
<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\
</head><body>x</body></html>";
        let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
        let (tail, _d) = txn.end().unwrap();
        out.extend_from_slice(&tail);
        let html = String::from_utf8(out).unwrap();

        assert!(
            html.to_ascii_lowercase()
                .contains(" http-equiv=\"content-security-policy\""),
            "CSP meta must survive filtered: {html}"
        );
        assert!(
            html.contains("'nonce-abc' 'self' 'unsafe-inline' 'unsafe-eval'"),
            "infra sources not merged: {html}"
        );
        assert!(html.contains("data-zp-blocked-http-equiv"), "no marker: {html}");
        assert!(html.contains("nonce-abc"), "policy value dropped: {html}");
        assert!(html.contains("X-UA-Compatible"), "unrelated meta touched: {html}");
    }

    #[test]
    fn target_csp_meta_with_entity_quotes_is_filtered_as_the_browser_reads_it() {
        // Cloudflare's challenge template writes its policy with `&#39;` quotes.
        for quote in ["&#39;", "&apos;", "&#x27;"] {
            let policy = "default-src 'none'; script-src 'nonce-abc' https://challenges.cloudflare.com; img-src 'self'"
                .replace('\'', quote);
            let doc = format!("<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"{policy}\"></head><body>x</body></html>");
            let mut txn = HtmlTxn::new(&opts(), String::new());
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
            let (tail, _d) = txn.end().unwrap();
            out.extend_from_slice(&tail);
            let html = String::from_utf8(out).unwrap();
            let start = html.find(" content=\"").expect("content attribute") + " content=\"".len();
            let content = &html[start..start + html[start..].find('"').unwrap()];
            assert!(content.starts_with("default-src 'self' 'unsafe-inline'"), "{quote}: {content}");
            assert!(content.contains("script-src 'nonce-abc' https://challenges.cloudflare.com 'self'"), "{quote}: {content}");
            assert!(content.contains("img-src 'self'"), "{quote}: {content}");
            assert!(!content.contains(quote.trim_end_matches(';')), "{quote} left in: {content}");
        }
    }

    #[test]
    fn filter_meta_csp_intersects() {
        use zp_shared::csp::filter_meta_csp;
        let out = filter_meta_csp("script-src 'none'; connect-src https://api.t");
        assert!(out.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:"), "{out}");
        assert!(out.contains("connect-src https://api.t 'self'") && !out.contains("connect-src https://api.t 'self' blob:"), "{out}");
        assert_eq!(filter_meta_csp("img-src 'none'"), "img-src 'none'");
        assert_eq!(filter_meta_csp("img-src https:"), "img-src https: 'self'");
        assert_eq!(filter_meta_csp("sandbox allow-scripts"), "");
        assert_eq!(filter_meta_csp("report-uri /x; upgrade-insecure-requests; frame-ancestors *"), "");
        assert_eq!(filter_meta_csp("some-future-directive https:"), "");
    }

    #[test]
    fn prelude_is_injected_even_without_head() {
        let prelude = "<script nonce=zp>window.__ZP_EXEC_INLINE_REWRITTEN = function(){};</script>";
        for doc in [
            "<html><body><script>location.replace('/x');</script></body></html>",
            "<script>location.replace('/x');</script>",
        ] {
            let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
            let (tail, _d) = txn.end().unwrap();
            out.extend_from_slice(&tail);
            let html = String::from_utf8(out).unwrap();

            assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1 for {doc}: {html}");
            let p = html.find(prelude).unwrap();
            let call = html
                .find("__ZP_EXEC_INLINE_SCRIPT(")
                .or_else(|| html.find("__ZP_EXEC_INLINE_REWRITTEN("))
                .expect("inline script must go through an exec wrapper");
            assert!(p < call, "prelude must precede the call it defines: {html}");
        }
    }

    /// When none of `html`/`head`/`body`/`script` appear in the source, the prelude
    /// must still be injected before the first element, before the first non-blank
    /// text node, or at the end of the document.
    #[test]
    fn prelude_is_injected_into_tagless_documents() {
        let prelude = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><script nonce=zp></script>";
        let run = |doc: &str| {
            let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
            let (tail, _d) = txn.end().unwrap();
            out.extend_from_slice(&tail);
            String::from_utf8(out).unwrap()
        };
        for (doc, first) in [
            ("<!doctype html><title>t</title><p>x</p>", "<title>"),
            ("<p>x</p>", "<p>"),
            ("hello <b>x</b>", "hello"),
        ] {
            let html = run(doc);
            assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1 for {doc}: {html}");
            assert!(html.find(prelude).unwrap() < html.find(first).unwrap(), "prelude must precede {first}: {html}");
        }
        for doc in ["", "<!-- only a comment -->", "  \n "] {
            let html = run(doc);
            assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1 for {doc:?}: {html}");
        }
        // Leading whitespace before `<html>` is not content; the prelude goes inside `<html>`.
        let html = run("\n\n<html><head></head><body>x</body></html>");
        assert_eq!(html.matches(prelude).count(), 1, "{html}");
        assert!(html.find("<html>").unwrap() < html.find(prelude).unwrap(), "prelude left <html>: {html}");
    }

    #[test]
    fn prelude_lands_in_head_not_body() {
        // The prelude contains a CSP `<meta>` tag, which browsers ignore if placed inside
        // `<body>`. Ensure the prelude precedes `<body>` even when `<head>` is omitted.
        let prelude = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\">";
        for doc in [
            "<html><body><p>x</p></body></html>",
            "<html><head><title>t</title></head><body><p>x</p></body></html>",
            "<!doctype html><html lang=\"en\"><body>x</body></html>",
        ] {
            let mut txn = HtmlTxn::new(&opts(), prelude.to_string());
            let mut out: Vec<u8> = Vec::new();
            out.extend_from_slice(&txn.write(doc.as_bytes()).unwrap());
            let (tail, _d) = txn.end().unwrap();
            out.extend_from_slice(&tail);
            let html = String::from_utf8(out).unwrap();

            assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1 for {doc}: {html}");
            let p = html.find(prelude).unwrap();
            let body = html.to_lowercase().find("<body").expect("body start");
            assert!(p < body, "prelude was emitted after <body>, where CSP meta is ignored: {html}");
        }
    }

    #[test]
    fn inline_script_rewrites_location() {
        let html = "<html><body><script>var u = location.href;</script></body></html>";
        let r = transform(html, &opts()).unwrap();
        // Small inline scripts are wrapped with their unrewritten source in
        // `__ZP_EXEC_INLINE_SCRIPT` and rewritten by the page-side rewriter at execution time.
        assert!(
            r.html.contains("__ZP_EXEC_INLINE_SCRIPT("),
            "wrap missing: {}",
            r.html
        );
        assert!(
            r.html.contains("var u = location.href;"),
            "original source was not preserved: {}",
            r.html
        );
        assert!(
            !r.html.contains("<script>var u = location.href;</script>"),
            "script remained unwrapped: {}",
            r.html
        );
    }
    #[test]
    fn event_handler_rewrites_window() {
        let html = "<button onclick=\"f(window)\">x</button>";
        let r = transform(html, &opts()).unwrap();
        // Attribute value is HTML-escaped on serialization (&quot; for ").
        assert!(
            r.html.contains("__zp_get(globalThis,&quot;window&quot;)")
                || r.html.contains("__zp_get(globalThis,\"window\")"),
            "event handler not rewritten: {}",
            r.html
        );
    }

    #[test]
    fn external_script_src_untouched_by_body_pass() {
        let html = "<script src=\"https://example.com/runtime.js\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "src must route through SW: {}",
            r.html
        );
        assert!(
            !r.html.contains("__zp_get"),
            "no body rewrite expected: {}",
            r.html
        );
    }

    #[test]
    fn template_type_script_left_alone() {
        let html = "<script type=\"text/x-handlebars\">{{location}}</script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !r.html.contains("__zp_get"),
            "template script must not be rewritten: {}",
            r.html
        );
    }

    #[test]
    fn module_script_rewrites_window() {
        let html = "<script type=\"module\">import x from './m.js'; use(window);</script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("__ZP_EXEC_INLINE_MODULE("),
            "module wrap missing: {}",
            r.html
        );
        assert!(
            r.html.contains("use(window);"),
            "original source was not preserved: {}",
            r.html
        );
    }

    #[test]
    fn malformed_handler_in_strict_removed() {
        // The body `function {` is a parse error; strict mode removes the attribute.
        let html = "<a onclick=\"function {\">x</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !r.html.contains("onclick"),
            "malformed handler should be removed: {}",
            r.html
        );
    }

    #[test]
    fn javascript_url_anchor_routed() {
        let html = "<a href=\"javascript:location.href='x'\">go</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("href=\"javascript:void(0)\""),
            "href not neutralised: {}",
            r.html
        );
        assert!(
            r.html.contains("data-zp-jsurl"),
            "data-zp-jsurl missing: {}",
            r.html
        );
        assert!(
            r.html.contains("data-zp-jsurl-kind=\"anchor\""),
            "kind missing: {}",
            r.html
        );
        assert!(
            r.html.contains("data-zp-lit-href=\"javascript:location.href='x'\""),
            "the author's literal must stay readable: {}",
            r.html
        );
        // Body should be rewritten through zp-rewriter (location is dangerous global).
        assert!(
            r.html.contains("__zp_get(globalThis,&quot;location&quot;)")
                || r.html.contains("__zp_get(globalThis,\"location\")"),
            "body not rewritten: {}",
            r.html
        );
    }

    #[test]
    fn javascript_url_form_routed() {
        let html = "<form action=\"javascript:submit(window)\"><input></form>";
        let r = transform(html, &opts()).unwrap();
        assert!(r.html.contains("action=\"javascript:void(0)\""));
        assert!(r.html.contains("data-zp-jsurl-kind=\"form\""));
    }

    #[test]
    fn javascript_url_percent_encoded_decoded_then_rewritten() {
        // The body is URL-encoded: `top.location='x'`
        let html = "<a href=\"javascript:top.location%3D'x'\">x</a>";
        let r = transform(html, &opts()).unwrap();
        // Percent-encoded characters are decoded prior to OXC parsing so `top` is rewritten.
        assert!(
            r.html.contains("data-zp-jsurl"),
            "should have stash: {}",
            r.html
        );
    }

    #[test]
    fn anchor_absolute_href_rewritten_to_proxy_via() {
        // Rewrite `<a href>` to a proxy-origin `?via=` URL and stash the absolute
        // target URL on `data-zp-target-url` for the prelude click handler's fast path.
        let html = "<a href=\"https://example.com/x\">x</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("href=\"https://example.com/x\""),
            "raw target URL must not survive on <a href>: {}",
            r.html
        );
        assert!(
            r.html
                .contains("href=\"http://proxy.localhost:18080/zp/?via="),
            "anchor href must point at proxy launcher: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/x\""),
            "absolute target must be preserved on data-zp-target-url: {}",
            r.html
        );
        assert!(!r.html.contains("data-zp-jsurl"));
    }

    #[test]
    fn anchor_host_relative_resolved_then_proxied() {
        let html = "<a href=\"/news/topAside\">x</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/news/topAside\""),
            "host-relative anchor must resolve against target: {}",
            r.html
        );
        assert!(
            r.html
                .contains("href=\"http://proxy.localhost:18080/zp/?via="),
            "href must be proxy launcher: {}",
            r.html
        );
        assert!(
            !strip_lit(&r.html).contains("href=\"/news/topAside\""),
            "raw relative href must not survive: {}",
            r.html
        );
    }

    #[test]
    fn anchor_fragment_only_href_left_alone() {
        // Page-internal fragment anchors (`#section`) carry no target host,
        // so leave them as-is; the prelude click handler treats them as
        // virtual hash updates.
        let html = "<a href=\"#topAside\">x</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("href=\"#topAside\""),
            "fragment-only href must not be rewritten: {}",
            r.html
        );
        assert!(
            !r.html.contains("data-zp-target-url"),
            "fragment-only href must not gain data-zp-target-url: {}",
            r.html
        );
    }

    #[test]
    fn area_href_rewritten_same_as_anchor() {
        let html = "<area href=\"https://example.com/clickmap\" coords=\"0,0,10,10\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("href=\"https://example.com/clickmap\""),
            "area raw href must not survive: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/clickmap\""),
            "area must carry data-zp-target-url: {}",
            r.html
        );
    }

    #[test]
    fn form_action_rewritten_to_proxy_via() {
        let html = "<form action=\"https://example.com/login\"><input></form>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("action=\"https://example.com/login\""),
            "form raw action must not survive: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/login\""),
            "form must carry data-zp-target-url: {}",
            r.html
        );
        assert!(
            r.html
                .contains("action=\"http://proxy.localhost:18080/zp/?via="),
            "form action must point at proxy launcher: {}",
            r.html
        );
    }

    #[test]
    fn input_formaction_rewritten() {
        let html = "<form><input type=\"submit\" formaction=\"https://example.com/submit\"></form>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("formaction=\"https://example.com/submit\""),
            "input formaction raw must not survive: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/submit\""),
            "input formaction must carry data-zp-target-url: {}",
            r.html
        );
    }

    #[test]
    fn button_formaction_rewritten() {
        let html = "<form><button type=\"submit\" formaction=\"https://example.com/go\">Go</button></form>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !strip_lit(&r.html).contains("formaction=\"https://example.com/go\""),
            "button formaction raw must not survive: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://example.com/go\""),
            "button formaction must carry data-zp-target-url: {}",
            r.html
        );
    }

    #[test]
    fn naver_real_world_anchor_reproducer() {
        let html = concat!(
            "<a href=\"https://whale.naver.com/ko/?wpid=main_theme1\" class=\"link_top\">",
            "<span class=\"top_text\">\u{B2E4}\u{C6B4}\u{B85C}\u{B4DC}</span></a>",
            "<a href=\"https://help.naver.com/alias/search/word/word_35.naver\" ",
            "target=\"_self\" class=\"kwd_help\" data-clk=\"sly.help\">",
            "\u{B3C4}\u{C6C0}\u{B9D0}</a>"
        );
        let opts = TransformOptions {
            target_url: "https://www.naver.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let r = transform(html, &opts).unwrap();
        eprintln!("NAVER reproducer output:\n{}", r.html);
        assert!(
            r.html.contains("?via=https%3A%2F%2Fwhale.naver.com"),
            "whale.naver.com anchor must rewrite: {}",
            r.html
        );
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://whale.naver.com"),
            "data-zp-target-url must be set: {}",
            r.html
        );
        assert!(
            !strip_lit(&r.html).contains("href=\"https://whale.naver.com"),
            "raw whale.naver.com href must not survive: {}",
            r.html
        );
    }

    #[test]
    fn proxy_origin_blank_skips_navigation_rewrite() {
        // When `proxy_origin` is empty (test harness fallback), leave the raw
        // navigation attribute untouched.
        let html = "<a href=\"https://example.com/x\">x</a>";
        let mut o = opts();
        o.proxy_origin = String::new();
        let r = transform(html, &o).unwrap();
        assert!(
            r.html.contains("href=\"https://example.com/x\""),
            "blank proxy_origin must leave raw href: {}",
            r.html
        );
    }

    #[test]
    fn numeric_html_entity_in_url_is_decoded() {
        for raw in ["&#x3D;", "&#X3D;", "&#61;"] {
            let src = format!("https://media.example/a.mp4?c{}original", raw);
            let decoded = decode_url_html_entities(&src);
            assert_eq!(
                &*decoded, "https://media.example/a.mp4?c=original",
                "numeric entity ({}) was not decoded: {}",
                raw, decoded
            );
        }
        // Invalid numeric character references are left untouched.
        let untouched = decode_url_html_entities("https://a/b?x&#zz;y");
        assert_eq!(&*untouched, "https://a/b?x&#zz;y");
    }

    #[test]
    fn inline_style_keeps_child_combinator_unescaped() {
        // `<style>` is raw text; `>` and `<` must not be HTML-escaped into `&gt;`/`&lt;`.
        let html = "<style>.a>div:nth-child(3){width:calc(33.33% - 16px)}</style>";
        let out = transform(html, &opts()).unwrap().html;
        assert!(
            out.contains(".a>div:nth-child(3)"),
            "child combinator was HTML-escaped: {out}"
        );
        assert!(!out.contains("&gt;"), "&gt; leaked into style content: {out}");
        let ranged = transform("<style>@media (400px<width<800px){.b{color:red}}</style>", &opts()).unwrap().html;
        assert!(!ranged.contains("&lt;"), "media query range was HTML-escaped: {ranged}");
    }

    #[test]
    fn stylesheet_link_with_html_entity_decoded() {
        // Decode HTML entities (`&amp;`) in attribute values before percent-encoding
        // the canonical target URL.
        let html = "<link rel=\"stylesheet\" href=\"https://cdn.example.com/load.php?lang=en&amp;modules=site.styles\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "link href must route through SW: {}",
            r.html
        );
        // The encoded URL must not contain `%26amp%3B` (`&amp;` percent-encoded);
        // it must contain `%26modules%3D` (`&modules=`).
        assert!(
            !r.html.contains("%26amp%3B"),
            "must not preserve `&amp;` entity in URL: {}",
            r.html
        );
        assert!(
            r.html.contains("%26modules%3D"),
            "expected `&modules=` encoded form: {}",
            r.html
        );
    }

    #[test]
    fn external_stylesheet_link_rewritten() {
        let html = "<link rel=\"stylesheet\" href=\"https://cdn.example.com/main.css\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "link href must route through SW: {}",
            r.html
        );
        assert!(
            !strip_lit(&r.html).contains("href=\"https://cdn.example.com/main.css\""),
            "original absolute URL must not survive on <link href> attribute: {}",
            r.html
        );
        // Original URL must be preserved on data-zp-target-url so script/link
        // .src/.href getters return the virtual URL (membrane invariant).
        assert!(
            r.html
                .contains("data-zp-target-url=\"https://cdn.example.com/main.css\""),
            "data-zp-target-url should preserve the original absolute URL: {}",
            r.html
        );
    }

    // Icon links carry an inert data URI in `href` while keeping the target and
    // literal URLs in `data-zp-*` stashes for the membrane.
    #[test]
    fn icon_link_carries_the_hidden_href_and_keeps_its_target() {
        for rel in ["icon", "shortcut icon", "apple-touch-icon", "MASK-ICON"] {
            let html = format!("<link rel=\"{rel}\" href=\"/site-icon.png\">");
            let r = transform(&html, &opts()).unwrap();
            assert!(r.html.contains("href=\"data:application/x-zeroproxy-icon,1\""), "{rel}: {}", r.html);
            assert!(!r.html.contains("/zp/api/fetch"), "{rel}: no fetchable URL: {}", r.html);
            assert!(r.html.contains("data-zp-lit-href=\"/site-icon.png\""), "{rel}: literal stash: {}", r.html);
            assert!(r.html.contains("data-zp-target-url=\"https://"), "{rel}: target stash: {}", r.html);
        }
        // Non-icon `<link>` elements continue to route through `/zp/api/fetch`.
        let r = transform("<link rel=\"preload\" as=\"image\" href=\"/site-icon.png\">", &opts()).unwrap();
        assert!(r.html.contains("/zp/api/fetch?url="), "{}", r.html);
    }

    #[test]
    fn host_relative_img_resolved_against_target() {
        // Host-relative `<img src="/_next/image?...">` must be resolved against `target_url`
        // before encoding into the proxy fetch query.
        let html = "<img src=\"/_next/image?url=%2Fpng%2Ferror.png&w=1920&q=75\">";
        let opts = TransformOptions {
            target_url: "https://shopsquare.naver.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let r = transform(html, &opts).unwrap();
        assert!(
            r.html
                .contains("shopsquare.naver.com%2F_next%2Fimage"),
            "host-relative img src must be resolved against target URL: {}",
            r.html
        );
    }

    #[test]
    fn github_pattern_link_dzt_added() {
        let html = "<link crossorigin=\"anonymous\" media=\"all\" rel=\"stylesheet\" href=\"https://github.githubassets.com/assets/light-4fded0090af0ad58.css\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("data-zp-target-url=\"https://github.githubassets.com/assets/light-4fded0090af0ad58.css\""),
            "data-zp-target-url missing on github-style <link>: {}",
            r.html
        );
    }

    #[test]
    fn external_script_src_rewritten() {
        let html = "<script src=\"https://cdn.example.com/app.js\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "script src must route through SW: {}",
            r.html
        );
    }

    #[test]
    fn external_script_src_uses_proxy_origin_absolute() {
        // Virtual `baseURI` overrides on the page resolve root-relative `/zp/...`
        // against the target host, so subresources must emit a proxy-origin-absolute URL.
        let html = "<script defer src=\"https://pm.pstatic.net/resources/js/preload.js\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html
                .contains("http://proxy.localhost:18080/zp/api/fetch?url="),
            "script src must include proxy_origin: {}",
            r.html
        );
    }

    #[test]
    fn module_script_src_carries_module_kind() {
        // Module scripts and `modulepreload` links route to `/zp/api/script?u=...&kind=module`
        // so the Service Worker rewrites them as ES modules even when they contain no
        // `import`/`export` syntax.
        let html = "<link rel=\"preload modulepreload\" href=\"/assets/m.js\">\
                    <link rel=\"preload\" as=\"script\" href=\"/assets/c.js\">\
                    <script type=\" Module \" src=\"/assets/m.js\"></script>\
                    <script src=\"/assets/c.js\"></script>\
                    <script type=\" module \">let e = 1;</script>\
                    <script>let f = 1;</script>";
        let r = transform(html, &opts()).unwrap();
        let out = r.html.replace("&amp;", "&");
        let m = "http://proxy.localhost:18080/zp/api/script?u=https%3A%2F%2Fexample.com%2Fassets%2Fm.js&kind=module";
        assert_eq!(out.matches(m).count(), 2, "modulepreload and module script must share canonical form: {out}");
        assert_eq!(out.matches("/zp/api/fetch?url=").count(), 2, "classic script and preload as=script must use fetch route: {out}");
        // Must match the exact URL emitted by static `import` specifier rewriting.
        let imported = rewrite_script(
            "import './assets/m.js';",
            &RewriteOpts {
                kind: ScriptKind::Module,
                target_url: "https://example.com/".into(),
                strict: true,
                proxy_origin: "http://proxy.localhost:18080".into(),
            },
        )
        .unwrap();
        assert!(imported.code.contains(m), "differed from static import canonical form: {}", imported.code);
        assert!(out.contains("__ZP_EXEC_INLINE_MODULE(\"let e = 1;\")"), "{out}");
        assert!(out.contains("__ZP_EXEC_INLINE_SCRIPT(\"let f = 1;\")"), "{out}");
    }

    #[test]
    fn external_img_src_rewritten() {
        let html = "<img src=\"https://cdn.example.com/p.png\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "img src must route through SW: {}",
            r.html
        );
    }

    #[test]
    fn unreserved_bytes_stay_raw_so_css_attribute_selectors_still_match() {
        // CSS attribute selectors (`script[src*="ncaptcha-api.js"]`) match against
        // the raw DOM attribute below the JS membrane, so RFC 3986 unreserved bytes
        // (`.`/`-`/`_`/`~`) must stay unescaped while reserved delimiters stay escaped.
        let html = "<script src=\"https://ncpt.naver.com/static/ncaptcha-api.js?k=1\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(r.html.contains("ncaptcha-api.js?k=1") || r.html.contains("ncaptcha-api.js%3Fk"));
        assert!(
            r.html.contains("static%2Fncaptcha-api.js"),
            "unreserved bytes must stay raw inside url=: {}",
            r.html
        );
        assert!(r.html.contains("url=https%3A%2F%2Fncpt.naver.com"), "got: {}", r.html);
        assert!(r.html.contains("%3Fk%3D1"), "query delimiters must stay encoded: {}", r.html);
    }

    #[test]
    fn relative_subresource_resolved_against_target() {
        // Resolve relative subresource URLs against `target_url` and fold `.`/`..`
        // dot-segments so the encoded `?url=` key matches the page realm's `new URL()`.
        let html =
            "<link rel=\"stylesheet\" href=\"/static/a.css\"><script src=\"./b.js\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("example.com%2Fstatic%2Fa.css"),
            "host-relative link must resolve against target: {}",
            r.html
        );
        assert!(
            r.html.contains("example.com%2Fb.js"),
            "path-relative script must resolve against target: {}",
            r.html
        );
    }

    #[test]
    fn data_and_blob_urls_left_alone() {
        let html = r#"<img src="data:image/png;base64,AAAA"><img src="blob:http://x/abc">"#;
        let r = transform(html, &opts()).unwrap();
        assert!(r.html.contains("data:image/png"), "{}", r.html);
        assert!(r.html.contains("blob:http://x/abc"), "{}", r.html);
        assert!(!r.html.contains("/zp/api/fetch"), "{}", r.html);
    }

    #[test]
    fn iframe_src_still_left_alone() {
        // `iframe[src]` is moved to `data-zp-frame-src` rather than rewritten to
        // `/zp/api/fetch` or `?via=` so the runtime-prelude `installNetworkContainment`
        // hook can route the frame through the document pipeline.
        let html = "<iframe src=\"https://other.example/f\"></iframe>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("src=\"https://other.example/f\""),
            "iframe src must not be rewritten in htmltx: {}",
            r.html
        );
        assert!(!r.html.contains("/zp/api/fetch"), "{}", r.html);
        assert!(
            !r.html.contains("?via="),
            "iframe src must not get the anchor ?via= treatment: {}",
            r.html
        );
    }
}

#[cfg(test)]
mod naver_perf {
    use super::*;
    // Benchmark `transform()` on a real NAVER document when `ZP_NAVER_HTML` is set.
    #[test]
    #[ignore]
    fn time_naver_document() {
        let path = std::env::var("ZP_NAVER_HTML").expect("set ZP_NAVER_HTML");
        let html = std::fs::read_to_string(path).unwrap();
        let o = TransformOptions {
            target_url: "https://www.naver.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let t = std::time::Instant::now();
        let r = transform(&html, &o);
        let ms = t.elapsed().as_millis();
        println!("NAVER transform: {} ms, ok={}, in={}B", ms, r.is_ok(), html.len());
        assert!(r.is_ok());
    }
}

#[cfg(test)]
mod naver_stream_perf {
    use super::*;
    // Benchmark streaming `HtmlTxn::write` across chunk sizes when `ZP_NAVER_HTML` is set.
    #[test]
    #[ignore]
    fn time_naver_streaming() {
        let path = std::env::var("ZP_NAVER_HTML").expect("set ZP_NAVER_HTML");
        let html = std::fs::read_to_string(path).unwrap();
        let o = TransformOptions {
            target_url: "https://www.naver.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        for &cs in &[65536usize, 16384, 8192, 4096, 1024] {
            let t = std::time::Instant::now();
            let mut txn = HtmlTxn::new(&o, String::new());
            let mut out = 0usize;
            let mut chunks = 0usize;
            for c in html.as_bytes().chunks(cs) {
                out += txn.write(c).unwrap().len();
                chunks += 1;
            }
            let (tail, _d) = txn.end().unwrap();
            out += tail.len();
            println!("chunk={:>6}B chunks={:>4} -> {:>7} ms out={}B", cs, chunks, t.elapsed().as_millis(), out);
        }
    }
}

/// Verify URL-bearing attribute handling against `crates/zp-shared/testdata/url_surfaces.json`
/// (shared with `test/js/static-policy.test.js`).
#[cfg(test)]
mod surface_fixture {
    use super::tests::opts;
    use super::transform;
    use super::{proxied_srcset, split_srcset_candidates};

    const TARGET: &str = "http://t.example/probe.bin";

    fn markup(tag: &str, attr: &str, kind: &str) -> String {
        let value = if kind == "srcset" {
            format!("{TARGET} 1x")
        } else {
            TARGET.to_string()
        };
        // Wrap SVG elements inside `<svg>` so the HTML parser constructs them in the SVG namespace.
        if matches!(tag, "image" | "use" | "feimage") {
            format!("<svg><{tag} {attr}=\"{value}\"></{tag}></svg>")
        } else {
            format!("<{tag} {attr}=\"{value}\"></{tag}>")
        }
    }

    #[test]
    fn integrity_is_stripped_and_backed_up() {
        for tag in ["script", "link"] {
            let html = format!(
                "<{tag} src=\"/a.js\" href=\"/a.css\" integrity=\"sha384-AAA\"></{tag}>"
            );
            let out = transform(&html, &opts()).expect("transform").html;
            assert!(
                !out.contains(" integrity=\""),
                "{tag}: integrity attribute remained and would block the resource: {out}"
            );
            assert!(
                out.contains("data-zp-integrity=\"sha384-AAA\""),
                "{tag}: original integrity value was not backed up: {out}"
            );
        }
    }

    #[test]
    fn integrity_backup_is_absent_when_there_was_none() {
        let out = transform("<script src=\"/a.js\"></script>", &opts()).expect("transform").html;
        assert!(!out.contains("data-zp-integrity"), "unexpected data-zp-integrity attribute: {out}");
    }

    #[test]
    fn base_href_rebases_following_relative_urls() {
        let html = concat!(
            "<html><head><base href=\"http://cdn.example/deep/\"></head>",
            "<body><img src=\"rel.png\"></body></html>"
        );
        let out = transform(html, &opts()).expect("transform").html;
        assert!(
            out.contains("url=http%3A%2F%2Fcdn.example%2Fdeep%2Frel.png"),
            "URL did not resolve against <base>: {out}"
        );
    }

    #[test]
    fn elements_before_base_use_the_document_url() {
        let html = concat!(
            "<html><head><img src=\"early.png\">",
            "<base href=\"http://cdn.example/deep/\"><img src=\"late.png\"></head></html>"
        );
        let out = transform(html, &opts()).expect("transform").html;
        assert!(out.contains("example.com%2Fearly.png"), "element before <base> resolved against <base>: {out}");
        assert!(out.contains("cdn.example%2Fdeep%2Flate.png"), "element after <base> did not resolve against <base>: {out}");
    }

    #[test]
    fn base_href_attribute_itself_is_left_alone() {
        let html = "<html><head><base href=\"http://cdn.example/deep/\"></head></html>";
        let out = transform(html, &opts()).expect("transform").html;
        assert!(
            out.contains("href=\"http://cdn.example/deep/\""),
            "base href was modified: {out}"
        );
    }

    /// Every `(tag, attr)` pair that initiates a fetch or navigation must either
    /// be rewritten to a proxy route or moved to a `data-zp-*` attribute.
    #[test]
    fn url_bearing_attribute_enumeration() {
        const CASES: &[(&str, &str, &str)] = &[
            ("a", "href", "rewrite"),
            ("area", "href", "rewrite"),
            ("form", "action", "rewrite"),
            ("input", "formaction", "rewrite"),
            ("button", "formaction", "rewrite"),
            ("script", "src", "rewrite"),
            ("img", "src", "rewrite"),
            ("img", "srcset", "rewrite"),
            ("source", "srcset", "rewrite"),
            ("link", "imagesrcset", "rewrite"),
            ("video", "poster", "rewrite"),
            ("video", "src", "rewrite"),
            ("audio", "src", "rewrite"),
            ("track", "src", "rewrite"),
            ("input", "src", "rewrite"),
            ("body", "background", "rewrite"),
            ("object", "data", "rewrite"),
            ("embed", "src", "rewrite"),
            ("iframe", "src", "moved"),
        ];
        for &(tag, attr, mode) in CASES {
            let html = markup(tag, attr, if attr == "srcset" || attr == "imagesrcset" { "srcset" } else { "url" });
            let out = transform(&html, &opts()).expect("transform").html;
            match mode {
                "moved" => {
                    assert!(
                        out.contains("data-zp-frame-src="),
                        "{tag}[{attr}] was not moved to data-zp-frame-src: {out}"
                    );
                    assert!(
                        !out.contains(&format!(" {attr}=\"{TARGET}\"")),
                        "{tag}[{attr}] retained original src: {out}"
                    );
                }
                _ => {
                    assert!(
                        !out.contains(&format!(" {attr}=\"{TARGET}\"")),
                        "{tag}[{attr}] retained original target URL: {out}"
                    );
                    assert!(
                        out.contains("/zp/"),
                        "{tag}[{attr}] was not rewritten to proxy path: {out}"
                    );
                }
            }
        }
        // Pure metadata attributes (`cite`, `longdesc`, `usemap`, `profile`) are not
        // fetched by the browser and retain their original value.
        let html = "<blockquote cite=\"http://t.example/q\"></blockquote>";
        let out = transform(html, &opts()).expect("transform").html;
        assert!(out.contains("cite=\"http://t.example/q\""), "cite attribute was modified: {out}");
    }

    #[test]
    fn srcset_candidates_match_shared_fixture() {
        let raw = include_str!("../../zp-shared/testdata/srcset_cases.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("parse srcset_cases.json");
        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 10, "fixture must stay populated for parity checks");
        for case in cases {
            let id = case["id"].as_str().unwrap_or("?");
            let input = case["input"].as_str().expect("input");
            let want = case["candidates"].as_array().expect("candidates");
            let got = split_srcset_candidates(input);
            assert_eq!(got.len(), want.len(), "{id}: candidate count");
            for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
                let w = w.as_array().expect("[lead, url, tail]");
                assert_eq!(g.lead, w[0].as_str().unwrap(), "{id}[{i}] lead");
                assert_eq!(g.url, w[1].as_str().unwrap(), "{id}[{i}] url");
                assert_eq!(g.tail, w[2].as_str().unwrap(), "{id}[{i}] tail");
            }
            let round: String = got
                .iter()
                .map(|c| format!("{}{}{}", c.lead, c.url, c.tail))
                .collect();
            assert_eq!(round, input, "{id}: round-trip differed from input");
        }
    }

    #[test]
    fn data_candidate_does_not_swallow_its_neighbour() {
        let raw = "data:image/svg+xml;utf8,<svg/> 1x, /b.png 2x";
        let out = proxied_srcset(raw, "http://proxy.example", "/zp/", "https://t.example/x/")
            .expect("must rewrite when neighbour candidate is present");
        assert!(
            out.starts_with("data:image/svg+xml;utf8,<svg/> 1x,"),
            "data: candidate must remain untouched: {out}"
        );
        assert!(
            out.contains("/zp/api/fetch?url=https%3A%2F%2Ft.example%2Fb.png"),
            "neighbour candidate must be rewritten to proxy path: {out}"
        );
    }

    #[test]
    fn every_fixture_surface_behaves_as_declared() {
        let raw = include_str!("../../zp-shared/testdata/url_surfaces.json");
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(raw).expect("parse url_surfaces.json");
        let mut checked = 0usize;
        for e in &entries {
            let Some(pair) = e.get("pair").and_then(|v| v.as_str()) else { continue };
            let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let (tag, attr) = pair.split_once(':').expect("pair must have tag:attr format");
            // Handle prefixed attributes such as `xlink:href`.
            let (tag, attr) = if let Some((t2, a2)) = attr.split_once(':') {
                (tag, Box::leak(format!("{t2}:{a2}").into_boxed_str()) as &str)
            } else {
                (tag, attr)
            };
            let html = markup(tag, attr, kind);
            let out = transform(&html, &opts()).expect("transform").html;
            checked += 1;
            match kind {
                "rewrite" | "srcset" => assert!(
                    out.contains("/zp/api/fetch?url="),
                    "{pair}: was not rewritten to proxy path (kind={kind})\n  in : {html}\n  out: {out}"
                ),
                "navigation" => assert!(
                    out.contains("?via="),
                    "{pair}: was not rewritten to navigation path\n  in : {html}\n  out: {out}"
                ),
                "deliberate" => assert!(
                    !out.contains("/zp/api/fetch?url="),
                    "{pair}: marked deliberate but was rewritten\n  out: {out}"
                ),
                "known-gap" => assert!(
                    !out.contains("/zp/api/fetch?url="),
                    "{pair}: now rewritten; update fixture from known-gap to rewrite\n  out: {out}"
                ),
                "special" => assert!(
                    out.contains("data-zp-frame-src")
                        || out.contains("data-zp-srcdoc")
                        || !out.contains(TARGET),
                    "{pair}: was neither moved nor rewritten
  out: {out}"
                ),
                other => panic!("{pair}: unknown kind {other}"),
            }
        }
        assert!(checked >= 20, "too few fixture entries checked ({checked})");
    }
}
