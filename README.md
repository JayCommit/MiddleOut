# Middle Out

Self-hosted, S3-compatible object storage with a web console. Run it with Docker or Node.js, store files in your database, and connect using the AWS CLI, rclone, or boto3.

## Features

- Create buckets, upload files, browse folders, and manage access keys.
- Keep buckets private or enable public reads.
- Share files with expiring links.
- Use S3 uploads, multipart uploads, downloads, copies, tags, and scoped access keys.
- Manage account settings, storage limits, sessions, and an activity log.
- Connect agents through a scoped REST API and a local MCP bridge.

Google Drive mounts support read-only and read-write folders using OAuth credentials or a service account. Console, single PUT, and multipart uploads use the mounted provider. Configure credentials in Settings, then select Google Drive when creating a bucket.

## Quick start

Clone this repository, then run:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs middleout
```

Open [localhost:8080](http://localhost:8080). Sign in as `admin@middleout.local` using the password printed in the first-start logs, then change it in Settings. Registration is disabled by default.

For another hostname or port, update `BETTER_AUTH_URL` in `.env` before starting. Compose binds to localhost by default.

Data and the generated authentication secret persist in the `middleout-data` Docker volume. Keep that volume when upgrading or replacing the container.

### Run with Node.js

Requires Node.js **22.12 or newer**.

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

The server listens on port 8080. Startup creates the initial account and applies database migrations. For development, run `npm run dev`.

## Connect an S3 client

Create an access key in the console's **Access keys** page. S3 clients use these credentials separately from your browser login.

```bash
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_REQUEST_CHECKSUM_CALCULATION="when_required"
export AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"
export ORIGIN="http://localhost:8080"

aws --endpoint-url "$ORIGIN/api/s3" s3 mb s3://photos
aws --endpoint-url "$ORIGIN/api/s3" s3 cp ./notes.txt s3://photos/notes.txt
aws --endpoint-url "$ORIGIN/api/s3" s3 ls s3://photos
```

For rclone, use the S3 provider **Other**, endpoint `http://localhost:8080/api/s3`, and `force_path_style = true`. More client examples are available on the console's **Docs** page.

## Configuration

| Setting               | Default                        | Purpose                                                                  |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL`     | `http://localhost:8080`        | Public URL used to access the console                                    |
| `ALLOW_SIGN_UP`       | `false`                        | Allow additional accounts to register                                    |
| `DATA_DIR`            | `./data`                       | Embedded database and generated authentication secret                    |
| `DATABASE_URL`        | Unset                          | Use external Postgres instead of embedded storage                        |
| `BETTER_AUTH_SECRET`  | Generated for embedded storage | Stable secret of at least 32 characters; required with external Postgres |
| `MAX_OBJECT_BYTES`    | `1073741824` (1 GiB)           | Default maximum object size                                              |
| `ACCOUNT_QUOTA_BYTES` | `10737418240` (10 GiB)         | Default storage quota per account                                        |

Storage limits can also be changed in Settings. See [.env.example](.env.example) for other options and [OPERATIONS.md](OPERATIONS.md) for HTTPS, backups, password recovery, metrics, and upgrades.

## Agent access

Create a token under **AI & Agents**, choosing its permissions, bucket scope, and expiry. REST requests use `Authorization: Bearer mo_agent_live_...`.

For a local MCP client, use the bridge from this checkout. Replace the script path and token below:

```json
{
  "mcpServers": {
    "middleout": {
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/MiddleOut/bin/middleout-mcp.mjs"],
      "env": {
        "MIDDLEOUT_ENDPOINT": "http://localhost:8080",
        "MIDDLEOUT_AGENT_KEY": "mo_agent_live_..."
      }
    }
  }
}
```

The bridge exposes six tools for listing buckets and files, reading and writing files, uploading artifacts, and creating share links. File listings accept a `cursor` from the previous page's `nextStart`; search scans nested keys across all listing pages. Artifact uploads create a fresh `agent-artifacts-*` scratch bucket, so scoped tokens must allow that prefix. Remote clients can connect to `/api/agent/v1/mcp` using **Streamable HTTP** and the same bearer token (legacy SSE is not supported). OpenAPI is available at `/api/agent/v1/openapi.json`, with discovery at `/.well-known/llms.txt`.

## Scope and limitations

- One storage node. Embedded storage requires one process per `DATA_DIR`; multiple application processes require external Postgres.
- Object bytes are stored as base64 database parts. Transfers can load entire objects into memory, so measure your workload before raising limits.
- S3 uses path-style addressing. Versioning, lifecycle rules, object lock, IAM bucket policies, server-side encryption, and signed streaming / `aws-chunked` requests are unsupported.
- Bucket CORS configuration is stored but is not enforced per bucket.
- Uploaded websites are served as downloads rather than hosted as same-origin pages.
- Scratch buckets are removed by periodic maintenance after expiry; expiry is not an immediate access cutoff.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:selfhost
npm run test:agents
```

The self-host smoke test checks login, uploads, private access, and persistence across restarts. To use an installed browser, set `PLAYWRIGHT_CHANNEL=msedge` or `chrome`.

See [RELEASING.md](RELEASING.md) for release checks, [SECURITY.md](SECURITY.md) for security boundaries and reporting, and [LICENSE](LICENSE) for the MIT license.
