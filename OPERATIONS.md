# Operations Guide

This guide covers running, backing up, upgrading, and placing **MiddleOut** (`v1.0.0-rc1`) behind a reverse proxy.

## 1. Deployment

### Docker Compose

`compose.yaml` builds and runs the single-binary `middleout` container as a non-root user (`uid=10001`, `gid=10001`) with persistent storage mounted at `/data`:

```bash
cp .env.example .env
# Edit .env to set strong MIDDLEOUT_ACCESS_KEY_ID and MIDDLEOUT_SECRET_ACCESS_KEY values
docker compose up -d --build
```

Check container health and logs:

```bash
docker compose ps
docker compose logs -f middleout
curl -fsS http://127.0.0.1:8080/health
```

### Bare Metal / Systemd

Build the release binary:

```bash
cargo build --release --bin middleout
sudo install -m 0755 target/release/middleout /usr/local/bin/middleout
```

Run with environment variables configured:

```bash
HOST=127.0.0.1 \
PORT=8080 \
DATA_DIR=/var/lib/middleout \
MIDDLEOUT_ACCESS_KEY_ID=your-access-key \
MIDDLEOUT_SECRET_ACCESS_KEY=your-secret-key \
/usr/local/bin/middleout
```

MiddleOut handles `SIGINT` and `SIGTERM` for graceful shutdown.

---

## 2. Reverse Proxy & TLS

For production deployments exposed over a network, run MiddleOut behind a TLS-terminating reverse proxy (such as Caddy, Nginx, or Traefik) and bind MiddleOut locally (`HOST=127.0.0.1`).

Important proxy settings for S3 compatibility:
- **Preserve the `Host` header**: AWS Signature Version 4 always signs the `Host` header. Ensure your reverse proxy forwards the original `Host` header unchanged to MiddleOut.
- **Preserve raw request URIs**: Do not normalize or double-encode percent-encoded characters (such as `%2F` or `%20`) in object keys before forwarding to MiddleOut.
- **Request body size limit**: Match or exceed `MAX_OBJECT_BYTES` (default `1 GiB`) in your reverse proxy's max body size configuration.

Example `Caddyfile`:

```caddyfile
s3.example.com {
    request_body {
        max_size 1GB
    }
    reverse_proxy 127.0.0.1:8080
}
```

---

## 3. Data Directory & Backups

All persistent state lives in `DATA_DIR`:

- `metadata.db` (and `metadata.db-wal`, `metadata.db-shm`): SQLite database in WAL mode containing buckets, object metadata, and in-progress multipart upload records.
- `objects/<bucket>/<shard>/<uuid>.blob`: Immutable object data files.
- `multipart/<upload_id>/`: Temporary part blobs for in-progress multipart uploads.
- `staging/`: Short-lived files being written before atomic rename into `objects/` or `multipart/` (automatically swept on server startup).

### Cold Backup (Simplest)

Stop MiddleOut briefly so SQLite checkpoints `metadata.db-wal` and no writes are in flight, then archive `DATA_DIR`:

```bash
docker compose stop middleout
tar -czf middleout-backup-$(date +%Y%m%d).tar.gz /path/to/data
docker compose start middleout
```

### Online Backup

If taking a backup while the server is running:
1. Back up `metadata.db` using `sqlite3 /path/to/data/metadata.db ".backup '/path/to/backup/metadata.db'"` so a consistent SQLite snapshot is captured.
2. Sync `objects/` using `rsync -a /path/to/data/objects/ /path/to/backup/objects/`. (Because object writes create new UUID blob files before updating SQLite and only unlink superseded blobs afterward, copying `metadata.db` first and `objects/` immediately during low write activity—or using filesystem snapshots such as ZFS/LVM/btrfs—ensures consistency.)

---

## 4. Credential Rotation

S3 API credentials and Web Console admin credentials are controlled by environment variables:
- `MIDDLEOUT_ACCESS_KEY_ID` / `MIDDLEOUT_SECRET_ACCESS_KEY`
- `MIDDLEOUT_ADMIN_USER` / `MIDDLEOUT_ADMIN_PASSWORD`

Rotating these variables and restarting the server immediately invalidates previous S3 credentials as well as any existing Web Console session cookies (since the HMAC signing key for console cookies is derived from the configured credentials).
