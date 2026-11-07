#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
PORT="${SMOKE_PORT:-18080}"
ENDPOINT="http://127.0.0.1:${PORT}"

export MIDDLEOUT_ACCESS_KEY_ID="smoke-access-key"
export MIDDLEOUT_SECRET_ACCESS_KEY="smoke-secret-key"
export MIDDLEOUT_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="${MIDDLEOUT_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${MIDDLEOUT_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="${MIDDLEOUT_REGION}"
export AWS_EC2_METADATA_DISABLED="true"

cleanup() {
    if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "==> Building MiddleOut binary..."
cargo build --manifest-path "${ROOT_DIR}/Cargo.toml" --bin middleout

echo "==> Starting MiddleOut server on ${ENDPOINT} (DATA_DIR=${TMP_DIR}/data)..."
HOST="127.0.0.1" PORT="${PORT}" DATA_DIR="${TMP_DIR}/data" \
    "${ROOT_DIR}/target/debug/middleout" >"${TMP_DIR}/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
    if curl -fsS "${ENDPOINT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 0.1
done
curl -fsS "${ENDPOINT}/health" | grep -q '"status":"ok"'
echo "    Health check passed."

echo "==> [1/4] Verifying with AWS CLI (aws s3 & aws s3api)..."
aws --endpoint-url "${ENDPOINT}" s3 mb s3://cli-private-bucket
aws --endpoint-url "${ENDPOINT}" s3 ls | grep -q "cli-private-bucket"

echo "Hello from AWS CLI!" > "${TMP_DIR}/hello.txt"
aws --endpoint-url "${ENDPOINT}" s3 cp "${TMP_DIR}/hello.txt" s3://cli-private-bucket/folder/hello.txt
aws --endpoint-url "${ENDPOINT}" s3 ls s3://cli-private-bucket/folder/ | grep -q "hello.txt"

aws --endpoint-url "${ENDPOINT}" s3 cp s3://cli-private-bucket/folder/hello.txt "${TMP_DIR}/hello-downloaded.txt"
diff -u "${TMP_DIR}/hello.txt" "${TMP_DIR}/hello-downloaded.txt"

# Range request via s3api get-object
aws --endpoint-url "${ENDPOINT}" s3api get-object \
    --bucket cli-private-bucket \
    --key folder/hello.txt \
    --range "bytes=0-4" \
    "${TMP_DIR}/hello-range.txt" >/dev/null
[[ "$(cat "${TMP_DIR}/hello-range.txt")" == "Hello" ]]

# Multipart upload via AWS CLI (create a 12MB file; default multipart threshold is 8MB)
dd if=/dev/urandom of="${TMP_DIR}/large.bin" bs=1M count=12 status=none
aws --endpoint-url "${ENDPOINT}" s3 cp "${TMP_DIR}/large.bin" s3://cli-private-bucket/large.bin
aws --endpoint-url "${ENDPOINT}" s3 cp s3://cli-private-bucket/large.bin "${TMP_DIR}/large-downloaded.bin"
cmp -s "${TMP_DIR}/large.bin" "${TMP_DIR}/large-downloaded.bin"

# Verify private bucket rejects anonymous GET
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${ENDPOINT}/cli-private-bucket/folder/hello.txt")
if [[ "${HTTP_CODE}" != "403" ]]; then
    echo "ERROR: Expected 403 for anonymous GET on private bucket, got ${HTTP_CODE}"
    exit 1
fi

# Create public bucket and verify anonymous GET succeeds while anonymous PUT is rejected
aws --endpoint-url "${ENDPOINT}" s3api create-bucket --bucket cli-public-bucket --acl public-read >/dev/null
aws --endpoint-url "${ENDPOINT}" s3 cp "${TMP_DIR}/hello.txt" s3://cli-public-bucket/public-hello.txt
PUBLIC_BODY=$(curl -fsS "${ENDPOINT}/cli-public-bucket/public-hello.txt")
[[ "${PUBLIC_BODY}" == "Hello from AWS CLI!" ]]
ANON_PUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT --data "anon" "${ENDPOINT}/cli-public-bucket/hack.txt")
if [[ "${ANON_PUT_CODE}" != "403" ]]; then
    echo "ERROR: Expected 403 for anonymous PUT on public bucket, got ${ANON_PUT_CODE}"
    exit 1
fi

# Delete objects & bucket via AWS CLI
aws --endpoint-url "${ENDPOINT}" s3 rm s3://cli-private-bucket/folder/hello.txt
aws --endpoint-url "${ENDPOINT}" s3 rm s3://cli-private-bucket/large.bin
aws --endpoint-url "${ENDPOINT}" s3 rb s3://cli-private-bucket
echo "    AWS CLI verification passed!"

echo "==> [2/4] Verifying with Python boto3 (CRUD, ListObjectsV2 pagination, Content-MD5, Range, Presigned URLs, Multipart)..."
python3 - <<'PY' "${ENDPOINT}" "${MIDDLEOUT_ACCESS_KEY_ID}" "${MIDDLEOUT_SECRET_ACCESS_KEY}" "${MIDDLEOUT_REGION}"
import sys, hashlib, base64, urllib.request, urllib.error
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

endpoint, access_key, secret_key, region = sys.argv[1:5]

s3 = boto3.client(
    "s3",
    endpoint_url=endpoint,
    aws_access_key_id=access_key,
    aws_secret_access_key=secret_key,
    region_name=region,
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

bucket = "boto3-test-bucket"
s3.create_bucket(Bucket=bucket)

# PutObject with Content-MD5 and custom metadata
payload = b"MiddleOut boto3 verification payload"
md5_b64 = base64.b64encode(hashlib.md5(payload).digest()).decode("ascii")
s3.put_object(
    Bucket=bucket,
    Key="docs/readme.txt",
    Body=payload,
    ContentType="text/plain",
    ContentMD5=md5_b64,
    Metadata={"author": "middleout", "env": "ci"},
)

# HeadObject
head = s3.head_object(Bucket=bucket, Key="docs/readme.txt")
assert head["ContentLength"] == len(payload)
assert head["ContentType"] == "text/plain"
assert head["Metadata"] == {"author": "middleout", "env": "ci"}

# Range GetObject
part_resp = s3.get_object(Bucket=bucket, Key="docs/readme.txt", Range="bytes=10-14")
assert part_resp["Body"].read() == b"boto3"

# Presigned GET and PUT URLs
presigned_get = s3.generate_presigned_url(
    "get_object", Params={"Bucket": bucket, "Key": "docs/readme.txt"}, ExpiresIn=300
)
with urllib.request.urlopen(presigned_get) as resp:
    assert resp.read() == payload

presigned_put = s3.generate_presigned_url(
    "put_object", Params={"Bucket": bucket, "Key": "docs/presigned.txt"}, ExpiresIn=300
)
req = urllib.request.Request(presigned_put, data=b"uploaded via presigned url", method="PUT")
with urllib.request.urlopen(req) as resp:
    assert resp.status == 200
assert s3.get_object(Bucket=bucket, Key="docs/presigned.txt")["Body"].read() == b"uploaded via presigned url"

# ListObjectsV2 with prefix, delimiter, and continuation tokens
for k in ["a/1.txt", "a/2.txt", "b/1.txt", "root1.txt", "root2.txt"]:
    s3.put_object(Bucket=bucket, Key=k, Body=k.encode())

delim_resp = s3.list_objects_v2(Bucket=bucket, Delimiter="/")
prefixes = sorted(p["Prefix"] for p in delim_resp.get("CommonPrefixes", []))
keys = sorted(c["Key"] for c in delim_resp.get("Contents", []))
assert prefixes == ["a/", "b/", "docs/"], f"Unexpected prefixes: {prefixes}"
assert keys == ["root1.txt", "root2.txt"], f"Unexpected keys: {keys}"

# Paginated listing (MaxKeys=2)
collected = []
token = None
while True:
    kwargs = {"Bucket": bucket, "MaxKeys": 2}
    if token:
        kwargs["ContinuationToken"] = token
    page = s3.list_objects_v2(**kwargs)
    collected.extend(c["Key"] for c in page.get("Contents", []))
    if page.get("IsTruncated"):
        token = page["NextContinuationToken"]
    else:
        break
assert len(collected) == 7, f"Expected 7 keys across pages, got {collected}"

# Explicit Multipart Upload (Initiate, UploadPart, ListParts, Complete, Abort)
mp = s3.create_multipart_upload(Bucket=bucket, Key="multipart/assembled.bin", ContentType="application/octet-stream")
upload_id = mp["UploadId"]
p1 = s3.upload_part(Bucket=bucket, Key="multipart/assembled.bin", UploadId=upload_id, PartNumber=1, Body=b"PART-ONE-")
p2 = s3.upload_part(Bucket=bucket, Key="multipart/assembled.bin", UploadId=upload_id, PartNumber=2, Body=b"PART-TWO")
parts_list = s3.list_parts(Bucket=bucket, Key="multipart/assembled.bin", UploadId=upload_id)
assert len(parts_list["Parts"]) == 2

s3.complete_multipart_upload(
    Bucket=bucket,
    Key="multipart/assembled.bin",
    UploadId=upload_id,
    MultipartUpload={
        "Parts": [
            {"PartNumber": 1, "ETag": p1["ETag"]},
            {"PartNumber": 2, "ETag": p2["ETag"]},
        ]
    },
)
assembled = s3.get_object(Bucket=bucket, Key="multipart/assembled.bin")["Body"].read()
assert assembled == b"PART-ONE-PART-TWO"

# Abort multipart upload
mp_abort = s3.create_multipart_upload(Bucket=bucket, Key="multipart/aborted.bin")
s3.upload_part(Bucket=bucket, Key="multipart/aborted.bin", UploadId=mp_abort["UploadId"], PartNumber=1, Body=b"temp")
s3.abort_multipart_upload(Bucket=bucket, Key="multipart/aborted.bin", UploadId=mp_abort["UploadId"])
try:
    s3.list_parts(Bucket=bucket, Key="multipart/aborted.bin", UploadId=mp_abort["UploadId"])
    raise AssertionError("Expected NoSuchUpload after abort")
except ClientError as e:
    assert e.response["Error"]["Code"] == "NoSuchUpload"

# Clean up bucket
for k in collected + ["multipart/assembled.bin"]:
    s3.delete_object(Bucket=bucket, Key=k)
s3.delete_bucket(Bucket=bucket)
PY
echo "    Python boto3 verification passed!"

echo "==> [3/4] Verifying with rclone..."
RCLONE_CONF="${TMP_DIR}/rclone.conf"
cat > "${RCLONE_CONF}" <<EOF
[middleout]
type = s3
provider = Other
access_key_id = ${MIDDLEOUT_ACCESS_KEY_ID}
secret_access_key = ${MIDDLEOUT_SECRET_ACCESS_KEY}
region = ${MIDDLEOUT_REGION}
endpoint = ${ENDPOINT}
force_path_style = true
EOF

mkdir -p "${TMP_DIR}/rclone-src/sub"
echo "rclone file 1" > "${TMP_DIR}/rclone-src/one.txt"
echo "rclone file 2" > "${TMP_DIR}/rclone-src/sub/two.txt"

rclone --config "${RCLONE_CONF}" mkdir middleout:rclone-bucket
rclone --config "${RCLONE_CONF}" sync "${TMP_DIR}/rclone-src" middleout:rclone-bucket/data
rclone --config "${RCLONE_CONF}" ls middleout:rclone-bucket/data | grep -q "one.txt"
rclone --config "${RCLONE_CONF}" ls middleout:rclone-bucket/data | grep -q "sub/two.txt"

rclone --config "${RCLONE_CONF}" copy middleout:rclone-bucket/data "${TMP_DIR}/rclone-dst"
diff -u "${TMP_DIR}/rclone-src/one.txt" "${TMP_DIR}/rclone-dst/one.txt"
diff -u "${TMP_DIR}/rclone-src/sub/two.txt" "${TMP_DIR}/rclone-dst/sub/two.txt"
rclone --config "${RCLONE_CONF}" purge middleout:rclone-bucket
echo "    rclone verification passed!"

echo "==> [4/4] Verifying Minimal Web Console & Public Bucket Browser..."
COOKIE_JAR="${TMP_DIR}/cookies.txt"
curl -fsS -c "${COOKIE_JAR}" -X POST "${ENDPOINT}/_console/login" \
    -d "username=${MIDDLEOUT_ACCESS_KEY_ID}&password=${MIDDLEOUT_SECRET_ACCESS_KEY}" >/dev/null

DASHBOARD_HTML=$(curl -fsS -b "${COOKIE_JAR}" "${ENDPOINT}/_console")
echo "${DASHBOARD_HTML}" | grep -q "cli-public-bucket"

PUBLIC_BROWSER_HTML=$(curl -fsS "${ENDPOINT}/_public/cli-public-bucket")
echo "${PUBLIC_BROWSER_HTML}" | grep -q "public-hello.txt"
echo "    Minimal Web Console & Public Bucket Browser verification passed!"

echo "ALL END-TO-END SMOKE TESTS PASSED!"
