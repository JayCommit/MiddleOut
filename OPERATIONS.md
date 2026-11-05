# Operations

## Accounts and origin setup

This release is a private, single-node storage service. The initial administrator is an account owner, not a node-wide superuser. Additional accounts are independent owners when the operator deliberately enables registration; there is no user-management/RBAC console. Registration stays hidden when disabled. Each account can change its password and revoke its other sessions in Settings. Change the generated password after initial login. Anyone who can read first-start logs can read that initial credential; restrict log access and retention.

Set BETTER_AUTH_URL to exactly the address in the browser, including scheme and nonstandard port. Examples: `http://localhost:8080`, `http://192.168.1.50:8080`, `https://storage.example.com`. Recreate the container after editing .env. An Invalid origin error means these differ; never solve it by disabling origin checks or accepting arbitrary Origin headers. Behind a TLS proxy use the external HTTPS origin, not the upstream HTTP address.

Lost password / lost first-start logs:

```bash
docker compose stop middleout
docker compose run --rm --no-deps middleout npm run admin:reset -- admin@middleout.local
docker compose up -d
```

For a source installation, stop the server and run `npm run admin:reset -- admin@middleout.local`. This updates only an existing password credential, revokes all its browser sessions, and retains buckets, objects and S3 access keys. It never creates a missing account. Save the replacement password securely. Embedded storage refuses the reset while another process holds its data lock. External Postgres operators should also stop application processes during recovery. No email provider is required.

## Capacity, limits and ACL management

Defaults are 1 GiB/object and 10 GiB/account quota. Admins can configure upload size limits and account quotas dynamically in the Settings page (with unit selectors for MB, GB, and TB) or configure baseline defaults via `MAX_OBJECT_BYTES` and `ACCOUNT_QUOTA_BYTES` in `.env`. Object limits accept 1 byte through 5 TiB (matching Amazon S3's single-object ceiling); the account quota must be at least the object limit and at most 1 PiB. Dynamically configured limits apply immediately across console uploads, simple S3 PUT operations, and S3 multipart uploads without requiring service restarts.

MiddleOut also supports Amazon S3 Access Control Lists (ACLs) for both buckets and objects:
- Canned ACLs: `private`, `public-read`, `public-read-write`, and `authenticated-read`.
- S3 API: Respects `x-amz-acl` headers on PUT requests and `?acl` subresource endpoints (`GET /<bucket>?acl`, `PUT /<bucket>?acl`, `GET /<bucket>/<key>?acl`, `PUT /<bucket>/<key>?acl`) using standard S3 XML `AccessControlPolicy`.
- Anonymous access: Objects marked `public-read` (or stored inside a `public-read` bucket) can be accessed anonymously without AWS SigV4 signatures.
- Web Console: Full AWS S3 console experience including Bucket permissions (Block public access, ACL grantee table, Bucket Policy, CORS) and per-object ACL management.

Existing objects are retained if limits are reduced; writes remain subject to quota. The console reads limits from the server, and the S3 and transport limits use the same configuration. If your reverse proxy applies a body-size cap, configure it to accommodate your desired maximum upload size (e.g. `client_max_body_size 1024M` in Nginx). The bundled Caddy configuration does not impose a separate upload body cap.

Objects are still base64 database parts and reads/writes may materialize entire objects. Use the defaults initially, keep concurrent large transfers low, and measure before raising limits. A 2 GiB memory allocation is a conservative starting point for evaluation, not a measured minimum or a production guarantee. BENCHMARK_RESULTS.json records a reproducible local sample with hardware, runtime, timings, RSS snapshots and disk growth. `npm run build && npm run benchmark` uses a disposable embedded database, random bytes and verified readback. It also exercises four concurrent 1 MiB HTTP write/read clients and a restart with byte verification. It does not measure TLS, sustained production load or peak memory. Size your deployment using its actual client workload and observe RSS, disk growth, backup time and restart time. The existing container gates verify crashes and disk exhaustion; they do not establish throughput SLAs.

Settings displays version, backend, public origin, limits and the account ownership model. Failed HTTP requests return an x-request-id and failures emit JSON records with that ID; request bodies, query strings, passwords and key values are not included in these records.

Metrics are disabled unless METRICS_TOKEN contains at least 32 characters. Scrape `/api/metrics` with `Authorization: Bearer <token>` from a trusted internal network. The bundled Caddy proxy continues blocking external metrics. Do not put bearer tokens in query strings. Existing deployments scraping anonymously must update their scraper.

Maintenance runs hourly by default, controlled by MAINTENANCE_INTERVAL_SECONDS (60–86400). It removes expired links and upload reservations inactive for at least 24 hours. Each cycle processes up to 100 affected accounts, up to 1,000 pending records of each type per account, and up to 1,000 expired links and audit records; large backlogs drain across cycles. Part writes refresh activity timestamps. Cleanup uses the same account locks as upload writes, and does not delete completed objects. Multiple external-Postgres instances may run maintenance safely through those locks; each process avoids overlapping its own runs. Audit records are retained for AUDIT_RETENTION_DAYS (1–3650, default 90). Export activity pages before retention expires if you need longer history.

## Backups, restore drills and upgrades

Use an absolute backup directory writable by UID 1000. Stop the embedded node first. Keep backups outside the data volume and protect them like the original data. For example, on a Linux host:

```bash
mkdir -p backups
sudo chown 1000:1000 backups
docker compose stop middleout
docker compose run --rm --no-deps -v "$PWD/backups:/backups" middleout npm run backup -- /backups/pre-upgrade
docker compose up -d
```

The backup directory must not already exist. Use unique timestamped destinations. Embedded backups include the signing secret and checksums. Do not copy a running embedded database. For external Postgres use pg_dump/pg_restore and retain BETTER_AUTH_SECRET separately, as described in README.

Restore a backup into a separate named volume and an absent subdirectory, never over a live node:

```bash
docker run --rm -v middleout-restore:/app/data -v "$PWD/backups:/backups:ro" -e DATA_DIR=/app/data/restored ghcr.io/jaycommit/middleout:0.2.0 npm run restore -- /backups/pre-upgrade
docker run --rm -p 127.0.0.1:8081:8080 -v middleout-restore:/app/data -e DATA_DIR=/app/data/restored -e BETTER_AUTH_URL=http://localhost:8081 ghcr.io/jaycommit/middleout:0.2.0
```

Sign in using the backed-up credentials, read an original private object with its original access key, and verify byte hashes. A successful backup command alone is not a restore drill. The restore-test volume is independent of production. The restore tool rejects an existing target and corrupt manifests.

Before upgrading, save the old image digest, configuration and a verified backup. Pull the new version-pinned image, recreate the container, and check health, login, private upload/download and key scope. Compose includes a pinned image and supports `docker compose pull && docker compose up -d --no-build`; use `--build` only when building the checked-out source. Never use `docker compose down -v` for an upgrade. Schema migrations are forward-only. If an old image is incompatible with the migrated schema, roll back by restoring the pre-upgrade backup into a separate volume and running its matching old image/configuration. Merely switching the image tag is not a safe universal downgrade.

For scheduled backups, have your host scheduler stop the service, invoke the offline backup command with a fresh date-stamped destination, restart it even if backup fails, and alert on failure. Retain multiple generations and an off-host copy, restrict access, and periodically restore a retained generation. Choose frequency and retention according to acceptable data loss; this application does not silently schedule downtime for you.

## Compatibility decisions

The next release continues the deliberately small single-node scope. IAM policies, signed streaming/aws-chunked, versioning, lifecycle, object lock, virtual-host addressing and application-managed encryption remain unsupported, documented features rather than promised capabilities. Bucket CORS records remain configuration storage, not enforced browser policy. Use supported simple or multipart requests and client checksum settings from Docs. Encryption at rest is supplied by host/database/backup storage. MFA, invitations, node-wide RBAC and advanced key controls are deferred pending a broader multi-user product requirement. This release adds session management, password recovery and activity-page export without introducing an external identity service.
