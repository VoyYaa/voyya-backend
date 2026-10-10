-- =============================================================================
-- VoyYa - ADR-033 verification (Llegada segura). Read-only. Run AFTER `db:release`
-- and BEFORE merging voyya-backend, with the owner connection (VOYYA_DB_OWNER_URL
-- exported in your terminal; never paste it in the chat). The owner has no `psql`
-- installed: use Docker, with this folder mounted:
--
--   docker run --rm -v "<ruta>\voyya-backend\apps\api\prisma\sql:/sql" postgis/postgis:16-3.4 `
--     psql $env:VOYYA_DB_OWNER_URL -v ON_ERROR_STOP=1 -f /sql/verify-adr-033.sql
--
-- Only results go back to the chat, never credentials. The last block (SUMMARY)
-- is one row: every column must be true, except exempt_trips_compare_to_b3, which
-- must not be greater than the B-3 count of the baseline.
-- Expected values are in ADR-033 section 6.4.
--
-- After the deploy (a different check, it does not decide the merge): GET
-- /health/db must list 11 flags in true, hasTripStartCode among them (the signal
-- that the new code is running), and the last block of this file, "AFTER THE
-- DEPLOY", shows the two location-notice-v3 rows that the API registers on start.
-- =============================================================================

\if :{?expected_db}
\else
  \set expected_db voyya_db
\endif

\echo '== 1a. current_database() = voyya_db =='
SELECT current_database() AS database, current_database() = :'expected_db' AS is_expected_database;

\echo '== 1b. last migration 20261009130000_trip_start_code, finished, not rolled back; none half applied =='
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;

SELECT (SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1) = '20261009130000_trip_start_code' AS last_is_trip_start_code,
       (SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL FROM _prisma_migrations
         WHERE migration_name = '20261009130000_trip_start_code') AS finished_and_not_rolled_back,
       (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS half_applied_migrations;

\echo '== 2. the six columns with their types and defaults =='
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'trips' AND table_name = 'trip_request'
   AND column_name IN ('start_code', 'start_code_failed_attempts', 'start_code_blocked_at',
                       'start_code_exempt', 'started_at', 'pickup_distance_at_assignment_m')
 ORDER BY column_name;

\echo '== 3. trigger trip_request_start_code: enabled=O and BEFORE + ROW + INSERT + UPDATE (C-8) =='
SELECT tgname,
       tgenabled,
       (tgtype & 1) <> 0  AS is_row_level,
       (tgtype & 2) <> 0  AS is_before,
       (tgtype & 4) <> 0  AS on_insert,
       (tgtype & 16) <> 0 AS on_update,
       tgfoid::regproc    AS function_name
  FROM pg_trigger
 WHERE tgrelid = 'trips.trip_request'::regclass AND NOT tgisinternal
 ORDER BY tgname;

\echo '== 3b. functions: prosecdef=f and proconfig with search_path =='
SELECT p.oid::regprocedure AS function_name, p.prosecdef, p.proconfig
  FROM pg_proc p
 WHERE p.oid IN ('trips.new_start_code()'::regprocedure, 'trips.trip_request_start_code_guard()'::regprocedure)
 ORDER BY 1;

\echo '== 4. the five constraints trip_request_start_code_*, all validated =='
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = 'trips.trip_request'::regclass AND conname ~ '^trip_request_start_code_'
 ORDER BY conname;

\echo '== 5. the generator returns four digits =='
SELECT trips.new_start_code() ~ '^[0-9]{4}$' AS returns_four_digits;

\echo '== 6. exempt trips (must be <= B-3 of the baseline), all in the window or already closed =='
SELECT count(*) AS exempt_trips,
       count(*) FILTER (WHERE status IN ('assigned', 'driver_en_route')) AS still_in_window,
       count(*) FILTER (WHERE status NOT IN ('assigned', 'driver_en_route')) AS already_closed
  FROM trips.trip_request WHERE start_code_exempt;

\echo '== 7. invariants (both counts must be 0) =='
SELECT count(*) FILTER (WHERE status IN ('assigned', 'driver_en_route')
                          AND start_code IS NULL AND NOT start_code_exempt AND start_code_blocked_at IS NULL)
         AS window_trips_without_code,
       count(*) FILTER (WHERE start_code IS NOT NULL AND status NOT IN ('assigned', 'driver_en_route'))
         AS codes_outside_the_window
  FROM trips.trip_request;

\echo '== 8. relforcerowsecurity = 14 (does not change) =='
SELECT count(*) AS forced_rls_tables FROM pg_class WHERE relforcerowsecurity;

\echo '== 9. the app role: no superuser, no BYPASSRLS, not the owner of the table, cannot set session_replication_role (C-8) =='
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN (current_user, 'app_voyya') ORDER BY rolname;

SELECT pg_has_role('app_voyya', c.relowner, 'MEMBER') AS app_is_owner_of_trip_request,
       has_parameter_privilege('app_voyya', 'session_replication_role', 'SET') AS app_can_set_session_replication_role
  FROM pg_class c WHERE c.oid = 'trips.trip_request'::regclass;

\echo '== 10. sequence lag (must equal the baseline: no table with lag > 0) =='
SELECT count(*) AS tables_with_positive_lag
  FROM (
    SELECT coalesce((xpath('/row/m/text()',
              query_to_xml(format('select max(%I) as m from %I.%I', c.column_name, c.table_schema, c.table_name),
                           false, true, '')))[1]::text::bigint, 0) - coalesce(s.last_value, 0) AS lag
      FROM information_schema.columns c
      JOIN pg_sequences s
        ON pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name)
           = format('%I.%I', s.schemaname, s.sequencename)
     WHERE c.table_schema IN ('auth', 'tenancy', 'users', 'fleet', 'trips', 'assignment', 'admin')
  ) l
 WHERE l.lag > 0;

\echo '== SUMMARY: every column must be true (exempt_trips_compare_to_b3: must be <= the B-3 count) =='
SELECT
  current_database() = :'expected_db'                                                              AS database_ok,
  (SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1)
    = '20261009130000_trip_start_code'                                                             AS last_migration_ok,
  NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)
                                                                                                   AS nothing_half_applied,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'trips' AND table_name = 'trip_request'
      AND column_name IN ('start_code', 'start_code_failed_attempts', 'start_code_blocked_at',
                          'start_code_exempt', 'started_at', 'pickup_distance_at_assignment_m')) = 6 AS six_columns,
  EXISTS (SELECT 1 FROM pg_trigger
           WHERE tgname = 'trip_request_start_code' AND tgrelid = 'trips.trip_request'::regclass
             AND NOT tgisinternal AND tgenabled = 'O'
             AND (tgtype & 1) <> 0 AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)
                                                                                                   AS trigger_ok,
  (SELECT count(*) = 2 AND bool_and(NOT p.prosecdef
            AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) s WHERE s LIKE 'search_path=%'))
     FROM pg_proc p
    WHERE p.oid IN ('trips.new_start_code()'::regprocedure, 'trips.trip_request_start_code_guard()'::regprocedure))
                                                                                                   AS functions_ok,
  (SELECT count(*) = 5 AND bool_and(convalidated) FROM pg_constraint
    WHERE conrelid = 'trips.trip_request'::regclass AND conname ~ '^trip_request_start_code_')     AS five_constraints_validated,
  trips.new_start_code() ~ '^[0-9]{4}$'                                                            AS generator_ok,
  (SELECT count(*) FROM trips.trip_request
    WHERE status IN ('assigned', 'driver_en_route') AND start_code IS NULL
      AND NOT start_code_exempt AND start_code_blocked_at IS NULL) = 0                             AS no_window_trip_without_code,
  (SELECT count(*) FROM trips.trip_request
    WHERE start_code IS NOT NULL AND status NOT IN ('assigned', 'driver_en_route')) = 0            AS no_code_outside_window,
  (SELECT count(*) FROM pg_class WHERE relforcerowsecurity) = 14                                   AS forced_rls_14,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya' AND NOT rolsuper AND NOT rolbypassrls) AS app_role_ok,
  NOT pg_has_role('app_voyya', (SELECT relowner FROM pg_class WHERE oid = 'trips.trip_request'::regclass), 'MEMBER')
                                                                                                   AS app_is_not_owner,
  NOT has_parameter_privilege('app_voyya', 'session_replication_role', 'SET')                      AS app_cannot_disable_triggers,
  (SELECT count(*) FROM trips.trip_request WHERE start_code_exempt)                                AS exempt_trips_compare_to_b3;

\echo '== AFTER THE DEPLOY (run only once the API is up): the v3 notices, two rows, driver and passenger =='
SELECT purpose, notice_version, audience, length(body) > 0 AS has_body, length(sha256) = 64 AS has_fingerprint
  FROM auth.consent_notice
 WHERE notice_version = 'location-notice-v3'
 ORDER BY audience;
