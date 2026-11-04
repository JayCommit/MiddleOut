# Middle Out

Single-node, S3-compatible object storage with a web console. Buckets are private until you mark them public.

## What you get

- **Console** — sign in, create buckets, upload and browse objects, issue share links, manage access keys, and read an activity log.
- **Public browser** — public buckets are listed at `/p/<bucket>`. Private buckets return nothing there.
- **S3 API** — path-style endpoint at `/api/s3` on the same origin. Works with the AWS CLI, rclone, boto3, and curl.
- **Auth for clients** — AWS Signature Version 4 (headers or a presigned query string), or `Authorization: MO <access-key>:<secret>` for simple curl.

Sign-in is for the console. S3 clients use an access key from **Access keys**, not the browser session.

## Limits

|                     |                                                               |
| ------------------- | ------------------------------------------------------------- |
| Max object          | 8 MB                                                          |
| Account quota       | 64 MB                                                         |
| Upload              | Single PUT and S3 Multipart Upload API (up to 10,000 parts).  |
| Addressing          | Path-style only. No virtual-hosted bucket DNS.                |
| Not in this version | Versioning, object lock, lifecycle, SSE, IAM bucket policies. |

Object bytes live in Postgres as base64 parts, next to the metadata. Region names are labels clients can read back; there is one node.

## Container releases

Download the archive for your architecture and SHA256SUMS from [Releases](https://github.com/JayCommit/MiddleOut/releases), verify the checksum and load it with `docker load -i <archive>`. This works without a registry account. The image is tagged `ghcr.io/jaycommit/middleout:<version>`. A direct registry pull is also available when the package is public; GitHub defaults new registry packages to private independently of source-repository visibility.

## Self-hosting

Run on any machine with Node 22+ or Docker. No hosted control plane, auth broker, or cloud account is required. Objects, accounts, and access keys stay in your database.

### Docker Compose

```bash
cp .env.example .env
# Set BETTER_AUTH_URL to the origin users will visit, including scheme/port.
# Set ALLOW_SIGN_UP=true temporarily to create your account.
docker compose up -d --build
```

Open your configured URL (default `http://localhost:8080`), choose **Create an account**, and register with a password of at least 12 characters. Then set `ALLOW_SIGN_UP=false` and run `docker compose up -d` again. Existing users can still sign in. Registration is disabled by default; do not enable it on an unattended public node.

Compose retains the database and generated authentication signing secret in the `middleout-data` volume. Replacing or restarting the container keeps them. Do not delete that volume unless you intend to delete the node's data. To use a standalone Docker container, build this Dockerfile, mount a persistent volume at `/app/data`, publish port 8080, and pass the same environment variables.

### Node

```bash
npm ci
cp .env.example .env
# Edit BETTER_AUTH_URL and temporarily enable ALLOW_SIGN_UP.
npm run build
npm start
```

The production server listens on `0.0.0.0:8080`; configure `HOST` and `PORT` as needed. Build does not contact or migrate a database. `npm start` applies external Postgres migrations before starting; embedded migrations run before the first database request. Start commands read `.env`. For development, use `npm run dev` (port 8080).

### Database and configuration

| Variable             | Meaning                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`    | Public origin, default `http://localhost:8080`. Set this to your actual URL before signing in.                                        |
| `ALLOW_SIGN_UP`      | `true` enables registration; default disabled. Changes require a server/container restart.                                            |
| `DATA_DIR`           | Persistent embedded storage directory; default `./data`, container `/app/data`. Contains `db/` and `auth-secret`.                     |
| `DATABASE_URL`       | Optional standard Postgres connection string. When set, embedded storage is not used.                                                 |
| `BETTER_AUTH_SECRET` | Stable secret of at least 32 characters. Required with external Postgres; otherwise generated and retained in `DATA_DIR/auth-secret`. |
| `HOST`, `PORT`       | Listen address and port for the production Node server.                                                                               |

Use one application process with embedded storage; multiple processes must use external Postgres. Mount writable persistent storage owned by the container's `node` user (UID 1000) when using a bind mount. Back up embedded storage with the server stopped, retaining both the database and signing secret. Use normal Postgres backup tools for an external database. Never use `DATA_DIR=:memory:` outside disposable tests.

For a domain behind a reverse proxy, terminate HTTPS at the proxy, forward requests to port 8080, and set `BETTER_AUTH_URL=https://your-domain`. Cookies automatically become secure for HTTPS origins. Keep the public origin consistent across browsers and configuration. Configure the proxy's upload limit to at least 12 MiB. `/api/health` can be used for readiness checks; the container includes a health check.

### Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:selfhost
```

The browser smoke test uses Playwright Chromium; alternatively set `PLAYWRIGHT_CHANNEL=msedge` or `chrome` to use an installed browser. Tests use isolated in-memory databases and a temporary directory for restart tests. To exercise the SQL paths against an external database, set `TEST_DATABASE_URL` to a dedicated disposable Postgres database, apply `npm run db:migrate` to it via `DATABASE_URL`, then run `npm test`. Never point tests at a database containing real objects.

Pending console uploads reserve their declared size against quota. An overwrite keeps the original readable until completion, so both the original and pending replacement need space until publication. Failed or cancelled uploads leave the original intact. Single PUTs and multipart completion publish metadata and bytes in one transaction.

IAM bucket policies are unsupported: new writes return HTTP 501. Buckets carrying policies accepted by older releases fail closed on S3 and public reads; retrieve the stored policy for recovery and explicitly remove it with `DeleteBucketPolicy` before using the bucket again. Public/private bucket access and access-key restrictions remain supported.

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

## Internet deployment and recovery

Raw Compose HTTP binds to loopback by default. To expose it through automatic HTTPS:

```bash
# In .env, set MIDDLEOUT_DOMAIN=storage.example.com
# and BETTER_AUTH_URL=https://storage.example.com
# Point the domain at this host and make ports 80/443 reachable.
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

The Caddy overlay obtains TLS certificates and blocks the node-wide metrics endpoint externally. The application does not trust caller-supplied forwarding headers for rate limits. Requests behind a proxy share that proxy's application-level limiter; configure additional per-client limits at your proxy if needed. Uploaded HTML, SVG and XML download as attachments; all object/S3 responses use sandbox and nosniff protections. Same-origin user-uploaded websites are intentionally unsupported.

The database takes an exclusive heartbeat lock in every embedded mode, including development and preview. Run only one process per DATA_DIR. After an abrupt crash, restart may wait up to roughly 30 seconds to reclaim a stale lock. Do not manually remove a live node's lock.

### Embedded backups

Stop the node before backing up. The maintenance command refuses a live embedded database and writes a SHA-256 manifest:

```bash
npm run backup -- /absolute/path/to/backups/node-2026-11-04
# On a separate stopped node, set DATA_DIR to an ABSENT restore target:
npm run restore -- /absolute/path/to/backups/node-2026-11-04
npm start
```

DATA_DIR and the backup directory must be separate non-nested paths. Backup destinations must be new; restore never overwrites existing directories. Retain auth-secret with the database. Protect backup directories with filesystem permissions and encryption; checksums detect corruption, not malicious replacement of both data and manifest. For container maintenance, stop the service, then run the same scripts in a one-off container with the data volume mounted at /app/data and a separate backup directory writable by UID 1000. Do not use a raw copy of a running embedded database.

For external Postgres, use a matching or newer `pg_dump` client to make a custom-format dump, restore it to a separate empty database with `pg_restore --exit-on-error`, and separately retain BETTER_AUTH_SECRET. The embedded backup tool deliberately refuses external-Postgres mode.

The release gates include backup/restore, old-schema upgrade, abrupt restart and constrained-filesystem tests. See [RELEASING.md](RELEASING.md) for the exact gates and the versioned container publication process. See [SECURITY.md](SECURITY.md) for reporting and security boundaries. The project is licensed under [MIT](LICENSE).

Signed streaming payloads and aws-chunked encodings return HTTP 501. Use single PUT or multipart with `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`. The maximum object remains 8 MiB and the account quota remains 64 MiB; this is a small single-node object store.

## API coverage

Supported: bucket create, delete, head, and list; bucket location, ACL, and CORS configuration storage (CORS rules are not enforced per bucket); object put, get, head, delete, and copy; S3 Multipart Upload API (InitiateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads); Object Tagging (GET/PUT/DELETE ?tagging); ListObjects and ListObjectsV2 (prefix, delimiter, max-keys, continuation tokens); range and conditional reads (If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since); SigV4 and presigned URLs; the `MO` authorization header; access key scoping (Read-Only & Bucket restriction); bounded request bodies; rate limiting; public-read buckets; Prometheus metrics (/api/metrics).

## Layout

```text
src/routes/          pages and HTTP routes (console, /api/s3, public objects)
src/lib/s3/          SigV4 and the S3 request engine
src/lib/storage/     buckets, objects, keys, quota
migrations/          Postgres schema (auth, then storage)
```
