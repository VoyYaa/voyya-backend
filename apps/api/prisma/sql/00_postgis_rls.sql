-- =============================================================================
-- VoyYa — Complemento SQL a `prisma migrate` (lo que Prisma no gestiona).
-- Ejecutar UNA vez DESPUÉS de `prisma migrate dev/deploy`, con la conexión DIRECTA
-- (DIRECT_URL), como el rol DUEÑO de las tablas.
--
-- Cubre (ver schema.prisma "BLOQUE SQL COMPLEMENTARIO"):
--   (a) PostGIS + columnas geography/geometry generadas + índices GiST
--   (b) Índice único parcial de la toma única (ADR-002)
--   (c) RLS por id_empresa (con WITH CHECK para permitir INSERT/UPDATE del tenant)
--
-- Idempotente (IF [NOT] EXISTS / DROP POLICY IF EXISTS).
-- =============================================================================

-- (a) PostGIS ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;

-- Ubicación del conductor (nearest-first).
ALTER TABLE fleet.conductor
  ADD COLUMN IF NOT EXISTS ubicacion_actual geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN lat_actual IS NOT NULL AND lng_actual IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(lng_actual, lat_actual), 4326)::geography
         ELSE NULL END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_conductor_ubicacion_gist
  ON fleet.conductor USING GIST (ubicacion_actual);

-- Punto de recogida de la solicitud.
ALTER TABLE trips.solicitud_viaje
  ADD COLUMN IF NOT EXISTS ubicacion_recogida geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(lng_recogida, lat_recogida), 4326)::geography
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_solicitud_recogida_gist
  ON trips.solicitud_viaje USING GIST (ubicacion_recogida);

-- Cobertura del municipio (punto ∈ polígono). ST_Multi acepta Polygon o MultiPolygon.
ALTER TABLE tenancy.municipio
  ADD COLUMN IF NOT EXISTS cobertura geometry(MultiPolygon, 4326)
  GENERATED ALWAYS AS (
    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(poligono_cobertura::text), 4326))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_municipio_cobertura_gist
  ON tenancy.municipio USING GIST (cobertura);

-- (b) Toma única: una sola asignación 'aceptada' por solicitud (ADR-002) ------
CREATE UNIQUE INDEX IF NOT EXISTS uq_asignacion_aceptada_por_solicitud
  ON assignment.asignacion (id_solicitud) WHERE estado = 'aceptada';

-- (c) RLS por id_empresa (defensa en profundidad) -----------------------------
-- WITH CHECK es obligatorio para que el tenant pueda INSERT/UPDATE sus propias filas.
-- FORCE (C-2): sin FORCE, el DUEÑO de la tabla IGNORA la RLS (owner-bypass). Si la
-- app conectara con el rol dueño, la RLS quedaría silenciosamente inactiva. FORCE la
-- aplica también al dueño. (Un SUPERUSER siempre la ignora → la app NO debe serlo.)
ALTER TABLE fleet.conductor       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.conductor       FORCE  ROW LEVEL SECURITY;
ALTER TABLE fleet.taxi            ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.taxi            FORCE  ROW LEVEL SECURITY;
ALTER TABLE assignment.asignacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment.asignacion FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_conductor ON fleet.conductor;
CREATE POLICY tenant_isolation_conductor ON fleet.conductor
  USING (id_empresa = current_setting('app.current_empresa', true)::int)
  WITH CHECK (id_empresa = current_setting('app.current_empresa', true)::int);

DROP POLICY IF EXISTS tenant_isolation_taxi ON fleet.taxi;
CREATE POLICY tenant_isolation_taxi ON fleet.taxi
  USING (id_empresa = current_setting('app.current_empresa', true)::int)
  WITH CHECK (id_empresa = current_setting('app.current_empresa', true)::int);

DROP POLICY IF EXISTS tenant_isolation_asignacion ON assignment.asignacion;
CREATE POLICY tenant_isolation_asignacion ON assignment.asignacion
  USING (id_empresa = current_setting('app.current_empresa', true)::int)
  WITH CHECK (id_empresa = current_setting('app.current_empresa', true)::int);

-- IMPORTANTE: el rol de la APP no debe ser superusuario ni tener BYPASSRLS.
-- Las migraciones y este script corren con el rol DUEÑO (DIRECT_URL).

-- (d) ROL DE APP no-dueño (C-2) -----------------------------------------------
-- La app (DATABASE_URL) DEBE conectarse con un rol distinto del dueño, SIN
-- SUPERUSER y SIN BYPASSRLS, para que ENABLE/FORCE RLS aplique de verdad.
-- Ejecutar como admin/dueño (ajustar contraseña por entorno / secret manager).
--
--   CREATE ROLE app_voyya LOGIN PASSWORD :'app_pwd' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--   GRANT USAGE ON SCHEMA auth, tenancy, users, fleet, trips, assignment, admin TO app_voyya;
--   GRANT SELECT, INSERT, UPDATE, DELETE
--     ON ALL TABLES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     TO app_voyya;
--   GRANT USAGE, SELECT ON ALL SEQUENCES
--     IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin TO app_voyya;
--   -- Que los objetos futuros (nuevas migraciones) hereden los grants:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_voyya;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     GRANT USAGE, SELECT ON SEQUENCES TO app_voyya;
--
-- (e) VERIFICACIÓN EN DEPLOY (C-2) --------------------------------------------
-- Debe devolver rolsuper=f y rolbypassrls=f para el rol de la app:
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_voyya';
-- Debe devolver relrowsecurity=t y relforcerowsecurity=t en las 3 tablas tenant:
--   SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN ('conductor','taxi','asignacion');
--
-- NOTA: en Supabase, el rol `postgres` es dueño; crear un rol de app dedicado
-- (o usar el rol `authenticated`/servicio con RLS) y apuntar DATABASE_URL a él.
-- TODO(Ciclo Auth · C-1): al integrar JWT, propagar el tenant real al set_config.
