# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# NexusPrice — Next.js app image (the request/response process).
#
# Multi-stage: deps -> builder -> runner. The final image ships only Next's
# `output: "standalone"` tree (server.js + traced node_modules), which is far
# smaller than a full `npm ci` install. The standalone output does NOT include
# public/ or .next/static, so those are copied in explicitly (see output.md).
#
# The worker is a *separate* image (Dockerfile.worker) — it runs TypeScript
# via tsx and can't use standalone output. See README "Architecture".
# ---------------------------------------------------------------------------

# Next 16 requires Node >=20.9.0 (next/package.json engines); 22 is what CI and
# BENCHMARKS.md use. Alpine keeps the image small; libc6-compat covers native
# addons that expect glibc symbols.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat

# --- deps: install node_modules from the lockfile, in isolation so it caches
# independently of source changes ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: produce .next/standalone ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must not require MONGODB_URI / ALCHEMY_API_KEY / NEXTAUTH_SECRET —
# those are runtime concerns (same contract the CI build job enforces).
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner: minimal runtime image ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# server.js honors PORT/HOSTNAME; bind all interfaces so the container is
# reachable on the published port.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user rather than the default root.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# public/ and .next/static are NOT part of standalone output — copy them in
# so server.js can serve static assets and the built client chunks.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
