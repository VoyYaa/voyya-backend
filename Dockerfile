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

# `prisma generate` (prebuild de la API) exige que exista DATABASE_URL, aunque NO se
# conecta en build. Placeholder SOLO de build (no es secreto; el runtime recibe el
# real desde Railway). No se hereda al stage runner.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

# 1) Manifiestos primero (capa cacheable de dependencias).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

# 2) Código fuente + build (turbo: shared → api; la API corre `prisma generate` en prebuild).
COPY . .
RUN pnpm build

# 3) Poda devDependencies (jest, ts-node, @nestjs/cli, typescript, …). `prisma` (CLI)
# vive en "dependencies" de apps/api precisamente para sobrevivir a esta poda.
RUN pnpm prune --prod

# ---- Runner -----------------------------------------------------------------
FROM node:20-slim AS runner
ENV NODE_ENV="production" PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Manifiestos del workspace: `pnpm --filter` los necesita para resolver el proyecto.
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json

# node_modules ya podado a solo dependencias de producción (incluye el cliente Prisma
# generado en node_modules/.pnpm/@prisma+client*; la CLI de Prisma no se usa en
# runtime, solo en build para `prisma generate` y aparte en `db:release`).
# Se copian los 3 niveles (raíz + cada workspace) para preservar los symlinks de pnpm.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Artefactos compilados (shared se construye antes que api vía turbo).
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Prisma: solo el schema (lo exige el cliente generado en runtime). Las migraciones y
# el SQL de PostGIS/RLS ya NO corren en el contenedor: son el paso de release
# `db:release`, ejecutado aparte por el operador/CI con la credencial del rol dueño
# (ver ADR-006). El contenedor solo conecta, nunca migra.
COPY --from=builder /app/apps/api/prisma/schema.prisma ./apps/api/prisma/schema.prisma

EXPOSE 3000

CMD ["node", "apps/api/dist/main.js"]
