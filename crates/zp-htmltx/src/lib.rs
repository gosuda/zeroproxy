//! ZeroProxy HTML transformer. Replaces Go `internal/htmltx`.
//!
//! Uses `lol_html` (Cloudflare's streaming HTML rewriter) to:
//! - rewrite inline `<script>` bodies via `zp-rewriter::rewrite_script` (classic
//!   and module both go through the same parser; module-source-type is selected
//!   by the `<script type="module">` attribute)
//! - rewrite inline `on*` event handler attribute bodies via `zp-rewriter`
//!   with `ScriptKind::EventHandler`
//! - in strict mode, fail-closed: a script that fails to parse is replaced
//!   with a safe `throw new DOMException(...)` (callable from the original
//!   call sites), and event handler attributes are removed entirely.

use lol_html::{element, html_content::ContentType, text, HtmlRewriter, Settings};
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
    /// post-OXC-init. Reserved for Phase B3 foreground bootstrap; currently
    /// unused (scripts execute inline after rewrite).
    pub pending_gate: bool,
    /// Proxy origin (e.g. `http://proxy.localhost:18080`) used to build
    /// absolute SW-routable URLs for subresources. Empty falls back to a
    /// root-relative path, which only works when the page's virtual baseURI
    /// is not overridden — production callers MUST supply this.
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

/// Transform target HTML — rewrites inline scripts and `on*` event handlers
/// through `zp-rewriter`. In strict mode failures become safe placeholders.
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
    Settings {
        element_content_handlers: vec![
                // on* event handler attributes + javascript: URL attributes.
                // D1: <a href="javascript:CODE">, <form action="javascript:...">,
                // <iframe src="javascript:..."> become harmless `javascript:void(0)`
                // with `data-zp-jsurl` carrying the OXC-rewritten body, executed
                // later by runtime-prelude's delegated click/submit handler.
                element!("*", move |el| {
                    // `tag_name()` is already lowercase per lol_html guarantee
                    // (it normalizes element names). Cache once per element
                    // instead of recomputing inside the per-attribute loop.
                    let tag = el.tag_name();
                    // 2026-08-14 — 타깃이 자기 CSP 를 `<meta http-equiv>` 로
                    // 실어 보내면 그걸 무력화한다.
                    //
                    // 응답 헤더의 CSP 는 우리가 `h.set` 으로 교체하지만 meta 는
                    // 그대로 통과하고 있었다. 그러면 **타깃의 정책이 우리 문서에
                    // 그대로 적용된다.** NAVER 로그인 페이지에서 실측:
                    //   Executing inline script violates … 'nonce-XI375…' *.nid.naver.com
                    //   Evaluating a string as JavaScript violates … 'unsafe-eval' is not allowed
                    // 즉 그들의 nonce 정책이 **우리가 리라이트한 인라인 스크립트와
                    // 멤브레인의 eval 경로를 막는다.** 우리는 그들의 nonce 를
                    // 재현할 수 없으므로 (그리고 재현해서도 안 된다) 이 meta 는
                    // 반드시 죽여야 한다. 우리 정책이 그 자리를 대신한다.
                    //
                    // 삭제 대신 이름만 바꾼다: 페이지 JS 가 자기 CSP 를 읽어
                    // 확인하는 경우가 있어 값은 남겨 둔다.
                    if tag == "meta" {
                        let equiv = el
                            .get_attribute("http-equiv")
                            .unwrap_or_default()
                            .trim()
                            .to_ascii_lowercase();
                        if equiv == "content-security-policy"
                            || equiv == "content-security-policy-report-only"
                        {
                            let content = el.get_attribute("content").unwrap_or_default();
                            let _ = el.remove_attribute("http-equiv");
                            let _ = el.set_attribute("data-zp-blocked-http-equiv", &equiv);
                            let _ = el.set_attribute("data-zp-blocked-content", &content);
                            let _ = el.remove_attribute("content");
                        }
                    }
                    // `srcdoc` 문서는 **파싱 시점에 멤브레인 없이** 만들어진다.
                    // 우리는 여기(서버)에서 srcdoc 안을 변환하지 않았고, 페이지
                    // realm 의 `injectSrcdoc` 은 JS 로 srcdoc 을 **대입할 때만**
                    // 걸리므로, 타깃 HTML 에 그대로 박혀 온 srcdoc 은 프렐류드도
                    // URL 리라이트도 없이 그냥 파싱됐다. 실측: 자식 문서에
                    // script 0개, `<img src="/img/x.png">` 가 원본 그대로 남아
                    // 프록시 오리진으로 요청 → SW 가 탭에 귀속시키지 못해
                    // UNCLASSIFIED 거절(`ref:""`). 교차 오리진이면 CSP 만이
                    // 유일한 방어선이 된다(실측: 브라우저 직접 요청 0 — 격리는
                    // 버텼지만 리소스는 전부 실패).
                    //
                    // 이름만 옮겨 둔다. 페이지 realm 의 백스톱이 후킹된 `srcdoc`
                    // 세터로 되돌리고, 그 경로가 이미 프렐류드 주입 +
                    // transformHTML 을 한다 — 검증된 코드를 재사용하는 쪽이
                    // Rust 에 HTML 변환을 한 벌 더 만드는 것보다 안전하다.
                    if (tag == "iframe" || tag == "frame") && el.has_attribute("srcdoc") {
                        let doc = el.get_attribute("srcdoc").unwrap_or_default();
                        let _ = el.set_attribute("data-zp-srcdoc", &doc);
                        let _ = el.remove_attribute("srcdoc");
                    }
                    // Lazy filter: only snapshot attributes we actually care about
                    // (URL-bearing href/src/action/formaction or on* handlers).
                    // Avoids cloning ALL attributes on the vast majority of
                    // elements that have neither (div, span, p, td, …) — saves
                    // ~1000+ (String, String) tuple allocations per typical page.
                    // Attribute names from lol_html are already lowercase for HTML.
                    let attrs_snapshot: Vec<(String, String)> = el
                        .attributes()
                        .iter()
                        .filter_map(|a| {
                            let name = a.name();
                            let lower_view = name.as_str();
                            // `srcset`/`imagesrcset` must be here too — the lazy
                            // filter is what decides which attributes the rewrite
                            // loop below can even see. Leaving them out is why
                            // `<source srcset>` shipped raw target URLs.
                            let is_url_attr = matches!(
                                lower_view,
                                "href"
                                    | "src"
                                    | "action"
                                    | "formaction"
                                    | "srcset"
                                    | "imagesrcset"
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
                        // 위 lazy filter 와 **같은 목록**이어야 한다. 두 곳이
                        // 갈라지면 스냅샷은 됐는데 여기서 걸러져 조용히 누락된다.
                        let is_url_attr = matches!(
                            lower,
                            "href"
                                | "src"
                                | "action"
                                | "formaction"
                                | "srcset"
                                | "imagesrcset"
                                | "style"
                        );
                        if !is_on_handler && !is_url_attr {
                            continue;
                        }
                        if is_url_attr {
                            // lol_html 2.x's `Attribute::value()` returns the
                            // raw attribute body — HTML entities (`&amp;`,
                            // `&lt;`, …) stay literal. Wikipedia's stylesheet
                            // href is `https://…/load.php?lang=en&amp;modules=…`;
                            // percent-encoding `&amp;` produces a URL the
                            // upstream server interprets as `&amp;modules=…`
                            // (literal `&amp;` key) → empty response → blank
                            // page. Decode the named entities every URL
                            // realistically carries before further processing.
                            // Cow::Borrowed in the common case (no `&` in URL)
                            // → zero allocation on every subresource.
                            let decoded = decode_url_html_entities(&value);
                            let trimmed = decoded.trim_start();
                            if !starts_with_ascii_ci(trimmed, "javascript:") {
                                // Absolute URL on subresource tags must be
                                // rewritten to a same-origin SW route — the
                                // strict CSP would otherwise block external
                                // origins before the SW gets to intercept.
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
                                );
                                // Anchor / form / input / button URL attributes.
                                // Previously left raw because the runtime-prelude
                                // click handler intercepts normal left-clicks.
                                // BUG (2026-06-06): the raw `<a href="https://target/...">`
                                // still surfaces in browser-native UI:
                                //   - hover → status bar shows target host
                                //   - middle-click / ctrl-click → new tab navigates
                                //     directly to target → real IP leak
                                //   - target="_blank" → same as above
                                //   - right-click → "open in new tab" /
                                //     "copy link address" → same leak
                                // Rewrite to a proxy-origin "via" URL so every
                                // browser-native vector stays inside the proxy.
                                // `data-zp-target-url` carries the absolute target
                                // for the prelude click handler's fast path
                                // (`clickNavigationTarget` already prefers it).
                                let is_navigation = matches!(
                                    (tag.as_str(), lower),
                                    ("a", "href")
                                        | ("area", "href")
                                        | ("form", "action")
                                        | ("input", "formaction")
                                        | ("button", "formaction")
                                );
                                // 2026-08-14 — `srcset` / `imagesrcset` 도 서브리소스다.
                                //
                                // 목록에 `("source","src")` 는 있는데 `srcset` 이 없었다.
                                // NAVER 로그인의 소셜 아이콘이 정확히 이 형태다:
                                //   <picture><source srcset="https://ssl.pstatic.net/…svg"
                                //            media="(prefers-color-scheme: dark)">
                                // 원본 URL 이 그대로 남아 CSP `img-src 'self'` 에 걸려
                                // 차단됐다(`--enforce-csp` 로 처음 관측). 값이 콤마 구분
                                // 후보 목록이라 단일 URL 리라이터를 그대로 못 쓴다.
                                // 2026-08-14 — `style` **속성** 안의 `url()` 도 CSS 다.
                                //
                                // 인라인 `<style>` 요소는 앞서 닫았는데 속성 쪽은
                                // 그대로였다. naver.com 실측: `<div style="…
                                // background-image: url(https://s.pstatic.net/…)">`
                                // 가 원본 URL 로 남아 `img-src 'self'` 에 걸렸다.
                                //
                                // 속성 값은 스타일시트가 아니라 **선언 목록**이라
                                // 그대로 파싱되지 않는다. `a{…}` 로 감쌌다가 벗긴다.
                                // `rewrite_css` 는 span 기반 치환이라 나머지 바이트를
                                // 그대로 보존하므로 이 감쌌다 벗기기가 안전하다.
                                if lower == "style" {
                                    let wrapped = format!("a{{{}}}", trimmed);
                                    let res = zp_css::rewrite_css(
                                        &wrapped,
                                        &target_for_attr,
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
                                        &target_for_attr,
                                    ) {
                                        let _ = el.set_attribute(&name, &next);
                                    }
                                    continue;
                                }
                                if is_subresource {
                                    if let Some(next) = proxied_subresource_url(
                                        trimmed,
                                        &proxy_origin,
                                        "/zp/",
                                        &target_for_attr,
                                    ) {
                                        let _ = el.set_attribute(&name, &next);
                                        // Stash the original absolute URL so the runtime-
                                        // prelude can return it when target code reads
                                        // `script.src` / `link.href` / etc. Without this,
                                        // webpack's automatic publicPath detection (which
                                        // strips `?` query from `currentScript.src`) reduces
                                        // the proxy URL to `/zp/api/` and all chunk loads
                                        // 404 — observed on github.com.
                                        if matches!(tag.as_str(), "script" | "link") {
                                            if let Some(abs) =
                                                absolute_target_url(trimmed, &target_for_attr)
                                            {
                                                let _ =
                                                    el.set_attribute("data-zp-target-url", &abs);
                                            }
                                        }
                                    }
                                } else if is_navigation {
                                    if let Some(abs) =
                                        absolute_target_url(trimmed, &target_for_attr)
                                    {
                                        if let Some(next) =
                                            proxied_navigation_url(&abs, &proxy_origin, "/zp/")
                                        {
                                            let _ = el.set_attribute(&name, &next);
                                            let _ = el.set_attribute("data-zp-target-url", &abs);
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

/// Transform target HTML — rewrites inline scripts and `on*` event handlers
/// through `zp-rewriter`. In strict mode failures become safe placeholders.
///
/// Thin wrapper over the streaming [`HtmlTxn`]: it feeds the whole document as a
/// single chunk, so the buffered and streaming paths share ONE implementation
/// (no chance of divergence). `HtmlTxn`'s host test pins chunk-invariance.
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
/// prepended right after the `<head>` start tag as raw HTML — lol_html does NOT
/// re-tokenize inserted content, so our own bootstrap `<script>`s are never
/// script-rewritten. Shared by the buffered `transform` path and [`HtmlTxn`].
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
    let current_kind: Rc<RefCell<Option<ScriptKind>>> = Rc::new(RefCell::new(None));
    let current_buffer: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let kind_for_el = current_kind.clone();
    let kind_for_text = current_kind.clone();
    let kind_for_end = current_kind.clone();
    let buf_for_text = current_buffer.clone();
    let buf_for_end = current_buffer.clone();
    let target_for_end = target.clone();
    // Dynamic-import URLs inside inline scripts must be proxy-origin absolute
    // (see RewriteOpts::proxy_origin) — the end handler rewrites those too.
    let origin_for_end = proxy_origin.clone();
    let diags_for_end = diags.clone();
    // 2026-08-14 — 인라인 `<style>` 의 CSS 도 리라이트한다.
    //
    // 외부 스타일시트는 SW 의 `rewriteCSSResponse` 가 처리하는데 문서 안에
    // 인라인으로 박힌 CSS 는 아무도 안 건드리고 있었다. `--enforce-csp` 로 CSP 를
    // 실제로 켜자 드러났다: `@font-face { src: url(https://wtm.pstatic.net/fonts/
    // ncap-probe-*.woff2) }` 가 원본 URL 로 남아 `font-src 'self'` 에 걸린다.
    // (initiator 가 `parser` 인데 문서 HTML 에서 URL 이 안 나오면 인라인 CSS 를
    // 의심할 것 — CSSOM 조회로는 다른 프레임의 것을 못 본다.)
    //
    // 스크립트와 같은 방식으로 텍스트 노드를 모았다가 `last_in_text_node` 에서
    // 한 번에 리라이트한다. 청크 단위로 파싱하면 규칙이 중간에 잘린다.
    let style_buffer: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let style_buf_for_text = style_buffer.clone();
    let style_target = target.clone();
    let style_origin = proxy_origin.clone();

    let mut handlers = vec![
                element!("script", move |el| {
                    if el.has_attribute("src") {
                        *kind_for_el.borrow_mut() = None;
                        return Ok(());
                    }
                    let kind = match el.get_attribute("type").as_deref() {
                        Some(t) if t.eq_ignore_ascii_case("module") => Some(ScriptKind::Module),
                        Some(t) if !t.is_empty() && !is_javascript_type(t) => None,
                        _ => Some(ScriptKind::Classic),
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
                        // 파서가 실패하면 `rewrite_css` 가 원본을 그대로 돌려준다
                        // (외부 스타일시트 경로와 동일한 fail-open). CSS 는 실행
                        // 가능한 코드가 아니라 URL 참조만 문제이므로, 여기서
                        // fail-closed 로 가면 멀쩡한 페이지의 스타일을 날린다.
                        let res = zp_css::rewrite_css(&css, &style_target, "/zp/", &style_origin);
                        let rewritten = if res.ok { res.code } else { css };
                        chunk.after(&rewritten, ContentType::Text);
                    }
                    Ok(())
                }),
                text!("script", move |chunk| {
                    if kind_for_text.borrow().is_some() {
                        buf_for_text.borrow_mut().push_str(chunk.as_str());
                        chunk.remove();
                    }
                    if chunk.last_in_text_node() {
                        if let Some(kind) = *kind_for_end.borrow() {
                            let src = buf_for_end.borrow().clone();
                            buf_for_end.borrow_mut().clear();
                            // Emit the rewriter's output directly, wrapped in
                            // `__ZP_EXEC_INLINE_REWRITTEN(<code>)` which the prelude
                            // executes WITHOUT going through the page-side rewriter
                            // again. NAVER's main page ships ~200KB + ~150KB
                            // EAGER-DATA inline scripts; rewriting them twice
                            // (once here, once in prelude) wedges the main thread
                            // for tens of seconds. The `_REWRITTEN` wrapper is the
                            // single-rewrite path — its prelude handler is a thin
                            // `Native.FunctionCtor(code)` call. Dynamic injection
                            // (createElement('script').textContent = …) still
                            // uses `__ZP_EXEC_INLINE_SCRIPT(<source>)` because the
                            // page only sees raw source at that point.
                            // Trap-notebook (2026-05-29 double rewrite) describes
                            // the historical reason this was a re-rewrite loop;
                            // the new wrapper sidesteps it by NOT going through
                            // `rewriteWithPageRewriter` on the prelude side.
                            let opts = RewriteOpts {
                                kind,
                                target_url: target_for_end.clone(),
                                strict,
                                proxy_origin: origin_for_end.clone(),
                            };
                            let replacement = match rewrite_script(&src, &opts) {
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
                            };
                            // ContentType::Html → raw passthrough (no HTML
                            // escaping). The browser parses <script> bodies as
                            // raw text and does NOT entity-decode them, so any
                            // `&` we let lol_html turn into `&amp;` lands
                            // verbatim in the JS source and produces
                            // SyntaxError: Unexpected token '&'.
                            chunk.before(&replacement, ContentType::Html);
                        }
                    }
                    Ok(())
                }),
    ];
    if !prelude.is_empty() {
        // Prepend = insert as the FIRST child of <head> (right after the start
        // tag), matching the SW's regex `injectPrelude`. ContentType::Html →
        // emitted verbatim, never re-parsed by these script handlers.
        //
        // 2026-08-13 — `<head>` 하나만 앵커로 쓰면 **머리 없는 문서에서 통째로
        // 안 들어간다.** 우리는 브라우저 파서가 아니라 원본 바이트를 스트리밍으로
        // 보므로, 브라우저가 자동 생성해 주는 `<head>` 는 여기 없다.
        // NAVER 로그인 결과처럼 `<script>location.replace(...)</script>` 만 든
        // 미니 문서가 실제로 그랬다: 인라인 스크립트는 `__ZP_EXEC_INLINE_REWRITTEN`
        // 호출로 바뀌는데 그 헬퍼를 정의할 프렐류드가 없어 흰 화면이 됐다.
        //
        // 그래서 앵커를 단계적으로 둔다 — `head` → `body` → 첫 `script` 앞.
        // 마지막 것이 중요하다: 프렐류드가 **자기를 필요로 하는 첫 스크립트보다
        // 먼저** 들어간다는 보장이 거기서 나온다.
        let injected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        for (selector, before_element) in [("head", false), ("body", false), ("script", true)] {
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
    }
    Settings {
        element_content_handlers: handlers,
        ..Settings::new()
    }
}

/// The streaming HTML transform: two chained `lol_html` rewriters (attribute
/// pass → inline-script-body pass) fed incrementally. `write` returns the bytes
/// produced so far; `end` flushes and returns the tail + collected diagnostics.
/// Byte output is independent of chunk boundaries (lol_html's streaming
/// guarantee + a full intermediate buffer between the two passes), so it equals
/// the whole-string `transform`. NO timer, NO whole-input buffering.
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
    /// right after `<head>` (see [`script_settings`]); the buffered `transform`
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

/// Serialise a script body as a JSON string literal suitable for embedding as
/// the argument to `__ZP_EXEC_INLINE_SCRIPT(...)`. Escapes `</` to prevent
/// the closing `</script>` sequence from terminating the wrapper.
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

/// Resolve a relative URL against an absolute target base. Handles the three
/// common relative forms (host-absolute `/path`, query/fragment-only, and
/// path-relative) — enough for what we hit inside iframes. Returns None when
/// the base is not http(s) absolute or when the relative form can't be
/// interpreted (we'd rather emit nothing than a wrong URL).
fn resolve_against_base(rel: &str, base: &str) -> Option<String> {
    // ASCII CI check on the scheme — saves the `base.to_ascii_lowercase()`
    // alloc on every URL resolve. Called ~N URL-bearing-elements per page.
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
        out.push_str(rel);
        return Some(out);
    }
    // Path-relative: drop the last segment of base_path, append rel.
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..=i],
        None => "/",
    };
    let mut out = String::with_capacity(origin.len() + dir.len() + rel.len());
    out.push_str(origin);
    out.push_str(dir);
    out.push_str(rel);
    Some(out)
}

/// Decode the handful of named HTML entities that realistically appear in
/// URL attribute values produced by mainstream encoders. `lol_html` does not
/// decode entities for `Attribute::value()`; without this step `&amp;` makes
/// it through percent-encoding as a literal substring and the upstream
/// server reads keys like `&amp;modules=…` instead of `&modules=…`.
///
/// Returns `Cow::Borrowed` for the common case (no `&` in URL) so the caller
/// doesn't pay an allocation on every URL attribute. The slow path only fires
/// on Wikipedia-style entity-bearing URLs (~few per page).
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
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// Percent-encoding set for the `url=` / `via=` query values.
///
/// `NON_ALPHANUMERIC` also escapes the RFC 3986 *unreserved* bytes `-._~`.
/// That is legal but self-defeating: an SDK that locates its own `<script>`
/// tag with a CSS attribute selector (`script[src*="ncaptcha-api.js"]`) is
/// matched by the engine against the RAW attribute, and CSS selectors sit
/// BELOW the membrane — our `getAttribute`/`.src` masking cannot reach them.
/// With `.`/`-` escaped the attribute reads `ncaptcha%2Dapi%2Ejs`, the
/// selector never matches, and the SDK silently never boots. Observed on
/// NAVER's WTM captcha: `ncaptcha-onload` was never invoked, so `wtmncapt`
/// stayed undefined and every submit carried
/// `wtoken=error1|ReferenceError|wtmncapt is not defined`.
///
/// Leaving unreserved bytes raw is parse-neutral — none of `-._~` can
/// terminate a query value or introduce a parameter, so no escape hatch opens.
const URL_PARAM_ENCODE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Convert a subresource URL to the SW-routable `/zp/api/fetch?url=<encoded>`
/// form. Relative URLs are first resolved against `target_url` so the browser
/// doesn't end up fetching `/_next/image?...` from the proxy origin (which is
/// where it would resolve without a base — exactly the failure mode observed
/// inside NAVER's `shopsquare.naver.com` iframe). Returns None for fragment-
/// only refs and inert schemes (data:/blob:/about:/mailto:).
/// Rewrite every candidate URL in a `srcset` / `imagesrcset` list, keeping the
/// descriptors (`2x`, `640w`) and the list shape intact. Returns `None` when
/// nothing changed, so the caller can skip the attribute write.
///
/// **Why a hand-rolled scanner instead of `split(',')`:** a candidate may be a
/// `data:` URL, and those contain commas (`data:image/gif;base64,R0lGOD…`).
/// Splitting on commas would cut them in half. A `srcset` URL cannot contain
/// whitespace, so "read until whitespace" is the correct way to take a URL;
/// only *after* the URL do commas act as separators.
fn proxied_srcset(
    raw: &str,
    proxy_origin: &str,
    control_prefix: &str,
    target_url: &str,
) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len() + 64);
    let mut i = 0usize;
    let mut changed = false;
    while i < bytes.len() {
        // Leading whitespace and stray commas between candidates.
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        out.push_str(&raw[start..i]);
        if i >= bytes.len() {
            break;
        }
        // URL: everything up to the next whitespace or comma. `data:` URLs may
        // carry commas, so for those only whitespace terminates.
        let url_start = i;
        let is_data = raw[i..].len() >= 5 && raw[i..i + 5].eq_ignore_ascii_case("data:");
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && (is_data || bytes[i] != b',')
        {
            i += 1;
        }
        let url = &raw[url_start..i];
        match proxied_subresource_url(url, proxy_origin, control_prefix, target_url) {
            Some(next) => {
                out.push_str(&next);
                changed = true;
            }
            None => out.push_str(url),
        }
        // Descriptor (and anything else) up to the next comma.
        let desc_start = i;
        while i < bytes.len() && bytes[i] != b',' {
            i += 1;
        }
        out.push_str(&raw[desc_start..i]);
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

fn proxied_subresource_url(
    raw: &str,
    proxy_origin: &str,
    control_prefix: &str,
    target_url: &str,
) -> Option<String> {
    use percent_encoding::utf8_percent_encode;
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
        // `format!` per scheme-relative URL avoided — push_str chain
        // is ~1.5-2× faster than `format!` in micro-benches.
        let mut a = String::with_capacity(6 + s.len());
        a.push_str("https:");
        a.push_str(s);
        a
    } else if let Some(abs) = resolve_against_base(s, target_url) {
        abs
    } else {
        return None;
    };
    // Emit a proxy-origin-absolute URL so the page's virtual baseURI override
    // does NOT shift the resolution to the target host. Falls back to a
    // root-relative path only if proxy_origin was not supplied.
    //
    // Reserve generously (~3× absolute) — percent-encoding `NON_ALPHANUMERIC`
    // expands every non-alphanumeric byte to `%XX`. Worst-case 3x for ASCII.
    let mut out =
        String::with_capacity(proxy_origin.len() + control_prefix.len() + absolute.len() * 3 + 32);
    out.push_str(proxy_origin.trim_end_matches('/'));
    out.push_str(control_prefix);
    if !out.ends_with('/') {
        out.push('/');
    }
    out.push_str("api/fetch?url=");
    // Stream percent-encoded chunks directly into `out` instead of
    // collecting into an intermediate String via `.to_string()`. Saves one
    // allocation per subresource URL — the dominant hot path on
    // resource-heavy pages.
    for chunk in utf8_percent_encode(&absolute, URL_PARAM_ENCODE) {
        out.push_str(chunk);
    }
    Some(out)
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

/// Build the proxy-origin "go-via launcher" URL used to rewrite anchor /
/// form / formaction attributes. Output shape:
///   `<proxy_origin><control_prefix>?via=<percent_encoded_absolute_target>`
///
/// Why a launcher URL instead of leaving the raw target: hover, middle-click,
/// ctrl-click, `target="_blank"`, "open in new tab" and "copy link address"
/// all read the raw attribute value — leaving the target host on disk would
/// leak it to the browser's native UI (and through "open in new tab" trigger
/// a real direct fetch to the target, bypassing the proxy entirely).
///
/// The runtime-prelude click handler reads `data-zp-target-url` first
/// (`clickNavigationTarget` in `web/runtime-prelude.js`), so normal in-page
/// left-clicks still take the share-encrypt fast path. The `?via=` URL is
/// the slow-path fallback consumed by the launcher when the browser performs
/// a native navigation (new tab, etc.).
///
/// Returns `None` if `proxy_origin` was not supplied (host-test fallback).
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

/// Minimal percent-decoder for URL bodies. Avoids the `percent_encoding`
/// crate dependency for now; we handle the common ASCII pairs target sites
/// produce (e.g. %22, %20, %3B). Non-decodable sequences are left as-is so
/// the rewriter receives best-effort JavaScript text.
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

    fn opts() -> TransformOptions {
        TransformOptions {
            target_url: "https://example.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        }
    }

    // 파싱 시점 `srcdoc` 은 멤브레인 없는 문서를 만든다 — 이름을 옮겨 두고
    // 페이지 realm 이 후킹된 세터로 되돌리게 한다. 옮기기만 하고 값을 잃으면
    // iframe 이 통째로 비므로 **값 보존까지** 확인한다.
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
    // A representative document exercising every Pass-1 / Pass-2 path: head,
    // inline classic + module scripts, external script (src), a stylesheet
    // link, an absolute anchor, an on* handler, and a javascript: URL — so
    // chunk-invariance is stressed across all handler kinds.
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

    // Pin: streaming `HtmlTxn` in N chunks == the whole-string `transform`,
    // for every chunk size — including size 1 (splits tags, scripts, and the
    // gzip-realistic byte boundaries). This is THE correctness guarantee for
    // the streaming HTML render: chunk boundaries must never change output.
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

    // Repro: NAVER search.js `loadRemoteFrame` embeds search.naver.com/remote_frame
    // (the CrossDomainStorage helper). It is XHTML (XHTML-1.0 doctype + xmlns +
    // self-closing <meta/>). If transform() errors on it, the SW returns
    // MALFORMED_HTML 502 for the iframe → search hydration stalls. This pins that
    // the real content transforms cleanly.
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
        // Inline scripts must be rewritten (membrane), external src proxied.
        assert!(out.contains("/zp/api/script") || out.contains("__zp"), "remote_frame not rewritten: {out}");
    }

    // Pin: a non-empty prelude is injected exactly once, right after <head>,
    // and is NOT script-rewritten (our bootstrap must survive verbatim).
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
        // Injected exactly once.
        assert_eq!(html.matches(prelude).count(), 1, "prelude count != 1: {html}");
        // Right after the <head> start tag.
        let head_open = html.find("<head").map(|i| html[i..].find('>').unwrap() + i + 1).unwrap();
        assert!(
            html[head_open..].trim_start().starts_with(prelude),
            "prelude not first child of <head>: {}",
            &html[head_open..head_open + 120.min(html.len() - head_open)]
        );
        // The prelude's own `location.href` must remain raw (NOT wrapped in
        // __ZP_EXEC_INLINE_REWRITTEN / membrane calls) — it bypassed Pass 2.
        assert!(
            html.contains("var __zp_boot = location.href;"),
            "prelude script was rewritten (must be verbatim): {html}"
        );
    }

    // Pin: `<head>` 가 없는 문서에도 프렐류드가 들어가야 한다.
    //
    // 실제 장애였다. NAVER 로그인 결과는 `<script>location.replace(...)</script>`
    // 만 든 미니 문서로 오는데, 우리는 브라우저 파서가 아니라 원본 바이트를 보므로
    // 브라우저가 자동 생성해 주는 `<head>` 가 여기엔 없다. 그런데 인라인 스크립트는
    // `__ZP_EXEC_INLINE_REWRITTEN(...)` 호출로 바뀌므로, 프렐류드가 없으면
    // `ReferenceError` 로 문서가 통째로 죽는다(흰 화면).
    // 2026-08-14 — 타깃이 `<meta http-equiv="Content-Security-Policy">` 로 실어
    // 보내는 자기 CSP 는 무력화해야 한다. 응답 헤더의 CSP 는 SW 가 교체하지만
    // meta 는 그대로 통과하고 있었고, 그러면 **그들의 정책이 우리 문서에 적용된다.**
    // NAVER 로그인 페이지 실측: 그들의 nonce 정책이 우리가 리라이트한 인라인
    // 스크립트("Executing inline script violates … 'nonce-…'")와 멤브레인의 eval
    // 경로("'unsafe-eval' is not an allowed source")를 둘 다 막았다. 우리는 그들의
    // nonce 를 재현할 수 없으므로 이 meta 는 반드시 죽여야 한다.
    // 2026-08-14 — `srcset` / `imagesrcset` 도 리라이트한다.
    //
    // 목록에 `("source","src")` 는 있는데 `srcset` 이 없어서, NAVER 로그인의
    // 소셜 아이콘(`<picture><source srcset="https://ssl.pstatic.net/…svg">`)이
    // 원본 URL 로 남아 CSP `img-src 'self'` 에 걸려 차단됐다. taskweaver
    // `--enforce-csp` 로 CSP 를 실제로 켜기 전까지는 SW 가 받아 주는 바람에
    // 증상이 보이지 않았다.
    // 2026-08-14 — 인라인 `<style>` 안의 URL 도 리라이트한다.
    //
    // 외부 스타일시트는 SW 의 rewriteCSSResponse 가 처리하는데 문서에 인라인으로
    // 박힌 CSS 는 아무도 안 건드리고 있었다. `--enforce-csp` 로 CSP 를 실제로
    // 켜자 `@font-face` 의 폰트 URL 이 `font-src 'self'` 에 걸려 드러났다.
    // 2026-08-14 — `style` **속성** 안의 url() 도 CSS 다.
    //
    // 인라인 `<style>` 요소를 닫은 뒤에도 naver.com 에서 CSP 위반이 남았다:
    // `<div style="… background-image: url(https://s.pstatic.net/…)">`.
    // 속성 값은 스타일시트가 아니라 선언 목록이라 `a{…}` 로 감쌌다 벗긴다.
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

        assert!(!html.contains("url(https://cdn.test/bg.png)"), "style attr url raw: {html}");
        assert!(html.contains("/zp/api/fetch?url="), "no proxied url emitted: {html}");
        // 다른 선언은 그대로 남아야 한다 — 감쌌다 벗기기가 값을 갉아먹으면 안 된다.
        assert!(html.contains("position:absolute"), "sibling declaration lost: {html}");
        assert!(html.contains("color: red"), "unrelated style attr mangled: {html}");
        // inert 스킴은 손대지 않는다.
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
        // 선언 자체는 살아 있어야 한다 — CSS 를 통째로 날리면 페이지가 무너진다.
        assert!(html.contains("@font-face"), "@font-face dropped: {html}");
        assert!(html.contains("format("), "declaration mangled: {html}");
        // inert 스킴은 그대로 — 네트워크로 나가지 않으므로 프록시할 이유가 없다.
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

        // 후보 URL 이 하나도 원본으로 남아선 안 된다.
        assert!(!html.contains("\"https://cdn.test/a.svg\""), "source srcset raw: {html}");
        assert!(!html.contains("https://cdn.test/1x.png 1x"), "img srcset raw: {html}");
        assert!(!html.contains("https://cdn.test/2x.png 2x"), "img srcset 2x raw: {html}");
        // 디스크립터와 목록 모양은 보존된다.
        assert!(html.contains(" 1x,"), "descriptor/comma lost: {html}");
        assert!(html.contains(" 2x\""), "descriptor lost: {html}");
        // `data:` 는 그대로 통과해야 하고, 내부 콤마 때문에 잘리면 안 된다.
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

        // 브라우저가 정책으로 읽을 수 있는 형태가 하나도 남아선 안 된다.
        // 앞의 공백이 중요하다: `data-zp-blocked-http-equiv=` 도 `http-equiv=` 를
        // 부분 문자열로 포함하므로, 그냥 검사하면 무력화된 것까지 걸려 통과할 수 없다.
        assert!(
            !html
                .to_ascii_lowercase()
                .contains(" http-equiv=\"content-security-policy"),
            "target CSP meta survived: {html}"
        );
        // 값은 남겨 둔다 — 페이지 JS 가 자기 정책을 읽어 확인하는 경우가 있다.
        assert!(html.contains("data-zp-blocked-http-equiv"), "no marker: {html}");
        assert!(html.contains("nonce-abc"), "policy value dropped: {html}");
        // 무관한 http-equiv 는 건드리지 않는다.
        assert!(html.contains("X-UA-Compatible"), "unrelated meta touched: {html}");
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
            // 그리고 자기를 필요로 하는 호출보다 **앞에** 있어야 한다.
            let p = html.find(prelude).unwrap();
            let call = html
                .find("__ZP_EXEC_INLINE_REWRITTEN(")
                .expect("inline script should have been rewritten");
            assert!(p < call, "prelude must precede the call it defines: {html}");
        }
    }

    #[test]
    fn inline_script_rewrites_location() {
        let html = "<html><body><script>var u = location.href;</script></body></html>";
        let r = transform(html, &opts()).unwrap();
        // zp-htmltx now wraps the *rewritten* inline body in
        // __ZP_EXEC_INLINE_REWRITTEN(<rewritten>) — prelude executes without
        // re-rewriting. Verify the wrapper is present and the payload contains
        // membrane calls, not the raw `location.href` access.
        assert!(
            r.html.contains("__ZP_EXEC_INLINE_REWRITTEN("),
            "wrap missing: {}",
            r.html
        );
        assert!(
            r.html.contains("__zp_get"),
            "rewritten payload missing: {}",
            r.html
        );
        assert!(
            !r.html.contains("var u = location.href"),
            "raw source must not survive — leak: {}",
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
        // The src= URL itself is rewritten by the URL attribute observer in
        // runtime-prelude or by Phase D1; this test only ensures we don't
        // try to rewrite a body that doesn't exist. Use an absolute URL so
        // the src-rewrite path is identical to production.
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
        // Wrap in __ZP_EXEC_INLINE_REWRITTEN_MODULE with the rewritten body.
        assert!(
            r.html.contains("__ZP_EXEC_INLINE_REWRITTEN_MODULE("),
            "module wrap missing: {}",
            r.html
        );
        assert!(
            r.html.contains("__zp_get"),
            "rewritten payload missing: {}",
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
        // Encoded percent-triple decoded prior to OXC parse → `top` rewritten.
        assert!(
            r.html.contains("data-zp-jsurl"),
            "should have stash: {}",
            r.html
        );
    }

    #[test]
    fn anchor_absolute_href_rewritten_to_proxy_via() {
        // 2026-06-06 escape vector fix: raw target on <a href> leaks to
        // browser-native UI (hover/middle-click/copy-link/open-in-new-tab).
        // Rewrite to a proxy-origin "?via=" URL + stash absolute on
        // data-zp-target-url for the prelude click handler's fast path.
        let html = "<a href=\"https://example.com/x\">x</a>";
        let r = transform(html, &opts()).unwrap();
        assert!(
            !r.html.contains("href=\"https://example.com/x\""),
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
            !r.html.contains("href=\"/news/topAside\""),
            "raw relative href must not survive: {}",
            r.html
        );
    }

    #[test]
    fn anchor_fragment_only_href_left_alone() {
        // Page-internal fragment anchors (`#section`) carry no target host,
        // so leave them as-is — the prelude click handler treats them as
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
            !r.html.contains("href=\"https://example.com/clickmap\""),
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
            !r.html.contains("action=\"https://example.com/login\""),
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
            !r.html.contains("formaction=\"https://example.com/submit\""),
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
            !r.html.contains("formaction=\"https://example.com/go\""),
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
        // Real NAVER main page anchor patterns observed in DOM.
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
            !r.html.contains("href=\"https://whale.naver.com"),
            "raw whale.naver.com href must not survive: {}",
            r.html
        );
    }

    #[test]
    fn proxy_origin_blank_skips_navigation_rewrite() {
        // Host-test fallback: when proxy_origin is empty (legacy / test
        // harness), don't synthesize a URL — leave the raw attribute so
        // callers can opt out cleanly.
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
    fn stylesheet_link_with_html_entity_decoded() {
        // Wikipedia emits `<link href="…/load.php?lang=en&amp;modules=…">`;
        // lol_html returns the raw value with `&amp;` intact, so percent-
        // encoding without HTML-entity decoding produces a URL where the
        // upstream server reads `&amp;modules=` as a separate key and returns
        // empty CSS. Decode first, then percent-encode the canonical URL.
        let html = "<link rel=\"stylesheet\" href=\"https://cdn.example.com/load.php?lang=en&amp;modules=site.styles\">";
        let r = transform(html, &opts()).unwrap();
        assert!(
            r.html.contains("/zp/api/fetch?url="),
            "link href must route through SW: {}",
            r.html
        );
        // The encoded URL must not contain the encoded entity `%26amp%3B`
        // (which is `&amp;` percent-encoded). It must contain `%26` (`&`)
        // followed by `modules=` directly.
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
            !r.html.contains("href=\"https://cdn.example.com/main.css\""),
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

    #[test]
    fn host_relative_img_resolved_against_target() {
        // Naver shopsquare iframe emits <img src="/_next/image?...">; without
        // base resolution the browser fetches from the proxy origin → 404.
        let html = "<img src=\"/_next/image?url=%2Fpng%2Ferror.png&w=1920&q=75\">";
        let opts = TransformOptions {
            target_url: "https://shopsquare.naver.com/".into(),
            strict: true,
            pending_gate: false,
            proxy_origin: "http://proxy.localhost:18080".into(),
        };
        let r = transform(html, &opts).unwrap();
        // Encoded form of `https://shopsquare.naver.com/_next/image?url=%2Fpng%2Ferror.png&w=1920&q=75`
        // (we expect the absolute URL to be percent-encoded into the proxy fetch query).
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
        // Regression: virtual baseURI override on the page resolves
        // root-relative `/zp/...` against the target host, so subresources
        // must emit a proxy-origin-absolute URL. See
        // .ai/trap-notebook/membrane.md (2026-05-29 setScriptSource fix) for the
        // companion runtime-prelude bug that re-stripped this prefix.
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
        // An SDK that finds its own tag via `script[src*="ncaptcha-api.js"]`
        // is matched by the engine against the RAW attribute — CSS selectors
        // sit below the membrane, so `.`/`-`/`_`/`~` must survive encoding or
        // self-discovery silently fails (NAVER WTM captcha: `ncaptcha-onload`
        // never fired → `wtmncapt is not defined` in every submitted token).
        let html = "<script src=\"https://ncpt.naver.com/static/ncaptcha-api.js?k=1\"></script>";
        let r = transform(html, &opts()).unwrap();
        assert!(r.html.contains("ncaptcha-api.js?k=1") || r.html.contains("ncaptcha-api.js%3Fk"));
        assert!(
            r.html.contains("static%2Fncaptcha-api.js"),
            "unreserved bytes must stay raw inside url=: {}",
            r.html
        );
        // …but reserved delimiters stay escaped — no new escape hatch.
        assert!(r.html.contains("url=https%3A%2F%2Fncpt.naver.com"), "got: {}", r.html);
        assert!(r.html.contains("%3Fk%3D1"), "query delimiters must stay encoded: {}", r.html);
    }

    #[test]
    fn relative_subresource_resolved_against_target() {
        // Earlier this test claimed the SW classifier would pick relative URLs
        // up via VIRTUAL_SUBRESOURCE — but classify() only routes paths under
        // /zp/, so `/static/a.css` actually fell through to UNKNOWN → fetch
        // failure. The real fix is to resolve relatives against the target
        // URL here so the browser issues a proxified absolute fetch.
        let html =
            "<link rel=\"stylesheet\" href=\"/static/a.css\"><script src=\"./b.js\"></script>";
        let r = transform(html, &opts()).unwrap();
        // Host-relative against https://example.com/ → https://example.com/static/a.css
        assert!(
            r.html.contains("example.com%2Fstatic%2Fa.css"),
            "host-relative link must resolve against target: {}",
            r.html
        );
        // Path-relative against https://example.com/ → https://example.com/./b.js
        assert!(
            r.html.contains("example.com%2F.%2Fb.js"),
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
        // iframe navigation stays under the runtime-prelude's
        // `installNetworkContainment` hook for now — rewriting iframe src in
        // htmltx would race with the child-realm fetch pipeline (sw control
        // reset after document.write, child Function captured, etc.). The
        // anchor/form/input/button rewrite landed 2026-06-06 explicitly
        // EXCLUDES iframe to avoid regression. See trap-notebook.
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
    // Diagnostic: how long does transform() take on the REAL NAVER document
    // (8 inline scripts, 204 KB total, largest 181 KB)? This runs on the SW's
    // single JS thread in production, so anything measured in seconds here
    // means the Service Worker is wedged for that long — no fetch, no stream
    // delivery, CDP unresponsive.
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
    // The production path is STREAMING (HtmlTxn.write per decoded chunk), not
    // the buffered transform(). Measure the real cost at realistic chunk sizes.
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
