# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS builder

WORKDIR /usr/src/middleout

# Copy workspace manifests first for dependency caching
COPY Cargo.toml Cargo.lock ./
COPY crates/middleout-storage/Cargo.toml crates/middleout-storage/Cargo.toml
COPY crates/middleout-s3/Cargo.toml crates/middleout-s3/Cargo.toml
COPY crates/middleout-server/Cargo.toml crates/middleout-server/Cargo.toml

# Copy full source tree and build release binary
COPY crates ./crates
RUN cargo build --release --locked --bin middleout

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user and data directory
RUN groupadd --system --gid 10001 middleout \
    && useradd --system --uid 10001 --gid middleout --home-dir /data --no-create-home middleout \
    && mkdir -p /data \
    && chown -R middleout:middleout /data

COPY --from=builder /usr/src/middleout/target/release/middleout /usr/local/bin/middleout

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    MIDDLEOUT_REGION=us-east-1 \
    MAX_OBJECT_BYTES=1073741824

VOLUME ["/data"]
EXPOSE 8080

USER middleout
WORKDIR /data

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/middleout"]
