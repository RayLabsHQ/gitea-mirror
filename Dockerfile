# syntax=docker/dockerfile:1.4

FROM oven/bun:1.2.17-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++ gcc wget sqlite openssl

# ----------------------------
FROM base AS deps
COPY package.json ./
COPY bun.lock* ./
RUN bun install --frozen-lockfile

# ----------------------------
FROM deps AS builder
COPY . .
ENV NODE_ENV=production
RUN bun run build
RUN mkdir -p dist/scripts && \
    for script in scripts/*.ts; do \
      bun build "$script" --target=bun --outfile=dist/scripts/$(basename "${script%.ts}.js"); \
    done

# ----------------------------
FROM deps AS pruner
RUN bun install --production --frozen-lockfile

# ----------------------------
FROM base AS runner
WORKDIR /app
COPY --from=pruner /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV DATABASE_URL=file:data/gitea-mirror.db

RUN chmod +x ./docker-entrypoint.sh && \
    mkdir -p /app/data && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 gitea-mirror && \
    chown -R gitea-mirror:nodejs /app/data

USER gitea-mirror

VOLUME /app/data
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4321/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
