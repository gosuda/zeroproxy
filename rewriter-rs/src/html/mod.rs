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
    let mut abs = match absolute_url(target_url, text) {
        Some(value) if is_http_url(value.as_str()) => value,
        _ => return blocked(),
    };
    let target = abs.to_string();
    let fragment = abs.fragment().map(str::to_string);
    abs.set_fragment(None);
    let mut out = format!(
        "{}api/fetch?url={}",
        control_prefix,
        percent_encode(abs.to_string())
    );
    if let Some(value) = fragment {
        out.push('#');
        out.push_str(&value);
    }
    URLPolicy {
        ok: true,
        url: out,
        target,
        error: String::new(),
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
    use super::fetch_url;

    #[test]
    fn rewrites_fetch_urls_without_leaking_fragments_to_network_target() {
        let out = fetch_url(
            "/icons.svg#icon-a",
            "https://target.example/app/page.html",
            "/zp/",
        );
        assert!(out.ok, "rewrite failed: {}", out.error);
        assert_eq!(out.target, "https://target.example/icons.svg#icon-a");
        assert_eq!(
            out.url,
            "/zp/api/fetch?url=https%3A%2F%2Ftarget.example%2Ficons.svg#icon-a"
        );
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
        assert_eq!(
            out.url,
            "/zp/api/fetch?url=https%3A%2F%2Ftarget.example%2Fmedia.webm"
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
}
