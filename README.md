# MiddleOut

**MiddleOut** is a lightweight, single-binary, S3-compatible object storage server written in Rust.

It pairs a fast, path-style S3 API (supporting AWS Signature Version 4, presigned URLs, multipart uploads, byte-range requests, and public-read buckets) with a clean, zero-dependency, server-rendered Web Console—all served on a single port and backed by local disk + SQLite.

---

## Features

- **Single Binary, Single Port**: Serves both the Path-Style S3 API (`/`) and the Minimal Web Console (`/_console`) on port `8080`.
- **Standard S3 Compatibility**:
  - Bucket operations: `ListBuckets`, `CreateBucket`, `DeleteBucket`, `HeadBucket`, `GetBucketLocation`
  - Object operations: `PutObject`, `GetObject` (including `Range: bytes=...`), `HeadObject`, `DeleteObject`, `DeleteObjects` (batch delete), `CopyObject`
  - Listing: `ListObjectsV2` and `ListObjects` (v1) with `prefix`, `delimiter`, `max-keys`, `continuation-token`, and `start-after`
  - Multipart uploads: `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`, `ListMultipartUploads`
  - Authentication: AWS Signature Version 4 (`Authorization: AWS4-HMAC-SHA256`), Presigned URLs (`X-Amz-Signature`), `aws-chunked` streaming payload decoding, and anonymous read access for public buckets
- **Minimal Built-in Web Console**:
  - Server-rendered HTML/CSS with zero external JS/CSS CDN dependencies
  - Create/delete buckets, toggle bucket visibility (`Private` / `Public`), browse folders/prefixes, upload files via browser, download objects, and delete objects
  - Built-in anonymous file browser at `/_public/{bucket}` for public buckets
- **Simple, Inspectable Storage**:
  - Metadata stored in SQLite (`WAL` mode) at `<DATA_DIR>/metadata.sqlite3`
  - Object payloads stored atomically on the local filesystem

---

## Quick Start

### 1. Run with Docker Compose (Recommended)

```bash
cp .env.example .env
docker compose up -d --build
```

- **S3 Endpoint**: `http://localhost:8080` (also accessible at `http://localhost:8080/api/s3`)
- **Web Console**: `http://localhost:8080` (or `http://localhost:8080/_console`)
- **Health Check**: `http://localhost:8080/health`

### 2. Run from Source with Cargo

```bash
cargo run --release --bin middleout
```

---

## Configuration (Environment Variables)

| Variable | Fallback | Default | Description |
| :--- | :--- | :--- | :--- |
| `HOST` | `BIND_ADDRESS` | `0.0.0.0` | Address to bind the HTTP server to |
| `PORT` | — | `8080` | Port to listen on |
| `DATA_DIR` | — | `./data` | Directory for SQLite metadata and object blobs |
| `MIDDLEOUT_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | `middleout` | S3 Access Key ID |
| `MIDDLEOUT_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | `middleout-secret-key` | S3 Secret Access Key |
| `MIDDLEOUT_ADMIN_USER` | `MIDDLEOUT_ACCESS_KEY_ID` | *(same as access key)* | Web Console login username |
| `MIDDLEOUT_ADMIN_PASSWORD` | `MIDDLEOUT_SECRET_ACCESS_KEY` | *(same as secret key)* | Web Console login password |
| `MIDDLEOUT_REGION` | `AWS_DEFAULT_REGION` | `us-east-1` | S3 region name |
| `MAX_OBJECT_BYTES` | — | `1073741824` (1 GiB) | Maximum size in bytes per single object upload or part |

---

## Web Console & Public Buckets

Open **`http://localhost:8080`** in your browser. It automatically redirects to **`http://localhost:8080/_console`**, where you can sign in using your `MIDDLEOUT_ACCESS_KEY_ID` and `MIDDLEOUT_SECRET_ACCESS_KEY`.

From the console you can:
1. Create buckets and toggle them between **Private** and **Public**.
2. Browse folders (`/`-delimited prefixes), upload files, download objects, and delete objects.
3. Share public buckets via:
   - **Public Browser UI**: `http://localhost:8080/_public/<bucket>`
   - **Direct Object URL**: `http://localhost:8080/<bucket>/<key>`

---

## Using S3 Clients

### AWS CLI

```bash
export AWS_ACCESS_KEY_ID="middleout"
export AWS_SECRET_ACCESS_KEY="middleout-secret-key"
export AWS_DEFAULT_REGION="us-east-1"

# Create a bucket
aws --endpoint-url http://localhost:8080 s3 mb s3://my-bucket

# Upload a file
aws --endpoint-url http://localhost:8080 s3 cp ./README.md s3://my-bucket/docs/README.md

# List buckets and objects
aws --endpoint-url http://localhost:8080 s3 ls
aws --endpoint-url http://localhost:8080 s3 ls s3://my-bucket/docs/

# Download a file
aws --endpoint-url http://localhost:8080 s3 cp s3://my-bucket/docs/README.md ./downloaded.md
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
    config=Config(s3={"addressing_style": "path"}),
)

s3.create_bucket(Bucket="demo")
s3.put_object(Bucket="demo", Key="hello.txt", Body=b"Hello from MiddleOut!")
obj = s3.get_object(Bucket="demo", Key="hello.txt")
print(obj["Body"].read().decode())

# Generate a presigned download URL
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "demo", "Key": "hello.txt"},
    ExpiresIn=3600,
)
print("Presigned URL:", url)
```

### `rclone`

Add a remote in `~/.config/rclone/rclone.conf`:

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

Then run:

```bash
rclone mkdir middleout:backups
rclone copy ./README.md middleout:backups/
rclone ls middleout:backups
```

### MinIO Client (`mc`)

```bash
mc alias set middleout http://localhost:8080 middleout middleout-secret-key --api S3v4
mc mb middleout/assets
mc cp ./README.md middleout/assets/
mc ls middleout/assets
```

---

## License

MIT
