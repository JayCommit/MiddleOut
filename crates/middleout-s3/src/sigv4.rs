use crate::error::S3Error;
use crate::S3Config;
use axum::http::{HeaderMap, Method, Uri};
use bytes::{Bytes, BytesMut};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use hmac::{Hmac, Mac};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// RFC 3986 unreserved characters: A-Z, a-z, 0-9, '-', '_', '.', '~'
const S3_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Authenticated { access_key_id: String },
    Anonymous,
}

/// URI-encode a string according to S3 SigV4 rules (RFC 3986 unreserved chars left unencoded).
pub fn s3_uri_encode(input: &str, encode_slash: bool) -> String {
    if encode_slash {
        utf8_percent_encode(input, S3_ENCODE_SET).to_string()
    } else {
        input
            .split('/')
            .map(|seg| utf8_percent_encode(seg, S3_ENCODE_SET).to_string())
            .collect::<Vec<_>>()
            .join("/")
    }
}

/// Canonicalize the URI path by first percent-decoding each segment and then S3-URI-encoding it.
pub fn canonical_uri(path: &str) -> String {
    if path.is_empty() {
        return "/".to_string();
    }
    path.split('/')
        .map(|seg| {
            let decoded = percent_decode_str(seg).decode_utf8_lossy();
            utf8_percent_encode(&decoded, S3_ENCODE_SET).to_string()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Parse raw query string into decoded (key, value) pairs.
pub fn parse_query_params(raw_query: &str) -> Vec<(String, String)> {
    if raw_query.is_empty() {
        return Vec::new();
    }
    raw_query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (raw_k, raw_v) = match part.split_once('=') {
                Some((k, v)) => (k, v),
                None => (part, ""),
            };
            // In query strings, '+' can be encoded space or literal '+', standard form decoding or percent decoding:
            // AWS SigV4 treats '%20' and '+' in query parameters when form-encoded: replace '+' with ' ' before percent-decoding.
            let k_plus = raw_k.replace('+', " ");
            let v_plus = raw_v.replace('+', " ");
            let k = percent_decode_str(&k_plus).decode_utf8_lossy().into_owned();
            let v = percent_decode_str(&v_plus).decode_utf8_lossy().into_owned();
            (k, v)
        })
        .collect()
}

/// Build the CanonicalQueryString for SigV4.
/// If `exclude_signature` is true, `X-Amz-Signature` is omitted.
pub fn canonical_query_string(raw_query: &str, exclude_signature: bool) -> String {
    if raw_query.is_empty() {
        return String::new();
    }
    let mut encoded_pairs: Vec<(String, String)> = raw_query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (raw_k, raw_v) = match part.split_once('=') {
                Some((k, v)) => (k, v),
                None => (part, ""),
            };
            let decoded_k = percent_decode_str(raw_k).decode_utf8_lossy();
            if exclude_signature && decoded_k == "X-Amz-Signature" {
                return None;
            }
            let decoded_v = percent_decode_str(raw_v).decode_utf8_lossy();
            let enc_k = utf8_percent_encode(&decoded_k, S3_ENCODE_SET).to_string();
            let enc_v = utf8_percent_encode(&decoded_v, S3_ENCODE_SET).to_string();
            Some((enc_k, enc_v))
        })
        .collect();

    encoded_pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    encoded_pairs
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Collapse sequential spaces and trim leading/trailing whitespace for header values.
fn normalize_header_value(val: &str) -> String {
    let trimmed = val.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        if ch == ' ' || ch == '\t' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

/// Build CanonicalHeaders and SignedHeaders string from the signed headers list.
fn build_canonical_headers(
    signed_headers_list: &[String],
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<(String, String), S3Error> {
    let mut sorted_names: Vec<String> = signed_headers_list
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    sorted_names.sort();
    sorted_names.dedup();

    let mut canonical = String::new();
    for name in &sorted_names {
        let values: Vec<String> = headers
            .get_all(name.as_str())
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(normalize_header_value)
            .collect();

        let combined = if !values.is_empty() {
            values.join(",")
        } else if name == "host" {
            if let Some(auth) = uri.authority() {
                auth.as_str().to_string()
            } else {
                return Err(S3Error::access_denied("Missing required Host header in SignedHeaders"));
            }
        } else {
            return Err(S3Error::access_denied(format!(
                "Missing signed header: {name}"
            )));
        };

        canonical.push_str(name);
        canonical.push(':');
        canonical.push_str(&combined);
        canonical.push('\n');
    }

    let signed_headers_str = sorted_names.join(";");
    Ok((canonical, signed_headers_str))
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub fn derive_signing_key(secret: &str, date_stamp: &str, region: &str, service: &str) -> Vec<u8> {
    let k_secret = format!("AWS4{secret}");
    let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

pub fn compute_sigv4_signature(
    secret: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
    string_to_sign: &str,
) -> String {
    let signing_key = derive_signing_key(secret, date_stamp, region, service);
    let sig_bytes = hmac_sha256(&signing_key, string_to_sign.as_bytes());
    hex::encode(sig_bytes)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn parse_amz_date(date_str: &str) -> Result<DateTime<Utc>, S3Error> {
    if let Ok(naive) = NaiveDateTime::parse_from_str(date_str, "%Y%m%dT%H%M%SZ") {
        return Ok(Utc.from_utc_datetime(&naive));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(date_str) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(date_str) {
        return Ok(dt.with_timezone(&Utc));
    }
    Err(S3Error::access_denied(format!(
        "Invalid date format: {date_str}"
    )))
}

struct CredentialScope {
    access_key_id: String,
    date_stamp: String,
    region: String,
    service: String,
}

fn parse_credential_scope(cred: &str) -> Result<CredentialScope, S3Error> {
    let parts: Vec<&str> = cred.split('/').collect();
    if parts.len() != 5 || parts[4] != "aws4_request" {
        return Err(S3Error::access_denied(
            "Malformed Credential scope in authorization",
        ));
    }
    if parts[1].len() != 8 || !parts[1].chars().all(|c| c.is_ascii_digit()) {
        return Err(S3Error::access_denied("Invalid date stamp in Credential"));
    }
    if parts[3] != "s3" {
        return Err(S3Error::access_denied(format!(
            "Invalid service '{}' in Credential scope; expected 's3'",
            parts[3]
        )));
    }
    Ok(CredentialScope {
        access_key_id: parts[0].to_string(),
        date_stamp: parts[1].to_string(),
        region: parts[2].to_string(),
        service: parts[3].to_string(),
    })
}

/// Verify incoming S3 request authentication via Authorization header, Presigned URL, or Anonymous.
pub fn verify_request_auth(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    config: &S3Config,
) -> Result<AuthOutcome, S3Error> {
    if let Some(auth_val) = headers.get("authorization") {
        let auth_str = auth_val
            .to_str()
            .map_err(|_| S3Error::access_denied("Invalid Authorization header encoding"))?;
        return verify_header_auth(method, uri, headers, body, config, auth_str);
    }

    let raw_query = uri.query().unwrap_or("");
    if !raw_query.is_empty() {
        let params = parse_query_params(raw_query);
        let has_presigned_v4 = params.iter().any(|(k, _)| {
            k.eq_ignore_ascii_case("X-Amz-Algorithm")
                || k.eq_ignore_ascii_case("X-Amz-Credential")
                || k.eq_ignore_ascii_case("X-Amz-Signature")
        });
        if has_presigned_v4 {
            return verify_presigned_auth(method, uri, headers, config, &params);
        }
        let has_presigned_v2 = params
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("AWSAccessKeyId"));
        if has_presigned_v2 {
            return Err(S3Error::invalid_request(
                "AWS Signature Version 2 is not supported; please use AWS4-HMAC-SHA256",
            ));
        }
    }

    Ok(AuthOutcome::Anonymous)
}

fn verify_header_auth(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
    config: &S3Config,
    auth_str: &str,
) -> Result<AuthOutcome, S3Error> {
    let rest = auth_str
        .strip_prefix("AWS4-HMAC-SHA256")
        .ok_or_else(|| S3Error::invalid_request("Unsupported Authorization algorithm"))?
        .trim();

    let mut credential_val = None;
    let mut signed_headers_val = None;
    let mut signature_val = None;

    for part in rest.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(v) = part.strip_prefix("Credential=") {
            credential_val = Some(v.trim());
        } else if let Some(v) = part.strip_prefix("SignedHeaders=") {
            signed_headers_val = Some(v.trim());
        } else if let Some(v) = part.strip_prefix("Signature=") {
            signature_val = Some(v.trim());
        }
    }

    let credential_raw = credential_val
        .ok_or_else(|| S3Error::access_denied("Missing Credential in Authorization header"))?;
    let signed_headers_raw = signed_headers_val
        .ok_or_else(|| S3Error::access_denied("Missing SignedHeaders in Authorization header"))?;
    let signature_hex = signature_val
        .ok_or_else(|| S3Error::access_denied("Missing Signature in Authorization header"))?;

    let scope = parse_credential_scope(credential_raw)?;
    if scope.access_key_id != config.access_key_id {
        return Err(S3Error::invalid_access_key_id(
            "The AWS Access Key Id you provided does not exist in our records.",
        ));
    }

    let amz_date_str = headers
        .get("x-amz-date")
        .or_else(|| headers.get("date"))
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| S3Error::access_denied("Missing x-amz-date or Date header"))?;

    // Validate date format
    let _parsed_dt = parse_amz_date(amz_date_str)?;

    let signed_headers_list: Vec<String> = signed_headers_raw
        .split(';')
        .map(|s| s.to_string())
        .collect();
    let (canonical_headers, signed_headers) =
        build_canonical_headers(&signed_headers_list, headers, uri)?;

    // Determine HashedPayload
    let hashed_payload = if let Some(content_sha) =
        headers.get("x-amz-content-sha256").and_then(|v| v.to_str().ok())
    {
        if content_sha == "UNSIGNED-PAYLOAD" || content_sha.starts_with("STREAMING-") {
            content_sha.to_string()
        } else {
            let actual_hash = sha256_hex(body);
            if !actual_hash.eq_ignore_ascii_case(content_sha) {
                return Err(S3Error::content_sha256_mismatch(
                    "The provided 'x-amz-content-sha256' header does not match what was computed.",
                ));
            }
            content_sha.to_ascii_lowercase()
        }
    } else {
        sha256_hex(body)
    };

    let can_uri = canonical_uri(uri.path());
    let can_query = canonical_query_string(uri.query().unwrap_or(""), false);

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        can_uri,
        can_query,
        canonical_headers,
        signed_headers,
        hashed_payload
    );

    let scope_str = format!(
        "{}/{}/{}/aws4_request",
        scope.date_stamp, scope.region, scope.service
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date_str,
        scope_str,
        sha256_hex(canonical_request.as_bytes())
    );

    let expected_sig = compute_sigv4_signature(
        &config.secret_access_key,
        &scope.date_stamp,
        &scope.region,
        &scope.service,
        &string_to_sign,
    );

    let sig_lower = signature_hex.to_ascii_lowercase();
    if !constant_time_eq(expected_sig.as_bytes(), sig_lower.as_bytes()) {
        return Err(S3Error::signature_does_not_match(
            "The request signature we calculated does not match the signature you provided.",
        ));
    }

    Ok(AuthOutcome::Authenticated {
        access_key_id: scope.access_key_id,
    })
}

fn verify_presigned_auth(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    config: &S3Config,
    params: &[(String, String)],
) -> Result<AuthOutcome, S3Error> {
    let get_param = |name: &str| -> Option<&str> {
        params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };

    let algo = get_param("X-Amz-Algorithm")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-Algorithm query parameter"))?;
    if algo != "AWS4-HMAC-SHA256" {
        return Err(S3Error::invalid_argument(
            "Unsupported X-Amz-Algorithm; expected AWS4-HMAC-SHA256",
        ));
    }

    let credential_raw = get_param("X-Amz-Credential")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-Credential query parameter"))?;
    let amz_date_str = get_param("X-Amz-Date")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-Date query parameter"))?;
    let expires_str = get_param("X-Amz-Expires")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-Expires query parameter"))?;
    let signed_headers_raw = get_param("X-Amz-SignedHeaders")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-SignedHeaders query parameter"))?;
    let signature_hex = get_param("X-Amz-Signature")
        .ok_or_else(|| S3Error::access_denied("Missing X-Amz-Signature query parameter"))?;

    let scope = parse_credential_scope(credential_raw)?;
    if scope.access_key_id != config.access_key_id {
        return Err(S3Error::invalid_access_key_id(
            "The AWS Access Key Id you provided does not exist in our records.",
        ));
    }

    let expires_secs: i64 = expires_str
        .parse()
        .map_err(|_| S3Error::invalid_argument("Invalid X-Amz-Expires value"))?;
    if !(1..=604800).contains(&expires_secs) {
        return Err(S3Error::invalid_argument(
            "X-Amz-Expires must be between 1 and 604800 seconds",
        ));
    }

    let signed_at = parse_amz_date(amz_date_str)?;
    let now = Utc::now();
    if signed_at > now + chrono::Duration::minutes(5) {
        return Err(S3Error::access_denied("Request date is too far in the future"));
    }
    let expires_at = signed_at + chrono::Duration::seconds(expires_secs);
    if now > expires_at {
        return Err(S3Error::access_denied("Request has expired"));
    }

    let signed_headers_list: Vec<String> = signed_headers_raw
        .split(';')
        .map(|s| s.to_string())
        .collect();
    let (canonical_headers, signed_headers) =
        build_canonical_headers(&signed_headers_list, headers, uri)?;

    let hashed_payload = headers
        .get("x-amz-content-sha256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("UNSIGNED-PAYLOAD");

    let can_uri = canonical_uri(uri.path());
    let can_query = canonical_query_string(uri.query().unwrap_or(""), true);

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        can_uri,
        can_query,
        canonical_headers,
        signed_headers,
        hashed_payload
    );

    let scope_str = format!(
        "{}/{}/{}/aws4_request",
        scope.date_stamp, scope.region, scope.service
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date_str,
        scope_str,
        sha256_hex(canonical_request.as_bytes())
    );

    let expected_sig = compute_sigv4_signature(
        &config.secret_access_key,
        &scope.date_stamp,
        &scope.region,
        &scope.service,
        &string_to_sign,
    );

    let sig_lower = signature_hex.to_ascii_lowercase();
    if !constant_time_eq(expected_sig.as_bytes(), sig_lower.as_bytes()) {
        return Err(S3Error::signature_does_not_match(
            "The request signature we calculated does not match the signature you provided.",
        ));
    }

    Ok(AuthOutcome::Authenticated {
        access_key_id: scope.access_key_id,
    })
}

/// Decodes an `aws-chunked` body if indicated by `x-amz-content-sha256` (`STREAMING-...`)
/// or `content-encoding` containing `aws-chunked`.
/// Otherwise returns `raw_body` unchanged.
pub fn decode_payload_if_aws_chunked(
    headers: &HeaderMap,
    raw_body: Bytes,
) -> Result<Bytes, S3Error> {
    let is_streaming_sha = headers
        .get("x-amz-content-sha256")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.starts_with("STREAMING-"))
        .unwrap_or(false);

    let is_aws_chunked_encoding = headers
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("aws-chunked"))
        .unwrap_or(false);

    if !is_streaming_sha && !is_aws_chunked_encoding {
        return Ok(raw_body);
    }

    decode_aws_chunked_bytes(&raw_body)
}

fn decode_aws_chunked_bytes(input: &[u8]) -> Result<Bytes, S3Error> {
    let mut out = BytesMut::with_capacity(input.len());
    let mut pos = 0;

    while pos < input.len() {
        // Find \r\n for the chunk header line
        let line_end = input[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| S3Error::invalid_request("Malformed aws-chunked header line"))?;

        let header_line = std::str::from_utf8(&input[pos..pos + line_end])
            .map_err(|_| S3Error::invalid_request("Invalid UTF-8 in aws-chunked header"))?;

        let size_hex = header_line
            .split(';')
            .next()
            .unwrap_or("")
            .trim();

        let chunk_size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| S3Error::invalid_request("Invalid hex chunk size in aws-chunked body"))?;

        pos += line_end + 2; // skip header line and \r\n

        if chunk_size == 0 {
            // Final 0-byte chunk reached; remaining bytes are optional trailers + \r\n
            break;
        }

        if pos + chunk_size > input.len() {
            return Err(S3Error::invalid_request(
                "Truncated aws-chunked data payload",
            ));
        }

        out.extend_from_slice(&input[pos..pos + chunk_size]);
        pos += chunk_size;

        // Expect trailing \r\n after chunk data
        if pos + 2 > input.len() || &input[pos..pos + 2] != b"\r\n" {
            return Err(S3Error::invalid_request(
                "Missing CRLF after aws-chunked data block",
            ));
        }
        pos += 2;
    }

    Ok(out.freeze())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, Method, Uri};

    fn test_config() -> S3Config {
        S3Config {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
            region: "us-east-1".to_string(),
            max_object_bytes: 10 * 1024 * 1024,
        }
    }

    fn sign_header_request(
        method: &Method,
        uri: &Uri,
        headers: &mut HeaderMap,
        body: &[u8],
        config: &S3Config,
        amz_date: &str,
        date_stamp: &str,
        region: &str,
    ) {
        let payload_hash = sha256_hex(body);
        headers.insert(
            "x-amz-date",
            HeaderValue::from_str(amz_date).unwrap(),
        );
        headers.insert(
            "x-amz-content-sha256",
            HeaderValue::from_str(&payload_hash).unwrap(),
        );
        if !headers.contains_key("host") {
            headers.insert("host", HeaderValue::from_static("localhost:9000"));
        }

        let signed_headers_list = vec![
            "host".to_string(),
            "x-amz-content-sha256".to_string(),
            "x-amz-date".to_string(),
        ];
        let (can_headers, signed_headers) =
            build_canonical_headers(&signed_headers_list, headers, uri).unwrap();
        let can_uri = canonical_uri(uri.path());
        let can_query = canonical_query_string(uri.query().unwrap_or(""), false);

        let canonical_req = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            can_uri,
            can_query,
            can_headers,
            signed_headers,
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
            config.access_key_id, scope, signed_headers, sig
        );
        headers.insert("authorization", HeaderValue::from_str(&auth_val).unwrap());
    }

    #[test]
    fn test_anonymous_request() {
        let cfg = test_config();
        let uri: Uri = "/my-bucket/key.txt".parse().unwrap();
        let headers = HeaderMap::new();
        let res = verify_request_auth(&Method::GET, &uri, &headers, b"", &cfg).unwrap();
        assert_eq!(res, AuthOutcome::Anonymous);
    }

    #[test]
    fn test_valid_header_sigv4_and_special_chars() {
        let cfg = test_config();
        let uri: Uri =
            "/my-bucket/folder/hello%20world+test.txt?list-type=2&prefix=folder%2F".parse().unwrap();
        let mut headers = HeaderMap::new();
        let body = b"hello world payload";
        sign_header_request(
            &Method::PUT,
            &uri,
            &mut headers,
            body,
            &cfg,
            "20261107T013000Z",
            "20261107",
            "us-east-1",
        );

        let res = verify_request_auth(&Method::PUT, &uri, &headers, body, &cfg).unwrap();
        assert_eq!(
            res,
            AuthOutcome::Authenticated {
                access_key_id: cfg.access_key_id
            }
        );
    }

    #[test]
    fn test_header_sigv4_wrong_signature() {
        let cfg = test_config();
        let uri: Uri = "/my-bucket/key.txt".parse().unwrap();
        let mut headers = HeaderMap::new();
        sign_header_request(
            &Method::GET,
            &uri,
            &mut headers,
            b"",
            &cfg,
            "20261107T013000Z",
            "20261107",
            "us-east-1",
        );
        // Tamper with authorization signature
        let bad_auth = headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .replace("Signature=", "Signature=0000");
        headers.insert("authorization", HeaderValue::from_str(&bad_auth).unwrap());

        let err = verify_request_auth(&Method::GET, &uri, &headers, b"", &cfg).unwrap_err();
        assert_eq!(err.code, "SignatureDoesNotMatch");
        assert_eq!(err.status, axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn test_header_sigv4_wrong_access_key() {
        let cfg = test_config();
        let mut wrong_cfg = cfg.clone();
        wrong_cfg.access_key_id = "WRONGKEY".to_string();

        let uri: Uri = "/my-bucket/key.txt".parse().unwrap();
        let mut headers = HeaderMap::new();
        sign_header_request(
            &Method::GET,
            &uri,
            &mut headers,
            b"",
            &wrong_cfg,
            "20261107T013000Z",
            "20261107",
            "us-east-1",
        );

        let err = verify_request_auth(&Method::GET, &uri, &headers, b"", &cfg).unwrap_err();
        assert_eq!(err.code, "InvalidAccessKeyId");
        assert_eq!(err.status, axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn test_header_sigv4_payload_hash_mismatch() {
        let cfg = test_config();
        let uri: Uri = "/my-bucket/key.txt".parse().unwrap();
        let mut headers = HeaderMap::new();
        sign_header_request(
            &Method::PUT,
            &uri,
            &mut headers,
            b"original body",
            &cfg,
            "20261107T013000Z",
            "20261107",
            "us-east-1",
        );

        let err =
            verify_request_auth(&Method::PUT, &uri, &headers, b"tampered body", &cfg).unwrap_err();
        assert_eq!(err.code, "XAmzContentSHA256Mismatch");
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_presigned_url_valid_and_expired_and_tampered() {
        let cfg = test_config();
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();

        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("localhost:9000"));

        let cred = format!("{}/{}/us-east-1/s3/aws4_request", cfg.access_key_id, date_stamp);
        let query_without_sig = format!(
            "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={}&X-Amz-Date={}&X-Amz-Expires=300&X-Amz-SignedHeaders=host",
            s3_uri_encode(&cred, true),
            amz_date
        );

        let path = "/my-bucket/presigned-obj.txt";
        let can_uri = canonical_uri(path);
        let can_query = canonical_query_string(&query_without_sig, true);
        let can_req = format!(
            "GET\n{}\n{}\nhost:localhost:9000\n\nhost\nUNSIGNED-PAYLOAD",
            can_uri, can_query
        );
        let scope = format!("{date_stamp}/us-east-1/s3/aws4_request");
        let sts = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            scope,
            sha256_hex(can_req.as_bytes())
        );
        let sig = compute_sigv4_signature(&cfg.secret_access_key, &date_stamp, "us-east-1", "s3", &sts);

        let full_uri: Uri = format!("{path}?{query_without_sig}&X-Amz-Signature={sig}")
            .parse()
            .unwrap();
        let res = verify_request_auth(&Method::GET, &full_uri, &headers, b"", &cfg).unwrap();
        assert_eq!(
            res,
            AuthOutcome::Authenticated {
                access_key_id: cfg.access_key_id.clone()
            }
        );

        // Tampered parameter (e.g. X-Amz-Expires=600)
        let tampered_uri: Uri = full_uri
            .to_string()
            .replace("X-Amz-Expires=300", "X-Amz-Expires=600")
            .parse()
            .unwrap();
        let err = verify_request_auth(&Method::GET, &tampered_uri, &headers, b"", &cfg).unwrap_err();
        assert_eq!(err.code, "SignatureDoesNotMatch");

        // Expired presigned URL (signed 1 hour ago with 60s expiry)
        let past = now - chrono::Duration::hours(1);
        let past_amz_date = past.format("%Y%m%dT%H%M%SZ").to_string();
        let past_date_stamp = past.format("%Y%m%d").to_string();
        let past_cred = format!(
            "{}/{}/us-east-1/s3/aws4_request",
            cfg.access_key_id, past_date_stamp
        );
        let expired_uri: Uri = format!(
            "{path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential={}&X-Amz-Date={}&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature={sig}",
            s3_uri_encode(&past_cred, true),
            past_amz_date
        )
        .parse()
        .unwrap();
        let err = verify_request_auth(&Method::GET, &expired_uri, &headers, b"", &cfg).unwrap_err();
        assert_eq!(err.code, "AccessDenied");
    }

    #[test]
    fn test_decode_aws_chunked() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-amz-content-sha256",
            HeaderValue::from_static("STREAMING-AWS4-HMAC-SHA256-PAYLOAD"),
        );

        let chunked = b"5;chunk-signature=deadbeef\r\nhello\r\n6;chunk-signature=cafebabe\r\n world\r\n0;chunk-signature=0000\r\n\r\n";
        let decoded = decode_payload_if_aws_chunked(&headers, Bytes::from_static(chunked)).unwrap();
        assert_eq!(&decoded[..], b"hello world");

        // Non-chunked passthrough
        let normal_headers = HeaderMap::new();
        let raw = Bytes::from_static(b"raw payload");
        let passthrough = decode_payload_if_aws_chunked(&normal_headers, raw.clone()).unwrap();
        assert_eq!(passthrough, raw);
    }
}
