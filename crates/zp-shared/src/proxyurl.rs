//! `/zp/api/fetch?url=…` 서브리소스 URL 빌더 — **단일 소스**.
//!
//! 이 문자열을 만드는 곳이 넷이었다: `zp-htmltx`(문서 파싱), `zp-css`(스타일시트),
//! 페이지 realm 프렐류드(`subresourceProxyPath`), 그리고 SW 의 릴레이 변환.
//! 출력이 서로 달랐다:
//!
//! | | 프래그먼트 | `&tab=` | 퍼센트 인코딩 |
//! |---|---|---|---|
//! | htmltx | 파라미터 **밖**에 보존 | 없음 | `NON_ALPHANUMERIC - -._~` |
//! | zp-css | 파라미터 **안**으로 삼킴 | 없음 | `form_urlencoded` (공백 → `+`) |
//! | 프렐류드 | 파라미터 **안**으로 삼킴 | 붙임 | `encodeURIComponent` |
//!
//! 프래그먼트가 파라미터 안으로 들어가면 **브라우저가 조각을 못 고른다** —
//! 외부 SVG 스프라이트(`sprite.svg#icon`)를 참조하는 `<use>` 와 CSS `url()`
//! 이 통째로 빈 채로 렌더된다. 프래그먼트는 요청에 실리지 않으므로 프록시 URL
//! **바깥**에 그대로 붙이는 것이 맞다.
//!
//! 인코딩 차이는 SW 가 `URLSearchParams` 로 읽어 `+` 도 공백으로 풀기 때문에
//! 관측되지 않았다 — 하지만 셋이 다른 채로 두면 다음 소비자가 그 가정을
//! 깨뜨린다. 여기 하나로 모은다.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// 쿼리 파라미터 값으로 안전한 집합. RFC 3986 unreserved 만 남긴다.
pub const URL_PARAM_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// 절대 http(s) URL 을 SW 가 라우팅하는 `?url=` 경로로 바꾼다.
///
/// `absolute` 는 **이미 절대 URL** 이어야 한다 — 상대 해석은 호출자의 몫이다
/// (문서는 타깃 URL 기준, CSS 는 시트 URL 기준으로 base 가 다르다).
///
/// `proxy_origin` 이 비면 루트 상대 경로(`/zp/api/fetch?url=…`)가 나온다.
/// 프록시 오리진을 아는 호출자는 반드시 넘길 것 — 멤브레인이 문서 base 를
/// 타깃 오리진으로 가상화하므로, 루트 상대 경로는 타깃 호스트로 풀려 404 가 된다.
pub fn subresource_proxy_url(
    absolute: &str,
    proxy_origin: &str,
    control_prefix: &str,
    tab_id: Option<&str>,
) -> String {
    let (head, fragment) = split_fragment(absolute);
    // 퍼센트 인코딩은 비영숫자 바이트를 `%XX` 로 늘린다 — 최악 3배.
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
    // 프래그먼트는 **맨 끝**. `&tab=` 뒤에 와야 브라우저가 쿼리와 조각을
    // 올바르게 나눈다.
    out.push_str(fragment);
    out
}

/// `("https://t/x.svg", "#icon")` 처럼 첫 `#` 에서 가른다. 없으면 뒤가 빈 문자열.
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

    /// 픽스처는 페이지 realm 의 `subresourceProxyPath` 와 **공유**한다
    /// (`test/js/static-policy.test.js` 가 같은 파일을 읽는다).
    #[test]
    fn matches_shared_fixture() {
        let raw = include_str!("../testdata/proxy_url_cases.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("parse proxy_url_cases.json");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 8, "픽스처가 비어 가면 파리티가 무의미해진다");
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

    /// 프래그먼트를 파라미터 안에 넣으면 `<use href="sprite.svg#icon">` 이
    /// 빈 채로 렌더된다 — 브라우저가 조각을 못 고르기 때문이다.
    #[test]
    fn fragment_stays_outside_the_param() {
        let out = build("https://t.example/sprite.svg#icon");
        assert!(out.ends_with("#icon"), "프래그먼트가 밖에 없다: {out}");
        assert!(!out.contains("%23"), "프래그먼트가 파라미터로 삼켜졌다: {out}");
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

    /// 공백은 `%20` 이다. `form_urlencoded` 는 `+` 를 내는데, 그 값을
    /// `decodeURIComponent` 로 읽는 소비자에게는 `+` 가 그대로 남는다.
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
