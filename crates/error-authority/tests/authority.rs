use error_authority::{
    AuthorityError, ERROR_VERSION, ErrorCode, ErrorStage, InternalError, PublicError,
    decode_internal, decode_public,
};
use serde_json::json;

const REQUEST_ID: &str = "request_identifier_1234";

#[test]
fn public_error_replaces_internal_cause() {
    let internal = InternalError::new(
        ERROR_VERSION,
        ErrorCode::StaleOperation,
        ErrorStage::Coordinator,
        REQUEST_ID,
        json!({"source": "private source text"}),
    )
    .unwrap();
    let public = internal.public(ERROR_VERSION).unwrap();
    assert_eq!(public.request_id, REQUEST_ID);
    assert_eq!(public.message_key, "stale_operation");
    assert!(public.retryable);
    let encoded = serde_json::to_string(&public).unwrap();
    assert!(!encoded.contains("private source text"));
    assert!(!encoded.contains("internal_cause"));
}

#[test]
fn parser_rejects_unknown_and_drifted_values() {
    assert!(matches!(
        InternalError::new(
            ERROR_VERSION + 1,
            ErrorCode::StaleOperation,
            ErrorStage::Coordinator,
            REQUEST_ID,
            json!(null),
        ),
        Err(AuthorityError::UnknownVersion(_))
    ));
    assert!(matches!(
        InternalError::new(
            ERROR_VERSION,
            ErrorCode::StaleOperation,
            ErrorStage::Body,
            REQUEST_ID,
            json!(null),
        ),
        Err(AuthorityError::InvalidStage)
    ));
    assert!(decode_internal(
        ERROR_VERSION,
        r#"{"code":"UNKNOWN","stage":"INTERNAL","retryable":false,"request_id":"request_identifier_1234","internal_cause":null}"#,
    )
    .is_err());
    assert!(decode_public(
        ERROR_VERSION,
        r#"{"code":"STALE_OPERATION","stage":"COORDINATOR","retryable":true,"request_id":"request_identifier_1234","message_key":"stale_operation","extra":true}"#,
    )
    .is_err());
    let drifted = PublicError {
        code: ErrorCode::StaleOperation,
        stage: ErrorStage::Coordinator,
        retryable: false,
        request_id: REQUEST_ID.to_owned(),
        message_key: "stale_operation".to_owned(),
    };
    assert!(matches!(
        drifted.validate(ERROR_VERSION),
        Err(AuthorityError::InvalidRetryable)
    ));
}
