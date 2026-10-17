//! Single source of truth for building `/zp/api/fetch?url=...` subresource URLs.
//!
//! Shared across `zp-htmltx` (document parsing), `zp-css` (stylesheets), the
//! page-realm prelude (`subresourceProxyPath`), and SW relay rewriting.
//! If the URL fragment is encoded inside the query parameter, the browser cannot
//! select the target fragment and renders `<use>` or CSS `url()` references to
//! external SVG sprites (`sprite.svg#icon`) blank. Since fragments are never
//! sent over the wire, we append the raw fragment outside the proxy URL.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// Safe byte set for query parameter values; retains only RFC 3986 unreserved characters.
pub const URL_PARAM_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Rewrites an absolute http(s) URL into a `?url=` path routed by the SW.
///
/// `absolute` **must already be an absolute URL**. Callers are responsible for
/// resolving relative references against the appropriate base (the target URL
/// for documents, or the stylesheet URL for CSS).
///
/// When `proxy_origin` is empty, a root-relative path (`/zp/api/fetch?url=...`)
/// is returned. Callers that know the proxy origin must pass it: because the
/// membrane virtualizes the document base to the target origin, a root-relative
/// path resolves against the target host and results in a 404.
pub fn subresource_proxy_url(
    absolute: &str,
    proxy_origin: &str,
    control_prefix: &str,
    tab_id: Option<&str>,
) -> String {
    let (head, fragment) = split_fragment(absolute);
    // Percent-encoding expands non-alphanumeric bytes to `%XX` (up to 3x in the worst case).
    let mut out = String::with_capacity(
        proxy_origin.len() + control_prefix.len() + head.len() * 3 + fragment.len() + 32,
    );
    out.push_str(proxy_origin.trim_end_matches('/'));
    out.push_str(control_prefix);
    if !out.ends_with('/') {
        out.push('/');
    }
    out.push_str("api/fetch?url=");
    for chunk in utf8_percent_encode(head, URL_PARAM_ENCODE) {
        out.push_str(chunk);
    }
    if let Some(tab) = tab_id.filter(|t| !t.is_empty()) {
        out.push_str("&tab=");
        for chunk in utf8_percent_encode(tab, URL_PARAM_ENCODE) {
            out.push_str(chunk);
        }
    }
    // Append the fragment **last**, after `&tab=`, so the browser splits query
    // parameters and the fragment properly.
    out.push_str(fragment);
    out
}

/// Splits `url` at the first `#`, e.g. `("https://t/x.svg", "#icon")`, or `(url, "")` if absent.
pub fn split_fragment(url: &str) -> (&str, &str) {
    match url.find('#') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(u: &str) -> String {
        subresource_proxy_url(u, "http://proxy.example", "/zp/", None)
    }

    /// Shared fixture with `subresourceProxyPath` in the page realm
    /// (`test/js/static-policy.test.js` reads the same file).
    #[test]
    fn matches_shared_fixture() {
        let raw = include_str!("../testdata/proxy_url_cases.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("parse proxy_url_cases.json");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 8, "fixture must stay populated for parity checks");
        for c in cases {
            let id = c["id"].as_str().unwrap_or("?");
            let url = c["url"].as_str().expect("url");
            let tab = c["tab"].as_str();
            let want = c["want"].as_str().expect("want");
            let got = subresource_proxy_url(url, "http://proxy.example", "/zp/", tab);
            assert_eq!(got, want, "{id}");
        }
    }

    #[test]
    fn absolute_url_becomes_fetch_param() {
        assert_eq!(
            build("https://t.example/a.png"),
            "http://proxy.example/zp/api/fetch?url=https%3A%2F%2Ft.example%2Fa.png"
        );
    }

    /// Encoding the fragment inside the query parameter leaves `<use href="sprite.svg#icon">`
    /// blank because the browser cannot select the fragment.
    #[test]
    fn fragment_stays_outside_the_param() {
        let out = build("https://t.example/sprite.svg#icon");
        assert!(out.ends_with("#icon"), "fragment missing outside query parameter: {out}");
        assert!(!out.contains("%23"), "fragment was percent-encoded into the parameter: {out}");
    }

    #[test]
    fn tab_comes_before_the_fragment() {
        let out = subresource_proxy_url("https://t.example/s.svg#i", "http://p", "/zp/", Some("t7"));
        assert_eq!(out, "http://p/zp/api/fetch?url=https%3A%2F%2Ft.example%2Fs.svg&tab=t7#i");
    }

    #[test]
    fn empty_tab_is_not_emitted() {
        assert!(!subresource_proxy_url("https://t/a", "http://p", "/zp/", Some("")).contains("tab="));
    }

    /// Spaces must encode as `%20`. `form_urlencoded` emits `+`, which remains a
    /// literal `+` for consumers that decode with `decodeURIComponent`.
    #[test]
    fn space_encodes_as_percent_twenty() {
        assert!(build("https://t.example/a b.png").contains("a%20b.png"));
    }

    #[test]
    fn trailing_slash_on_origin_does_not_double() {
        assert!(subresource_proxy_url("https://t/a", "http://p/", "/zp/", None)
            .starts_with("http://p/zp/api/fetch?url="));
    }
}
