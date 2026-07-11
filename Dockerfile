# =============================================================================
# VoyYa Backend — imagen multi-stage para Railway. Node 20 (Debian slim) + pnpm.
# =============================================================================

# ---- Builder ----------------------------------------------------------------
FROM node:20-slim AS builder
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
# OpenSSL/ca-certificates: requeridos por los motores de Prisma.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# `prisma generate` (prebuild de la API) exige que exista DATABASE_URL/DIRECT_URL,
# aunque NO se conecta en build. Placeholders SOLO de build (no son secretos; el
# runtime recibe los reales desde Railway). No se heredan al stage runner.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    DIRECT_URL="postgresql://build:build@localhost:5432/build?schema=public"

# 1) Manifiestos primero (capa cacheable de dependencias).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

# 2) Código fuente + build (turbo: shared → api; la API corre `prisma generate` en prebuild).
COPY . .
RUN pnpm build

# ---- Runner -----------------------------------------------------------------
FROM node:20-slim AS runner
ENV NODE_ENV="production" PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Copia el workspace ya construido: node_modules (incluye la CLI de Prisma para
# `migrate deploy` y el cliente generado), dist de shared y api, schema y migraciones.
COPY --from=builder /app ./

EXPOSE 3000

# Aplica migraciones pendientes (Prisma usa DIRECT_URL del datasource) y arranca la API.
# migrate deploy es idempotente; si no hay pendientes, no hace nada.
CMD ["sh", "-c", "pnpm --filter @voyya/api exec prisma migrate deploy && node apps/api/dist/main.js"]
