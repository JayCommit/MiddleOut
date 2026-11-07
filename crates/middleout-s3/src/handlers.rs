use std::collections::BTreeMap;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, OriginalUri, Request, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use bytes::Bytes;
use http_body_util::BodyExt;
use middleout_storage::{ListObjectsV2Input, ObjectMeta, PutObjectInput};
use percent_encoding::percent_decode_str;
use uuid::Uuid;

use crate::error::S3Error;
use crate::sigv4::{self, AuthOutcome};
use crate::xml;
use crate::S3State;

pub fn router(state: S3State) -> Router {
    let max_bytes = state.config.max_object_bytes;
    Router::new()
        .route("/", any(handle_s3_request))
        .route("/{*path}", any(handle_s3_request))
        .fallback(handle_s3_request)
        .layer(DefaultBodyLimit::max(max_bytes))
        .with_state(state)
}

#[derive(Debug, Clone)]
enum S3Target {
    Service,
    Bucket { bucket: String },
    Object { bucket: String, key: String },
}

fn parse_s3_path(raw_path: &str) -> S3Target {
    let trimmed = raw_path.strip_prefix('/').unwrap_or(raw_path);
    if trimmed.is_empty() {
        return S3Target::Service;
    }

    match trimmed.split_once('/') {
        None => {
            let bucket = percent_decode_str(trimmed)
                .decode_utf8_lossy()
                .into_owned();
            S3Target::Bucket { bucket }
        }
        Some((raw_bucket, raw_key)) => {
            let bucket = percent_decode_str(raw_bucket)
                .decode_utf8_lossy()
                .into_owned();
            if raw_key.is_empty() {
                S3Target::Bucket { bucket }
            } else {
                let key = percent_decode_str(raw_key)
                    .decode_utf8_lossy()
                    .into_owned();
                S3Target::Object { bucket, key }
            }
        }
    }
}

fn get_query_param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn has_query_param(params: &[(String, String)], key: &str) -> bool {
    params.iter().any(|(k, _)| k == key)
}

fn require_authenticated(auth: &AuthOutcome) -> Result<(), S3Error> {
    match auth {
        AuthOutcome::Authenticated { .. } => Ok(()),
        AuthOutcome::Anonymous => Err(S3Error::access_denied("Access Denied")),
    }
}

fn require_object_read_access(
    state: &S3State,
    auth: &AuthOutcome,
    bucket: &str,
) -> Result<(), S3Error> {
    match auth {
        AuthOutcome::Authenticated { .. } => Ok(()),
        AuthOutcome::Anonymous => {
            let bucket_info = state
                .storage
                .get_bucket(bucket)
                .map_err(|_| S3Error::access_denied("Access Denied"))?;
            if bucket_info.public_read {
                Ok(())
            } else {
                Err(S3Error::access_denied("Access Denied"))
            }
        }
    }
}

fn extract_user_meta(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut meta = BTreeMap::new();
    for (name, val) in headers.iter() {
        let name_str = name.as_str().to_ascii_lowercase();
        if let Some(meta_key) = name_str.strip_prefix("x-amz-meta-") {
            if !meta_key.is_empty() {
                if let Ok(val_str) = val.to_str() {
                    meta.insert(meta_key.to_string(), val_str.trim().to_string());
                }
            }
        }
    }
    meta
}

fn format_http_date(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

fn append_object_headers(headers: &mut HeaderMap, meta: &ObjectMeta, content_length: u64) {
    if let Ok(v) = HeaderValue::from_str(&meta.content_type) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&content_length.to_string()) {
        headers.insert(header::CONTENT_LENGTH, v);
    }
    let quoted_etag = format!("\"{}\"", meta.etag.trim_matches('"'));
    if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
        headers.insert(header::ETAG, v);
    }
    let last_modified = format_http_date(&meta.updated_at);
    if let Ok(v) = HeaderValue::from_str(&last_modified) {
        headers.insert(header::LAST_MODIFIED, v);
    }
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));

    for (k, v) in &meta.user_meta {
        let header_name_str = format!("x-amz-meta-{}", k.to_ascii_lowercase());
        if let (Ok(hname), Ok(hval)) = (
            HeaderName::from_bytes(header_name_str.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(hname, hval);
        }
    }
}

fn xml_response(status: StatusCode, xml_body: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/xml")],
        xml_body,
    )
        .into_response()
}

fn etag_matches(candidate: &str, obj_etag: &str) -> bool {
    let c = candidate.trim();
    if c == "*" {
        return true;
    }
    let c_clean = c.strip_prefix("W/").unwrap_or(c).trim().trim_matches('"');
    let obj_clean = obj_etag.trim().trim_matches('"');
    c_clean.eq_ignore_ascii_case(obj_clean)
}

fn header_matches_etag(header_val: &str, obj_etag: &str) -> bool {
    header_val
        .split(',')
        .any(|part| etag_matches(part, obj_etag))
}

fn verify_md5_header(headers: &HeaderMap, data: &[u8]) -> Result<Option<String>, S3Error> {
    if let Some(md5_val) = headers.get("content-md5") {
        let md5_str = md5_val
            .to_str()
            .map_err(|_| S3Error::bad_digest("Invalid Content-MD5 header"))?
            .trim()
            .to_string();
        use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
        use base64::Engine as _;
        use md5::{Digest as _, Md5};

        let decoded_md5 = BASE64_STANDARD
            .decode(&md5_str)
            .map_err(|_| S3Error::bad_digest("The Content-MD5 you specified is not valid."))?;
        if decoded_md5.len() != 16 {
            return Err(S3Error::bad_digest(
                "The Content-MD5 you specified is not valid.",
            ));
        }
        let actual_digest = Md5::digest(data);
        if actual_digest.as_slice() != decoded_md5.as_slice() {
            return Err(S3Error::bad_digest(
                "The Content-MD5 you specified did not match what we received.",
            ));
        }
        Ok(Some(md5_str))
    } else {
        Ok(None)
    }
}

fn parse_copy_source(raw_header: &str) -> Result<(String, String), S3Error> {
    let trimmed = raw_header.trim();
    // Strip optional query string (e.g. ?versionId=...)
    let path_part = match trimmed.split_once('?') {
        Some((p, _)) => p,
        None => trimmed,
    };
    let without_leading = path_part.strip_prefix('/').unwrap_or(path_part);
    let (raw_bucket, raw_key) = without_leading.split_once('/').ok_or_else(|| {
        S3Error::invalid_argument("Invalid x-amz-copy-source header: must contain bucket and key")
    })?;
    if raw_bucket.is_empty() || raw_key.is_empty() {
        return Err(S3Error::invalid_argument(
            "Invalid x-amz-copy-source header: bucket and key must be non-empty",
        ));
    }
    let src_bucket = percent_decode_str(raw_bucket)
        .decode_utf8_lossy()
        .into_owned();
    let src_key = percent_decode_str(raw_key)
        .decode_utf8_lossy()
        .into_owned();
    Ok((src_bucket, src_key))
}

async fn handle_s3_request(
    State(state): State<S3State>,
    OriginalUri(original_uri): OriginalUri,
    req: Request,
) -> Response {
    let is_head = req.method() == Method::HEAD;
    let request_id = Uuid::new_v4().to_string();

    let mut resp = match dispatch_s3_request(&state, original_uri, req).await {
        Ok(r) => r,
        Err(mut err) => {
            err.request_id = request_id.clone();
            err.into_response()
        }
    };

    if let Ok(val) = HeaderValue::from_str(&request_id) {
        resp.headers_mut().insert("x-amz-request-id", val);
    }

    if is_head {
        let (parts, _) = resp.into_parts();
        Response::from_parts(parts, Body::empty())
    } else {
        resp
    }
}

async fn dispatch_s3_request(
    state: &S3State,
    uri: axum::http::Uri,
    req: Request,
) -> Result<Response, S3Error> {
    let method = req.method().clone();
    let headers = req.headers().clone();

    let max_bytes = state.config.max_object_bytes;
    let body_bytes: Bytes = req
        .into_body()
        .collect()
        .await
        .map_err(|_| {
            S3Error::entity_too_large("Your proposed upload exceeds the maximum allowed size")
        })?
        .to_bytes();

    if body_bytes.len() > max_bytes {
        return Err(S3Error::entity_too_large(
            "Your proposed upload exceeds the maximum allowed size",
        ));
    }

    let auth = sigv4::verify_request_auth(&method, &uri, &headers, &body_bytes, &state.config)?;
    let query_params = sigv4::parse_query_params(uri.query().unwrap_or(""));
    let target = parse_s3_path(uri.path());

    match target {
        S3Target::Service => handle_service(&state, &auth, &method).await,
        S3Target::Bucket { bucket } => {
            handle_bucket(
                &state,
                &auth,
                &method,
                &bucket,
                &query_params,
                &headers,
                body_bytes,
            )
            .await
        }
        S3Target::Object { bucket, key } => {
            handle_object(
                &state,
                &auth,
                &method,
                &bucket,
                &key,
                &query_params,
                &headers,
                body_bytes,
            )
            .await
        }
    }
}

async fn handle_service(
    state: &S3State,
    auth: &AuthOutcome,
    method: &Method,
) -> Result<Response, S3Error> {
    require_authenticated(auth)?;
    match *method {
        Method::GET => {
            let buckets = state.storage.list_buckets()?;
            let xml = xml::render_list_buckets(&buckets);
            Ok(xml_response(StatusCode::OK, xml))
        }
        _ => Err(S3Error::method_not_allowed(
            "The specified method is not allowed against this resource.",
        )),
    }
}

async fn handle_bucket(
    state: &S3State,
    auth: &AuthOutcome,
    method: &Method,
    bucket: &str,
    query_params: &[(String, String)],
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, S3Error> {
    require_authenticated(auth)?;

    match *method {
        Method::PUT => {
            let public_read = headers
                .get("x-amz-acl")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().eq_ignore_ascii_case("public-read"))
                .unwrap_or(false);

            state.storage.create_bucket(bucket, public_read)?;

            let location = format!("/{bucket}");
            let mut resp = StatusCode::OK.into_response();
            if let Ok(loc_val) = HeaderValue::from_str(&location) {
                resp.headers_mut().insert(header::LOCATION, loc_val);
            }
            if let Ok(reg_val) = HeaderValue::from_str(&state.config.region) {
                resp.headers_mut().insert("x-amz-bucket-region", reg_val);
            }
            Ok(resp)
        }
        Method::DELETE => {
            state.storage.delete_bucket(bucket)?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Method::HEAD => {
            state.storage.get_bucket(bucket)?;
            let mut resp = StatusCode::OK.into_response();
            if let Ok(reg_val) = HeaderValue::from_str(&state.config.region) {
                resp.headers_mut().insert("x-amz-bucket-region", reg_val);
            }
            Ok(resp)
        }
        Method::POST => {
            if has_query_param(query_params, "delete") {
                let _ = verify_md5_header(headers, &body)?;
                let (keys, quiet) = xml::parse_delete_objects(&body)?;
                // Ensure bucket exists first
                state.storage.get_bucket(bucket)?;
                let mut deleted = Vec::with_capacity(keys.len());
                for key in keys {
                    state.storage.delete_object(bucket, &key)?;
                    deleted.push(key);
                }
                let xml = xml::render_delete_objects_result(&deleted, quiet);
                Ok(xml_response(StatusCode::OK, xml))
            } else {
                Err(S3Error::invalid_request(
                    "Unsupported POST operation on bucket",
                ))
            }
        }
        Method::GET => {
            if has_query_param(query_params, "location") {
                state.storage.get_bucket(bucket)?;
                let xml = xml::render_location_constraint(&state.config.region);
                return Ok(xml_response(StatusCode::OK, xml));
            }
            if has_query_param(query_params, "versioning") {
                state.storage.get_bucket(bucket)?;
                let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>".to_string();
                return Ok(xml_response(StatusCode::OK, xml));
            }
            if has_query_param(query_params, "uploads") {
                state.storage.get_bucket(bucket)?;
                let xml = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ListMultipartUploadsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Bucket>{}</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>",
                    xml::escape_xml(bucket)
                );
                return Ok(xml_response(StatusCode::OK, xml));
            }

            let list_type = get_query_param(query_params, "list-type");
            let prefix = get_query_param(query_params, "prefix").map(|s| s.to_string());
            let delimiter = get_query_param(query_params, "delimiter").map(|s| s.to_string());
            let max_keys = match get_query_param(query_params, "max-keys") {
                Some(s) => {
                    let parsed: i64 = s.parse().map_err(|_| {
                        S3Error::invalid_argument(
                            "Provided max-keys not an integer or within integer range",
                        )
                    })?;
                    if parsed < 0 {
                        return Err(S3Error::invalid_argument(
                            "Argument maxKeys must be an integer between 0 and 2147483647",
                        ));
                    }
                    parsed as usize
                }
                None => 1000,
            };

            let encoding_type = get_query_param(query_params, "encoding-type");
            if let Some(enc) = encoding_type {
                if enc != "url" {
                    return Err(S3Error::invalid_argument(format!(
                        "Invalid Encoding Method specified in Request: {enc}"
                    )));
                }
            }
            let encoding_type_url = encoding_type == Some("url");

            if list_type == Some("2") {
                let continuation_token =
                    get_query_param(query_params, "continuation-token").map(|s| s.to_string());
                let start_after =
                    get_query_param(query_params, "start-after").map(|s| s.to_string());
                let out = state.storage.list_objects_v2(ListObjectsV2Input {
                    bucket: bucket.to_string(),
                    prefix,
                    delimiter,
                    max_keys,
                    continuation_token,
                    start_after,
                })?;
                let xml = xml::render_list_objects_v2(&out, encoding_type_url);
                Ok(xml_response(StatusCode::OK, xml))
            } else if list_type == Some("1")
                || (list_type.is_none() && has_query_param(query_params, "marker"))
            {
                let marker = get_query_param(query_params, "marker").map(|s| s.to_string());
                let out = state.storage.list_objects_v2(ListObjectsV2Input {
                    bucket: bucket.to_string(),
                    prefix,
                    delimiter,
                    max_keys,
                    continuation_token: None,
                    start_after: marker.clone(),
                })?;
                let next_marker = if out.is_truncated {
                    let last_obj = out.contents.last().map(|o| o.key.as_str());
                    let last_cp = out.common_prefixes.last().map(|s| s.as_str());
                    match (last_obj, last_cp) {
                        (Some(a), Some(b)) => Some(if a >= b { a } else { b }),
                        (Some(a), None) => Some(a),
                        (None, Some(b)) => Some(b),
                        (None, None) => None,
                    }
                } else {
                    None
                };
                let xml = xml::render_list_objects_v1(
                    &out,
                    marker.as_deref(),
                    next_marker,
                    encoding_type_url,
                );
                Ok(xml_response(StatusCode::OK, xml))
            } else if list_type.is_none() {
                let continuation_token =
                    get_query_param(query_params, "continuation-token").map(|s| s.to_string());
                let start_after =
                    get_query_param(query_params, "start-after").map(|s| s.to_string());
                let out = state.storage.list_objects_v2(ListObjectsV2Input {
                    bucket: bucket.to_string(),
                    prefix,
                    delimiter,
                    max_keys,
                    continuation_token,
                    start_after,
                })?;
                let xml = xml::render_list_objects_v2(&out, encoding_type_url);
                Ok(xml_response(StatusCode::OK, xml))
            } else {
                Err(S3Error::invalid_argument("Invalid list-type parameter"))
            }
        }
        _ => Err(S3Error::method_not_allowed(
            "The specified method is not allowed against this resource.",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_object(
    state: &S3State,
    auth: &AuthOutcome,
    method: &Method,
    bucket: &str,
    key: &str,
    query_params: &[(String, String)],
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, S3Error> {
    match *method {
        Method::PUT => {
            require_authenticated(auth)?;

            // Check if Multipart UploadPart: ?partNumber=N&uploadId=ID
            if let Some(upload_id) = get_query_param(query_params, "uploadId") {
                let part_num_str = get_query_param(query_params, "partNumber").ok_or_else(|| {
                    S3Error::invalid_argument("Part number must be specified for UploadPart")
                })?;
                let part_number: u32 = part_num_str.parse().map_err(|_| {
                    S3Error::new(
                        StatusCode::BAD_REQUEST,
                        "InvalidArgument",
                        "Part number must be an integer between 1 and 10000, inclusive",
                    )
                })?;
                if !(1..=10_000).contains(&part_number) {
                    return Err(S3Error::new(
                        StatusCode::BAD_REQUEST,
                        "InvalidArgument",
                        "Part number must be an integer between 1 and 10000, inclusive",
                    ));
                }

                let decoded_body = sigv4::decode_payload_if_aws_chunked(headers, body)?;
                let expected_md5 = verify_md5_header(headers, &decoded_body)?;

                let part_info = state.storage.upload_part(
                    bucket,
                    key,
                    upload_id,
                    part_number,
                    decoded_body,
                    expected_md5,
                )?;

                let quoted_etag = format!("\"{}\"", part_info.etag.trim_matches('"'));
                let mut resp = StatusCode::OK.into_response();
                if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
                    resp.headers_mut().insert(header::ETAG, v);
                }
                return Ok(resp);
            }

            // Check if CopyObject: header x-amz-copy-source
            if let Some(copy_source_val) = headers.get("x-amz-copy-source") {
                let copy_source_str = copy_source_val.to_str().map_err(|_| {
                    S3Error::invalid_argument("Invalid x-amz-copy-source header encoding")
                })?;
                let (src_bucket, src_key) = parse_copy_source(copy_source_str)?;

                let directive = headers
                    .get("x-amz-metadata-directive")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim().to_ascii_uppercase())
                    .unwrap_or_else(|| "COPY".to_string());

                let (content_type_override, user_meta_override) = match directive.as_str() {
                    "COPY" => (None, None),
                    "REPLACE" => {
                        let ct = headers
                            .get(header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let um = extract_user_meta(headers);
                        (ct, Some(um))
                    }
                    _ => {
                        return Err(S3Error::invalid_argument(format!(
                            "Unknown metadata directive: {directive}"
                        )));
                    }
                };

                let meta = state.storage.copy_object(
                    &src_bucket,
                    &src_key,
                    bucket,
                    key,
                    content_type_override,
                    user_meta_override,
                )?;

                let xml = xml::render_copy_object_result(&meta);
                return Ok(xml_response(StatusCode::OK, xml));
            }

            // Standard PutObject
            let decoded_body = sigv4::decode_payload_if_aws_chunked(headers, body)?;
            let expected_md5_b64 = verify_md5_header(headers, &decoded_body)?;
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let user_meta = extract_user_meta(headers);

            let meta = state.storage.put_object(PutObjectInput {
                bucket: bucket.to_string(),
                key: key.to_string(),
                data: decoded_body,
                content_type,
                expected_md5_b64,
                user_meta,
            })?;

            let quoted_etag = format!("\"{}\"", meta.etag.trim_matches('"'));
            let mut resp = StatusCode::OK.into_response();
            if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
                resp.headers_mut().insert(header::ETAG, v);
            }
            Ok(resp)
        }
        Method::GET => {
            if let Some(upload_id) = get_query_param(query_params, "uploadId") {
                require_authenticated(auth)?;
                let (info, parts) = state.storage.list_parts(bucket, key, upload_id)?;
                let xml = xml::render_list_parts(&info, &parts);
                return Ok(xml_response(StatusCode::OK, xml));
            }

            require_object_read_access(state, auth, bucket)?;

            let range_str = headers
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok());
            let out = state.storage.get_object(bucket, key, range_str)?;

            // Check conditional headers
            if let Some(if_match) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
                if !header_matches_etag(if_match, &out.meta.etag) {
                    return Err(S3Error::new(
                        StatusCode::PRECONDITION_FAILED,
                        "PreconditionFailed",
                        "At least one of the pre-conditions you specified did not hold",
                    ));
                }
            }
            if let Some(if_none_match) = headers
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
            {
                if header_matches_etag(if_none_match, &out.meta.etag) {
                    let mut resp = StatusCode::NOT_MODIFIED.into_response();
                    let quoted_etag = format!("\"{}\"", out.meta.etag.trim_matches('"'));
                    if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
                        resp.headers_mut().insert(header::ETAG, v);
                    }
                    let last_modified = format_http_date(&out.meta.updated_at);
                    if let Ok(v) = HeaderValue::from_str(&last_modified) {
                        resp.headers_mut().insert(header::LAST_MODIFIED, v);
                    }
                    return Ok(resp);
                }
            }

            let status = if out.is_partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };

            let mut resp_headers = HeaderMap::new();
            append_object_headers(&mut resp_headers, &out.meta, out.data.len() as u64);
            if let Some(ref cr) = out.content_range {
                if let Ok(v) = HeaderValue::from_str(cr) {
                    resp_headers.insert(header::CONTENT_RANGE, v);
                }
            }

            Ok((status, resp_headers, out.data).into_response())
        }
        Method::HEAD => {
            require_object_read_access(state, auth, bucket)?;
            let meta = state.storage.head_object(bucket, key)?;

            if let Some(if_match) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
                if !header_matches_etag(if_match, &meta.etag) {
                    return Err(S3Error::new(
                        StatusCode::PRECONDITION_FAILED,
                        "PreconditionFailed",
                        "At least one of the pre-conditions you specified did not hold",
                    ));
                }
            }
            if let Some(if_none_match) = headers
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
            {
                if header_matches_etag(if_none_match, &meta.etag) {
                    let mut resp = StatusCode::NOT_MODIFIED.into_response();
                    let quoted_etag = format!("\"{}\"", meta.etag.trim_matches('"'));
                    if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
                        resp.headers_mut().insert(header::ETAG, v);
                    }
                    let last_modified = format_http_date(&meta.updated_at);
                    if let Ok(v) = HeaderValue::from_str(&last_modified) {
                        resp.headers_mut().insert(header::LAST_MODIFIED, v);
                    }
                    return Ok(resp);
                }
            }

            let mut resp_headers = HeaderMap::new();
            append_object_headers(&mut resp_headers, &meta, meta.size);
            Ok((StatusCode::OK, resp_headers, Body::empty()).into_response())
        }
        Method::DELETE => {
            require_authenticated(auth)?;
            if let Some(upload_id) = get_query_param(query_params, "uploadId") {
                state
                    .storage
                    .abort_multipart_upload(bucket, key, upload_id)?;
                return Ok(StatusCode::NO_CONTENT.into_response());
            }

            state.storage.delete_object(bucket, key)?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Method::POST => {
            require_authenticated(auth)?;
            if has_query_param(query_params, "uploads") {
                let content_type = headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let user_meta = extract_user_meta(headers);
                let info =
                    state
                        .storage
                        .initiate_multipart_upload(bucket, key, content_type, user_meta)?;
                let xml = xml::render_initiate_multipart_upload(&info);
                return Ok(xml_response(StatusCode::OK, xml));
            }

            if let Some(upload_id) = get_query_param(query_params, "uploadId") {
                let parts = xml::parse_complete_multipart_upload(&body)?;
                let meta = state
                    .storage
                    .complete_multipart_upload(bucket, key, upload_id, &parts)?;
                let location = format!("/{bucket}/{key}");
                let xml = xml::render_complete_multipart_upload(&location, &meta);
                let quoted_etag = format!("\"{}\"", meta.etag.trim_matches('"'));
                let mut resp = xml_response(StatusCode::OK, xml);
                if let Ok(v) = HeaderValue::from_str(&quoted_etag) {
                    resp.headers_mut().insert(header::ETAG, v);
                }
                return Ok(resp);
            }

            Err(S3Error::invalid_request(
                "Unsupported POST operation on object",
            ))
        }
        _ => Err(S3Error::method_not_allowed(
            "The specified method is not allowed against this resource.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum::http::{Method, Request as HttpRequest, StatusCode, Uri};
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;
    use md5::{Digest as _, Md5};
    use middleout_storage::StorageEngine;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use crate::sigv4::{
        canonical_query_string, canonical_uri, compute_sigv4_signature, sha256_hex,
    };
    use crate::S3Config;

    fn test_setup() -> (tempfile::TempDir, Router, S3State) {
        let dir = tempdir().unwrap();
        let storage = StorageEngine::open(dir.path()).unwrap();
        let config = Arc::new(S3Config {
            access_key_id: "test-access-key".to_string(),
            secret_access_key: "test-secret-key".to_string(),
            region: "us-east-1".to_string(),
            max_object_bytes: 10 * 1024 * 1024,
        });
        let state = S3State { storage, config };
        let app = router(state.clone());
        (dir, app, state)
    }

    fn build_signed_request(
        method: Method,
        uri_str: &str,
        extra_headers: Vec<(&str, &str)>,
        body: impl Into<Bytes>,
        config: &S3Config,
    ) -> HttpRequest<Body> {
        let body_bytes: Bytes = body.into();
        let uri: Uri = uri_str.parse().unwrap();
        let amz_date = "20261107T013000Z";
        let date_stamp = "20261107";
        let region = &config.region;

        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:9000"));
        headers.insert("x-amz-date", HeaderValue::from_static(amz_date));

        for (k, v) in extra_headers {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }

        let payload_hash = headers
            .get("x-amz-content-sha256")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let h = sha256_hex(&body_bytes);
                headers.insert(
                    "x-amz-content-sha256",
                    HeaderValue::from_str(&h).unwrap(),
                );
                h
            });

        let mut signed_names: Vec<String> = headers
            .keys()
            .map(|k| k.as_str().to_ascii_lowercase())
            .collect();
        signed_names.sort();
        signed_names.dedup();

        let mut can_headers = String::new();
        for name in &signed_names {
            let val = headers.get(name.as_str()).unwrap().to_str().unwrap().trim();
            can_headers.push_str(&format!("{name}:{val}\n"));
        }
        let signed_headers_str = signed_names.join(";");

        let can_uri = canonical_uri(uri.path());
        let can_query = canonical_query_string(uri.query().unwrap_or(""), false);

        let canonical_req = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            can_uri,
            can_query,
            can_headers,
            signed_headers_str,
            payload_hash
        );

        let scope = format!("{date_stamp}/{region}/s3/aws4_request");
        let sts = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            scope,
            sha256_hex(canonical_req.as_bytes())
        );
        let sig = compute_sigv4_signature(
            &config.secret_access_key,
            date_stamp,
            region,
            "s3",
            &sts,
        );
        let auth_val = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            config.access_key_id, scope, signed_headers_str, sig
        );
        headers.insert("authorization", HeaderValue::from_str(&auth_val).unwrap());

        let mut builder = HttpRequest::builder().method(method).uri(uri);
        for (k, v) in headers.iter() {
            builder = builder.header(k, v);
        }
        builder.body(Body::from(body_bytes)).unwrap()
    }

    fn build_anon_request(
        method: Method,
        uri_str: &str,
        extra_headers: Vec<(&str, &str)>,
        body: impl Into<Bytes>,
    ) -> HttpRequest<Body> {
        let mut builder = HttpRequest::builder().method(method).uri(uri_str);
        for (k, v) in extra_headers {
            builder = builder.header(k, v);
        }
        builder.body(Body::from(body.into())).unwrap()
    }

    async fn read_body_bytes(resp: Response) -> Bytes {
        resp.into_body().collect().await.unwrap().to_bytes()
    }

    #[tokio::test]
    async fn test_bucket_lifecycle_and_probes() {
        let (_dir, app, state) = test_setup();

        // Anonymous ListBuckets rejected
        let resp = app
            .clone()
            .oneshot(build_anon_request(Method::GET, "/", vec![], ""))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp.headers().contains_key("x-amz-request-id"));

        // CreateBucket with trailing slash and LocationConstraint XML body
        let create_xml = r#"<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>us-east-1</LocationConstraint></CreateBucketConfiguration>"#;
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/alpha-bucket/",
                vec![],
                create_xml,
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get("location").unwrap(), "/alpha-bucket");

        // HeadBucket
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::HEAD,
                "/alpha-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("x-amz-bucket-region").unwrap(),
            "us-east-1"
        );
        assert!(read_body_bytes(resp).await.is_empty());

        // HeadBucket on non-existent bucket -> 404 with empty body
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::HEAD,
                "/nonexistent-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(read_body_bytes(resp).await.is_empty());

        // GetBucketLocation
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/alpha-bucket?location",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(body.contains("LocationConstraint"));

        // GetBucketVersioning
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/alpha-bucket?versioning",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(body.contains("VersioningConfiguration"));

        // ListMultipartUploads
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/alpha-bucket?uploads",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(body.contains("ListMultipartUploadsResult"));

        // ListBuckets
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(body.contains("<Name>alpha-bucket</Name>"));

        // DeleteBucket
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::DELETE,
                "/alpha-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn test_public_and_private_bucket_authorization() {
        let (_dir, app, state) = test_setup();

        // Create private bucket and public bucket
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/priv-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/pub-bucket",
                vec![("x-amz-acl", "public-read")],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Put object in both buckets
        for bucket in ["priv-bucket", "pub-bucket"] {
            let resp = app
                .clone()
                .oneshot(build_signed_request(
                    Method::PUT,
                    &format!("/{bucket}/hello.txt"),
                    vec![("content-type", "text/plain")],
                    "secret-or-public-data",
                    &state.config,
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
        }

        // Anonymous GET on private bucket -> 403 AccessDenied
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::GET,
                "/priv-bucket/hello.txt",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let err_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(err_xml.contains("<Code>AccessDenied</Code>"));

        // Anonymous HEAD on private bucket -> 403
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::HEAD,
                "/priv-bucket/hello.txt",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Anonymous GET on public bucket -> 200 OK
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::GET,
                "/pub-bucket/hello.txt",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            read_body_bytes(resp).await,
            Bytes::from_static(b"secret-or-public-data")
        );

        // Anonymous HEAD on public bucket -> 200 OK
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::HEAD,
                "/pub-bucket/hello.txt",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get("content-length").unwrap(), "21");

        // Anonymous ListObjects on public bucket -> 403 Forbidden (only GET/HEAD object allowed anonymously)
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::GET,
                "/pub-bucket?list-type=2",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Anonymous PUT/DELETE on public bucket -> 403 Forbidden
        let resp = app
            .clone()
            .oneshot(build_anon_request(
                Method::DELETE,
                "/pub-bucket/hello.txt",
                vec![],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_object_crud_metadata_ranges_copy_and_batch_delete() {
        let (_dir, app, state) = test_setup();

        app.clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/test-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();

        let payload = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let md5_b64 = BASE64_STANDARD.encode(Md5::digest(payload));

        // PutObject with nested key, special chars, user metadata, Content-MD5
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/test-bucket/dir/sub%20folder/file%2B1.txt",
                vec![
                    ("content-type", "text/plain; charset=utf-8"),
                    ("content-md5", &md5_b64),
                    ("x-amz-meta-author", "Richard Hendricks"),
                    ("x-amz-meta-compression", "middle-out"),
                ],
                Bytes::from_static(payload),
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let etag = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        // HeadObject
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::HEAD,
                "/test-bucket/dir/sub%20folder/file%2B1.txt",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/plain; charset=utf-8"
        );
        assert_eq!(resp.headers().get("content-length").unwrap(), "36");
        assert_eq!(resp.headers().get("etag").unwrap(), &etag);
        assert_eq!(resp.headers().get("accept-ranges").unwrap(), "bytes");
        assert_eq!(
            resp.headers().get("x-amz-meta-author").unwrap(),
            "Richard Hendricks"
        );
        assert_eq!(
            resp.headers().get("x-amz-meta-compression").unwrap(),
            "middle-out"
        );
        assert!(read_body_bytes(resp).await.is_empty());

        // Conditional GET If-None-Match -> 304 Not Modified
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/test-bucket/dir/sub%20folder/file%2B1.txt",
                vec![("if-none-match", &etag)],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_MODIFIED);

        // Partial Range GET: bytes=10-15
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/test-bucket/dir/sub%20folder/file%2B1.txt",
                vec![("range", "bytes=10-15")],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get("content-range").unwrap(),
            "bytes 10-15/36"
        );
        assert_eq!(resp.headers().get("content-length").unwrap(), "6");
        assert_eq!(read_body_bytes(resp).await, Bytes::from_static(b"abcdef"));

        // CopyObject (COPY metadata directive)
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/test-bucket/dir/copied.txt",
                vec![(
                    "x-amz-copy-source",
                    "/test-bucket/dir/sub%20folder/file%2B1.txt",
                )],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let copy_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(copy_xml.contains("<CopyObjectResult"));

        // Verify copied object has original metadata
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::HEAD,
                "/test-bucket/dir/copied.txt",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("x-amz-meta-author").unwrap(),
            "Richard Hendricks"
        );

        // ListObjectsV2 with delimiter
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/test-bucket?list-type=2&prefix=dir/&delimiter=/",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let list_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(list_xml.contains("<Key>dir/copied.txt</Key>"));
        assert!(list_xml.contains("<CommonPrefixes><Prefix>dir/sub folder/</Prefix></CommonPrefixes>"));

        // ListObjects v1 with marker
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/test-bucket?prefix=dir/&marker=dir/copied.txt",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let list_v1_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(list_v1_xml.contains("<Marker>dir/copied.txt</Marker>"));
        assert!(!list_v1_xml.contains("<Key>dir/copied.txt</Key>"));
        assert!(list_v1_xml.contains("<Key>dir/sub folder/file+1.txt</Key>"));

        // Batch DeleteObjects (POST /{bucket}?delete)
        let del_xml = r#"<Delete><Object><Key>dir/copied.txt</Key></Object><Object><Key>dir/sub folder/file+1.txt</Key></Object></Delete>"#;
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::POST,
                "/test-bucket?delete",
                vec![],
                del_xml,
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let del_res_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(del_res_xml.contains("<Deleted><Key>dir/copied.txt</Key></Deleted>"));
    }

    #[tokio::test]
    async fn test_multipart_upload_and_aws_chunked() {
        let (_dir, app, state) = test_setup();

        app.clone()
            .oneshot(build_signed_request(
                Method::PUT,
                "/mp-bucket",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();

        // 1. InitiateMultipartUpload
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::POST,
                "/mp-bucket/large.bin?uploads",
                vec![
                    ("content-type", "application/octet-stream"),
                    ("x-amz-meta-part-test", "yes"),
                ],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let init_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        let upload_id = init_xml
            .split("<UploadId>")
            .nth(1)
            .unwrap()
            .split("</UploadId>")
            .next()
            .unwrap()
            .to_string();

        // 2. UploadPart 1 (using aws-chunked encoding)
        let chunked_body = b"5;chunk-signature=aaaa\r\nhello\r\n6;chunk-signature=bbbb\r\n world\r\n0;chunk-signature=cccc\r\n\r\n";
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                &format!("/mp-bucket/large.bin?partNumber=1&uploadId={upload_id}"),
                vec![
                    (
                        "x-amz-content-sha256",
                        "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
                    ),
                    ("content-encoding", "aws-chunked"),
                ],
                Bytes::from_static(chunked_body),
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let etag1 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // 3. UploadPart 2 (standard body)
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::PUT,
                &format!("/mp-bucket/large.bin?partNumber=2&uploadId={upload_id}"),
                vec![],
                " - part two!",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let etag2 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // 4. ListParts
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                &format!("/mp-bucket/large.bin?uploadId={upload_id}"),
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let parts_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(parts_xml.contains("<PartNumber>1</PartNumber>"));
        assert!(parts_xml.contains("<PartNumber>2</PartNumber>"));

        // 5. CompleteMultipartUpload
        let complete_xml = format!(
            "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>{etag2}</ETag></Part></CompleteMultipartUpload>"
        );
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::POST,
                &format!("/mp-bucket/large.bin?uploadId={upload_id}"),
                vec![],
                complete_xml,
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let comp_res_xml = String::from_utf8(read_body_bytes(resp).await.to_vec()).unwrap();
        assert!(comp_res_xml.contains("<CompleteMultipartUploadResult"));

        // 6. Verify assembled object content and metadata
        let resp = app
            .clone()
            .oneshot(build_signed_request(
                Method::GET,
                "/mp-bucket/large.bin",
                vec![],
                "",
                &state.config,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get("x-amz-meta-part-test").unwrap(), "yes");
        assert_eq!(
            read_body_bytes(resp).await,
            Bytes::from_static(b"hello world - part two!")
        );
    }
}

