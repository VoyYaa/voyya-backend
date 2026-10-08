-- =============================================================================
-- VoyYa - ADR-032 baseline. Read-only. Run BEFORE `db:release`, with the owner
-- connection (VOYYA_DB_OWNER_URL, exported in your terminal; never paste it):
--
--   psql "$VOYYA_DB_OWNER_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/sql/verify-adr-032-baseline.sql
--
-- Keep the output. The second file (verify-adr-032.sql) repeats B-2 after the
-- release and the fingerprint must match.
--
-- If B-1 shows a commission_pct greater than 50, do NOT run db:release: the
-- second migration stops at its guard (ADR-032 section 12.1, MD-20).
--
-- B-2 runs as app_voyya (SET LOCAL ROLE): a superuser owner ignores RLS and
-- the comparison would always match (MD-08). SET LOCAL ROLE needs the owner to
-- be a superuser or a member of app_voyya. If it answers "permission denied to
-- set role", run the B-2 block without the SET LOCAL ROLE line from a session
-- opened with app_voyya's runtime DATABASE_URL.
-- =============================================================================

\echo '== roles (the owner is noted; app_voyya must be rolsuper=f, rolbypassrls=f) =='
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN (current_user, 'app_voyya') ORDER BY rolname;

\echo '== current_database() must be voyya_db =='
SELECT current_database();

\echo '== B-1: the fare Yarumal quotes today (commission_pct must be <= 50) =='
BEGIN READ ONLY;
SELECT set_config('app.current_company', (SELECT company_id::text FROM tenancy.company WHERE legal_name = 'Cootrayal'), true);
SELECT base_fare, night_surcharge_pct, holiday_surcharge_pct, commission_pct
  FROM trips.fare_config WHERE service_type = 'taxi' AND valid_to IS NULL;
ROLLBACK;

\echo '== open taxi commissions outside 0-50 (must be 0 rows) =='
SELECT company_id, commission_pct FROM trips.fare_config
 WHERE service_type = 'taxi' AND valid_to IS NULL AND commission_pct NOT BETWEEN 0 AND 50;

\echo '== B-2: fingerprint of the completed trips of Cootrayal, seen by app_voyya =='
BEGIN READ ONLY;
SET LOCAL ROLE app_voyya;
SELECT current_user, set_config('app.current_company', (SELECT company_id::text FROM tenancy.company WHERE legal_name = 'Cootrayal'), true);
SELECT count(*) AS trips,
       md5(string_agg(concat_ws('|', t.trip_request_id, t.fare, t.commission, t.cash_collected_at, a.driver_id),
                      E'\n' ORDER BY t.trip_request_id)) AS fingerprint
  FROM assignment.assignment a
  JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
 WHERE a.status = 'completed' AND t.status = 'completed';
ROLLBACK;

\echo '== municipalities and companies today (the rename guard of the catalog migration needs a DANE name match) =='
SELECT m.municipality_id, m.name, m.department, m.status, c.company_id, c.legal_name, c.status AS company_status
  FROM tenancy.municipality m
  LEFT JOIN tenancy.company c ON c.municipality_id = m.municipality_id
 ORDER BY m.municipality_id;

\echo '== rows that block the migrations (all must be 0) =='
SELECT count(*) FILTER (WHERE service_type = 'motorcycle') AS motorcycle_trips FROM trips.trip_request;
