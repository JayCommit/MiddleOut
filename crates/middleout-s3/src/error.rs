use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use middleout_storage::StorageError;

#[derive(Debug, Clone)]
pub struct S3Error {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub resource: Option<String>,
    pub request_id: String,
}

impl S3Error {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            resource: None,
            request_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn with_resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }

    pub fn access_denied(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "AccessDenied", message)
    }

    pub fn invalid_access_key_id(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "InvalidAccessKeyId", message)
    }

    pub fn signature_does_not_match(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "SignatureDoesNotMatch", message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "InvalidArgument", message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "InvalidRequest", message)
    }

    pub fn malformed_xml(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "MalformedXML", message)
    }

    pub fn bad_digest(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BadDigest", message)
    }

    pub fn content_sha256_mismatch(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "XAmzContentSHA256Mismatch",
            message,
        )
    }

    pub fn no_such_bucket(bucket: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "NoSuchBucket",
            format!("The specified bucket does not exist: {bucket}"),
        )
    }

    pub fn no_such_key(key: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "NoSuchKey",
            format!("The specified key does not exist: {key}"),
        )
    }

    pub fn no_such_upload(upload_id: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "NoSuchUpload",
            format!("The specified multipart upload does not exist: {upload_id}"),
        )
    }

    pub fn method_not_allowed(message: impl Into<String>) -> Self {
        Self::new(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed", message)
    }

    pub fn entity_too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "EntityTooLarge", message)
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "InternalError", message)
    }
}

impl From<StorageError> for S3Error {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::BucketAlreadyExists(b) => S3Error::new(
                StatusCode::CONFLICT,
                "BucketAlreadyOwnedByYou",
                format!(
                    "Your previous request to create the named bucket succeeded and you already own it: {b}"
                ),
            ),
            StorageError::NoSuchBucket(b) => S3Error::new(
                StatusCode::NOT_FOUND,
                "NoSuchBucket",
                format!("The specified bucket does not exist: {b}"),
            ),
            StorageError::BucketNotEmpty(b) => S3Error::new(
                StatusCode::CONFLICT,
                "BucketNotEmpty",
                format!("The bucket you tried to delete is not empty: {b}"),
            ),
            StorageError::InvalidBucketName(b) => S3Error::new(
                StatusCode::BAD_REQUEST,
                "InvalidBucketName",
                format!("The specified bucket is not valid: {b}"),
            ),
            StorageError::NoSuchKey(k) => S3Error::new(
                StatusCode::NOT_FOUND,
                "NoSuchKey",
                format!("The specified key does not exist: {k}"),
            ),
            StorageError::InvalidKey(k) => S3Error::new(
                StatusCode::BAD_REQUEST,
                "InvalidArgument",
                format!("Invalid key: {k}"),
            ),
            StorageError::NoSuchUpload(u) => S3Error::new(
                StatusCode::NOT_FOUND,
                "NoSuchUpload",
                format!("The specified multipart upload does not exist: {u}"),
            ),
            StorageError::InvalidPart(m) => S3Error::new(StatusCode::BAD_REQUEST, "InvalidPart", m),
            StorageError::InvalidPartOrder(m) => {
                S3Error::new(StatusCode::BAD_REQUEST, "InvalidPartOrder", m)
            }
            StorageError::BadDigest(m) => S3Error::new(StatusCode::BAD_REQUEST, "BadDigest", m),
            StorageError::InvalidRange(m) => {
                S3Error::new(StatusCode::RANGE_NOT_SATISFIABLE, "InvalidRange", m)
            }
            StorageError::EntityTooLarge(m) => {
                S3Error::new(StatusCode::PAYLOAD_TOO_LARGE, "EntityTooLarge", m)
            }
            StorageError::Database(e) => S3Error::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                e.to_string(),
            ),
            StorageError::Io(e) => S3Error::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                e.to_string(),
            ),
            StorageError::Internal(m) => {
                S3Error::new(StatusCode::INTERNAL_SERVER_ERROR, "InternalError", m)
            }
        }
    }
}

impl IntoResponse for S3Error {
    fn into_response(self) -> Response {
        let xml = crate::xml::render_error(&self);
        (
            self.status,
            [
                ("content-type", "application/xml"),
                ("x-amz-request-id", self.request_id.as_str()),
            ],
            xml,
        )
            .into_response()
    }
}
