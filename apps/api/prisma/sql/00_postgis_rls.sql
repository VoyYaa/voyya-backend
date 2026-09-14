-- =============================================================================
-- VoyYa - SQL complement to `prisma migrate` (what Prisma does not manage).
-- Applied on every release by `pnpm --filter @voyya/api run db:release`
-- (= `prisma migrate deploy` && this file), with the connection of the table
-- OWNER role (never the app runtime role). See ADR-006.
--
-- Covers:
--   (a) PostGIS + generated geography/geometry columns + GiST indexes
--   (b) Partial unique index for the single-take (ADR-002)
--   (c) RLS by company_id (with WITH CHECK for tenant INSERT/UPDATE)
--   (d) Non-owner app role
--   (e) Deploy verification
--
-- Idempotent (IF [NOT] EXISTS / DROP POLICY IF EXISTS).
-- =============================================================================

-- (a) PostGIS ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE fleet.driver
  ADD COLUMN IF NOT EXISTS current_location geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN current_lat IS NOT NULL AND current_lng IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(current_lng, current_lat), 4326)::geography
         ELSE NULL END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_driver_current_location_gist
  ON fleet.driver USING GIST (current_location);

ALTER TABLE trips.trip_request
  ADD COLUMN IF NOT EXISTS pickup_location geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_trip_request_pickup_location_gist
  ON trips.trip_request USING GIST (pickup_location);

ALTER TABLE tenancy.municipality
  ADD COLUMN IF NOT EXISTS coverage geometry(MultiPolygon, 4326)
  GENERATED ALWAYS AS (
    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(coverage_polygon::text), 4326))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_municipality_coverage_gist
  ON tenancy.municipality USING GIST (coverage);

-- (b) Single-take: one accepted assignment per trip request (ADR-002) ----------
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_accepted_per_trip_request
  ON assignment.assignment (trip_request_id) WHERE status = 'accepted';

-- (c) RLS by company_id (defense in depth) -------------------------------------
ALTER TABLE fleet.driver           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.driver           FORCE  ROW LEVEL SECURITY;
ALTER TABLE fleet.vehicle          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.vehicle          FORCE  ROW LEVEL SECURITY;
ALTER TABLE assignment.assignment  ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment.assignment  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_driver ON fleet.driver;
CREATE POLICY tenant_isolation_driver ON fleet.driver
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_isolation_vehicle ON fleet.vehicle;
CREATE POLICY tenant_isolation_vehicle ON fleet.vehicle
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_isolation_assignment ON assignment.assignment;
CREATE POLICY tenant_isolation_assignment ON assignment.assignment
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

-- (d) Non-owner app role (run as owner; adjust password per environment) --------
--   CREATE ROLE app_voyya LOGIN PASSWORD :'app_pwd' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--   GRANT USAGE ON SCHEMA auth, tenancy, users, fleet, trips, assignment, admin TO app_voyya;
--   GRANT SELECT, INSERT, UPDATE, DELETE
--     ON ALL TABLES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     TO app_voyya;
--   GRANT USAGE, SELECT ON ALL SEQUENCES
--     IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin TO app_voyya;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_voyya;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
--     GRANT USAGE, SELECT ON SEQUENCES TO app_voyya;

-- (e) Deploy verification ------------------------------------------------------
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_voyya';
--   SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN ('driver','vehicle','assignment');
