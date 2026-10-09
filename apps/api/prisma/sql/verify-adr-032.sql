-- =============================================================================
-- VoyYa - ADR-032 / ADR-031 verification. Read-only. Run AFTER `db:release`
-- (and after `activate-coverage --dane-code 05686 --deactivate --apply`) and
-- BEFORE merging voyya-backend, with the owner connection (VOYYA_DB_OWNER_URL
-- exported in your terminal; never paste it in the chat):
--
--   psql "$VOYYA_DB_OWNER_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/sql/verify-adr-032.sql
--
-- Only results go back to the chat, never credentials. Expected values are in
-- ADR-032 section 12.4 and ADR-031 section 10.
--
-- The RLS blocks (B-2 and the GUC '' probe) run as app_voyya with SET LOCAL
-- ROLE (MD-08): a superuser owner ignores RLS. If it answers "permission denied
-- to set role", run those two blocks without the SET LOCAL ROLE line from a
-- session opened with app_voyya's runtime DATABASE_URL. Do not grant the
-- membership just for this.
-- =============================================================================

\echo '== 1. roles: app_voyya rolsuper=f rolbypassrls=f; the owner is noted =='
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN (current_user, 'app_voyya') ORDER BY rolname;

\echo '== 2. current_database() = voyya_db =='
SELECT current_database();

\echo '== 3. last migrations: trip_company_scope, municipal_service_config, municipality_dane_catalog finished, none rolled back =='
SELECT migration_name, finished_at, rolled_back_at
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 4;

\echo '== 4. catalog: 1122 / 1103 / 1 / 18; active_coverage = 1 after D-4; legacy_rows = 0 =='
SELECT count(*) FILTER (WHERE dane_code IS NOT NULL)                AS catalog_rows,
       count(*) FILTER (WHERE dane_type = 'municipality')           AS municipalities,
       count(*) FILTER (WHERE dane_type = 'island')                 AS islands,
       count(*) FILTER (WHERE dane_type = 'non_municipalized_area') AS non_municipalized,
       count(*) FILTER (WHERE status = 'active')                    AS active_coverage,
       count(*) FILTER (WHERE dane_code IS NULL)                    AS legacy_rows
  FROM tenancy.municipality;

\echo '== 5. companies per municipality: Yarumal keeps id 1 and code 05887 =='
SELECT m.municipality_id, m.dane_code, m.name, m.status, c.legal_name, c.status AS company_status
  FROM tenancy.municipality m
  JOIN tenancy.company c ON c.municipality_id = m.municipality_id
 ORDER BY m.municipality_id;

\echo '== 6. catalog checksum (must equal prisma/data/divipola/SOURCE.md) =='
SELECT md5(string_agg(dane_code || '|' || name || '|' || department || '|' || dane_type, E'\n' ORDER BY dane_code))
  FROM tenancy.municipality WHERE dane_code IS NOT NULL;

\echo '== 7. municipality constraints: the five of ADR-031 section 1.3 =='
SELECT conname FROM pg_constraint
 WHERE conrelid = 'tenancy.municipality'::regclass AND contype = 'c' ORDER BY conname;

\echo '== 8. active coverage that does not contain its DANE point (must be 0 rows) =='
SELECT municipality_id, dane_code, name
  FROM tenancy.municipality
 WHERE status = 'active'
   AND NOT ST_Covers(coverage, ST_SetSRID(ST_MakePoint(reference_lng, reference_lat), 4326));

\echo '== 9. municipality fare: Yarumal taxi with the same three values as B-1, is_official=f, origin=migrated =='
SELECT m.dane_code, m.name, f.service_type, f.base_fare, f.night_surcharge_pct, f.holiday_surcharge_pct,
       f.is_official, f.origin
  FROM trips.municipality_fare f
  JOIN tenancy.municipality m ON m.municipality_id = f.municipality_id
 WHERE f.valid_to IS NULL
 ORDER BY m.dane_code, f.service_type;

\echo '== 10. operational params: Yarumal with the values of Cootrayal and cancellation_window_min NULL =='
SELECT m.dane_code, p.search_radius_km, p.expansion_radius_km, p.acceptance_timeout_sec, p.max_auto_retries,
       p.tiebreak_window_hours, p.location_stale_min, p.avg_speed_kmh, p.cancellation_window_min, p.no_show_grace_min
  FROM admin.municipality_operational_params p
  JOIN tenancy.municipality m ON m.municipality_id = p.municipality_id
 WHERE p.valid_to IS NULL
 ORDER BY m.dane_code;

\echo '== 11. commission: Cootrayal {taxi} with the commission_pct of B-1; no active company without commission =='
BEGIN READ ONLY;
SELECT set_config('app.platform_session', 'on', true);
SELECT c.legal_name, c.status, c.service_types, k.commission_pct, k.origin
  FROM tenancy.company c
  LEFT JOIN tenancy.company_commission k ON k.company_id = c.company_id AND k.valid_to IS NULL
 ORDER BY c.company_id;
ROLLBACK;

\echo '== 12. trips: without_addressed = 0, directed = 0, completed_without_company = 0, motorcycle = 0 =='
SELECT count(*)                                                       AS trips,
       count(*) FILTER (WHERE addressed_company_id IS NULL)           AS without_addressed,
       count(*) FILTER (WHERE requested_company_id IS NOT NULL)       AS directed,
       count(*) FILTER (WHERE status = 'completed' AND company_id IS NULL) AS completed_without_company,
       count(*) FILTER (WHERE service_type = 'motorcycle')            AS motorcycle
  FROM trips.trip_request;

\echo '== 13. four *_no_motorcycle constraints =='
SELECT conname FROM pg_constraint WHERE conname LIKE '%no_motorcycle' ORDER BY conname;

\echo '== 14. trigger on trip_request: trip_request_company_preference =='
SELECT tgname FROM pg_trigger WHERE tgrelid = 'trips.trip_request'::regclass AND NOT tgisinternal;

\echo '== 15. policies: company_scope_trip_request; three per fare/params table; three on commission =='
SELECT polrelid::regclass AS table_name, polname
  FROM pg_policy
 WHERE polrelid IN ('trips.trip_request'::regclass, 'trips.municipality_fare'::regclass,
                    'admin.municipality_operational_params'::regclass, 'tenancy.company_commission'::regclass)
 ORDER BY 1, 2;

\echo '== 16. three open-version indexes =='
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('uq_municipality_fare_open', 'uq_municipality_operational_params_open', 'uq_company_commission_open')
 ORDER BY 1;

\echo '== 17. privileges on the three config tables: can_delete=f can_update=f can_close=t app_owns_table=f =='
SELECT t AS table_name,
       has_table_privilege('app_voyya', t, 'DELETE')              AS can_delete,
       has_table_privilege('app_voyya', t, 'UPDATE')              AS can_update,
       has_column_privilege('app_voyya', t, 'valid_to', 'UPDATE') AS can_close,
       pg_has_role('app_voyya', c.relowner, 'MEMBER')             AS app_owns_table
  FROM unnest(ARRAY['trips.municipality_fare', 'admin.municipality_operational_params', 'tenancy.company_commission']) AS t
  JOIN pg_class c ON c.oid = t::regclass
 ORDER BY 1;

\echo '== 17b. trips.trip_request: app_owns_table=f (the app cannot disable the trigger or the RLS) =='
SELECT 'trips.trip_request' AS table_name, pg_has_role('app_voyya', c.relowner, 'MEMBER') AS app_owns_table
  FROM pg_class c WHERE c.oid = 'trips.trip_request'::regclass;

\echo '== 18. functions: prosecdef=f, proconfig with search_path; company_has_live_assignment app_can_execute=t public_can_execute=f =='
SELECT p.oid::regprocedure AS function_name, p.prosecdef, p.proconfig,
       has_function_privilege('app_voyya', p.oid, 'EXECUTE') AS app_can_execute,
       has_function_privilege('public', p.oid, 'EXECUTE')    AS public_can_execute
  FROM pg_proc p
 WHERE p.oid IN ('trips.trip_request_company_preference()'::regprocedure,
                 'assignment.company_has_live_assignment(integer, boolean)'::regprocedure)
 ORDER BY 1;

\echo '== 19. relforcerowsecurity = 14 =='
SELECT count(*) FROM pg_class WHERE relforcerowsecurity;

\echo '== 20. GUC residual probe as app_voyya: no error in the three statements; trips_seen_without_tenant = total trips of block 12 =='
BEGIN READ ONLY;
SET LOCAL ROLE app_voyya;
SELECT current_user, set_config('app.current_company', '', true);
EXPLAIN SELECT count(*) FROM trips.trip_request WHERE trip_request_id = 0;
SELECT count(*) FROM trips.trip_request WHERE trip_request_id = 0;
SELECT count(*) AS trips_seen_without_tenant FROM trips.trip_request;
ROLLBACK;

\echo '== 21. B-2 after: same trips and fingerprint as the baseline, as app_voyya =='
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
