pub(crate) fn proxied_url(raw: &str, base_url: &str, control_prefix: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with("var(") {
        return None;
    }
    let lower = s.get(..s.len().min(32)).unwrap_or("").to_ascii_lowercase();
    if is_non_fetchable_scheme(&lower) {
        return None;
    }
    let base = url::Url::parse(base_url).ok()?;
    let abs = base.join(s).ok()?;
    if abs.scheme() != "http" && abs.scheme() != "https" {
        return None;
    }
    let mut out = String::new();
    out.push_str(control_prefix);
    if !out.ends_with('/') {
        out.push('/');
    }
    out.push_str("error/POLICY_BLOCKED");
    Some(out)
}

fn is_non_fetchable_scheme(lower: &str) -> bool {
    lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("about:")
        || lower.starts_with("javascript:")
        || lower.starts_with("vbscript:")
}

pub(crate) fn escape_string(s: &str, quote: u8) -> String {
    let q = quote as char;
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == q || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}
