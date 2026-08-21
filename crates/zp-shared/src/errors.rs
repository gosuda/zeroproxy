//! Error codes shown to users via the styled ZeroProxy error page.
//!
//! 2026-08-21 — 이 목록은 **세 곳**에 있다: 여기(Rust), `web/zp-core.js` 의
//! `ZP.ERRORS`, 그리고 Go `cmd/zeroproxy-server` 의 `sanitizeCode`.
//! 예전 주석은 "sync 를 유지하라" 는 **부탁**이었고, 실제로는 갈라져 있었다 —
//! Rust 에 `SUBMISSION_EXPIRED` 가 없었고(JS 는 쓰고 있었다), Go 는 12개만
//! 알아서 **자기가 내는 `RTC_GATEWAY_UNAVAILABLE` 을 `POLICY_BLOCKED` 로
//! 강등**하고 있었다.
//!
//! 이제 `testdata/error_codes.json` 이 단일 소스이고 세 곳 모두 그 파일과
//! 대조하는 테스트를 갖는다. 코드를 추가할 때는 **JSON 을 먼저** 고칠 것.

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
        // 손목록을 들고 있으면 이 파일 안에서만 사본이 둘이 된다 — ALL 하나만 쓴다.
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

/// 선언 순서대로 모든 코드. `testdata/error_codes.json` 과 대조하는 데 쓴다.
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

    // 단일 소스와의 대조. 순서까지 본다 — 순서가 흔들리면 어느 한쪽이 손으로
    // 편집됐다는 뜻이고, 그게 바로 갈라지기 시작하는 지점이다.
    #[test]
    fn matches_error_codes_json() {
        let raw = include_str!("../testdata/error_codes.json");
        let want: Vec<String> = serde_json::from_str(raw).expect("parse error_codes.json");
        let got: Vec<String> = ALL.iter().map(|c| c.as_str().to_string()).collect();
        assert_eq!(
            got, want,
            "errors.rs 와 testdata/error_codes.json 이 갈라졌다 — JSON 을 먼저 고칠 것"
        );
    }
}
