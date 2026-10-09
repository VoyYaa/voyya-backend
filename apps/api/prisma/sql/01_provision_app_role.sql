-- =============================================================================
-- VoyYa - Provisioning of the non-owner runtime role `app_voyya`.
--
-- Deliberately NOT wired into `db:release` / `prisma db execute` (see the
-- commented block (d) in 00_postgis_rls.sql). Two independent reasons:
--
--   1. `prisma db execute` sends this file's text straight to the database
--      driver; it does not go through `psql` and does not expand `-v`
--      variables. The `:'app_pwd'` token below only works when the file is
--      run with the real `psql` client, which does its own substitution
--      before the SQL ever reaches Postgres. Left inside 00_postgis_rls.sql,
--      it would fail with a syntax error on every `db:release`.
--   2. The only alternative would be a literal password committed to the
--      file - a secret in git. Keeping this file separate, psql-only, and
--      manually invoked keeps the password out of any file and out of the
--      automated release path.
--
-- Run once per target database (and again to rotate the password), with the
-- OWNER role's connection string - never with app_voyya's own credential:
--
--   psql "$VOYYA_DB_OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v app_pwd="$APP_VOYYA_PASSWORD" \
--     -f apps/api/prisma/sql/01_provision_app_role.sql
--
-- Idempotent: safe to re-run. Creates the role only if missing; every run
-- re-applies the password and the grants.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    CREATE ROLE app_voyya LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE app_voyya WITH LOGIN PASSWORD :'app_pwd' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA auth, tenancy, users, fleet, trips, assignment, admin TO app_voyya;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
  TO app_voyya;

GRANT USAGE, SELECT ON ALL SEQUENCES
  IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
  TO app_voyya;

ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_voyya;

ALTER DEFAULT PRIVILEGES IN SCHEMA auth, tenancy, users, fleet, trips, assignment, admin
  GRANT USAGE, SELECT ON SEQUENCES TO app_voyya;

REVOKE UPDATE, DELETE ON admin.settlement_remittance, admin.settlement_export FROM app_voyya;
REVOKE UPDATE, DELETE ON auth.consent_record, auth.consent_notice FROM app_voyya;
REVOKE DELETE ON auth."user" FROM app_voyya;

REVOKE EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) TO app_voyya;

REVOKE UPDATE, DELETE ON trips.municipality_fare, admin.municipality_operational_params, tenancy.company_commission FROM app_voyya;
GRANT UPDATE (valid_to) ON trips.municipality_fare, admin.municipality_operational_params, tenancy.company_commission TO app_voyya;
GRANT EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) TO app_voyya;
REVOKE EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) FROM PUBLIC;

-- Verification (prints the row so the operator sees it in the psql output):
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_voyya';
