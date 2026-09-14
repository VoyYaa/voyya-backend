# backend-yavoy

Backend **standalone** de VoyYa (plataforma de taxis para municipios de Colombia). Monolito modular
**NestJS 10 + PostgreSQL 16/Prisma (+ PostGIS)**, en un workspace pnpm con los contratos compartidos
`@voyya/shared`. Diseñado para desplegar en **Railway** (Docker) con base de datos **PostgreSQL 16 +
PostGIS también en Railway** (no Neon).

- API: `apps/api` (NestJS). Contratos Zod: `packages/shared`.
- Auth: JWT (access) + refresh opaco revocable; RBAC + multi-tenant (RLS). OTP por SMS (Twilio en prod).
- Núcleo: solicitud de taxi + asignación con **toma única atómica**.
- **La aplicación solo se conecta a la base de datos; nunca migra** (ADR-006). Las migraciones y el SQL
  complementario de PostGIS/RLS son un paso de release aparte (`db:release`), ejecutado por el
  operador/CI con credenciales de dueño — nunca por el contenedor en runtime.

## Estructura

```
backend-yavoy/
├── apps/api/                 # NestJS (API)
│   ├── prisma/
│   │   ├── schema.prisma     # datasource: url=DATABASE_URL (una sola conexión de runtime)
│   │   ├── migrations/       # migraciones versionadas (aplicadas por `db:release`, nunca en el arranque)
│   │   ├── sql/00_postgis_rls.sql   # PostGIS + RLS + índice único parcial (aplicado en cada release)
│   │   └── seed.ts
│   └── src/
│       └── infrastructure/prisma/
│           ├── prisma.service.ts              # conexión con backoff, nunca migra
│           └── database-preflight.service.ts  # verifica rol/RLS/PostGIS al arrancar
├── packages/shared/          # @voyya/shared (Zod, DTOs, máquina de estados)
├── Dockerfile                # multi-stage Node 20; build + start (sin migrar)
├── railway.json              # builder DOCKERFILE + healthcheck /health (sin migrar en el arranque)
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

> **Importante:** `DATABASE_URL` en local (y en `.env`) debe apuntar al rol de aplicación
> `app_voyya` (NOSUPERUSER/NOBYPASSRLS), **no** al rol dueño. Es la única forma de detectar en tu
> máquina, antes de desplegar, una consulta que se olvidó de pasar por `runInTenant` (ver
> "Riesgo de regresión" más abajo).

## Variables de entorno

Definir en Railway (Service → Variables) y, para local, en `.env`. **Nunca** commitear valores reales.

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | sí | **Única** conexión de la aplicación (runtime). Rol **`app_voyya`** (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`). En local: `postgresql://app_voyya:app_voyya_dev_pw@localhost:5459/voyya`. En Railway: la cadena de `app_voyya` sobre `postgis.railway.internal`. |
| `DB_CONNECT_MAX_ATTEMPTS` | no | Intentos de `$connect()` con backoff exponencial antes de abortar el arranque. Default `6`. |
| `DB_CONNECT_RETRY_BASE_MS` | no | Base (ms) del backoff exponencial entre reintentos de conexión. Default `500`. |
| `JWT_SECRET` | sí | ≥32 caracteres aleatorios (`openssl rand -base64 48`). |
| `QUOTE_TOKEN_SECRET` | sí | ≥32 caracteres aleatorios. |
| `AUTH_DEV_HEADERS` | sí | `false` en producción (el gate se ignora igual en prod). |
| `CORS_ORIGINS` | no | Allowlist separada por comas (orígenes de la consola/PWA). Vacío = sin CORS. |
| `TWILIO_ACCOUNT_SID` | prod | SID de Twilio (empieza con `AC`). Sin las 3 TWILIO_*, el arranque en prod FALLA. |
| `TWILIO_AUTH_TOKEN` | prod | Token de Twilio (secreto). |
| `TWILIO_FROM_NUMBER` | prod | Número emisor E.164 (p. ej. `+1XXXXXXXXXX`). |

> `PORT` lo inyecta Railway automáticamente (la API lo respeta; fallback `API_PORT=3000`).
> Parámetros del motor/OTP/throttle tienen defaults en `apps/api/src/config/env.schema.ts` (no obligatorios).
> **`DIRECT_URL` ya no existe** (ADR-006): con una sola conexión de runtime no hace falta distinguir
> "pooled/unpooled"; hoy no hay pooler.

### Credencial de dueño (solo para `db:release`, nunca variable del servicio)

`VOYYA_DB_OWNER_URL` **no** es una variable de la aplicación: vive solo en el entorno del operador (y,
cuando exista el pipeline, como secreto de GitHub Actions). Se usa **exclusivamente** para ejecutar
`db:release` (migraciones + SQL de PostGIS/RLS). **Nunca** se define en Railway → Service → Variables.

- Local: `VOYYA_DB_OWNER_URL=postgresql://voyya_owner:voyya_dev_pw@localhost:5459/voyya`
- Railway: la cadena del rol dueño sobre `postgis.railway.internal`, guardada en el gestor de secretos
  del operador — no en las variables del servicio de la API.

## Base de datos (PostgreSQL 16 + PostGIS en Railway) — aprovisionamiento por ÚNICA vez

Prisma crea las tablas base (`migrate deploy`), pero **PostGIS, las columnas geográficas generadas, la
RLS y el índice único parcial NO los gestiona Prisma**: se aplican con el SQL complementario
(`00_postgis_rls.sql`), encadenado con las migraciones en el script `db:release`, usando la conexión
del **rol dueño**.

1. Crea la base PostgreSQL 16 + PostGIS (en Railway o en tu contenedor local) y anota la cadena del rol
   dueño (superusuario de aprovisionamiento, p. ej. `voyya_owner`).
2. Crea el **rol de aplicación no-dueño** `app_voyya` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
   con los grants sobre los 7 schemas — sección comentada (d) de
   `apps/api/prisma/sql/00_postgis_rls.sql`. Es aprovisionamiento **por única vez** (lleva contraseña
   propia del entorno) y se ejecuta con la credencial de dueño.
3. Ejecuta el release (migraciones + PostGIS + RLS + índice único parcial), siempre con la credencial
   del rol dueño:
   ```bash
   DATABASE_URL="$VOYYA_DB_OWNER_URL" pnpm --filter @voyya/api run db:release
   # = prisma migrate deploy && prisma db execute --file prisma/sql/00_postgis_rls.sql
   ```
   Es idempotente: se puede correr en cada release sin efectos secundarios.
4. (Opcional, datos de prueba) `DATABASE_URL="$VOYYA_DB_OWNER_URL" pnpm --filter @voyya/api run db:seed`
   — crea municipio Yarumal, empresa Cootrayal, admin y conductores. El seed inserta a través de varios
   tenants, así que corre siempre con la credencial de dueño, fuera del runtime de la aplicación.
5. Apunta `DATABASE_URL` (variable de la aplicación, en Railway o en `.env`) al rol **`app_voyya`**.

## Despliegue en Railway

1. **Conecta el repo**: Railway → *New Project* → *Deploy from GitHub repo* → selecciona este repositorio
   (`backend-yavoy`). Railway detecta `railway.json` y construye con el **Dockerfile** (no usa Nixpacks).
2. **Base de datos**: PostgreSQL 16 + PostGIS en Railway (mismo proyecto o servicio aparte). Anota la
   cadena del rol dueño (para `db:release`, fuera del servicio de la API) y la del rol `app_voyya` (para
   `DATABASE_URL` de la API).
3. **Variables del servicio de la API**: `DATABASE_URL` (rol `app_voyya`), `JWT_SECRET`,
   `QUOTE_TOKEN_SECRET`, `AUTH_DEV_HEADERS=false`, `CORS_ORIGINS`, las `TWILIO_*`, y opcionalmente
   `DB_CONNECT_MAX_ATTEMPTS`/`DB_CONNECT_RETRY_BASE_MS`. **No** definas `DIRECT_URL` ni
   `VOYYA_DB_OWNER_URL` aquí — el servicio de la API nunca debe tener credenciales de dueño. `PORT` lo
   pone Railway solo.
4. **Orden obligatorio del release**: `db:release` (con `VOYYA_DB_OWNER_URL`, desde tu máquina o desde
   CI) **antes** de promover el deploy de la nueva imagen:
   ```bash
   DATABASE_URL="$VOYYA_DB_OWNER_URL" pnpm --filter @voyya/api run db:release
   ```
   Recién entonces despliega/promueve la imagen. El contenedor **ya no ejecuta `prisma migrate deploy`**
   al arrancar: solo `node apps/api/dist/main.js`, que se conecta (con reintentos y backoff) y valida
   las invariantes de RLS/PostGIS (`DatabasePreflightService`) antes de servir tráfico en producción.
5. **Healthcheck**: Railway usa `GET /health` (liveness, sin tocar la base — definido en `railway.json`).
   Debe responder `200 { status: 'ok' }`. `GET /health/db` es *readiness* (`SELECT 1` + preflight):
   `200` si todo bien, `503` si no.
6. **Dominio**: expón el servicio (Railway → *Settings* → *Networking* → *Generate Domain*) y usa esa URL
   (con TLS) como base para las apps móviles/consola. Añade el/los orígenes web a `CORS_ORIGINS`.

## Migraciones compatibles hacia atrás

Como el release tiene dos pasos ordenados (`db:release` → deploy de la imagen), durante la ventana entre
ambos conviven el esquema nuevo y el código viejo. Toda migración debe seguir el patrón
**expand → migrate → contract**: agrega columnas/tablas nuevas como nullable u opcionales primero,
despliega el código que las usa, y solo en un cambio posterior elimina lo viejo. A este volumen (una
empresa, un municipio) la ventana es de minutos.

## Riesgo de regresión: RLS fail-closed sin `runInTenant`

`fleet.driver`, `fleet.vehicle` y `assignment.assignment` tienen `FORCE ROW LEVEL SECURITY`. Cualquier
consulta sobre esas tablas que **no** pase por `PrismaService.runInTenant(companyId, …)` (que setea
`app.current_company` en la transacción) devuelve **0 filas** con el rol `app_voyya` — nunca un error, ni
una fuga entre tenants. Antes de tocar esas tablas, corre la suite completa apuntando `DATABASE_URL`
local a `app_voyya` (no al rol dueño): es la forma de descubrir el bug en tu máquina, no en Yarumal.

## Notas

- **Migraciones**: la carpeta `apps/api/prisma/migrations/` contiene las migraciones versionadas. Nuevos
  cambios de modelo → `pnpm --filter @voyya/api exec prisma migrate dev --name <cambio>` en local (contra
  una DB de desarrollo) y commitear la migración; se aplican en producción con `db:release`, nunca con
  el contenedor.
- **Secretos**: `.env` está en `.gitignore`; solo se versiona `.env.example` (placeholders).
- **Imagen**: Node 20 slim + OpenSSL (requerido por los motores de Prisma).
