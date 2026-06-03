//! Share URL parser. Go side: `internal/shareurl/shareurl.go`.
//! Both must accept/reject the same URL set; parity enforced via
//! testdata/shareurl_cases.json.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ShareUrlError {
    #[error("empty url")]
    Empty,
    #[error("invalid scheme: only http and https are allowed")]
    InvalidScheme,
    #[error("malformed url")]
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareUrl {
    pub raw: String,
    pub scheme: String,
    pub host: String,
}

/// Parse and validate a target URL for share encryption.
/// Accepts only http:// and https://. Rejects ws:, wss:, javascript:, data:, blob:, empty, malformed.
pub fn parse_share_url(input: &str) -> Result<ShareUrl, ShareUrlError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(ShareUrlError::Empty);
    }
    // Manual scheme extraction (no external url crate to keep zp-shared tiny + parity-friendly).
    let colon = s.find(':').ok_or(ShareUrlError::Malformed)?;
    let scheme = &s[..colon];
    let lower = scheme.to_ascii_lowercase();
    if lower != "http" && lower != "https" {
        return Err(ShareUrlError::InvalidScheme);
    }
    let after = &s[colon + 1..];
    if !after.starts_with("//") {
        return Err(ShareUrlError::Malformed);
    }
    let rest = &after[2..];
    let host_end = rest
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let host = &rest[..host_end];
    if host.is_empty() {
        return Err(ShareUrlError::Malformed);
    }
    Ok(ShareUrl {
        raw: s.to_string(),
        scheme: lower,
        host: host.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(parse_share_url("https://example.com/").is_ok());
        assert!(parse_share_url("http://example.com").is_ok());
        assert!(parse_share_url("HTTPS://Example.com/path?q=1").is_ok());
    }

    #[test]
    fn rejects_invalid_schemes() {
        for bad in &[
            "ws://x",
            "wss://x",
            "javascript:alert(1)",
            "data:,a",
            "blob:abc",
            "file:///etc/passwd",
        ] {
            assert!(
                matches!(parse_share_url(bad), Err(ShareUrlError::InvalidScheme)),
                "should reject: {bad}"
            );
        }
    }

    #[test]
    fn rejects_empty_or_malformed() {
        assert_eq!(parse_share_url(""), Err(ShareUrlError::Empty));
        assert_eq!(parse_share_url("   "), Err(ShareUrlError::Empty));
        assert_eq!(parse_share_url("notaurl"), Err(ShareUrlError::Malformed));
        assert_eq!(
            parse_share_url("https:no-slashes"),
            Err(ShareUrlError::Malformed)
        );
        assert_eq!(
            parse_share_url("https:///nohost"),
            Err(ShareUrlError::Malformed)
        );
    }

    /// Parity with internal/shareurl/parity_test.go using shared JSON fixtures.
    #[test]
    fn matches_shareurl_cases_json() {
        let raw = include_str!("../testdata/shareurl_cases.json");
        let cases: Vec<ShareUrlCase> =
            serde_json::from_str(raw).expect("testdata/shareurl_cases.json must be valid JSON");
        for c in cases {
            let got = parse_share_url(&c.input);
            match (c.ok, got) {
                (true, Ok(p)) => {
                    if !c.scheme.is_empty() {
                        assert_eq!(p.scheme, c.scheme.to_ascii_lowercase(), "{}", c.input);
                    }
                    if !c.host.is_empty() {
                        assert_eq!(p.host, c.host, "{}", c.input);
                    }
                }
                (false, Err(_)) => {} // both reject, OK
                (true, Err(e)) => panic!("input {:?}: expected ok, got error {:?}", c.input, e),
                (false, Ok(_)) => panic!("input {:?}: expected error, got ok", c.input),
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct ShareUrlCase {
        input: String,
        ok: bool,
        #[serde(default)]
        scheme: String,
        #[serde(default)]
        host: String,
        #[serde(default)]
        #[allow(dead_code)]
        reason: String,
    }
}
