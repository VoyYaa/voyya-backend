DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trips.trip_request WHERE service_type = 'motorcycle') THEN
    RAISE EXCEPTION 'ADR-032: trip_request rows with service_type motorcycle exist; review before release';
  END IF;
END
$$;

DO $$
DECLARE
  c record;
  out_of_range text;
BEGIN
  FOR c IN SELECT co.company_id FROM tenancy.company co ORDER BY co.company_id LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);
    IF EXISTS (SELECT 1 FROM trips.fare_config f
                WHERE f.company_id = c.company_id
                  AND f.service_type = 'taxi'
                  AND f.valid_to IS NULL
                  AND f.commission_pct NOT BETWEEN 0 AND 50) THEN
      out_of_range := concat_ws(',', out_of_range, c.company_id::text);
    END IF;
  END LOOP;
  IF out_of_range IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-032: companies with an open taxi commission outside 0-50: %; review before release', out_of_range;
  END IF;
END
$$;

DO $$
DECLARE
  c record;
  missing text;
BEGIN
  FOR c IN SELECT co.company_id FROM tenancy.company co WHERE co.status = 'active' ORDER BY co.company_id LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);
    IF NOT EXISTS (SELECT 1 FROM trips.fare_config f
                    WHERE f.company_id = c.company_id AND f.service_type = 'taxi' AND f.valid_to IS NULL) THEN
      missing := concat_ws(',', missing, c.company_id::text);
    END IF;
  END LOOP;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-032: active companies without an open commission: %', missing;
  END IF;

  missing := NULL;
  FOR c IN
    SELECT DISTINCT ON (co.municipality_id) co.municipality_id, co.company_id
      FROM tenancy.company co
     WHERE co.status = 'active'
     ORDER BY co.municipality_id, co.company_id
  LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);
    IF NOT EXISTS (SELECT 1 FROM trips.fare_config f
                    WHERE f.company_id = c.company_id AND f.service_type = 'taxi' AND f.valid_to IS NULL) THEN
      missing := concat_ws(',', missing, c.municipality_id::text);
    END IF;
  END LOOP;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-032: municipalities with an active company but no open taxi fare: %', missing;
  END IF;
END
$$;

ALTER TABLE tenancy.company
  ADD COLUMN service_types trips."ServiceType"[] NOT NULL DEFAULT ARRAY['taxi']::trips."ServiceType"[],
  ADD COLUMN public_name TEXT,
  ADD CONSTRAINT company_service_types_no_motorcycle
    CHECK (cardinality(service_types) >= 1 AND NOT ('motorcycle' = ANY (service_types))),
  ADD CONSTRAINT company_public_name_length
    CHECK (public_name IS NULL OR char_length(public_name) BETWEEN 2 AND 60);

CREATE TABLE trips.municipality_fare (
  municipality_fare_id  SERIAL PRIMARY KEY,
  municipality_id       INTEGER NOT NULL REFERENCES tenancy.municipality (municipality_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  service_type          trips."ServiceType" NOT NULL,
  base_fare             DECIMAL(12,2) NOT NULL,
  night_surcharge_pct   DECIMAL(5,2) NOT NULL,
  holiday_surcharge_pct DECIMAL(5,2) NOT NULL,
  is_official           BOOLEAN NOT NULL DEFAULT false,
  official_reference    TEXT,
  origin                TEXT NOT NULL,
  origin_company_id     INTEGER REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_fare_config_id INTEGER UNIQUE,
  valid_from            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to              TIMESTAMP(3),
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by            INTEGER REFERENCES auth."user" (user_id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT municipality_fare_no_motorcycle CHECK (service_type <> 'motorcycle'),
  CONSTRAINT municipality_fare_origin CHECK (origin IN ('migrated', 'company_approval', 'platform_edit')),
  CONSTRAINT municipality_fare_reference_only_official CHECK (official_reference IS NULL OR is_official),
  CONSTRAINT municipality_fare_validity CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE admin.municipality_operational_params (
  operational_params_id   SERIAL PRIMARY KEY,
  municipality_id         INTEGER NOT NULL REFERENCES tenancy.municipality (municipality_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  service_type            trips."ServiceType" NOT NULL,
  search_radius_km        DECIMAL(5,1),
  expansion_radius_km     DECIMAL(5,1),
  acceptance_timeout_sec  INTEGER,
  max_auto_retries        INTEGER,
  tiebreak_window_hours   INTEGER,
  location_stale_min      INTEGER,
  avg_speed_kmh           INTEGER,
  cancellation_window_min INTEGER,
  no_show_grace_min       INTEGER,
  origin                  TEXT NOT NULL,
  origin_company_id       INTEGER REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  valid_from              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to                TIMESTAMP(3),
  created_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by              INTEGER REFERENCES auth."user" (user_id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT municipality_operational_params_no_motorcycle CHECK (service_type <> 'motorcycle'),
  CONSTRAINT municipality_operational_params_origin CHECK (origin IN ('migrated', 'company_approval', 'platform_edit')),
  CONSTRAINT municipality_operational_params_radius CHECK (
    search_radius_km IS NULL OR expansion_radius_km IS NULL OR search_radius_km <= expansion_radius_km)
);

CREATE TABLE tenancy.company_commission (
  company_commission_id SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES tenancy.company (company_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  commission_pct        DECIMAL(5,2) NOT NULL,
  origin                TEXT NOT NULL,
  source_fare_config_id INTEGER UNIQUE,
  valid_from            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to              TIMESTAMP(3),
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by            INTEGER REFERENCES auth."user" (user_id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT company_commission_pct_range CHECK (commission_pct BETWEEN 0 AND 50),
  CONSTRAINT company_commission_origin CHECK (origin IN ('migrated', 'company_approval', 'platform_edit')),
  CONSTRAINT company_commission_validity CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX municipality_fare_municipality_id_service_type_valid_from_idx
  ON trips.municipality_fare (municipality_id, service_type, valid_from);
CREATE INDEX municipality_operational_params_municipality_id_service_type_valid_from_idx
  ON admin.municipality_operational_params (municipality_id, service_type, valid_from);
CREATE INDEX company_commission_company_id_valid_from_idx
  ON tenancy.company_commission (company_id, valid_from);

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT DISTINCT ON (co.municipality_id) co.municipality_id, co.company_id
      FROM tenancy.company co
     WHERE co.status = 'active'
     ORDER BY co.municipality_id, co.company_id
  LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);

    INSERT INTO trips.municipality_fare
      (municipality_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct, is_official,
       origin, origin_company_id, source_fare_config_id, valid_from, valid_to, created_at, created_by)
    SELECT c.municipality_id, f.service_type, f.base_fare, f.night_surcharge_pct, f.holiday_surcharge_pct, false,
           'migrated', c.company_id, f.fare_config_id, f.valid_from::timestamp, f.valid_to::timestamp,
           f.created_at, f.created_by
      FROM trips.fare_config f
     WHERE f.company_id = c.company_id
       AND f.service_type <> 'motorcycle'
    ON CONFLICT (source_fare_config_id) DO NOTHING;

    INSERT INTO admin.municipality_operational_params
      (municipality_id, service_type, search_radius_km, expansion_radius_km, acceptance_timeout_sec,
       max_auto_retries, tiebreak_window_hours, location_stale_min, avg_speed_kmh, no_show_grace_min,
       cancellation_window_min, origin, origin_company_id)
    SELECT c.municipality_id, 'taxi',
           max(p.value) FILTER (WHERE p.key = 'search_radius_km')::numeric,
           max(p.value) FILTER (WHERE p.key = 'expansion_radius_km')::numeric,
           max(p.value) FILTER (WHERE p.key = 'acceptance_timeout_sec')::int,
           max(p.value) FILTER (WHERE p.key = 'max_auto_retries')::int,
           max(p.value) FILTER (WHERE p.key = 'tiebreak_window_hours')::int,
           max(p.value) FILTER (WHERE p.key = 'location_stale_min')::int,
           max(p.value) FILTER (WHERE p.key = 'avg_speed_kmh')::int,
           max(p.value) FILTER (WHERE p.key = 'no_show_grace_min')::int,
           NULL,
           'migrated', c.company_id
      FROM admin.system_parameter p
     WHERE p.company_id = c.company_id
    HAVING NOT EXISTS (SELECT 1 FROM admin.municipality_operational_params x
                        WHERE x.municipality_id = c.municipality_id AND x.service_type = 'taxi');
  END LOOP;

  FOR c IN SELECT co.company_id FROM tenancy.company co LOOP
    PERFORM set_config('app.current_company', c.company_id::text, true);

    INSERT INTO tenancy.company_commission
      (company_id, commission_pct, origin, source_fare_config_id, valid_from, created_at, created_by)
    SELECT f.company_id, f.commission_pct, 'migrated', f.fare_config_id, f.valid_from::timestamp, f.created_at, f.created_by
      FROM trips.fare_config f
     WHERE f.company_id = c.company_id AND f.service_type = 'taxi' AND f.valid_to IS NULL
    ON CONFLICT (source_fare_config_id) DO NOTHING;
  END LOOP;
END
$$;
