import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { DriverRepository } from '../src/modules/assignment/driver.repository';
import {
  type World,
  adminAuth,
  bootWorld,
  createAdminUser,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  driverAuth,
  ownerClient,
  passengerAuth,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { grantLocationConsent } from './support/grant-location-consent';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';
import {
  type WindowTrip,
  createAcceptedTrip,
  createEnRouteTrip,
  readStartState,
  wrongCodeFor,
} from './support/window-trip';

const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = url ? describe : describe.skip;
const ownerIt = ownerUrl ? it : it.skip;

const PREFIX = '_Tracking';
const CENTER = { lat: 12.55, lng: -69.55 };
const FAR = { lat: CENTER.lat + 0.015, lng: CENTER.lng };
const NEAR = { lat: CENTER.lat + 0.001, lng: CENTER.lng };

jest.setTimeout(120_000);

suite('ADR-033 what the passenger and the driver see: code, tracking window and negative tests', () => {
  let world: World;
  let http: ReturnType<typeof request>;
  let municipalityId: number;
  let companyA: number;
  let companyB: number;
  let owner: PrismaClient | null = null;

  const newTrip = (
    kind: 'accepted' | 'enRoute' = 'accepted',
    options: { driverPosition?: { lat: number; lng: number } | null; companyId?: number; consent?: boolean } = {},
  ): Promise<WindowTrip> =>
    (kind === 'enRoute' ? createEnRouteTrip : createAcceptedTrip)(world, {
      municipalityId,
      companyId: options.companyId ?? companyA,
      pickup: CENTER,
      driverPosition: options.driverPosition,
      consent: options.consent,
    });

  const asPassenger = (trip: WindowTrip, passengerId = trip.passengerId) =>
    http.get(`/trips/${trip.tripRequestId}`).set('Authorization', passengerAuth(world.jwt, passengerId));

  const asDriver = (trip: WindowTrip) => driverAuth(world.jwt, trip.driver.driverId, trip.companyId);

  const report = (trip: WindowTrip, position: { lat: number; lng: number }) =>
    http.post('/driver/location').set('Authorization', asDriver(trip)).send(position);

  const ageAssignment = (trip: WindowTrip) =>
    world.prisma.$executeRaw`
      UPDATE trips.trip_request SET assigned_at = (now() AT TIME ZONE 'UTC') - interval '20 minutes'
       WHERE trip_request_id = ${trip.tripRequestId}`;

  const home = (trip: WindowTrip) => http.get('/driver/me').set('Authorization', asDriver(trip));

  beforeAll(async () => {
    world = await bootWorld();
    http = request(world.app.getHttpServer());
    owner = ownerClient();
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER, { half: 0.2 });
    companyA = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Alfa Taxis' });
    companyB = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Beta Taxis' });
  });

  afterAll(async () => {
    await owner?.$disconnect();
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  describe('the passenger sees the code', () => {
    it.each(['accepted', 'enRoute'] as const)('in %s the passenger reads the active code and its state', async (kind) => {
      const trip = await newTrip(kind);
      const stored = (await readStartState(world, trip.tripRequestId)).startCode;

      const response = await asPassenger(trip);

      expect(response.status).toBe(200);
      expect(response.body.start_code).toBe(stored);
      expect(response.body.start_code_state).toBe('active');
    });

    it('GET /trips/active carries the same code', async () => {
      const trip = await newTrip();
      const stored = (await readStartState(world, trip.tripRequestId)).startCode;

      const response = await http.get('/trips/active').set('Authorization', passengerAuth(world.jwt, trip.passengerId));

      expect(response.status).toBe(200);
      expect(response.body.active_trip.start_code).toBe(stored);
      expect(response.body.active_trip.start_code_state).toBe('active');
    });

    it('once the driver blocks the start the passenger sees blocked and no code', async () => {
      const trip = await newTrip('enRoute');
      const wrong = wrongCodeFor((await readStartState(world, trip.tripRequestId)).startCode as string);
      for (let i = 0; i < 5; i += 1) {
        await http
          .post(`/trips/${trip.tripRequestId}/start`)
          .set('Authorization', asDriver(trip))
          .send({ start_code: wrong });
      }

      const response = await asPassenger(trip);

      expect(response.body.start_code).toBeNull();
      expect(response.body.start_code_state).toBe('blocked');
    });

    it('after the start the code and the tracking are gone', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      await report(trip, NEAR).expect(200);
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: code })
        .expect(200);
      await report(trip, NEAR).expect(200);

      const response = await asPassenger(trip);

      expect(response.body.status).toBe('in_progress');
      expect(response.body.start_code).toBeNull();
      expect(response.body.start_code_state).toBe('not_applicable');
      expect(response.body.driver_tracking).toBeNull();
    });

    it('a pending trip has neither code nor tracking', async () => {
      const passengerId = await createFreshPassenger(world.prisma);
      const { createPendingTrip } = await import('./support/dispatch-world');
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER, { passengerId });

      const response = await http
        .get(`/trips/${trip.tripRequestId}`)
        .set('Authorization', passengerAuth(world.jwt, passengerId));

      expect(response.body.start_code).toBeNull();
      expect(response.body.start_code_state).toBe('not_applicable');
      expect(response.body.driver_tracking).toBeNull();
    });

    it('another passenger gets 403 and nothing about the code or the position', async () => {
      const trip = await newTrip();
      await report(trip, NEAR).expect(200);
      const stranger = await createFreshPassenger(world.prisma);
      const stored = (await readStartState(world, trip.tripRequestId)).startCode as string;

      const response = await asPassenger(trip, stranger);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('NOT_OWNER');
      expect(JSON.stringify(response.body)).not.toContain(stored);
      expect(JSON.stringify(response.body)).not.toContain('position');
    });

    it('the three responses that carry the code or the position are never cached', async () => {
      const trip = await newTrip();

      const status = await asPassenger(trip);
      const active = await http.get('/trips/active').set('Authorization', passengerAuth(world.jwt, trip.passengerId));
      const driverHome = await home(trip);

      for (const response of [status, active, driverHome]) {
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('per-user limits on the real routes (C-3)', () => {
    it('GET /trips/:id cuts at 30 per minute per passenger and GET /driver/me at 30 per minute per driver', async () => {
      const trip = await newTrip();
      const passenger: number[] = [];
      const driver: number[] = [];
      for (let i = 0; i < 31; i += 1) {
        passenger.push((await asPassenger(trip)).status);
        driver.push((await home(trip)).status);
      }

      expect(passenger.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(passenger[30]).toBe(429);
      expect(driver.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(driver[30]).toBe(429);
    });

    it('POST /driver/location cuts at 12 per minute per driver', async () => {
      const trip = await newTrip();
      const statuses: number[] = [];
      for (let i = 0; i < 13; i += 1) statuses.push((await report(trip, NEAR)).status);

      expect(statuses.slice(0, 12).every((status) => status === 200)).toBe(true);
      expect(statuses[12]).toBe(429);
    });
  });

  describe('the tracking window', () => {
    it('right after accepting there is a window with the thresholds and no position yet', async () => {
      const trip = await newTrip();

      const response = await asPassenger(trip);

      expect(response.body.driver_tracking).toMatchObject({
        stale_after_sec: 45,
        hide_after_sec: 300,
        position: null,
      });
      expect(response.body.driver_tracking.window_age_sec).toBeGreaterThanOrEqual(0);
      expect(response.body.driver_tracking.window_age_sec).toBeLessThan(30);
    });

    it('a driver report after accepting becomes the position, and the report tells the app to keep going', async () => {
      const trip = await newTrip();

      const reported = await report(trip, NEAR);
      const response = await asPassenger(trip);

      expect(reported.status).toBe(200);
      expect(reported.body).toEqual({
        ok: true,
        location_sharing: { trip_request_id: trip.tripRequestId, interval_sec: 15 },
      });
      expect(response.body.driver_tracking.position.lat).toBeCloseTo(NEAR.lat, 5);
      expect(response.body.driver_tracking.position.lng).toBeCloseTo(NEAR.lng, 5);
      expect(response.body.driver_tracking.position.age_sec).toBeLessThan(10);
    });

    it('the position that existed before accepting is never shown', async () => {
      const trip = await newTrip('accepted', { driverPosition: FAR });

      const response = await asPassenger(trip);

      expect(response.body.driver_tracking).not.toBeNull();
      expect(response.body.driver_tracking.position).toBeNull();
    });

    it('a position older than five minutes is dropped but the window and the thresholds stay', async () => {
      const trip = await newTrip();
      await report(trip, NEAR).expect(200);
      await ageAssignment(trip);
      await world.prisma.runInTenant(trip.companyId, (tx) =>
        tx.$executeRaw`
          UPDATE fleet.driver SET location_updated_at = (now() AT TIME ZONE 'UTC') - interval '6 minutes'
           WHERE driver_id = ${trip.driver.driverId}`,
      );

      const response = await asPassenger(trip);

      expect(response.body.driver_tracking.position).toBeNull();
      expect(response.body.driver_tracking.hide_after_sec).toBe(300);
    });

    it('a position between 45 s and 5 min is still delivered with its age so the app can show it frozen', async () => {
      const trip = await newTrip();
      await report(trip, NEAR).expect(200);
      await ageAssignment(trip);
      await world.prisma.runInTenant(trip.companyId, (tx) =>
        tx.$executeRaw`
          UPDATE fleet.driver SET location_updated_at = (now() AT TIME ZONE 'UTC') - interval '90 seconds'
           WHERE driver_id = ${trip.driver.driverId}`,
      );

      const response = await asPassenger(trip);

      expect(response.body.driver_tracking.position.age_sec).toBeGreaterThanOrEqual(89);
      expect(response.body.driver_tracking.position.age_sec).toBeLessThan(100);
    });

    it('the passenger cancels: the window closes and the next report of the driver is told to stop', async () => {
      const trip = await newTrip();
      await report(trip, NEAR).expect(200);

      await http
        .post(`/trips/${trip.tripRequestId}/cancel`)
        .set('Authorization', passengerAuth(world.jwt, trip.passengerId))
        .send({})
        .expect(200);

      const status = await asPassenger(trip);
      const afterwards = await report(trip, NEAR);
      expect(status.body.driver_tracking).toBeNull();
      expect(afterwards.status).toBe(200);
      expect(afterwards.body.location_sharing).toBeNull();
    });

    it('a driver that only accepted the previous notice reports but the passenger never gets the position', async () => {
      const trip = await newTrip('accepted', { consent: false });
      if (ownerUrl) {
        await (owner as PrismaClient).$executeRawUnsafe(
          `INSERT INTO auth.consent_notice (purpose, notice_version, audience, sha256, body)
           VALUES ('location', 'location-notice-v2', 'driver',
                   encode(sha256(convert_to('fixture of the previous notice', 'utf8')), 'hex'),
                   'fixture of the previous notice')
           ON CONFLICT DO NOTHING`,
        );
        await world.prisma.consentRecord.create({
          data: {
            userId: trip.driver.driverId,
            purpose: 'location',
            noticeVersion: 'location-notice-v2',
            audience: 'driver',
            action: 'granted',
          },
        });
      } else {
        return;
      }

      const reported = await report(trip, NEAR);
      const response = await asPassenger(trip);

      expect(reported.status).toBe(200);
      expect(reported.body.location_sharing).toBeNull();
      expect(response.body.driver_tracking.position).toBeNull();
      expect(response.body.driver_tracking.stale_after_sec).toBe(45);
    });

    it('a driver without any consent cannot report and the passenger gets no position', async () => {
      const trip = await newTrip('accepted', { consent: false });

      const reported = await report(trip, NEAR);
      const response = await asPassenger(trip);

      expect(reported.status).toBe(403);
      expect(reported.body.code).toBe('LOCATION_CONSENT_REQUIRED');
      expect(response.body.driver_tracking.position).toBeNull();
    });

    it('with "any company" and a driver of company B the position is read in the tenant of B', async () => {
      const trip = await newTrip('accepted', { companyId: companyB });
      await report(trip, NEAR).expect(200);

      const response = await asPassenger(trip);

      expect(response.body.driver_tracking.position.lat).toBeCloseTo(NEAR.lat, 5);
    });
  });

  describe('C-5: the position always belongs to the driver whose consent was checked', () => {
    it('if the trip is reassigned the statement for the previous driver returns no position', async () => {
      const first = await newTrip();
      await report(first, NEAR).expect(200);
      await http
        .post(`/assignments/${first.assignmentId}/cancel`)
        .set('Authorization', asDriver(first))
        .send({ reason: 'Se me dañó el carro' })
        .expect(200);
      const second = await createDriver(world.prisma, companyA, NEAR);
      await grantLocationConsent(world.prisma, second.driverId);
      const offerId = await createOffer(world.prisma, first.tripRequestId, second, companyA);
      await http
        .post(`/assignments/${offerId}/accept`)
        .set('Authorization', driverAuth(world.jwt, second.driverId, companyA))
        .send({})
        .expect(200);
      await http
        .post('/driver/location')
        .set('Authorization', driverAuth(world.jwt, second.driverId, companyA))
        .send(NEAR)
        .expect(200);
      const repository = world.moduleRef.get(DriverRepository);
      const params = { tripRequestId: first.tripRequestId, companyId: companyA, hideSec: 300 };

      const stale = await world.prisma.runInTenant(companyA, (tx) =>
        repository.getTrackingSnapshot(tx, { ...params, driverId: first.driver.driverId }),
      );
      const current = await world.prisma.runInTenant(companyA, (tx) =>
        repository.getTrackingSnapshot(tx, { ...params, driverId: second.driverId }),
      );

      expect(stale).not.toBeNull();
      expect(stale?.lat).toBeNull();
      expect(stale?.lng).toBeNull();
      expect(current?.lat).toBeCloseTo(NEAR.lat, 5);
    });

    it('one sentence decides the window and the position: a trip that already started returns no row', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: code })
        .expect(200);
      await report(trip, NEAR).expect(200);

      const snapshot = await world.prisma.runInTenant(companyA, (tx) =>
        world.moduleRef.get(DriverRepository).getTrackingSnapshot(tx, {
          tripRequestId: trip.tripRequestId,
          companyId: companyA,
          driverId: trip.driver.driverId,
          hideSec: 300,
        }),
      );

      expect(snapshot).toBeNull();
    });
  });

  describe('the ETA is frozen at acceptance', () => {
    it('moving the driver does not change the ETA the passenger sees', async () => {
      const trip = await newTrip('accepted', { driverPosition: FAR });
      const before = await asPassenger(trip);

      await report(trip, NEAR).expect(200);
      const after = await asPassenger(trip);

      expect(before.body.driver.eta).not.toBeNull();
      expect(after.body.driver.eta).toEqual(before.body.driver.eta);
      expect(before.body.driver.eta.max_minutes).toBeGreaterThan(3);
    });
  });

  describe('what the driver receives', () => {
    it('start_code_required, attempts remaining and the pickup point, but never the code or the destination before starting', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      const wrong = wrongCodeFor(code);
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: wrong })
        .expect(422);
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: wrong })
        .expect(422);

      const response = await home(trip);

      const view = response.body.active_trip;
      expect(view.start_code_required).toBe(true);
      expect(view.start_attempts_remaining).toBe(3);
      expect(view.start_blocked).toBe(false);
      expect(view.pickup_location.lat).toBeCloseTo(CENTER.lat, 5);
      expect(view.dropoff_location).toBeNull();
      expect(view.location_sharing).toEqual({ trip_request_id: trip.tripRequestId, interval_sec: 15 });
      expect(JSON.stringify(response.body)).not.toContain(`"${code}"`);
      expect(JSON.stringify(response.body)).not.toContain('start_code"');
    });

    it('a blocked trip reads start_blocked and zero attempts', async () => {
      const trip = await newTrip('enRoute');
      const wrong = wrongCodeFor((await readStartState(world, trip.tripRequestId)).startCode as string);
      for (let i = 0; i < 5; i += 1) {
        await http
          .post(`/trips/${trip.tripRequestId}/start`)
          .set('Authorization', asDriver(trip))
          .send({ start_code: wrong });
      }

      const view = (await home(trip)).body.active_trip;

      expect(view.start_blocked).toBe(true);
      expect(view.start_attempts_remaining).toBe(0);
      expect(view.start_code_required).toBe(true);
    });

    it('in progress the destination arrives, the code is no longer required and sharing stops', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: code })
        .expect(200);

      const view = (await home(trip)).body.active_trip;

      expect(view.status).toBe('in_progress');
      expect(view.start_code_required).toBe(false);
      expect(view.start_attempts_remaining).toBeNull();
      expect(view.location_sharing).toBeNull();
      expect(view.dropoff_location.lat).toBeCloseTo(CENTER.lat + 0.005, 5);
    });

    it('the response of /driver/me for a driver without v3 consent does not offer sharing', async () => {
      const trip = await newTrip('accepted', { consent: false });

      const view = (await home(trip)).body.active_trip;

      expect(view.location_sharing).toBeNull();
    });
  });

  describe('negative test: the code and the position never leave through a driver, console or platform path', () => {
    it('serialises every response of a trip with a code, with the real PrismaService, and finds neither', async () => {
      const trip = await newTrip('accepted');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      const adminId = await createAdminUser(world.prisma, companyA);
      const admin = adminAuth(world.jwt, adminId, companyA);
      const driver = asDriver(trip);
      const bodies: unknown[] = [];
      const keep = async (call: request.Test) => {
        const response = await call;
        bodies.push(response.body);
        return response;
      };

      await keep(http.get('/assignments/nearby').set('Authorization', driver));
      await keep(http.get('/driver/me').set('Authorization', driver));
      await keep(http.post(`/trips/${trip.tripRequestId}/en-route`).set('Authorization', driver).send({}));
      await keep(http.post('/driver/location').set('Authorization', driver).send(NEAR));
      await keep(http.post(`/trips/${trip.tripRequestId}/arrived`).set('Authorization', driver).send({}));
      await keep(
        http.post(`/trips/${trip.tripRequestId}/start`).set('Authorization', driver).send({ start_code: wrongCodeFor(code) }),
      );
      await keep(http.post(`/trips/${trip.tripRequestId}/start`).set('Authorization', driver).send({}));
      await keep(http.get('/ops/trip-requests?status=all').set('Authorization', admin));
      await keep(http.get(`/ops/trip-requests/${trip.tripRequestId}`).set('Authorization', admin));
      await keep(http.get('/ops/drivers').set('Authorization', admin));
      await keep(http.post(`/trips/${trip.tripRequestId}/start`).set('Authorization', driver).send({ start_code: code }));
      await keep(http.get('/driver/me').set('Authorization', driver));
      await keep(
        http.post(`/trips/${trip.tripRequestId}/complete`).set('Authorization', driver).send({ cash_collected: true }),
      );

      const serialised = JSON.stringify(bodies);
      expect(serialised).not.toContain(`"${code}"`);
      expect(serialised).not.toMatch(/"start_code"/);
      expect(serialised).not.toMatch(/"driver_tracking"/);
      expect(serialised).not.toMatch(/"position"/);
    });

    it('a company that does not own the trip does not see it in its console either', async () => {
      const trip = await newTrip('accepted');
      const adminId = await createAdminUser(world.prisma, companyB);

      const response = await http
        .get(`/ops/trip-requests/${trip.tripRequestId}`)
        .set('Authorization', adminAuth(world.jwt, adminId, companyB));

      expect(response.status).toBe(404);
    });

    it('the console shows the attempts and the block, and the timeline gains started_at', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      const adminId = await createAdminUser(world.prisma, companyA);
      const admin = adminAuth(world.jwt, adminId, companyA);
      const wrong = wrongCodeFor(code);
      for (let i = 0; i < 2; i += 1) {
        await http
          .post(`/trips/${trip.tripRequestId}/start`)
          .set('Authorization', asDriver(trip))
          .send({ start_code: wrong });
      }

      const partial = await http.get(`/ops/trip-requests/${trip.tripRequestId}`).set('Authorization', admin);
      for (let i = 0; i < 3; i += 1) {
        await http
          .post(`/trips/${trip.tripRequestId}/start`)
          .set('Authorization', asDriver(trip))
          .send({ start_code: wrong });
      }
      const blocked = await http.get(`/ops/trip-requests/${trip.tripRequestId}`).set('Authorization', admin);
      const queue = await http.get('/ops/trip-requests?status=all').set('Authorization', admin);

      expect(partial.body.start_failed_attempts).toBe(2);
      expect(partial.body.start_blocked_at).toBeNull();
      expect(blocked.body.start_failed_attempts).toBe(5);
      expect(typeof blocked.body.start_blocked_at).toBe('string');
      const row = queue.body.rows.find((r: { trip_request_id: number }) => r.trip_request_id === trip.tripRequestId);
      expect(row.start_failed_attempts).toBe(5);
      expect(row.start_blocked_at).toBe(blocked.body.start_blocked_at);
      expect(blocked.body.timeline.started_at).toBeNull();
    });

    it('started_at appears in the timeline once the trip starts', async () => {
      const trip = await newTrip('enRoute');
      const code = (await readStartState(world, trip.tripRequestId)).startCode as string;
      const adminId = await createAdminUser(world.prisma, companyA);
      await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', asDriver(trip))
        .send({ start_code: code })
        .expect(200);

      const response = await http
        .get(`/ops/trip-requests/${trip.tripRequestId}`)
        .set('Authorization', adminAuth(world.jwt, adminId, companyA));

      expect(typeof response.body.timeline.started_at).toBe('string');
    });
  });

  describe('minimisation (F-09)', () => {
    ownerIt('the 90 day purge erases pickup_distance_at_assignment_m together with the coordinates', async () => {
      const trip = await newTrip('accepted', { driverPosition: FAR });
      const before = await world.prisma.$queryRaw<Array<{ meters: number | null }>>`
        SELECT pickup_distance_at_assignment_m AS meters FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId}`;
      expect(before[0]?.meters).toBeGreaterThan(1000);
      await (owner as PrismaClient).$executeRawUnsafe(
        `UPDATE trips.trip_request SET status = 'no_show', finished_at = now() - interval '200 days'
          WHERE trip_request_id = ${trip.tripRequestId}`,
      );
      const { TripsRepository } = await import('../src/modules/trips/trips.repository');

      await world.prisma.$transaction((tx) =>
        world.moduleRef.get(TripsRepository).purgeCoordinatesBatch(tx, 90, 500),
      );

      const after = await world.prisma.$queryRaw<
        Array<{ meters: number | null; lat: number | null; address: string | null }>
      >`
        SELECT pickup_distance_at_assignment_m AS meters, pickup_lat AS lat, pickup_address AS address
          FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId}`;
      expect(after[0]).toEqual({ meters: null, lat: null, address: null });
    });
  });
});
