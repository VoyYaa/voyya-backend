ALTER FUNCTION assignment.trip_has_assignment(integer) SET row_security = off;
REVOKE EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_voyya') THEN
    GRANT EXECUTE ON FUNCTION assignment.trip_has_assignment(integer) TO app_voyya;
  END IF;
END
$$;
