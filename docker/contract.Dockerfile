# syntax=docker/dockerfile:1.7
# Contract build + test image. Everything compiles inside the container; the
# host only needs Docker.
FROM rust:1-slim-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

WORKDIR /app

# Cache the dependency graph before the sources land.
COPY contract/Cargo.toml contract/Cargo.lock* ./
RUN mkdir -p src && echo 'pub fn _placeholder() {}' > src/lib.rs \
 && cargo fetch || cargo fetch

COPY contract/ ./

# 1. unit tests for every mandate rule
# 2. reproducible wasm artifact
RUN --mount=type=cache,target=/app/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo test --release -- --nocapture \
 && cargo build --target wasm32-unknown-unknown --release \
 && mkdir -p /out \
 && cp target/wasm32-unknown-unknown/release/mandate_otc.wasm /out/mandate_otc.wasm

FROM scratch AS artifact
COPY --from=builder /out/mandate_otc.wasm /mandate_otc.wasm
