# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .
RUN npx prisma generate
RUN --mount=type=cache,target=/app/.build_cache \
    npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --omit=optional

# Copy prisma schema + generated client from builder
COPY --from=builder /app/node_modules/.prisma        ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Copy compiled output
COPY --from=builder /app/dist ./dist
# Engine pair configs and its plain-SQL migrations are read at runtime
COPY --from=builder /app/pairs ./pairs
COPY --from=builder /app/sql ./sql
# Admin helper: create a login (no public sign-up)
COPY --from=builder /app/scripts/create-user.js ./scripts/create-user.js
COPY --from=builder /app/scripts/start-all.js ./scripts/start-all.js

EXPOSE 3069

CMD ["node", "dist/src/main"]
