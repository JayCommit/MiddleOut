# Changelog

## v1.0.0-rc1 (2026-11-07)

Complete clean-room rewrite of **MiddleOut** in Rust as a lean, single-binary, self-hosted S3-compatible object storage server.

### Highlights

- **Single-Binary Rust Workspace**:
  - Replaced the legacy Node.js/TypeScript stack with a 3-crate Rust workspace (`middleout-storage`, `middleout-s3`, `middleout-server`) compiling to a single `middleout` binary.
- **Storage & Metadata Engine (`middleout-storage`)**:
  - Embedded SQLite metadata store (`metadata.db` in WAL mode) paired with sharded local filesystem blob storage (`objects/<bucket>/<shard>/<uuid>.blob`), avoiding POSIX file/directory collisions when object keys share prefixes.
  - Atomic writes via `staging/` temporary files with `sync_all()` + `rename`, plus automatic startup cleanup of leftover staging files.
  - Full `ListObjectsV2` (and `ListObjects` v1) implementation with `prefix`, `delimiter`, `CommonPrefixes`, `start-after`, and base64 `continuation-token` pagination.
  - Byte-range `GetObject` support (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`) and `Content-MD5` checksum verification.
  - Full multipart upload lifecycle (`InitiateMultipartUpload`, `UploadPart`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`) with composite `hex-N` ETag calculation.
- **S3 Protocol & SigV4 (`middleout-s3`)**:
  - Path-style S3 routing at `/` (and `/api/s3`) verified against AWS CLI, Python `boto3`, `rclone`, and MinIO Client (`mc`).
  - AWS Signature Version 4 verification for `Authorization` headers and presigned URLs (`X-Amz-Signature`), plus `aws-chunked` streaming payload decoding.
  - Private-by-default buckets with optional `public-read` ACL allowing anonymous `GET`/`HEAD` on objects while rejecting unauthenticated writes and bucket listings.
- **Web Console & Docker (`middleout-server`)**:
  - Built-in server-rendered Web Console at `/_console` with HMAC-SHA256 signed session cookies, bucket creation/deletion, public/private visibility toggles, and folder/object browser with file upload/download.
  - Anonymous public bucket browser at `/_public/{bucket}`.
  - Multi-stage `Dockerfile` and one-command `compose.yaml`.

### Security & Correctness Hardening

- Enforced $\pm 15$-minute clock-skew validation (`RequestTimeTooSkewed`), credential scope date matching, and required `host` in `SignedHeaders` for SigV4 requests.
- Enforced terminal `0`-size chunk verification and checked arithmetic in `aws-chunked` payload decoding.
- Added `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff` headers on object downloads to prevent same-origin script execution from uploaded HTML/SVG files.
- Added `Origin`/`Host` CSRF validation on console `POST` handlers, redacted secrets in `AppConfig` `Debug` output, and sanitized internal 500 error responses.
- Validated `upload_id` characters before filesystem path construction and ensured failed staging writes immediately unlink temporary files.
