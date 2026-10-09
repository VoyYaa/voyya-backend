BEGIN;
INSERT INTO tenancy.municipality (name, department, coverage_polygon, status)
VALUES ('Yarumal', 'Antioquia', '{"type":"Polygon","coordinates":[[[-75.45,6.94],[-75.39,6.94],[-75.39,6.99],[-75.45,6.99],[-75.45,6.94]]]}'::jsonb, 'active');
INSERT INTO tenancy.company (legal_name, tax_id, type, municipality_id, status)
SELECT 'Cootrayal', '890900001', 'cooperative', municipality_id, 'active' FROM tenancy.municipality WHERE name='Yarumal';
SELECT set_config('app.current_company', company_id::text, true) FROM tenancy.company;
INSERT INTO trips.fare_config (company_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct, commission_pct)
SELECT company_id, 'taxi', 8500, 25, 15, 7.5 FROM tenancy.company;
INSERT INTO admin.system_parameter (company_id, key, value)
SELECT company_id, k, v FROM tenancy.company, (VALUES ('search_radius_km','3'),('expansion_radius_km','7'),('acceptance_timeout_sec','20'),('max_auto_retries','4'),('tiebreak_window_hours','2'),('location_stale_min','10'),('avg_speed_kmh','25'),('no_show_grace_min','6')) AS p(k,v);
INSERT INTO auth."user" (first_name, last_name, phone, role) VALUES ('Paola','Pasajera','3101110001','passenger'),('Dario','Conductor','3002220001','driver');
INSERT INTO users.passenger (passenger_id) SELECT user_id FROM auth."user" WHERE phone='3101110001';
INSERT INTO fleet.vehicle (company_id, plate) SELECT company_id, 'MIG001' FROM tenancy.company;
INSERT INTO fleet.driver (driver_id, company_id, national_id, pin, status, current_vehicle_id, updated_at)
SELECT u.user_id, c.company_id, '70000001', 'x', 'available', (SELECT vehicle_id FROM fleet.vehicle LIMIT 1), now() FROM auth."user" u, tenancy.company c WHERE u.phone='3002220001';
INSERT INTO trips.trip_request (passenger_id, municipality_id, fare, commission, status, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, requested_at, updated_at, finished_at, cash_collected_at)
SELECT p.user_id, m.municipality_id, 8500, 638, 'completed', 'Parque Principal', 'Hospital', 6.9617, -75.4185, 6.97, -75.42, now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour' FROM auth."user" p, tenancy.municipality m WHERE p.phone='3101110001' AND m.name='Yarumal';
INSERT INTO trips.trip_request (passenger_id, municipality_id, fare, commission, status, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, requested_at, updated_at)
SELECT p.user_id, m.municipality_id, 8500, 0, 'cancelled_by_passenger', 'Parque Principal', 'Hospital', 6.9617, -75.4185, 6.97, -75.42, now() - interval '90 minutes', now() - interval '80 minutes' FROM auth."user" p, tenancy.municipality m WHERE p.phone='3101110001' AND m.name='Yarumal';
INSERT INTO trips.trip_request (passenger_id, municipality_id, fare, commission, status, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, requested_at, updated_at)
SELECT p.user_id, m.municipality_id, 8500, 0, 'pending_assignment', 'Parque Principal', 'Hospital', 6.9617, -75.4185, 6.97, -75.42, now(), now() FROM auth."user" p, tenancy.municipality m WHERE p.phone='3101110001' AND m.name='Yarumal';
INSERT INTO assignment.assignment (trip_request_id, driver_id, vehicle_id, company_id, status)
SELECT t.trip_request_id, d.driver_id, d.current_vehicle_id, d.company_id, 'completed' FROM trips.trip_request t, fleet.driver d WHERE t.status='completed';
COMMIT;
