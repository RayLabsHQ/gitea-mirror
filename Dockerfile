# syntax=docker/dockerfile:1.4

FROM oven/bun:1.3.10-debian AS base
WORKDIR /app
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends \
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
  if [ "$(basename "$script")" = "runtime-server.ts" ]; then continue; fi; \
  bun build "$script" --target=bun --outfile=dist/scripts/$(basename "${script%.ts}.js"); \
  done

# ----------------------------
FROM base AS pruner
COPY package.json ./
COPY bun.lock* ./
RUN bun install --production --omit=peer --frozen-lockfile

# ----------------------------
# Build git-lfs from source with patched Go to resolve Go stdlib CVEs
FROM debian:trixie-slim AS git-lfs-builder
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends \
  wget ca-certificates git make \
  && rm -rf /var/lib/apt/lists/*
ARG GO_VERSION=1.25.8
ARG GIT_LFS_VERSION=3.7.1
RUN ARCH="$(dpkg --print-architecture)" \
  && wget -qO /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
  && tar -C /usr/local -xzf /tmp/go.tar.gz \
  && rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
# Force using our installed Go (not the version in go.mod toolchain directive)
ENV GOTOOLCHAIN=local
RUN git clone --branch "v${GIT_LFS_VERSION}" --depth 1 https://github.com/git-lfs/git-lfs.git /tmp/git-lfs \
  && cd /tmp/git-lfs \
  && go get golang.org/x/crypto@latest \
  && go mod tidy \
  && make \
  && install -m 755 /tmp/git-lfs/bin/git-lfs /usr/local/bin/git-lfs

# ----------------------------
FROM oven/bun:1.3.10-debian AS runner
WORKDIR /app
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends \
  git wget sqlite3 openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=git-lfs-builder /usr/local/bin/git-lfs /usr/local/bin/git-lfs
RUN git lfs install
COPY --from=pruner /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=builder /app/scripts/runtime-server.ts ./scripts/runtime-server.ts
COPY --from=builder /app/drizzle ./drizzle

# Remove build-only packages that are not needed at runtime
# (esbuild, vite, rollup, tailwind, svgo — all only used during `astro build`)
RUN rm -rf node_modules/esbuild node_modules/@esbuild \
  node_modules/rollup node_modules/@rollup \
  node_modules/vite node_modules/svgo \
  node_modules/@tailwindcss/vite \
  node_modules/tailwindcss

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV DATABASE_URL=file:data/gitea-mirror.db
ENV BASE_URL=/

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
  CMD sh -c 'BASE="${BASE_URL:-/}"; if [ "$BASE" = "/" ]; then BASE=""; else BASE="${BASE%/}"; fi; wget --no-verbose --tries=1 --spider "http://localhost:4321${BASE}/api/health" || exit 1'

ENTRYPOINT ["./docker-entrypoint.sh"]
