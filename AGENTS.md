# Repository Architecture & Agent Guide (`AGENTS.md`)

MiddleOut (`v1.0.0-rc1`) is a Cargo workspace written in Rust (edition 2024) that compiles into a single binary named `middleout`.

## Workspace Structure

```text
MiddleOut/
├── Cargo.toml                     # Workspace manifest (v1.0.0-rc1)
├── Dockerfile                     # Multi-stage Rust build -> debian:bookworm-slim runtime
├── compose.yaml                   # One-command Docker Compose setup
├── .env.example                   # Environment variable reference
├── scripts/
│   └── smoke-test.sh              # End-to-end verification (AWS CLI, boto3, rclone, curl)
└── crates/
    ├── middleout-storage/         # Embedded SQLite metadata + atomic filesystem blob engine
    │   └── src/lib.rs
    ├── middleout-s3/              # S3 protocol, SigV4 auth, XML serde, and Axum S3 handlers
    │   └── src/
    │       ├── lib.rs
    │       ├── error.rs           # S3Error codes and HTTP status mappings
    │       ├── sigv4.rs           # Header SigV4, Presigned URLs, and aws-chunked decoding
    │       ├── xml.rs             # S3 XML serializers and parsers
    │       └── handlers.rs        # Path-style S3 request routing and handlers
    └── middleout-server/          # Binary crate: config, web console, unified router, main
        └── src/
            ├── main.rs            # Entrypoint, tracing setup, graceful shutdown
            ├── lib.rs             # Unified router (/health, /_console, /_public, S3 at / and /api/s3)
            ├── config.rs          # Environment variable configuration
            └── console.rs         # Server-rendered Web Console and public bucket browser
```

## Key Commands

- **Check & Lint**:
  ```bash
  cargo clippy --workspace --all-targets -- -D warnings
  cargo fmt --all -- --check
  ```
- **Run Unit & Integration Tests**:
  ```bash
  cargo test --workspace
  ```
- **Run Real-Client Smoke Tests**:
  ```bash
  ./scripts/smoke-test.sh
  ```

## Design Principles

1. **Single binary, zero external services**: Only local filesystem storage and bundled SQLite (`rusqlite` with `bundled` feature in WAL mode).
2. **Atomic storage**: Every object or part write goes to `<DATA_DIR>/staging/tmp-<uuid>.blob`, calls `sync_all()`, and atomically renames into `<DATA_DIR>/objects/...` before updating SQLite.
3. **Strict S3 compatibility**: Always verify changes against real S3 clients (`aws`, `boto3`, `rclone`, `mc`) rather than relying solely on synthetic unit tests.
