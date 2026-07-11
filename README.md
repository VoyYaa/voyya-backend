# backend-yavoy

Backend **standalone** de VoyYa (plataforma de taxis para municipios de Colombia). Monolito modular
**NestJS 10 + PostgreSQL/Prisma (+ PostGIS)**, en un workspace pnpm con los contratos compartidos
`@voyya/shared`. Diseñado para desplegar en **Railway** (Docker) con base de datos **Neon**.

- API: `apps/api` (NestJS). Contratos Zod: `packages/shared`.
- Auth: JWT (access) + refresh opaco revocable; RBAC + multi-tenant (RLS). OTP por SMS (Twilio en prod).
- Núcleo: solicitud de taxi + asignación con **toma única atómica**.

## Estructura

```
backend-yavoy/
├── apps/api/                 # NestJS (API)
│   ├── prisma/
│   │   ├── schema.prisma     # datasource: url=DATABASE_URL, directUrl=DIRECT_URL
│   │   ├── migrations/       # migración base (prisma migrate deploy)
│   │   ├── sql/00_postgis_rls.sql   # PostGIS + RLS + índice único parcial (correr UNA vez)
│   │   └── seed.ts
│   └── src/
├── packages/shared/          # @voyya/shared (Zod, DTOs, máquina de estados)
├── Dockerfile                # multi-stage Node 20; build + migrate deploy + start
├── railway.json              # builder DOCKERFILE + healthcheck /health
├── pnpm-workspace.yaml · turbo.json · tsconfig.base.json
└── .env.example              # plantilla (SIN credenciales)
```

## Desarrollo local

```bash
pnpm install
cp .env.example .env          # y completa los valores (ver tabla)
pnpm build                    # turbo: shared → api (corre prisma generate)
pnpm --filter @voyya/api dev  # API en http://localhost:3000  (GET /health)
pnpm test                     # tests (no requieren DB; los e2e reales son gated por PG_TEST_URL)
```

## Variables de entorno

Definir en Railway (Service → Variables) y, para local, en `.env`. **Nunca** commitear valores reales.

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | sí | Neon **pooled** (`...-pooler...?sslmode=require&pgbouncer=true`). La usa la app. |
| `DIRECT_URL` | sí | Neon **unpooled** (`...?sslmode=require`). La usan las migraciones. |
| `JWT_SECRET` | sí | ≥32 caracteres aleatorios (`openssl rand -base64 48`). |
| `QUOTE_TOKEN_SECRET` | sí | ≥32 caracteres aleatorios. |
| `AUTH_DEV_HEADERS` | sí | `false` en producción (el gate se ignora igual en prod). |
| `CORS_ORIGINS` | no | Allowlist separada por comas (orígenes de la consola/PWA). Vacío = sin CORS. |
| `TWILIO_ACCOUNT_SID` | prod | SID de Twilio (empieza con `AC`). Sin las 3 TWILIO_*, el arranque en prod FALLA. |
| `TWILIO_AUTH_TOKEN` | prod | Token de Twilio (secreto). |
| `TWILIO_FROM_NUMBER` | prod | Número emisor E.164 (p. ej. `+1XXXXXXXXXX`). |

> `PORT` lo inyecta Railway automáticamente (la API lo respeta; fallback `API_PORT=3000`).
> Parámetros del motor/OTP/throttle tienen defaults en `apps/api/src/config/env.schema.ts` (no obligatorios).
> Nota Neon: usar `sslmode=require`. Si Prisma se queja de `channel_binding`, quítalo del query string.

## Base de datos (Neon) — preparación por ÚNICA vez

Prisma crea las tablas base (`migrate deploy`), pero **PostGIS, las columnas geográficas generadas, la RLS
y el índice único parcial NO los gestiona Prisma**: se aplican una vez con el SQL complementario, usando la
conexión **DIRECT_URL** (sin pooler) y el rol dueño.

1. Crea el proyecto/branch en Neon y copia las dos cadenas (pooled → `DATABASE_URL`, unpooled → `DIRECT_URL`).
2. Aplica las migraciones base (o deja que lo haga el contenedor al arrancar — ver Despliegue):
   ```bash
   DIRECT_URL="postgresql://…?sslmode=require" pnpm db:deploy
   ```
3. Aplica el complemento PostGIS + RLS + índice único parcial (una sola vez, con DIRECT_URL):
   ```bash
   psql "postgresql://…?sslmode=require" -f apps/api/prisma/sql/00_postgis_rls.sql
   ```
4. (Recomendado) Crea el **rol de app no-dueño** (sin `SUPERUSER`/`BYPASSRLS`) para que la RLS aplique de
   verdad, y apunta `DATABASE_URL` a ese rol (dejando `DIRECT_URL` con el rol dueño para migraciones). El
   script comentado y la verificación (`rolsuper=f`, `rolbypassrls=f`) están al final de
   `apps/api/prisma/sql/00_postgis_rls.sql` (secciones (d) y (e)). Ejecutarlo con DIRECT_URL/rol dueño.
5. (Opcional, datos de prueba) `pnpm db:seed` — crea municipio Yarumal, empresa Cootrayal, admin y conductores.

## Despliegue en Railway

1. **Conecta el repo**: Railway → *New Project* → *Deploy from GitHub repo* → selecciona este repositorio
   (`backend-yavoy`). Railway detecta `railway.json` y construye con el **Dockerfile** (no usa Nixpacks).
2. **Base de datos**: crea la DB en **Neon** (fuera de Railway) y copia las dos URLs.
3. **Variables**: en el Service → *Variables*, define todas las de la tabla de arriba (`DATABASE_URL`,
   `DIRECT_URL`, `JWT_SECRET`, `QUOTE_TOKEN_SECRET`, `AUTH_DEV_HEADERS=false`, `CORS_ORIGINS`, y las
   `TWILIO_*`). `PORT` lo pone Railway solo.
4. **Deploy**: al desplegar, el contenedor ejecuta `prisma migrate deploy` (aplica las migraciones usando
   `DIRECT_URL`) y luego `node apps/api/dist/main.js`. `migrate deploy` es idempotente.
5. **Preparación única de Neon**: corre **una vez** los pasos 3–4 de la sección anterior
   (`00_postgis_rls.sql` + rol de app). Sin PostGIS/RLS, la asignación por cercanía y el aislamiento
   multi-tenant no funcionan.
6. **Healthcheck**: Railway usa `GET /health` (definido en `railway.json`). Debe responder `200 { status: 'ok' }`.
7. **Dominio**: expón el servicio (Railway → *Settings* → *Networking* → *Generate Domain*) y usa esa URL
   (con TLS) como base para las apps móviles/consola. Añade el/los orígenes web a `CORS_ORIGINS`.

## Notas

- **Migraciones**: la carpeta `apps/api/prisma/migrations/` contiene la migración base generada desde el
  schema. Nuevos cambios de modelo → `pnpm --filter @voyya/api exec prisma migrate dev --name <cambio>` en
  local (contra una DB de desarrollo) y commitear la migración; Railway la aplica con `migrate deploy`.
- **Secretos**: `.env` está en `.gitignore`; solo se versiona `.env.example` (placeholders).
- **Imagen**: Node 20 slim + OpenSSL (requerido por los motores de Prisma).
