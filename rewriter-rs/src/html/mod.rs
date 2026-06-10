pub mod document;

pub(crate) struct URLPolicy {
    pub(crate) ok: bool,
    pub(crate) url: String,
    pub(crate) target: String,
    pub(crate) error: String,
}

pub(crate) fn fetch_url(raw: &str, target_url: &str, control_prefix: &str) -> URLPolicy {
    let blocked = || URLPolicy {
        ok: false,
        url: format!("{}error/POLICY_BLOCKED", control_prefix),
        target: String::new(),
        error: "POLICY_BLOCKED".to_string(),
    };
    let text = raw.trim();
    if text.is_empty() || text.starts_with('#') || is_executable_scheme(text) {
        return blocked();
    }
    let target = match resolve_http_target(target_url, text) {
        Some(value) => value.to_string(),
        None => return blocked(),
    };
    let out = format!("{}error/POLICY_BLOCKED", control_prefix);
    URLPolicy {
        ok: true,
        url: out,
        target,
        error: String::new(),
    }
}

pub(crate) fn srcset(raw: &str, target_url: &str, control_prefix: &str) -> URLPolicy {
    let candidates = parse_srcset(raw);
    if candidates.is_empty() {
        return URLPolicy {
            ok: false,
            url: raw.to_string(),
            target: raw.to_string(),
            error: "UNCHANGED".to_string(),
        };
    }
    let mut out = Vec::with_capacity(candidates.len());
    let mut visible = Vec::with_capacity(candidates.len());
    let mut changed = false;
    for candidate in candidates {
        if candidate.url.is_empty() {
            continue;
        }
        let rewritten = fetch_url(candidate.url, target_url, control_prefix);
        if !rewritten.ok {
            out.push(candidate.raw.clone());
            visible.push(candidate.raw);
            continue;
        }
        out.push(join_srcset_candidate(&rewritten.url, candidate.descriptor));
        if rewritten.target.is_empty() {
            visible.push(candidate.raw);
        } else {
            visible.push(join_srcset_candidate(
                &rewritten.target,
                candidate.descriptor,
            ));
        }
        changed = true;
    }
    if !changed {
        return URLPolicy {
            ok: false,
            url: raw.to_string(),
            target: raw.to_string(),
            error: "UNCHANGED".to_string(),
        };
    }
    URLPolicy {
        ok: true,
        url: out.join(", "),
        target: visible.join(", "),
        error: String::new(),
    }
}

pub(crate) fn target_url(raw: &str, target_url: &str, control_prefix: &str) -> URLPolicy {
    let blocked = || URLPolicy {
        ok: false,
        url: format!("{}error/POLICY_BLOCKED", control_prefix),
        target: String::new(),
        error: "POLICY_BLOCKED".to_string(),
    };
    let text = raw.trim();
    if text.is_empty() || text.starts_with('#') || is_executable_scheme(text) {
        return blocked();
    }
    let Some(abs) = resolve_http_target(target_url, text) else {
        return blocked();
    };
    let target = abs.to_string();
    URLPolicy {
        ok: true,
        url: target.clone(),
        target,
        error: String::new(),
    }
}

pub(crate) fn link_rel_kind(rel: &str) -> &'static str {
    let mut kind = "pass";
    for token in rel
        .trim()
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .filter(|token| !token.is_empty())
    {
        let token = token.to_ascii_lowercase();
        if is_blocked_link_rel_token(&token) {
            return "blocked";
        }
        if is_icon_link_rel_token(&token) {
            kind = "icon";
            continue;
        }
        if token == "stylesheet" && kind == "pass" {
            kind = "stylesheet";
        }
    }
    kind
}

pub(crate) fn blocked_element_kind(tag: &str) -> &'static str {
    match tag.trim().to_ascii_lowercase().as_str() {
        "object" => "object",
        "embed" => "embed",
        _ => "pass",
    }
}

pub(crate) fn meta_policy_kind(http_equiv: &str) -> &'static str {
    match http_equiv.trim().to_ascii_lowercase().as_str() {
        "refresh" | "content-security-policy" | "content-security-policy-report-only" => "drop",
        _ => "pass",
    }
}

pub(crate) fn attr_policy_kind(tag: &str, key: &str) -> &'static str {
    let tag = tag.trim().to_ascii_lowercase();
    match attr_local_name(key).as_str() {
        "style" => "style",
        "href" => match tag.as_str() {
            "a" | "area" => "navigation",
            "link" | "image" | "use" => "passive",
            _ => "pass",
        },
        "action" if tag == "form" => "navigation",
        "formaction" if tag == "input" || tag == "button" => "navigation",
        "src" => match tag.as_str() {
            "iframe" | "frame" => "navigation",
            "img" | "source" | "audio" | "video" | "track" | "input" => "passive",
            _ => "pass",
        },
        "poster" if tag == "video" => "passive",
        "srcset" if tag == "img" || tag == "source" => "srcset",
        _ => "pass",
    }
}

pub(crate) fn script_type_kind(script_type: &str) -> &'static str {
    match script_type.trim().to_ascii_lowercase().as_str() {
        ""
        | "text/javascript"
        | "application/javascript"
        | "application/ecmascript"
        | "text/ecmascript" => "classic",
        "module" => "module",
        "importmap" => "importmap",
        "speculationrules" => "speculationrules",
        _ => "pass",
    }
}

pub(crate) fn event_handler_attr_kind(attr_name: &str) -> &'static str {
    let attr_name = attr_name.trim().to_ascii_lowercase();
    if attr_name.starts_with("on") && attr_name.len() > 2 {
        "block"
    } else {
        "pass"
    }
}

fn attr_local_name(key: &str) -> String {
    let key = key.trim().to_ascii_lowercase();
    match key.split_once(':') {
        Some((_, local)) => local.to_string(),
        None => key,
    }
}

fn is_blocked_link_rel_token(token: &str) -> bool {
    matches!(
        token,
        "modulepreload"
            | "preload"
            | "prefetch"
            | "preconnect"
            | "dns-prefetch"
            | "prerender"
            | "manifest"
    )
}

fn is_icon_link_rel_token(token: &str) -> bool {
    matches!(
        token,
        "icon"
            | "mask-icon"
            | "apple-touch-icon"
            | "apple-touch-icon-precomposed"
            | "apple-touch-startup-image"
            | "fluid-icon"
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SrcsetCandidate<'a> {
    raw: String,
    url: &'a str,
    descriptor: &'a str,
}

fn parse_srcset(raw: &str) -> Vec<SrcsetCandidate<'_>> {
    let mut out = Vec::new();
    let mut rest = raw.trim();
    while !rest.is_empty() {
        rest = trim_leading_html_space(rest);
        if rest.is_empty() {
            break;
        }
        let (candidate, next, more) = next_srcset_candidate(rest);
        out.push(candidate);
        if !more {
            break;
        }
        rest = next;
    }
    out
}

fn next_srcset_candidate(input: &str) -> (SrcsetCandidate<'_>, &str, bool) {
    let url_end = srcset_url_end(input);
    let mut candidate_end = url_end;
    for (offset, ch) in input[url_end..].char_indices() {
        if ch == ',' {
            break;
        }
        candidate_end = url_end + offset + ch.len_utf8();
    }
    if candidate_end < url_end {
        candidate_end = url_end;
    }
    if input[url_end..].chars().all(|ch| ch != ',') {
        candidate_end = input.len();
    }
    let candidate = SrcsetCandidate {
        raw: input[..candidate_end].trim().to_string(),
        url: &input[..url_end],
        descriptor: input[url_end..candidate_end].trim(),
    };
    if candidate_end >= input.len() {
        return (candidate, "", false);
    }
    (candidate, &input[candidate_end + 1..], true)
}

fn srcset_url_end(input: &str) -> usize {
    let lower = input.to_ascii_lowercase();
    if lower.starts_with("data:") {
        for (idx, ch) in input.char_indices() {
            if is_html_space(ch) {
                return idx;
            }
        }
        return input.len();
    }
    for (idx, ch) in input.char_indices() {
        if is_html_space(ch) || ch == ',' {
            return idx;
        }
    }
    input.len()
}

fn trim_leading_html_space(input: &str) -> &str {
    let mut start = 0;
    for (idx, ch) in input.char_indices() {
        if !is_html_space(ch) {
            start = idx;
            return &input[start..];
        }
        start = idx + ch.len_utf8();
    }
    &input[start..]
}

fn is_html_space(ch: char) -> bool {
    matches!(ch, ' ' | '\n' | '\t' | '\r' | '\u{000C}')
}

fn join_srcset_candidate(url_part: &str, descriptor: &str) -> String {
    let descriptor = descriptor.trim();
    if descriptor.is_empty() {
        url_part.to_string()
    } else {
        format!("{url_part} {descriptor}")
    }
}

fn resolve_http_target(base: &str, raw: &str) -> Option<url::Url> {
    let abs = absolute_url(base, raw)?;
    if is_http_url(abs.as_str()) {
        Some(abs)
    } else {
        None
    }
}

fn is_executable_scheme(spec: &str) -> bool {
    if !has_scheme(spec) {
        return false;
    }
    let scheme = spec.split_once(':').map(|(value, _)| value).unwrap_or("");
    scheme.eq_ignore_ascii_case("javascript")
        || scheme.eq_ignore_ascii_case("data")
        || scheme.eq_ignore_ascii_case("vbscript")
}

fn absolute_url(base: &str, raw: &str) -> Option<url::Url> {
    url::Url::parse(raw)
        .or_else(|_| url::Url::parse(base).and_then(|base_url| base_url.join(raw)))
        .ok()
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn has_scheme(spec: &str) -> bool {
    let mut chars = spec.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{
        attr_policy_kind, blocked_element_kind, event_handler_attr_kind, fetch_url, link_rel_kind,
        meta_policy_kind, parse_srcset, script_type_kind, srcset, target_url, SrcsetCandidate,
    };

    #[test]
    fn rewrites_fetch_urls_without_leaking_fragments_to_network_target() {
        let out = fetch_url(
            "/icons.svg#icon-a",
            "https://target.example/app/page.html",
            "/zp/",
        );
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert_eq!(out.target, "https://target.example/icons.svg#icon-a");
        assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
    }

    #[test]
    fn resolves_relative_fetch_urls() {
        let out = fetch_url(
            "../media.webm",
            "https://target.example/app/page.html",
            "/zp/",
        );
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert_eq!(out.target, "https://target.example/media.webm");
        assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
    }

    #[test]
    fn rewrites_static_srcset_policy() {
        let out = srcset(
            "/small.png 1x, ../large.png 2x, data:image/png,AAAA 3x",
            "https://target.example/app/page.html",
            "/zp/",
        );
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert_eq!(
            out.url,
            "/zp/error/POLICY_BLOCKED 1x, /zp/error/POLICY_BLOCKED 2x, data:image/png,AAAA 3x"
        );
        assert_eq!(
            out.target,
            "https://target.example/small.png 1x, https://target.example/large.png 2x, data:image/png,AAAA 3x"
        );
    }

    #[test]
    fn keeps_srcset_unchanged_without_rewritable_candidates() {
        let out = srcset(
            "data:image/png,AAAA 1x, javascript:alert(1) 2x",
            "https://target.example/app/page.html",
            "/zp/",
        );
        assert!(!out.ok);
        assert_eq!(out.url, "data:image/png,AAAA 1x, javascript:alert(1) 2x");
    }

    #[test]
    fn parses_srcset_like_static_html_policy() {
        let got = parse_srcset(" /a.png 1x, data:image/png,AAAA 2x, ../b.png ");
        assert_eq!(
            got,
            vec![
                SrcsetCandidate {
                    raw: "/a.png 1x".to_string(),
                    url: "/a.png",
                    descriptor: "1x"
                },
                SrcsetCandidate {
                    raw: "data:image/png,AAAA 2x".to_string(),
                    url: "data:image/png,AAAA",
                    descriptor: "2x"
                },
                SrcsetCandidate {
                    raw: "../b.png".to_string(),
                    url: "../b.png",
                    descriptor: ""
                },
            ]
        );
    }

    #[test]
    fn blocks_non_http_fetch_urls() {
        for raw in [
            "",
            "#local",
            "javascript:alert(1)",
            "data:image/png,0",
            "mailto:a@b",
        ] {
            let out = fetch_url(raw, "https://target.example/app/page.html", "/zp/");
            assert!(!out.ok, "{raw} unexpectedly rewrote to {}", out.url);
            assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
        }
    }

    #[test]
    fn resolves_visible_target_urls_for_static_html_policy() {
        let out = target_url("touch.png", "https://target.example/app/page.html", "/zp/");
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert_eq!(out.target, "https://target.example/app/touch.png");
        assert_eq!(out.url, out.target);
    }

    #[test]
    fn blocks_visible_target_urls_without_http_targets() {
        for raw in [
            "",
            "#local",
            "javascript:alert(1)",
            "data:image/png,0",
            "mailto:a@b",
        ] {
            let out = target_url(raw, "https://target.example/app/page.html", "/zp/");
            assert!(!out.ok, "{raw} unexpectedly resolved to {}", out.target);
            assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
        }
    }

    #[test]
    fn classifies_static_link_rel_policy() {
        for rel in [
            "preload",
            "modulepreload stylesheet",
            "icon, preconnect",
            "dns-prefetch",
            "manifest",
        ] {
            assert_eq!(link_rel_kind(rel), "blocked", "{rel}");
        }
        for rel in [
            "icon",
            "mask-icon",
            "apple-touch-icon",
            "apple-touch-icon-precomposed",
            "apple-touch-startup-image",
            "fluid-icon",
        ] {
            assert_eq!(link_rel_kind(rel), "icon", "{rel}");
        }
        assert_eq!(link_rel_kind("stylesheet"), "stylesheet");
        assert_eq!(link_rel_kind("alternate stylesheet"), "stylesheet");
        assert_eq!(link_rel_kind("canonical"), "pass");
        assert_eq!(link_rel_kind(""), "pass");
    }

    #[test]
    fn classifies_static_blocked_element_policy() {
        assert_eq!(blocked_element_kind("object"), "object");
        assert_eq!(blocked_element_kind(" EMBED "), "embed");
        assert_eq!(blocked_element_kind("iframe"), "pass");
    }

    #[test]
    fn classifies_static_meta_policy() {
        assert_eq!(meta_policy_kind("refresh"), "drop");
        assert_eq!(meta_policy_kind(" Content-Security-Policy "), "drop");
        assert_eq!(
            meta_policy_kind("content-security-policy-report-only"),
            "drop"
        );
        assert_eq!(meta_policy_kind("viewport"), "pass");
        assert_eq!(meta_policy_kind(""), "pass");
    }

    #[test]
    fn classifies_static_attr_policy() {
        for (tag, key) in [
            ("a", "href"),
            ("area", "href"),
            ("form", "action"),
            ("input", "formaction"),
            ("button", "formaction"),
            ("iframe", "src"),
            ("frame", "src"),
        ] {
            assert_eq!(attr_policy_kind(tag, key), "navigation", "{tag}.{key}");
        }
        for (tag, key) in [
            ("link", "href"),
            ("image", "xlink:href"),
            ("use", "href"),
            ("img", "src"),
            ("source", "src"),
            ("audio", "src"),
            ("video", "poster"),
            ("track", "src"),
        ] {
            assert_eq!(attr_policy_kind(tag, key), "passive", "{tag}.{key}");
        }
        assert_eq!(attr_policy_kind("img", "srcset"), "srcset");
        assert_eq!(attr_policy_kind("source", "srcset"), "srcset");
        assert_eq!(attr_policy_kind("div", "style"), "style");
        assert_eq!(attr_policy_kind("script", "src"), "pass");
        assert_eq!(attr_policy_kind("link", "rel"), "pass");
    }

    #[test]
    fn classifies_static_script_type_policy() {
        for value in [
            "",
            " text/javascript ",
            "application/javascript",
            "application/ecmascript",
            "text/ecmascript",
        ] {
            assert_eq!(script_type_kind(value), "classic", "{value}");
        }
        assert_eq!(script_type_kind("module"), "module");
        assert_eq!(script_type_kind(" importmap "), "importmap");
        assert_eq!(script_type_kind("speculationrules"), "speculationrules");
        assert_eq!(script_type_kind("application/json"), "pass");
    }

    #[test]
    fn classifies_static_event_handler_attr_policy() {
        assert_eq!(event_handler_attr_kind("onclick"), "block");
        assert_eq!(event_handler_attr_kind(" onLoad "), "block");
        assert_eq!(event_handler_attr_kind("on"), "pass");
        assert_eq!(event_handler_attr_kind("data-onclick"), "pass");
    }
}
