pub(crate) struct ScriptURL {
    pub(crate) ok: bool,
    pub(crate) url: String,
    pub(crate) target: String,
    pub(crate) error: String,
}

pub(crate) fn module_specifier(
    raw: &str,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> String {
    if target_url.is_empty() {
        return raw.to_string();
    }
    if is_bare_specifier(raw) {
        return raw.to_string();
    }
    if has_scheme(raw) && !raw.starts_with("http://") && !raw.starts_with("https://") {
        return format!("{}error/POLICY_BLOCKED", control_prefix);
    }
    let abs = join_url(target_url, raw);
    if !abs.starts_with("http://") && !abs.starts_with("https://") {
        return format!("{}error/POLICY_BLOCKED", control_prefix);
    }
    let mut out = format!(
        "{}api/script?kind=module&u={}",
        control_prefix,
        percent_encode(abs)
    );
    append_context(&mut out, "tab", tab_id);
    append_context(&mut out, "rt", runtime_token);
    out
}

pub(crate) fn script_url(
    raw: &str,
    kind: &str,
    target_url: &str,
    control_prefix: &str,
    tab_id: &str,
    runtime_token: &str,
) -> ScriptURL {
    let blocked = || ScriptURL {
        ok: false,
        url: format!("{}error/POLICY_BLOCKED", control_prefix),
        target: String::new(),
        error: "POLICY_BLOCKED".to_string(),
    };
    let text = raw.trim();
    if text.is_empty() || text.starts_with('#') || is_executable_scheme(text) {
        return blocked();
    }
    let abs = match absolute_url(target_url, text) {
        Some(value) if is_http_url(value.as_str()) => value,
        _ => return blocked(),
    };
    let normalized_kind = if kind == "module" {
        "module"
    } else {
        "classic"
    };
    let mut out = format!(
        "{}api/script?kind={}&u={}",
        control_prefix,
        normalized_kind,
        percent_encode(abs.clone())
    );
    append_context(&mut out, "tab", tab_id);
    append_context(&mut out, "rt", runtime_token);
    ScriptURL {
        ok: true,
        url: out,
        target: abs,
        error: String::new(),
    }
}

fn append_context(out: &mut String, key: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    out.push('&');
    out.push_str(key);
    out.push('=');
    out.push_str(&percent_encode(value.to_string()));
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

fn absolute_url(base: &str, raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw)
        .or_else(|_| url::Url::parse(base).and_then(|base_url| base_url.join(raw)))
        .ok()?;
    Some(parsed.to_string())
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn is_bare_specifier(spec: &str) -> bool {
    !spec.starts_with('/')
        && !spec.starts_with("./")
        && !spec.starts_with("../")
        && !has_scheme(spec)
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

fn join_url(base: &str, raw: &str) -> String {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    if raw.starts_with('/') {
        if let Some(idx) = base.find("://") {
            let rest = &base[idx + 3..];
            if let Some(slash) = rest.find('/') {
                return format!("{}{}", &base[..idx + 3 + slash], raw);
            }
        }
        return raw.to_string();
    }
    let prefix = match base.rfind('/') {
        Some(i) => &base[..=i],
        None => base,
    };
    let mut parts: Vec<&str> = prefix.split('/').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    for part in raw.split('/') {
        match part {
            "." => {}
            ".." => {
                if parts.len() > 3 {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn percent_encode(input: String) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 15));
            }
        }
    }
    out
}

fn hex(v: u8) -> char {
    match v {
        0..=9 => (b'0' + v) as char,
        _ => (b'A' + (v - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::{module_specifier, script_url};

    #[test]
    fn preserves_bare_specifiers() {
        assert_eq!(
            module_specifier(
                "react",
                "https://target.example/app/main.js",
                "/zp/",
                "",
                ""
            ),
            "react"
        );
    }

    #[test]
    fn rewrites_relative_module_specifiers() {
        assert_eq!(
            module_specifier(
                "./dep.js",
                "https://target.example/app/main.js",
                "/zp/",
                "",
                ""
            ),
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Fapp%2Fdep.js"
        );
        assert_eq!(
            module_specifier(
                "../lib/a b.js",
                "https://target.example/app/main.js",
                "/zp/",
                "",
                ""
            ),
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Flib%2Fa%20b.js"
        );
    }

    #[test]
    fn appends_runtime_context_when_present() {
        assert_eq!(
            module_specifier(
                "./dep.js",
                "https://target.example/app/main.js",
                "/zp/",
                "tab 1",
                "rt+1"
            ),
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Fapp%2Fdep.js&tab=tab%201&rt=rt%2B1"
        );
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert_eq!(
            module_specifier(
                "data:text/javascript,0",
                "https://target.example/app/main.js",
                "/zp/",
                "",
                ""
            ),
            "/zp/error/POLICY_BLOCKED"
        );
    }

    #[test]
    fn leaves_empty_target_context_unchanged() {
        assert_eq!(module_specifier("./dep.js", "", "/zp/", "", ""), "./dep.js");
    }

    #[test]
    fn rewrites_external_script_urls() {
        let classic = script_url(
            "./app.js",
            "classic",
            "https://target.example/dir/page.html",
            "/zp/",
            "tab 1",
            "rt+1",
        );
        assert!(classic.ok);
        assert_eq!(classic.target, "https://target.example/dir/app.js");
        assert_eq!(
            classic.url,
            "/zp/api/script?kind=classic&u=https%3A%2F%2Ftarget.example%2Fdir%2Fapp.js&tab=tab%201&rt=rt%2B1"
        );

        let module = script_url(
            "/main.js",
            "module",
            "https://target.example/dir/page.html",
            "/zp/",
            "tab",
            "rt",
        );
        assert!(module.ok);
        assert_eq!(
            module.url,
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Fmain.js&tab=tab&rt=rt"
        );
    }

    #[test]
    fn blocks_external_script_unsafe_urls() {
        for raw in [
            "",
            "#frag",
            "javascript:alert(1)",
            "data:text/javascript,0",
            "file:///x.js",
        ] {
            let out = script_url(
                raw,
                "classic",
                "https://target.example/app.js",
                "/zp/",
                "tab",
                "rt",
            );
            assert!(!out.ok, "{raw}");
            assert_eq!(out.url, "/zp/error/POLICY_BLOCKED");
        }
    }
}
