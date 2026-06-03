use url::{form_urlencoded, Url};

pub(crate) fn rewrite_address(
    raw: &str,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) -> String {
    let Some(abs) = absolute_url(raw, base_url) else {
        return policy_blocked(control_prefix);
    };
    if abs.scheme() != "http" && abs.scheme() != "https" {
        return policy_blocked(control_prefix);
    }

    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("kind", "module");
    query.append_pair("rt", runtime_token);
    query.append_pair("tab", tab_id);
    query.append_pair("u", abs.as_str());
    format!("{}api/script?{}", control_prefix, query.finish())
}

fn absolute_url(raw: &str, base_url: &str) -> Option<Url> {
    let trimmed = raw.trim();
    match Url::parse(trimmed) {
        Ok(url) => Some(url),
        Err(_) => Url::parse(base_url).ok()?.join(trimmed).ok(),
    }
}

fn policy_blocked(control_prefix: &str) -> String {
    format!("{}error/POLICY_BLOCKED", control_prefix)
}
