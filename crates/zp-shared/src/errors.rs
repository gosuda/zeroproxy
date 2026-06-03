//! Error codes shown to users via the styled ZeroProxy error page.
//! JS side mirror: `ZP.ERRORS` / `ZP.errorInfo` in `web/zp-core.js`.
//! Keep this list, the JS list, and the Go list (if added) in sync.

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
    MalformedHtml,
    RealmInjectionFailure,
    RequestBodyTooLarge,
    PolicyBlocked,
    RewriteFailed,
    ScriptSrcBlocked,
    RedirectBodyNonReplayable,
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
            Self::MalformedHtml => "MALFORMED_HTML",
            Self::RealmInjectionFailure => "REALM_INJECTION_FAILURE",
            Self::RequestBodyTooLarge => "REQUEST_BODY_TOO_LARGE",
            Self::PolicyBlocked => "POLICY_BLOCKED",
            Self::RewriteFailed => "REWRITE_FAILED",
            Self::ScriptSrcBlocked => "SCRIPT_SRC_BLOCKED",
            Self::RedirectBodyNonReplayable => "REDIRECT_BODY_NONREPLAYABLE",
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
        let codes = [
            ErrorCode::BadHmac,
            ErrorCode::InvalidShareLink,
            ErrorCode::MalformedRoute,
            ErrorCode::SwNotReady,
            ErrorCode::TargetProtocolBlocked,
            ErrorCode::TlsCertificateInvalid,
            ErrorCode::TlsHandshakeFailed,
            ErrorCode::TargetConnectFailed,
            ErrorCode::MalformedHtml,
            ErrorCode::RealmInjectionFailure,
            ErrorCode::RequestBodyTooLarge,
            ErrorCode::PolicyBlocked,
            ErrorCode::RewriteFailed,
            ErrorCode::ScriptSrcBlocked,
            ErrorCode::RedirectBodyNonReplayable,
            ErrorCode::WsBlocked,
            ErrorCode::RtcGatewayUnavailable,
            ErrorCode::WtUnsupported,
        ];
        let mut seen = std::collections::HashSet::new();
        for c in codes {
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
