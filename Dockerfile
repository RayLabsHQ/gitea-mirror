# syntax=docker/dockerfile:1.4

FROM oven/bun:1.3.9-debian AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ gcc wget sqlite3 openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ----------------------------
FROM base AS builder
COPY package.json ./
COPY bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
RUN mkdir -p dist/scripts && \
  for script in scripts/*.ts; do \
  bun build "$script" --target=bun --outfile=dist/scripts/$(basename "${script%.ts}.js"); \
  done

# ----------------------------
FROM base AS pruner
COPY package.json ./
COPY bun.lock* ./
RUN bun install --production --omit=peer --frozen-lockfile

# ----------------------------
FROM oven/bun:1.3.9-debian AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
  git git-lfs wget sqlite3 openssl ca-certificates \
  && git lfs install \
  && rm -rf /var/lib/apt/lists/*
COPY --from=pruner /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/drizzle ./drizzle

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV DATABASE_URL=file:data/gitea-mirror.db

# Create directories and setup permissions
RUN mkdir -p /app/certs && \
  chmod +x ./docker-entrypoint.sh && \
  mkdir -p /app/data && \
  groupadd --system --gid 1001 nodejs && \
  useradd --system --uid 1001 --gid 1001 --create-home --home-dir /home/gitea-mirror gitea-mirror && \
  chown -R gitea-mirror:nodejs /app/data && \
  chown -R gitea-mirror:nodejs /app/certs && \
  chown -R gitea-mirror:nodejs /home/gitea-mirror

USER gitea-mirror

VOLUME /app/data
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4321/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
