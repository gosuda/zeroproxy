//! Cloudflare challenge classifier — pure header/URL predicate.
//!
//! Single source of truth shared with the Go server (`internal/headers/
//! challenge.go`); parity is enforced via `testdata/challenge_cases.json`
//! consumed by both `cargo test -p zp-shared` and `go test ./internal/headers`.
//!
//! Body is NEVER read or sniffed. Inputs are limited to three already-parsed
//! signals (the `Cf-Mitigated` response-header value, the final URL host, and
//! the final URL path). The classifier itself grants no egress, manufactures
//! no eval, and synthesizes no challenge solution — it is the gate that
//! upstream callers consult before applying the armed CSP / `no-store` skip /
//! `X-ZP-Challenge-Compat` marker.

/// The exact Cloudflare-Turnstile widget host. Case-insensitive equality.
pub const CHALLENGE_HOST: &str = "challenges.cloudflare.com";

/// The same-zone challenge-platform orchestration loader path prefix.
/// Exact-prefix match on the *path component* (caller must pre-extract it from
/// the URL, so query/fragment never participate).
pub const CHALLENGE_PLATFORM_PREFIX: &str = "/cdn-cgi/challenge-platform/";

/// Returns true when the response classifies as a Cloudflare challenge
/// document or subresource via:
///   1. `Cf-Mitigated: challenge` response header (case-insensitive, trimmed), OR
///   2. final-URL host == `challenges.cloudflare.com` (case-insensitive), OR
///   3. final-URL path starts with `/cdn-cgi/challenge-platform/`.
///
/// Pure: no I/O, no body access, no allocation beyond ASCII trimming.
pub fn is_challenge_document(cf_mitigated: &str, host: &str, path: &str) -> bool {
    let cf = cf_mitigated.trim();
    if !cf.is_empty() && cf.eq_ignore_ascii_case("challenge") {
        return true;
    }
    if host.eq_ignore_ascii_case(CHALLENGE_HOST) {
        return true;
    }
    path.starts_with(CHALLENGE_PLATFORM_PREFIX)
}

/// The two-signal SUBRESOURCE gate: returns true ONLY when the tab is armed
/// AND the request is not a document navigation AND the response classifies
/// as a challenge. The `is_doc == false` term is load-bearing: it keeps the
/// challenge DOCUMENT (navigation HTML) on `no-store` and lets ONLY classified
/// subresources (e.g. turnstile api.js) preserve Cloudflare's cache semantics.
pub fn challenge_subresource_skip(
    armed: bool,
    is_doc: bool,
    cf_mitigated: &str,
    host: &str,
    path: &str,
) -> bool {
    if !armed || is_doc {
        return false;
    }
    is_challenge_document(cf_mitigated, host, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn empty_inputs_are_not_a_challenge() {
        assert!(!is_challenge_document("", "", ""));
    }

    #[test]
    fn cf_mitigated_header_matches_case_insensitive_and_trimmed() {
        assert!(is_challenge_document("challenge", "example.test", "/x"));
        assert!(is_challenge_document("  Challenge  ", "example.test", "/x"));
        assert!(is_challenge_document("CHALLENGE", "example.test", "/x"));
        assert!(!is_challenge_document("managed", "example.test", "/x"));
        assert!(!is_challenge_document("", "example.test", "/x"));
    }

    #[test]
    fn challenge_host_matches_case_insensitive() {
        assert!(is_challenge_document("", "challenges.cloudflare.com", "/"));
        assert!(is_challenge_document("", "CHALLENGES.CLOUDFLARE.COM", "/"));
        assert!(!is_challenge_document(
            "",
            "challenges.cloudflare.com.evil.test",
            "/"
        ));
        assert!(!is_challenge_document(
            "",
            "evil.challenges.cloudflare.com",
            "/"
        ));
    }

    #[test]
    fn challenge_platform_prefix_matches_path_exactly() {
        assert!(is_challenge_document(
            "",
            "example.test",
            "/cdn-cgi/challenge-platform/h/g/orchestrate"
        ));
        assert!(!is_challenge_document(
            "",
            "example.test",
            "/cdn-cgi/challenge-platform"
        )); // missing trailing slash
        assert!(!is_challenge_document(
            "",
            "example.test",
            "/CDN-CGI/CHALLENGE-PLATFORM/"
        )); // path match is case-sensitive
        assert!(!is_challenge_document(
            "",
            "example.test",
            "/x/cdn-cgi/challenge-platform/"
        ));
    }

    #[test]
    fn subresource_gate_requires_armed_and_not_doc_and_classifier() {
        // ALL FOUR must hold: armed, !is_doc, classifier match.
        assert!(challenge_subresource_skip(
            true,
            false,
            "challenge",
            "x",
            "/"
        ));
        // disarmed → never
        assert!(!challenge_subresource_skip(
            false,
            false,
            "challenge",
            "x",
            "/"
        ));
        // is_doc → never (document stays on no-store)
        assert!(!challenge_subresource_skip(
            true,
            true,
            "challenge",
            "x",
            "/"
        ));
        // classifier miss → never
        assert!(!challenge_subresource_skip(true, false, "", "x", "/"));
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        cf_mitigated: String,
        host: String,
        path: String,
        want: bool,
    }

    #[test]
    fn classifier_matches_golden_cases() {
        let raw = include_str!("../testdata/challenge_cases.json");
        let cases: Vec<Case> = serde_json::from_str(raw).expect("parse challenge_cases.json");
        assert!(!cases.is_empty(), "challenge_cases.json must not be empty");
        for c in cases {
            let got = is_challenge_document(&c.cf_mitigated, &c.host, &c.path);
            assert_eq!(
                got, c.want,
                "case {:?}: cf={:?} host={:?} path={:?} want {} got {}",
                c.name, c.cf_mitigated, c.host, c.path, c.want, got
            );
        }
    }
}
