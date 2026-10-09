-- =============================================================================
-- VoyYa - ADR-033 baseline (Llegada segura). Read-only. Run BEFORE `db:release`,
-- with the owner connection (VOYYA_DB_OWNER_URL, exported in your terminal; never
-- paste it in the chat). The owner has no `psql` installed: use Docker, with this
-- folder mounted:
--
--   docker run --rm -v "<ruta>\voyya-backend\apps\api\prisma\sql:/sql" postgis/postgis:16-3.4 `
--     psql $env:VOYYA_DB_OWNER_URL -v ON_ERROR_STOP=1 -f /sql/verify-adr-033-baseline.sql
--
-- Only results go back to the chat, never credentials. Keep the output: the second
-- file (verify-adr-033.sql) repeats B-2 after the release and the lag must match.
--
-- B-1 and B-2 must be clean before `db:release`. B-3 is informative: those are the
-- trips that the migration marks as exempt from the start code (HU-CI-12).
-- The migration inserts no rows into existing tables, so no sequence can collide
-- (REL-004); B-2 is taken anyway because every release takes it.
-- =============================================================================

\if :{?expected_db}
\else
  \set expected_db voyya_db
\endif

\echo '== owner check: this file must run as a superuser or a BYPASSRLS role =='
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ADR-033: este archivo debe correr con el propietario de la base (superusuario o rol con BYPASSRLS); el rol conectado % no lo es y el conteo B-3 bajo RLS daria un resultado falso', current_user;
  END IF;
END
$$;

\echo '== B-1a: current_database() must be voyya_db (if it says railway or anything else, STOP) =='
SELECT current_database() AS database, current_database() = :'expected_db' AS is_expected_database;

\echo '== B-1b: the last migration must be 20261009120000_trip_company_scope, finished, none half applied =='
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 3;

SELECT count(*) AS half_applied_migrations
  FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;

SELECT (SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1) = '20261009120000_trip_company_scope' AS last_is_trip_company_scope,
       NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261009130000_trip_start_code') AS this_cycle_not_applied_yet;

\echo '== B-2: sequence lag of every serial table (every row must show lag <= 0) =='
SELECT format('%I.%I', c.table_schema, c.table_name) AS tbl,
       c.column_name,
       (xpath('/row/m/text()',
              query_to_xml(format('select max(%I) as m from %I.%I', c.column_name, c.table_schema, c.table_name),
                           false, true, '')))[1]::text::bigint AS max_id,
       s.last_value,
       coalesce((xpath('/row/m/text()',
              query_to_xml(format('select max(%I) as m from %I.%I', c.column_name, c.table_schema, c.table_name),
                           false, true, '')))[1]::text::bigint, 0) - coalesce(s.last_value, 0) AS lag
  FROM information_schema.columns c
  JOIN pg_sequences s
    ON pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name)
       = format('%I.%I', s.schemaname, s.sequencename)
 WHERE c.table_schema IN ('auth', 'tenancy', 'users', 'fleet', 'trips', 'assignment', 'admin')
 ORDER BY lag DESC, 1;

\echo '== B-2 summary: tables with lag > 0 (must be 0) =='
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

\echo '== B-3: trips in the window right now; they will be exempt from the code (expected 0 or almost 0) =='
SELECT count(*) AS window_trips,
       count(*) FILTER (WHERE status = 'assigned') AS assigned,
       count(*) FILTER (WHERE status = 'driver_en_route') AS driver_en_route
  FROM trips.trip_request
 WHERE status IN ('assigned', 'driver_en_route');
