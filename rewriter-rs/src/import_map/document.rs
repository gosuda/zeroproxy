use serde_json::{Map, Value};

use super::address::rewrite_address;

pub(crate) fn rewrite_imports(
    map: &mut Map<String, Value>,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) {
    if let Some(imports) = map.get_mut("imports").and_then(Value::as_object_mut) {
        rewrite_addresses(imports, base_url, tab_id, runtime_token, control_prefix);
    }
    if let Some(scopes) = map.get("scopes").and_then(Value::as_object) {
        map.insert(
            "scopes".to_string(),
            Value::Object(rewrite_scopes(
                scopes,
                base_url,
                tab_id,
                runtime_token,
                control_prefix,
            )),
        );
    }
}

fn rewrite_addresses(
    addresses: &mut Map<String, Value>,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) {
    for value in addresses.values_mut() {
        if let Some(raw) = value.as_str() {
            *value = Value::String(rewrite_address(
                raw,
                base_url,
                tab_id,
                runtime_token,
                control_prefix,
            ));
        }
    }
}

fn rewrite_scopes(
    scopes: &Map<String, Value>,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) -> Map<String, Value> {
    let mut next = Map::new();
    for (scope, raw_entries) in scopes {
        let scope_key = rewrite_address(scope, base_url, tab_id, runtime_token, control_prefix);
        let mut out = Map::new();
        if let Some(entries) = raw_entries.as_object() {
            rewrite_scope_entries(
                &mut out,
                entries,
                base_url,
                tab_id,
                runtime_token,
                control_prefix,
            );
        }
        next.insert(scope_key, Value::Object(out));
    }
    next
}

fn rewrite_scope_entries(
    out: &mut Map<String, Value>,
    entries: &Map<String, Value>,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) {
    for (key, value) in entries {
        if let Some(raw) = value.as_str() {
            out.insert(
                key.clone(),
                Value::String(rewrite_address(
                    raw,
                    base_url,
                    tab_id,
                    runtime_token,
                    control_prefix,
                )),
            );
        }
    }
}
