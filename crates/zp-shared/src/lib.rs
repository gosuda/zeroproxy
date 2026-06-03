//! Shared types and spec for ZeroProxy browser-side crates.
//!
//! Single source of truth for: CSP builder, share URL parser, error codes,
//! transformer version. Go server has independent implementation; parity is
//! enforced via cross-language golden tests (testdata/*.json).

pub mod challenge;
pub mod csp;
pub mod errors;
pub mod shareurl;
pub mod version;

pub use challenge::{
    challenge_subresource_skip, is_challenge_document, CHALLENGE_HOST, CHALLENGE_PLATFORM_PREFIX,
};
pub use csp::{build_csp, build_csp_with, CspOptions};
pub use errors::ErrorCode;
pub use shareurl::{parse_share_url, ShareUrl, ShareUrlError};
pub use version::TRANSFORMER_VERSION;
