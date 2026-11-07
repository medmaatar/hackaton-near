# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY agent/package.json agent/package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM deps AS runtime
WORKDIR /app
COPY agent/ ./
ENV NODE_ENV=production \
    PORT=8787 \
    AUDIT_PATH=/data/audit.jsonl
RUN mkdir -p /data
RUN npm run typecheck
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
