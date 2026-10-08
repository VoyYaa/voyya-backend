ALTER TABLE trips.trip_request
  ADD COLUMN requested_company_id INTEGER REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN addressed_company_id INTEGER REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN company_id           INTEGER REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN municipality_fare_id INTEGER REFERENCES trips.municipality_fare (municipality_fare_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN commission_pct       DECIMAL(5,2),
  ADD CONSTRAINT trip_request_no_motorcycle CHECK (service_type <> 'motorcycle'),
  ADD CONSTRAINT trip_request_directed_is_addressed
    CHECK (requested_company_id IS NULL OR addressed_company_id = requested_company_id);

CREATE INDEX trip_request_company_id_updated_at_idx ON trips.trip_request (company_id, updated_at);
CREATE INDEX trip_request_addressed_company_id_updated_at_idx ON trips.trip_request (addressed_company_id, updated_at);

UPDATE trips.trip_request t
   SET addressed_company_id = s.company_id
  FROM (SELECT municipality_id, min(company_id) AS company_id
          FROM tenancy.company
         WHERE status = 'active'
         GROUP BY municipality_id
        HAVING count(*) = 1) s
 WHERE t.municipality_id = s.municipality_id
   AND t.addressed_company_id IS NULL;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT company_id FROM tenancy.company LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);
    UPDATE trips.trip_request t
       SET company_id = a.company_id
      FROM assignment.assignment a
     WHERE a.trip_request_id = t.trip_request_id
       AND a.company_id = c.company_id
       AND a.status IN ('accepted', 'completed')
       AND t.company_id IS NULL;
  END LOOP;
END
$$;

CREATE FUNCTION trips.trip_request_company_preference() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, trips, tenancy, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_company_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM tenancy.company c
         WHERE c.company_id = NEW.requested_company_id
           AND c.municipality_id = NEW.municipality_id
           AND c.status = 'active'
           AND NEW.service_type = ANY (c.service_types)
      ) THEN
        RAISE EXCEPTION 'ADR-032: requested company % is not available for this trip', NEW.requested_company_id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'trip_request_requested_company_available';
      END IF;
      NEW.addressed_company_id := NEW.requested_company_id;
    ELSE
      SELECT CASE WHEN count(*) = 1 THEN min(c.company_id) END
        INTO NEW.addressed_company_id
        FROM tenancy.company c
       WHERE c.municipality_id = NEW.municipality_id
         AND c.status = 'active'
         AND NEW.service_type = ANY (c.service_types);
    END IF;
  ELSIF NEW.requested_company_id IS DISTINCT FROM OLD.requested_company_id
     OR NEW.addressed_company_id IS DISTINCT FROM OLD.addressed_company_id THEN
    RAISE EXCEPTION 'ADR-032: requested_company_id and addressed_company_id are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trip_request_company_preference
  BEFORE INSERT OR UPDATE OF requested_company_id, addressed_company_id ON trips.trip_request
  FOR EACH ROW EXECUTE FUNCTION trips.trip_request_company_preference();

CREATE FUNCTION assignment.company_has_live_assignment(p_trip_request_id integer, p_offers_visible boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, assignment, pg_temp
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM assignment.assignment a
     WHERE a.trip_request_id = p_trip_request_id
       AND a.company_id = nullif(current_setting('app.current_company', true), '')::int
       AND (a.status IN ('accepted', 'completed')
            OR (p_offers_visible
                AND a.status IN ('created', 'notified')
                AND a.expires_at > (now() AT TIME ZONE 'UTC'))));
END
$$;
