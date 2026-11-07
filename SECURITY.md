# Security Policy & Architecture

MiddleOut (`v1.0.0-rc1`) is designed with secure defaults for single-node, self-hosted S3 object storage.

## Trust Boundaries & Security Controls

### 1. S3 Authentication (AWS Signature Version 4)
- **Header & Presigned Auth**: All S3 requests are verified in [`crates/middleout-s3/src/sigv4.rs`](crates/middleout-s3/src/sigv4.rs) using constant-time HMAC-SHA256 comparisons.
- **Clock Skew & Replay Protection**:
  - Header-signed requests enforce a $\pm 15$-minute clock-skew window against UTC (`RequestTimeTooSkewed`) and verify that the credential scope date matches `x-amz-date` / `Date`.
  - Presigned URLs enforce `X-Amz-Expires` ($1\text{..=}604800$ seconds), reject timestamps more than 15 minutes in the future, and require `host` in `X-Amz-SignedHeaders`.
- **Payload Integrity**:
  - When `x-amz-content-sha256` contains a hex SHA-256 digest, it is verified against the request body before dispatching.
  - When `Content-MD5` is supplied on `PutObject`, `UploadPart`, or `DeleteObjects`, the base64-encoded MD5 digest is verified against the decoded payload (`BadDigest` on mismatch).
  - `aws-chunked` streaming uploads validate chunk framing and require a terminal `0`-size chunk.

### 2. Bucket & Object Authorization
- **Private by Default**: New buckets default to `public_read = false`. Unauthenticated requests to private or non-existent buckets always return `403 AccessDenied` (preventing bucket enumeration).
- **Scoped Public-Read**: Buckets explicitly marked `public-read` allow anonymous `GET /{bucket}/{key}` and `HEAD /{bucket}/{key}` (as well as browsing via `/_public/{bucket}`), while rejecting anonymous S3 `ListObjects`, `PutObject`, `DeleteObject`, and multipart operations with `403 AccessDenied`.
- **Same-Origin Isolation Headers**: All object download responses include `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff` so uploaded HTML/SVG objects cannot execute scripts in the origin of the web console.

### 3. Filesystem & Database Isolation
- **No Path Traversal**: S3 object keys are never used as filesystem paths. Every object and multipart part is stored under a generated UUID filename (`objects/{bucket}/{sha256_shard}/{uuid}.blob`) and mapped via parameterized SQLite queries. Bucket names and `upload_id` values are strictly validated before any path construction.
- **No Secret Leakage**: `AppConfig` redacts `secret_access_key` and `admin_password` in its `Debug` implementation, and internal SQLite/IO error details are logged server-side rather than echoed in HTTP 500 responses.

### 4. Web Console Session Security
- Admin login verifies credentials in constant time and issues an HMAC-SHA256 signed session cookie (`middleout_session`) with `HttpOnly; SameSite=Lax; Path=/` and a 7-day expiration.
- All state-changing `POST` endpoints in `/_console` verify both the session cookie and `Origin` / `Host` header alignment (`verify_same_origin`).

## Production Recommendations

1. **Change Default Credentials**: Always override `MIDDLEOUT_ACCESS_KEY_ID` and `MIDDLEOUT_SECRET_ACCESS_KEY` with high-entropy secrets before exposing the server.
2. **Use TLS**: Terminate HTTPS in front of MiddleOut using a reverse proxy (Caddy, Nginx, or Traefik) when accessing the S3 API or Web Console over untrusted networks.
3. **Restrict Network Binding**: When running behind a local reverse proxy, set `HOST=127.0.0.1` so port `8080` is not directly reachable from external interfaces.
