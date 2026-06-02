pub(crate) fn module_specifier(raw: &str, target_url: &str, control_prefix: &str) -> String {
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
    format!(
        "{}api/script?kind=module&u={}",
        control_prefix,
        percent_encode(abs)
    )
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
    use super::module_specifier;

    #[test]
    fn preserves_bare_specifiers() {
        assert_eq!(
            module_specifier("react", "https://target.example/app/main.js", "/zp/"),
            "react"
        );
    }

    #[test]
    fn rewrites_relative_module_specifiers() {
        assert_eq!(
            module_specifier("./dep.js", "https://target.example/app/main.js", "/zp/"),
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Fapp%2Fdep.js"
        );
        assert_eq!(
            module_specifier(
                "../lib/a b.js",
                "https://target.example/app/main.js",
                "/zp/"
            ),
            "/zp/api/script?kind=module&u=https%3A%2F%2Ftarget.example%2Flib%2Fa%20b.js"
        );
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert_eq!(
            module_specifier(
                "data:text/javascript,0",
                "https://target.example/app/main.js",
                "/zp/"
            ),
            "/zp/error/POLICY_BLOCKED"
        );
    }

    #[test]
    fn leaves_empty_target_context_unchanged() {
        assert_eq!(module_specifier("./dep.js", "", "/zp/"), "./dep.js");
    }
}
