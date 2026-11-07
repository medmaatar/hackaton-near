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
COPY contract/Cargo.toml ./
COPY contract/mock-ft/Cargo.toml ./mock-ft/
RUN mkdir -p src mock-ft/src \
 && echo 'pub fn _placeholder() {}' > src/lib.rs \
 && echo 'pub fn _placeholder() {}' > mock-ft/src/lib.rs \
 && cargo fetch

COPY contract/ ./

# 1. rule tests for the mandate contract
# 2. reproducible wasm artifacts: the mandate contract and the sandbox-only token
RUN --mount=type=cache,target=/app/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo test --release -p mandate-otc -- --nocapture \
 && cargo build --target wasm32-unknown-unknown --release --workspace \
 && mkdir -p /out \
 && find target/wasm32-unknown-unknown/release -name "*.wasm" -exec cp {} /out/ \; \
 && ls -la /out

FROM scratch AS artifact
COPY --from=builder /out/ /
