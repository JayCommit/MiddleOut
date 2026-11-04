# Middle Out

Single-node, S3-compatible object storage with a web console. Buckets are private until you mark them public.

## What you get

- **Console** — sign in, create buckets, upload and browse objects, issue share links, manage access keys, and read an activity log.
- **Public browser** — public buckets are listed at `/p/<bucket>`. Private buckets return nothing there.
- **S3 API** — path-style endpoint at `/api/s3` on the same origin. Works with the AWS CLI, rclone, boto3, and curl.
- **Auth for clients** — AWS Signature Version 4 (headers or a presigned query string), or `Authorization: MO <access-key>:<secret>` for simple curl.

Sign-in is for the console. S3 clients use an access key from **Access keys**, not the browser session.

## Limits

| | |
|---|---|
| Max object | 8 MB |
| Account quota | 64 MB |
| Upload | Single PUT and full S3 Multipart Upload API (up to 10,000 parts). |
| Addressing | Path-style only. No virtual-hosted bucket DNS. |
| Not in this version | Versioning, object lock, lifecycle, SSE. |

Object bytes live in Postgres as base64 parts, next to the metadata. Region names are labels clients can read back; there is one node.

## Run

Requires Node 22.

```bash
npm install
npm run dev
```

The dev server listens on port 8080. With no `DATABASE_URL`, it uses an embedded Postgres (PGLite) and applies `migrations/` on startup. Set `DATABASE_URL` to use a real Postgres database instead; `npm run build` runs the same migrations.

```bash
npm test
npm run typecheck
npm run build
```

## Talk to it

```bash
export AWS_ACCESS_KEY_ID=MO...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

aws s3 mb s3://photos --endpoint-url "$ORIGIN/api/s3"
aws s3 cp ./notes.txt s3://photos/notes.txt --endpoint-url "$ORIGIN/api/s3"
aws s3 ls s3://photos --endpoint-url "$ORIGIN/api/s3"
```

```bash
curl -H "Authorization: MO $AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "$ORIGIN/api/s3/photos/notes.txt" --upload-file notes.txt
```

rclone:

```ini
[middleout]
type = s3
provider = Other
access_key_id = MO...
secret_access_key = ...
endpoint = https://your-host/api/s3
force_path_style = true
```

`GET /api/health` returns `{ "ok": true }` when the database answers. `GET /api/metrics` is the metrics endpoint.

## API coverage

Supported: bucket create, delete, head, and list; bucket location, ACL, CORS, and policy; object put, get, head, delete, and copy; S3 Multipart Upload API (InitiateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads); Object Tagging (GET/PUT/DELETE ?tagging); ListObjects and ListObjectsV2 (prefix, delimiter, max-keys, continuation tokens); range and conditional reads (If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since); SigV4 and presigned URLs; the `MO` authorization header; access key scoping (Read-Only & Bucket restriction); rate limiting; aws-chunked bodies; public-read buckets; Prometheus metrics (/api/metrics).

## Layout

```text
src/routes/          pages and HTTP routes (console, /api/s3, public objects)
src/lib/s3/          SigV4 and the S3 request engine
src/lib/storage/     buckets, objects, keys, quota
migrations/          Postgres schema (auth, then storage)
```
