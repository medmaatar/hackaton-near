# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
RUN npm install -g near-cli-rs@0.17.0 \
 && rm -rf /root/.npm
WORKDIR /work
ENTRYPOINT ["near"]
CMD ["--help"]
