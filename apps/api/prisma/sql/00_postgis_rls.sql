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
--   (f) Trip lifecycle partial indexes (ADR-010)
--   (g) Ops console live queue (ADR-015)
--   (h) RLS by company_id — trips.fare_config and admin.system_parameter (ADR-018)
--   (i) One open fare version per company and service type (ADR-018, closes B-13)
--   (j) RLS by company_id — affiliation documents and reviews (ADR-021)
--   (k) RLS by company_id — settlement remittances and export audit (ADR-027)
--   (l) Uniqueness and purge support (ADR-027, ADR-029, ADR-030)
--   (m) Unassigned-trip probe (CM-14)
--   (n) RLS on trips.trip_request scoped to tenant sessions + function permissions (ADR-032 section 3)
--   (o) RLS and append-only privileges — municipality fare, operational params, company commission (ADR-032 section 4.4)
--   (p) One open version per key (ADR-032 section 4)
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

-- (f) Trip lifecycle partial indexes (ADR-010) ---------------------------------
CREATE INDEX IF NOT EXISTS idx_trip_request_cash_pending
  ON trips.trip_request (trip_request_id)
  WHERE status = 'completed' AND cash_collected_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trip_request_penalty
  ON trips.trip_request (passenger_id, finished_at)
  WHERE penalty_recorded;

-- (g) Ops console live queue (ADR-015) ------------------------------------------
CREATE INDEX IF NOT EXISTS idx_trip_request_ops_queue
  ON trips.trip_request (municipality_id, updated_at DESC);

-- (h) RLS by company_id — trips.fare_config and admin.system_parameter (ADR-018) ---
ALTER TABLE trips.fare_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips.fare_config       FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin.system_parameter  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.system_parameter  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_fare_config ON trips.fare_config;
CREATE POLICY tenant_isolation_fare_config ON trips.fare_config
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_isolation_system_parameter ON admin.system_parameter;
CREATE POLICY tenant_isolation_system_parameter ON admin.system_parameter
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

-- (i) One open fare version per company and service type (ADR-018, closes B-13) ----
CREATE UNIQUE INDEX IF NOT EXISTS uq_fare_config_open_per_company_service
  ON trips.fare_config (company_id, service_type) WHERE valid_to IS NULL;

-- (j) RLS by company_id — affiliation documents and reviews (ADR-021) -----------
ALTER TABLE tenancy.company_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_document FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_review   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_review   FORCE  ROW LEVEL SECURITY;
ALTER TABLE fleet.driver_document    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet.driver_document    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_company_document ON tenancy.company_document;
CREATE POLICY tenant_isolation_company_document ON tenancy.company_document
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_isolation_company_review ON tenancy.company_review;
CREATE POLICY tenant_isolation_company_review ON tenancy.company_review
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_isolation_driver_document ON fleet.driver_document;
CREATE POLICY tenant_isolation_driver_document ON fleet.driver_document
  USING (company_id = current_setting('app.current_company', true)::int)
  WITH CHECK (company_id = current_setting('app.current_company', true)::int);

-- (k) RLS by company_id — settlement remittances and export audit (ADR-027) — append-only ---
ALTER TABLE admin.settlement_remittance ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.settlement_remittance FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin.settlement_export     ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.settlement_export     FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select_settlement_remittance ON admin.settlement_remittance;
CREATE POLICY tenant_select_settlement_remittance ON admin.settlement_remittance
  FOR SELECT USING (company_id = current_setting('app.current_company', true)::int);
DROP POLICY IF EXISTS tenant_insert_settlement_remittance ON admin.settlement_remittance;
CREATE POLICY tenant_insert_settlement_remittance ON admin.settlement_remittance
  FOR INSERT WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DROP POLICY IF EXISTS tenant_select_settlement_export ON admin.settlement_export;
CREATE POLICY tenant_select_settlement_export ON admin.settlement_export
  FOR SELECT USING (company_id = current_setting('app.current_company', true)::int);
DROP POLICY IF EXISTS tenant_insert_settlement_export ON admin.settlement_export;
CREATE POLICY tenant_insert_settlement_export ON admin.settlement_export
  FOR INSERT WITH CHECK (company_id = current_setting('app.current_company', true)::int);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    REVOKE UPDATE, DELETE ON admin.settlement_remittance, admin.settlement_export FROM app_voyya;
    REVOKE UPDATE, DELETE ON auth.consent_record, auth.consent_notice FROM app_voyya;
    REVOKE DELETE ON auth."user" FROM app_voyya;
  END IF;
END
$$;

-- (l) Uniqueness and purge support (ADR-027, ADR-029, ADR-030) ----------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_completed_per_trip_request
  ON assignment.assignment (trip_request_id) WHERE status = 'completed';

DO $$
BEGIN
  IF EXISTS (
    SELECT passenger_id FROM trips.trip_request
     WHERE status IN ('pending_assignment', 'assigned', 'driver_en_route', 'in_progress')
     GROUP BY passenger_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ADR-030: some passengers have more than one active trip request; expire the older ones before release';
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_request_active_per_passenger
  ON trips.trip_request (passenger_id)
  WHERE status IN ('pending_assignment', 'assigned', 'driver_en_route', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_trip_request_coordinates_purge
  ON trips.trip_request (COALESCE(finished_at, requested_at))
  WHERE location_purged_at IS NULL;

-- (m) Unassigned-trip probe: bypass RLS only through its owner, callable only by the runtime role (CM-14) ---
ALTER FUNCTION assignment.trip_has_assignment(integer) SET row_security = off;
REVOKE EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    GRANT EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) TO app_voyya;
  END IF;
END
$$;


-- (n) RLS on trips.trip_request, scoped to tenant sessions (ADR-032 section 3) ----------------------
ALTER TABLE trips.trip_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips.trip_request FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_scope_trip_request ON trips.trip_request;
CREATE POLICY company_scope_trip_request ON trips.trip_request
  USING (
    CASE
      WHEN nullif(current_setting('app.current_company', true), '') IS NULL THEN true
      ELSE company_id = nullif(current_setting('app.current_company', true), '')::int
        OR (company_id IS NULL
            AND addressed_company_id = nullif(current_setting('app.current_company', true), '')::int)
        OR assignment.company_has_live_assignment(trip_request_id, status = 'pending_assignment')
    END
  )
  WITH CHECK (
    CASE
      WHEN nullif(current_setting('app.current_company', true), '') IS NULL THEN true
      ELSE company_id IS NULL OR company_id = nullif(current_setting('app.current_company', true), '')::int
    END
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    GRANT EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) TO app_voyya;
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) FROM PUBLIC;

-- (o) RLS and append-only privileges — municipality fare, operational params, company commission (ADR-032 section 4.4) ---
ALTER TABLE trips.municipality_fare ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips.municipality_fare FORCE  ROW LEVEL SECURITY;
ALTER TABLE admin.municipality_operational_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.municipality_operational_params FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_commission ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.company_commission FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_municipality_fare ON trips.municipality_fare;
CREATE POLICY read_municipality_fare ON trips.municipality_fare FOR SELECT USING (true);
DROP POLICY IF EXISTS platform_insert_municipality_fare ON trips.municipality_fare;
CREATE POLICY platform_insert_municipality_fare ON trips.municipality_fare FOR INSERT
  WITH CHECK (current_setting('app.platform_session', true) = 'on');
DROP POLICY IF EXISTS platform_close_municipality_fare ON trips.municipality_fare;
CREATE POLICY platform_close_municipality_fare ON trips.municipality_fare FOR UPDATE
  USING (current_setting('app.platform_session', true) = 'on' AND valid_to IS NULL)
  WITH CHECK (current_setting('app.platform_session', true) = 'on'
              AND valid_to IS NOT NULL
              AND valid_to BETWEEN (now() AT TIME ZONE 'UTC') - interval '1 minute'
                               AND (now() AT TIME ZONE 'UTC') + interval '1 minute');

DROP POLICY IF EXISTS read_municipality_operational_params ON admin.municipality_operational_params;
CREATE POLICY read_municipality_operational_params ON admin.municipality_operational_params FOR SELECT USING (true);
DROP POLICY IF EXISTS platform_insert_municipality_operational_params ON admin.municipality_operational_params;
CREATE POLICY platform_insert_municipality_operational_params ON admin.municipality_operational_params FOR INSERT
  WITH CHECK (current_setting('app.platform_session', true) = 'on');
DROP POLICY IF EXISTS platform_close_municipality_operational_params ON admin.municipality_operational_params;
CREATE POLICY platform_close_municipality_operational_params ON admin.municipality_operational_params FOR UPDATE
  USING (current_setting('app.platform_session', true) = 'on' AND valid_to IS NULL)
  WITH CHECK (current_setting('app.platform_session', true) = 'on'
              AND valid_to IS NOT NULL
              AND valid_to BETWEEN (now() AT TIME ZONE 'UTC') - interval '1 minute'
                               AND (now() AT TIME ZONE 'UTC') + interval '1 minute');

DROP POLICY IF EXISTS read_company_commission ON tenancy.company_commission;
CREATE POLICY read_company_commission ON tenancy.company_commission FOR SELECT
  USING (current_setting('app.platform_session', true) = 'on'
         OR company_id = nullif(current_setting('app.current_company', true), '')::int);
DROP POLICY IF EXISTS platform_insert_company_commission ON tenancy.company_commission;
CREATE POLICY platform_insert_company_commission ON tenancy.company_commission FOR INSERT
  WITH CHECK (current_setting('app.platform_session', true) = 'on');
DROP POLICY IF EXISTS platform_close_company_commission ON tenancy.company_commission;
CREATE POLICY platform_close_company_commission ON tenancy.company_commission FOR UPDATE
  USING (current_setting('app.platform_session', true) = 'on' AND valid_to IS NULL)
  WITH CHECK (current_setting('app.platform_session', true) = 'on'
              AND valid_to IS NOT NULL
              AND valid_to BETWEEN (now() AT TIME ZONE 'UTC') - interval '1 minute'
                               AND (now() AT TIME ZONE 'UTC') + interval '1 minute');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    REVOKE UPDATE, DELETE ON trips.municipality_fare, admin.municipality_operational_params, tenancy.company_commission FROM app_voyya;
    GRANT UPDATE (valid_to) ON trips.municipality_fare, admin.municipality_operational_params, tenancy.company_commission TO app_voyya;
  END IF;
END
$$;

-- (p) One open version per key (ADR-032 section 4) ----------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_municipality_fare_open
  ON trips.municipality_fare (municipality_id, service_type) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_municipality_operational_params_open
  ON admin.municipality_operational_params (municipality_id, service_type) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_commission_open
  ON tenancy.company_commission (company_id) WHERE valid_to IS NULL;
