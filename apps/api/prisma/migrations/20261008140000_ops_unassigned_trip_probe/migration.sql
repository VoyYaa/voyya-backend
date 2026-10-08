CREATE OR REPLACE FUNCTION assignment.trip_has_assignment(p_trip_request_id integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, assignment
AS $$
  SELECT EXISTS (
    SELECT 1 FROM assignment.assignment WHERE trip_request_id = p_trip_request_id
  )
$$;
