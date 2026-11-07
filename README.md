# MiddleOut

MiddleOut (`v1.0.0-rc1`) is a single-binary, self-hosted, S3-compatible object storage server written in Rust.

It serves a path-style S3 API (AWS Signature Version 4, presigned URLs, `ListObjectsV2`, multipart uploads, byte-range requests, and optional public-read buckets) alongside a server-rendered web console on a single port, backed by local filesystem blobs and an embedded SQLite metadata store.

## Quick Start

### Docker Compose (One-Liner)

```bash
docker compose up -d --build
```

Data persists in the `middleout-data` Docker volume mounted at `/data`. To customize credentials or ports before starting, copy `.env.example` to `.env`:

```bash
cp .env.example .env
docker compose up -d --build
```

### Run Locally with Cargo

Requires Rust (1.85+ / 2024 edition).

```bash
cargo run --release --bin middleout
```

Or build the standalone binary directly:

```bash
cargo build --release --bin middleout
./target/release/middleout
```

### Endpoints

- **S3 Endpoint**: `http://localhost:8080` (also accepts `http://localhost:8080/api/s3`)
- **Web Console**: `http://localhost:8080/_console` (visiting `http://localhost:8080` in a browser redirects here)
- **Public Bucket Browser**: `http://localhost:8080/_public/<bucket>`
- **Health Check**: `GET http://localhost:8080/health` (or `/api/health`) -> `{"status":"ok"}`

---

## Configuration

MiddleOut is configured via environment variables with sensible defaults:

| Variable | Fallback | Default | Description |
| :--- | :--- | :--- | :--- |
| `HOST` | `BIND_ADDRESS` | `0.0.0.0` | Bind address for the HTTP server |
| `PORT` | — | `8080` | HTTP listen port |
| `DATA_DIR` | — | `./data` | Directory for SQLite metadata and object blobs |
| `MIDDLEOUT_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | `middleout` | S3 Access Key ID |
| `MIDDLEOUT_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | `middleout-secret-key` | S3 Secret Access Key |
| `MIDDLEOUT_ADMIN_USER` | `MIDDLEOUT_ACCESS_KEY_ID` | *(same as access key)* | Web console login username |
| `MIDDLEOUT_ADMIN_PASSWORD` | `MIDDLEOUT_SECRET_ACCESS_KEY` | *(same as secret key)* | Web console login password |
| `MIDDLEOUT_REGION` | `AWS_DEFAULT_REGION` | `us-east-1` | S3 region name |
| `MAX_OBJECT_BYTES` | — | `1073741824` (1 GiB) | Max size in bytes per single `PutObject` or `UploadPart` request |

---

## Bucket Visibility & Access Control

- **Private by default**: Newly created buckets reject all unauthenticated requests with `403 AccessDenied`.
- **Optional public-read**: A bucket can be made public-read in two ways:
  1. Via S3 API at creation time using the `x-amz-acl: public-read` header (`aws s3api create-bucket --bucket my-public-bucket --acl public-read`).
  2. Via the Web Console (`/_console`) by clicking **Make Public** (or **Make Private** to revoke) on any bucket.
- **Public-read scope**: When a bucket is marked `public-read`:
  - Anonymous S3 `GET /{bucket}/{key}` and `HEAD /{bucket}/{key}` are allowed.
  - Anonymous S3 bucket listing (`GET /{bucket}`) and all write/delete operations remain forbidden (`403 AccessDenied`).
  - Anonymous users can browse and download files via the web UI at `/_public/{bucket}`.

---

## Minimal Web Console

Open `http://localhost:8080/_console` in your browser and sign in with `MIDDLEOUT_ADMIN_USER` and `MIDDLEOUT_ADMIN_PASSWORD` (which default to `MIDDLEOUT_ACCESS_KEY_ID` and `MIDDLEOUT_SECRET_ACCESS_KEY`).

Console capabilities:
- View all buckets, object counts, total storage bytes, creation timestamps, and visibility status.
- Create and delete buckets, or toggle a bucket between **Private** and **Public**.
- Browse objects by `/` prefix, upload files via multipart form, download objects, and delete objects.
- Browse public buckets without logging in at `http://localhost:8080/_public/{bucket}`.

---

## Connecting S3 Clients

MiddleOut uses **path-style** S3 addressing (`http://localhost:8080/{bucket}/{key}`) and **AWS Signature Version 4** (`AWS4-HMAC-SHA256`).

### AWS CLI

```bash
export AWS_ACCESS_KEY_ID="middleout"
export AWS_SECRET_ACCESS_KEY="middleout-secret-key"
export AWS_DEFAULT_REGION="us-east-1"

# Create a private bucket
aws --endpoint-url http://localhost:8080 s3 mb s3://my-bucket

# Create a public-read bucket
aws --endpoint-url http://localhost:8080 s3api create-bucket --bucket pub-assets --acl public-read

# Upload, list, range-read, and download objects
aws --endpoint-url http://localhost:8080 s3 cp ./README.md s3://my-bucket/docs/README.md
aws --endpoint-url http://localhost:8080 s3 ls s3://my-bucket/docs/
aws --endpoint-url http://localhost:8080 s3 cp s3://my-bucket/docs/README.md ./README.copy.md

# Delete object and bucket
aws --endpoint-url http://localhost:8080 s3 rm s3://my-bucket/docs/README.md
aws --endpoint-url http://localhost:8080 s3 rb s3://my-bucket
```

### Python (`boto3`)

```python
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:8080",
    aws_access_key_id="middleout",
    aws_secret_access_key="middleout-secret-key",
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

s3.create_bucket(Bucket="demo")
s3.put_object(Bucket="demo", Key="hello.txt", Body=b"Hello from MiddleOut!")

resp = s3.get_object(Bucket="demo", Key="hello.txt")
print(resp["Body"].read().decode())

# Generate a presigned GET URL
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "demo", "Key": "hello.txt"},
    ExpiresIn=3600,
)
print("Presigned URL:", url)
```

### `rclone`

Configure a remote in `~/.config/rclone/rclone.conf`:

```ini
[middleout]
type = s3
provider = Other
access_key_id = middleout
secret_access_key = middleout-secret-key
region = us-east-1
endpoint = http://localhost:8080
force_path_style = true
```

Run commands:

```bash
rclone mkdir middleout:backups
rclone sync ./docs middleout:backups/docs
rclone ls middleout:backups
```

### MinIO Client (`mc`)

```bash
mc alias set middleout http://localhost:8080 middleout middleout-secret-key --api S3v4
mc mb middleout/artifacts
mc cp ./README.md middleout/artifacts/
mc ls middleout/artifacts
```

---

## Data Directory Layout

All state lives inside `DATA_DIR` (default `./data`, or `/data` in Docker):

```text
<DATA_DIR>/
├── metadata.db          # SQLite database (WAL mode) storing buckets, object metadata, and active multipart uploads
├── metadata.db-wal      # SQLite write-ahead log
├── metadata.db-shm      # SQLite shared-memory index
├── objects/
│   └── <bucket>/
│       └── <2-char-sha256-shard>/
│           └── <uuid>.blob   # Raw object payload bytes
├── multipart/
│   └── <upload_id>/
│       └── part-<N>-<uuid>.blob  # Uploaded multipart part blobs prior to completion
└── staging/
    └── tmp-<uuid>.blob  # Temporary staging files synced before atomic rename (swept on startup)
```

Why UUID blobs instead of raw key paths on disk? In S3, a bucket can hold both an object named `foo` and an object named `foo/bar` simultaneously. Mapping `(bucket, key)` in SQLite to sharded UUID blob files avoids POSIX file/directory collisions and path traversal while keeping every object as a plain, unencoded file on the local filesystem.

---

## Known Limitations (`v1.0.0-rc1`)

- **Single-node embedded architecture**: One `middleout` server process per `DATA_DIR`. No clustering, erasure coding, object versioning, or object lock.
- **In-memory payload buffering**: Single `PutObject`, `UploadPart`, and `GetObject` requests buffer payloads in memory up to `MAX_OBJECT_BYTES` (default `1 GiB`). Tune `MAX_OBJECT_BYTES` to match available host memory, and use multipart uploads for large objects.
- **Abandoned multipart uploads**: `AbortMultipartUpload` and `DeleteBucket` immediately remove staged part files, and `staging/` is cleaned on startup, but multipart uploads that a client initiates and never completes or aborts remain in `multipart/<upload_id>` until explicitly aborted via the S3 API.
- **`aws-chunked` per-chunk signatures**: `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` requests verify the SigV4 seed signature and validate the chunk framing through the terminal `0`-length chunk, but individual per-chunk trailer signatures are not re-verified.

---

## Development & Verification

```bash
# Run unit and integration tests across the workspace
cargo test --workspace

# Lint with Clippy
cargo clippy --workspace --all-targets -- -D warnings

# Run the end-to-end real-client smoke suite (AWS CLI, boto3, rclone, curl)
./scripts/smoke-test.sh
```

See [OPERATIONS.md](OPERATIONS.md) for deployment, backups, and reverse-proxy setup, [SECURITY.md](SECURITY.md) for security boundaries, [AGENTS.md](AGENTS.md) for repository architecture, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE)
