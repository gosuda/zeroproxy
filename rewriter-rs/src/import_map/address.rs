use url::Url;

pub(crate) fn rewrite_address(
    raw: &str,
    base_url: &str,
    _tab_id: &str,
    _runtime_token: &str,
    control_prefix: &str,
) -> String {
    let Some(abs) = absolute_url(raw, base_url) else {
        return policy_blocked(control_prefix);
    };
    if abs.scheme() != "http" && abs.scheme() != "https" {
        return policy_blocked(control_prefix);
    }

    policy_blocked(control_prefix)
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
