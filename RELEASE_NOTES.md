Middle Out is a self-hosted, single-node S3-compatible object store with a local web console.

This release includes persistent embedded storage or external Postgres, local account authentication, private/public buckets, scoped access keys, multipart uploads and share links. Limits are 8 MiB per object and 64 MiB per account. IAM policies, versioning, object lock, lifecycle management and signed aws-chunked payloads are unsupported.

Security protections include sandboxed object responses, attachment delivery for active documents, copy-source authorization, bounded request bodies, transport-based rate limits and a production dependency audit gate. Offline checksummed backup/restore and an automatic-HTTPS Compose overlay are included.

Validation gates cover Linux and Windows, Node 22/24, real Postgres 17/18, AWS CLI/boto3/rclone, browser authentication and malicious-document handling, amd64/arm64 containers, crash recovery, schema upgrades, backup/restore and filesystem exhaustion.

Download the archive for your CPU architecture and the SHA256SUMS file. Verify the checksum, then load the image:

```bash
sha256sum -c SHA256SUMS --ignore-missing
docker load -i middleout-v0.1.0-linux-amd64.tar.gz
```

Use the arm64 archive on ARM hosts. The loaded image is tagged `ghcr.io/jaycommit/middleout:0.1.0`; it can run without signing into a registry. Public release archives provide anonymous distribution even if the registry package's visibility has not yet been changed. Configure a persistent volume at `/app/data` and the exact public `BETTER_AUTH_URL` before use; follow the repository README for account creation and HTTPS.

See README.md, SECURITY.md and RELEASING.md for deployment, supported operations, backups and the release process. Licensed under MIT.
