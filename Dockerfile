# syntax=docker/dockerfile:1.7
# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS builder

WORKDIR /app

# Install system deps needed for native modules (tree-sitter, ladybugdb).
# NOTE: BuildKit cache mounts (`--mount=type=cache,...`) were removed because
# Railway's Metal builder rejects them with "missing the cacheKey prefix from
# its id" — Railway requires a service-scoped `s/<cacheKey>-<id>` prefix that
# we can't bake into a portable Dockerfile. Layer caching still applies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all deps (including dev for build tools). Cache mount removed —
# see note on the apt RUN above.
RUN npm ci --legacy-peer-deps \
    && sha256sum package-lock.json | cut -d ' ' -f1 > node_modules/.xyz-hydrated-lock-hash

# Install mobile app dependencies so runtime EAS commands can resolve Expo config
# plugins from /app/mobile. Root npm ci does not install this nested package.
# Copy the nested package manifests and local Expo module explicitly first so
# the lockfile is a hard Docker input, not an accidental dependency of COPY . . .
COPY mobile/package.json mobile/package-lock.json ./mobile/
COPY mobile/modules/agent-native ./mobile/modules/agent-native
RUN cd mobile && npm ci --legacy-peer-deps

# Copy source
COPY . .

# Build everything: vite (client) + esbuild (server) + gitnexus runtime + claude CLI.
# Cache mounts removed (see note on the apt RUN above) — the gitnexus runtime
# is therefore re-bundled from scratch on every build instead of being
# restored from /tmp/gitnexus-runtime-cache.
# GitHub push is disabled by default unless BUILD_PUSH_TO_GITHUB=true.
RUN npm run build

# Remove test bundles from production image (~300MB savings)
RUN rm -rf dist/tests

# Keep devDependencies (typescript, vite, esbuild) in the runtime image.
# The runtime is a development workspace that runs tsc/vite/esbuild during
# implement skill sessions — pruning and reinstalling per-session is wasteful.

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-trixie-slim

WORKDIR /app

RUN groupadd --system mantra && useradd --system --gid mantra --home-dir /home/mantra --create-home mantra

# Runtime system deps for native modules. Cache mounts removed (see builder
# stage note).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    git \
    ca-certificates \
    chromium \
    python3 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 --version \
    && python --version \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts (tests already removed in builder stage)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/shared ./shared

# Copy package files + full node_modules (including devDependencies) from the
# builder stage. DevDeps are needed at runtime for implement skill sessions.
COPY package.json package-lock.json ./
COPY AGENTS.md CODING.md SECURITY.md DESIGN.md GOALS.md PLANNING.md ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
RUN chmod +x ./scripts/*.sh

# Install Playwright's bundled Chrome for Testing. System chromium (v150+ on
# trixie) crashes with SIGTRAP in Railway's container seccomp profile.
# Playwright's version-matched Chrome avoids the incompatibility.
RUN npx playwright install chromium 2>/dev/null || echo "Playwright Chrome install skipped"
COPY --from=builder /app/mobile ./mobile

# The server runs on port 5000 by default
ENV PORT=5000
ENV NODE_ENV=production
# Tell Claude Code this is the product's sandboxed/containerized execution
# boundary. The runtime drops root below; deterministic capability policy still
# owns which tools and commands the model can reach.
ENV IS_SANDBOX=1
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://localhost:5000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Runtime execution capabilities remain explicit, but they no longer receive
# container-root authority. Writable workspaces and browser caches belong to mantra.
RUN chown -R mantra:mantra /app /home/mantra
USER mantra
ENV HOME=/home/mantra

# Tini is PID 1: it forwards signals to the exec'd process supervisor and
# reaps orphaned grandchildren from git, esbuild, Chromium, and other runtime
# tooling. The supervisor launches dist/index.mjs and forwards Railway signals.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "scripts/docker-entrypoint.sh"]
