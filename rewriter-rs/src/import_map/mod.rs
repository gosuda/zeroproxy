mod address;
mod document;

use document::rewrite_imports;
use serde_json::Value;

pub(crate) fn rewrite(
    source: &str,
    base_url: &str,
    tab_id: &str,
    runtime_token: &str,
    control_prefix: &str,
) -> String {
    let Ok(mut doc) = serde_json::from_str::<Value>(source) else {
        return "{}".to_string();
    };
    if doc.is_null() {
        return "null".to_string();
    }
    let Some(map) = doc.as_object_mut() else {
        return "{}".to_string();
    };

    rewrite_imports(map, base_url, tab_id, runtime_token, control_prefix);

    match serde_json::to_string(&doc) {
        Ok(json) => escape_html_json_chars(json),
        Err(_) => "{}".to_string(),
    }
}

fn escape_html_json_chars(json: String) -> String {
    json.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

#[cfg(test)]
mod tests {
    use super::rewrite;
    use serde_json::Value;

    const BASE: &str = "https://target.example/app/main.js";
    const TAB: &str = "tab-1";
    const RT: &str = "rt-1";
    const PREFIX: &str = "/zp/";

    fn value(source: &str) -> Value {
        serde_json::from_str(source).expect(source)
    }

    fn rewritten_url(raw: &str) -> String {
        format!(
            "/zp/api/script?kind=module&rt=rt-1&tab=tab-1&u={}",
            url::form_urlencoded::byte_serialize(raw.as_bytes()).collect::<String>()
        )
    }

    #[test]
    fn malformed_and_non_object_inputs_match_static_policy() {
        assert_eq!(rewrite("not json", BASE, TAB, RT, PREFIX), "{}");
        assert_eq!(rewrite("", BASE, TAB, RT, PREFIX), "{}");
        assert_eq!(rewrite("[]", BASE, TAB, RT, PREFIX), "{}");
        assert_eq!(rewrite("42", BASE, TAB, RT, PREFIX), "{}");
        assert_eq!(rewrite("null", BASE, TAB, RT, PREFIX), "null");
    }

    #[test]
    fn rewrites_import_addresses_and_keeps_non_strings() {
        let out = rewrite(
            r#"{"imports":{"a":"/a.js","b":"./rel.js","c":"https://cdn.test/x.js","n":123}}"#,
            BASE,
            TAB,
            RT,
            PREFIX,
        );
        let got = value(&out);
        assert_eq!(
            got["imports"]["a"],
            rewritten_url("https://target.example/a.js")
        );
        assert_eq!(
            got["imports"]["b"],
            rewritten_url("https://target.example/app/rel.js")
        );
        assert_eq!(got["imports"]["c"], rewritten_url("https://cdn.test/x.js"));
        assert_eq!(got["imports"]["n"], 123);
    }

    #[test]
    fn blocks_non_http_import_targets() {
        let out = rewrite(
            r##"{"imports":{"bad":"javascript:alert(1)","data":"data:text/js,x","frag":"#x"}}"##,
            BASE,
            TAB,
            RT,
            PREFIX,
        );
        let got = value(&out);
        assert_eq!(got["imports"]["bad"], "/zp/error/POLICY_BLOCKED");
        assert_eq!(got["imports"]["data"], "/zp/error/POLICY_BLOCKED");
        assert_eq!(
            got["imports"]["frag"],
            rewritten_url("https://target.example/app/main.js#x")
        );
    }

    #[test]
    fn rewrites_scope_keys_and_string_entries() {
        let out = rewrite(
            r#"{"scopes":{"/s/":{"a":"/a.js","n":1},"bad:scope":{"x":"/x.js"},"/empty":5}}"#,
            BASE,
            TAB,
            RT,
            PREFIX,
        );
        let got = value(&out);
        let scopes = got["scopes"].as_object().expect("scopes");
        let good_scope = rewritten_url("https://target.example/s/");
        let blocked_scope = "/zp/error/POLICY_BLOCKED".to_string();
        let empty_scope = rewritten_url("https://target.example/empty");
        assert_eq!(
            scopes[&good_scope]["a"],
            rewritten_url("https://target.example/a.js")
        );
        assert!(!scopes[&good_scope].as_object().unwrap().contains_key("n"));
        assert_eq!(
            scopes[&blocked_scope]["x"],
            rewritten_url("https://target.example/x.js")
        );
        assert_eq!(scopes[&empty_scope], value("{}"));
    }

    #[test]
    fn escapes_html_sensitive_json_characters() {
        let out = rewrite(
            r#"{"imports":{"amp":"https://cdn.test/a&b.js","<key>":"/safe.js"}}"#,
            BASE,
            TAB,
            RT,
            PREFIX,
        );
        assert!(out.contains("\\u0026"));
        assert!(out.contains("\\u003c"));
        assert!(out.contains("\\u003e"));
    }
}
