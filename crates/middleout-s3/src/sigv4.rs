use crate::error::S3Error;
use crate::S3Config;
use axum::http::{HeaderMap, Method, Uri};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Authenticated { access_key_id: String },
    Anonymous,
}

pub fn verify_request_auth(
    _method: &Method,
    _uri: &Uri,
    _headers: &HeaderMap,
    _body: &[u8],
    _config: &S3Config,
) -> Result<AuthOutcome, S3Error> {
    Ok(AuthOutcome::Anonymous)
}
