# syntax=docker/dockerfile:1.7
#
# Production-grade Dockerfile for the Crivacy Next.js runtime.
#
# Multi-stage build:
#   1. deps     — install pnpm + workspace dependencies with the
#                 frozen lockfile.
#   2. build    — compile Next.js with `output: 'standalone'` so the
#                 runtime image only carries the trace minimum.
#   3. runtime  — node:22-alpine, non-root, read-only-friendly,
#                 HEALTHCHECK probes /api/v1/health.
#
# Base image is pinned by digest so a retagged `node:22-alpine`
# upstream cannot silently land a compromised layer on rebuild.
# Dependabot watches the docker ecosystem (see
# `.github/dependabot.yml`) and opens a PR when a newer digest
# ships, so the pin stays current under review rather than
# rotting unpatched. Same pattern as the telegram-alert-bot
# Dockerfile.
#
# Standalone output is opt-in in `next.config.mjs` via
# `NEXT_OUTPUT=standalone` — the build stage sets it explicitly so
# the .next/standalone tree exists by the time the runtime stage
# copies it.
#
# Build context: this file lives at `apps/web/Dockerfile`. Build
# from the repo root so the COPY can reach the workspace root,
# packages/, and pnpm-lock.yaml:
#
#   docker build -f apps/web/Dockerfile -t crivacy-web:dev .
#
# Local smoke test:
#
#   docker run --rm -p 3001:3001 \
#     --env-file apps/web/.env \
#     crivacy-web:dev
#   curl -fsS http://localhost:3001/api/v1/health
#
# Production deployments must NOT use the dev `.env`; supply
# secrets via the orchestrator's secret store (sops, k8s secrets,
# Docker swarm secrets, etc.) and pass them in as env at run
# time. The image carries no secrets — that's the contract.

# ---------------------------------------------------------------------------
# Stage 1: deps — install workspace dependencies with frozen lockfile.
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS deps
WORKDIR /repo

# Enable corepack so the pnpm version pinned in package.json's
# `packageManager` field is the one used. Avoids drift between
# the contributor's local pnpm and the build image's pnpm.
RUN corepack enable

# Copy ONLY the manifest + lockfile + workspace declaration first
# so the cache invalidates on dependency change, not on every
# source edit. The deps install is the slowest layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/js-sdk/package.json packages/js-sdk/
COPY packages/eslint-config/package.json packages/eslint-config/

# Production-only install would skip drizzle-kit + tsc etc. that
# the build stage needs. We install full dev deps here, then
# prune in the build stage after the bundle is sealed.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline


# ---------------------------------------------------------------------------
# Stage 2: build — compile Next.js with standalone output.
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build
WORKDIR /repo

RUN corepack enable

# Bring in deps from the previous stage to avoid re-downloading.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=deps /repo/packages/js-sdk/node_modules ./packages/js-sdk/node_modules

# Now bring the source. We deliberately do NOT copy `.env`, `data/`,
# `ref-dosyalar/`, or `.claude/` — secrets and large local fixtures
# stay on the host. `.dockerignore` enforces this for a wider
# defence in case the COPY pattern broadens accidentally.
COPY tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps/web apps/web

# Compile Next.js into the standalone tree. NEXT_TELEMETRY_DISABLED
# avoids an outbound POST during build; not strictly required for
# correctness but matches the locked-down posture of the rest of
# the runtime.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @crivacy/web build


# ---------------------------------------------------------------------------
# Stage 3: runtime — minimal image, non-root, healthchecked.
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime
WORKDIR /app

# Default non-root user baked into the official image. The Next
# standalone server only needs read access to the bundled tree
# and write access to /tmp / log targets the orchestrator
# configures externally. We chown the copied artefacts to `node`
# so the runtime user can read its own bundle.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Listen on 3001 to match the rest of the codebase
# (NEXT_PUBLIC_APP_URL, dev cookies, runbooks). Override at run
# time with `-e PORT=...` if the orchestrator wants something else.
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# The standalone tracer emits a self-contained server.js plus the
# minimum node_modules subset under `.next/standalone`. The
# `.next/static` and `public/` trees are NOT included by trace —
# we copy them in alongside.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

# Drop privileges before the entrypoint executes. node:alpine ships
# `node` as uid 1000.
USER node

EXPOSE 3001

# Lightweight liveness probe. /api/v1/health is implemented by
# `apps/web/src/app/api/v1/health/route.ts`; it returns 200 +
# `{status:"ok",db:"ok",...}` when the admin pool round-trip
# works. wget --spider avoids needing curl in the runtime layer.
# `--start-period=20s` covers cold-boot pool warmup; below that
# the orchestrator considers the container "starting" rather than
# unhealthy and does not cycle it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3001/api/v1/health || exit 1

# The standalone runtime entrypoint. Path is set by Next's tracer
# under `apps/web/server.js` inside `.next/standalone`.
CMD ["node", "apps/web/server.js"]
