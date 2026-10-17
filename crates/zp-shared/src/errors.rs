//! Error codes shown to users via the styled ZeroProxy error page.
//!
//! This list exists in three places: here (Rust), `ZP.ERRORS` in
//! `web/zp-core.js`, and `sanitizeCode` in Go `cmd/zeroproxy-server`.
//! `testdata/error_codes.json` is the single source of truth, and all three
//! locations have tests verifying parity against that file. Update the JSON
//! file first when adding a new code.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadHmac,
    InvalidShareLink,
    MalformedRoute,
    SwNotReady,
    TargetProtocolBlocked,
    TlsCertificateInvalid,
    TlsHandshakeFailed,
    TargetConnectFailed,
    TargetHttpFailed,
    MalformedHtml,
    RealmInjectionFailure,
    RequestBodyTooLarge,
    SubmissionExpired,
    PolicyBlocked,
    RewriteFailed,
    ScriptSrcBlocked,
    RedirectBodyNonReplayable,
    RedirectLimitExceeded,
    WsBlocked,
    RtcGatewayUnavailable,
    WtUnsupported,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadHmac => "BAD_HMAC",
            Self::InvalidShareLink => "INVALID_SHARE_LINK",
            Self::MalformedRoute => "MALFORMED_ROUTE",
            Self::SwNotReady => "SW_NOT_READY",
            Self::TargetProtocolBlocked => "TARGET_PROTOCOL_BLOCKED",
            Self::TlsCertificateInvalid => "TLS_CERTIFICATE_INVALID",
            Self::TlsHandshakeFailed => "TLS_HANDSHAKE_FAILED",
            Self::TargetConnectFailed => "TARGET_CONNECT_FAILED",
            Self::TargetHttpFailed => "TARGET_HTTP_FAILED",
            Self::MalformedHtml => "MALFORMED_HTML",
            Self::RealmInjectionFailure => "REALM_INJECTION_FAILURE",
            Self::RequestBodyTooLarge => "REQUEST_BODY_TOO_LARGE",
            Self::SubmissionExpired => "SUBMISSION_EXPIRED",
            Self::PolicyBlocked => "POLICY_BLOCKED",
            Self::RewriteFailed => "REWRITE_FAILED",
            Self::ScriptSrcBlocked => "SCRIPT_SRC_BLOCKED",
            Self::RedirectBodyNonReplayable => "REDIRECT_BODY_NONREPLAYABLE",
            Self::RedirectLimitExceeded => "REDIRECT_LIMIT_EXCEEDED",
            Self::WsBlocked => "WS_BLOCKED",
            Self::RtcGatewayUnavailable => "RTC_GATEWAY_UNAVAILABLE",
            Self::WtUnsupported => "WT_UNSUPPORTED",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_codes_have_unique_strings() {
        // Reference `ALL` directly to avoid maintaining a second list in this file.
        let codes = ALL;
        let mut seen = std::collections::HashSet::new();
        for c in codes.iter().copied() {
            assert!(seen.insert(c.as_str()), "duplicate code: {}", c.as_str());
        }
        // SCREAMING_SNAKE_CASE only
        for c in codes {
            let s = c.as_str();
            for ch in s.chars() {
                assert!(
                    ch.is_ascii_uppercase() || ch == '_',
                    "code not screaming snake: {s}"
                );
            }
        }
    }
}

/// All error codes in declaration order, verified against `testdata/error_codes.json`.
pub const ALL: &[ErrorCode] = &[
    ErrorCode::BadHmac,
    ErrorCode::InvalidShareLink,
    ErrorCode::MalformedRoute,
    ErrorCode::SwNotReady,
    ErrorCode::TargetProtocolBlocked,
    ErrorCode::TlsCertificateInvalid,
    ErrorCode::TlsHandshakeFailed,
    ErrorCode::TargetConnectFailed,
    ErrorCode::TargetHttpFailed,
    ErrorCode::MalformedHtml,
    ErrorCode::RealmInjectionFailure,
    ErrorCode::RequestBodyTooLarge,
    ErrorCode::SubmissionExpired,
    ErrorCode::PolicyBlocked,
    ErrorCode::RewriteFailed,
    ErrorCode::ScriptSrcBlocked,
    ErrorCode::RedirectBodyNonReplayable,
    ErrorCode::RedirectLimitExceeded,
    ErrorCode::WsBlocked,
    ErrorCode::RtcGatewayUnavailable,
    ErrorCode::WtUnsupported,
];

#[cfg(test)]
mod json_parity {
    use super::*;

    // Verify exact order and contents against the single source of truth.
    #[test]
    fn matches_error_codes_json() {
        let raw = include_str!("../testdata/error_codes.json");
        let want: Vec<String> = serde_json::from_str(raw).expect("parse error_codes.json");
        let got: Vec<String> = ALL.iter().map(|c| c.as_str().to_string()).collect();
        assert_eq!(
            got, want,
            "errors.rs and testdata/error_codes.json diverged; update the JSON file first"
        );
    }
}
