# syntax=docker/dockerfile:1.7

FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:vps

FROM node:22.18.0-bookworm-slim AS runtime
ARG MARKET_SIGNAL_REVISION=unknown
ENV NODE_ENV=production \
    PORT=3000 \
    MARKET_SIGNAL_SQLITE_PATH=/data/market-signal.sqlite \
    MARKET_SIGNAL_BACKUP_DIR=/backups
LABEL org.opencontainers.image.title="Market Signal" \
      org.opencontainers.image.source="https://github.com/BlyzrHQ/market-signal" \
      org.opencontainers.image.revision="${MARKET_SIGNAL_REVISION}"
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 market-signal \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin market-signal

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=peer \
    && npm uninstall --no-save --omit=dev --omit=peer drizzle-kit \
    && test ! -d node_modules/drizzle-kit \
    && node --input-type=module -e "await import('better-auth'); await import('better-sqlite3'); await import('drizzle-orm'); await import('vite')" \
    && npm cache clean --force
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/public ./public
COPY --from=build --chown=10001:10001 /app/scripts/backup-sqlite.mjs ./scripts/backup-sqlite.mjs
COPY --from=build --chown=10001:10001 /app/scripts/verify-sqlite-backup.mjs ./scripts/verify-sqlite-backup.mjs
COPY --from=build --chown=10001:10001 /app/scripts/sqlite-backup-utils.mjs ./scripts/sqlite-backup-utils.mjs

RUN mkdir -p /data /backups \
    && chown 10001:10001 /data /backups

USER 10001:10001
EXPOSE 3000
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "node_modules/vinext/dist/cli.js", "start"]
