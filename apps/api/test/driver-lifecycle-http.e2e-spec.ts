import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('Driver + trip lifecycle over real HTTP (TenantGuard + Roles + Zod + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: number;
  let municipalityId: number;
  let passengerId: number;
  let driver1Id: number;
  let driver2Id: number;
  let vehicle1Id: number;
  let vehicle2Id: number;

  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.AUTH_DEV_HEADERS = 'true';
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9004 },
      update: {},
      create: {
        municipalityId: 9004,
        name: '_HttpE2eTestMuni',
        department: 'Test',
        coveragePolygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
        status: 'active',
      },
    });
    municipalityId = municipality.municipalityId;

    const company = await prisma.company.upsert({
      where: { taxId: '_http-e2e-test' },
      update: { status: 'active' },
      create: {
        legalName: '_HttpE2eTestCo',
        taxId: '_http-e2e-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await prisma.user.upsert({
      where: { phone: `_http-${runId}-p` },
      update: {},
      create: { firstName: '_Http', lastName: 'Passenger', phone: `_http-${runId}-p`, role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    const vehicle1 = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_HTTP001' },
        update: { status: 'active', companyId },
        create: { plate: '_HTTP001', companyId, status: 'active' },
      }),
    );
    vehicle1Id = vehicle1.vehicleId;

    const vehicle2 = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_HTTP002' },
        update: { status: 'active', companyId },
        create: { plate: '_HTTP002', companyId, status: 'active' },
      }),
    );
    vehicle2Id = vehicle2.vehicleId;

    const driver1User = await prisma.user.upsert({
      where: { phone: `_http-${runId}-d1` },
      update: {},
      create: { firstName: '_Http', lastName: 'Driver1', phone: `_http-${runId}-d1`, role: 'driver' },
    });
    driver1Id = driver1User.userId;

    const driver2User = await prisma.user.upsert({
      where: { phone: `_http-${runId}-d2` },
      update: {},
      create: { firstName: '_Http', lastName: 'Driver2', phone: `_http-${runId}-d2`, role: 'driver' },
    });
    driver2Id = driver2User.userId;

    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: driver1Id },
        update: {
          companyId,
          status: 'off_shift',
          currentVehicleId: vehicle1Id,
          pin: 'x',
          currentLat: null,
          currentLng: null,
          locationUpdatedAt: null,
        },
        create: {
          driverId: driver1Id,
          companyId,
          nationalId: `_HTTP-DRV-1-${runId}`,
          pin: 'x',
          status: 'off_shift',
          currentVehicleId: vehicle1Id,
        },
      }),
    );

    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: driver2Id },
        update: {
          companyId,
          status: 'off_shift',
          currentVehicleId: vehicle2Id,
          pin: 'x',
        },
        create: {
          driverId: driver2Id,
          companyId,
          nationalId: `_HTTP-DRV-2-${runId}`,
          pin: 'x',
          status: 'off_shift',
          currentVehicleId: vehicle2Id,
        },
      }),
    );
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  }, 20_000);

  function driverHeaders(driverId: number): Record<string, string> {
    return { 'x-driver-id': String(driverId), 'x-company-id': String(companyId) };
  }

  async function makeTrip(): Promise<number> {
    const trip = await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'Calle 1',
        dropoffAddress: 'Calle 2',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status: 'assigned',
      },
    });
    return trip.tripRequestId;
  }

  async function acceptAssignment(
    tripRequestId: number,
    driverId: number,
    vehicleId: number,
  ): Promise<number> {
    const assignment = await prisma.runInTenant(companyId, (tx) =>
      tx.assignment.create({
        data: {
          tripRequestId,
          driverId,
          vehicleId,
          companyId,
          status: 'accepted',
          assignedBy: 'system',
        },
      }),
    );
    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.update({ where: { driverId }, data: { status: 'on_trip' } }),
    );
    return assignment.assignmentId;
  }

  async function getTripStatus(tripRequestId: number): Promise<string> {
    const t = await prisma.tripRequest.findUnique({ where: { tripRequestId } });
    return t?.status ?? 'MISSING';
  }

  describe('happy path: en-route -> arrived -> start -> complete -> cash-collected', () => {
    let tripRequestId: number;

    it('PUT /driver/shift (on_shift=true) starts the shift', async () => {
      const res = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driver1Id))
        .send({ on_shift: true, location: { lat: 6.96, lng: -75.42 } });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'available', on_shift: true, vehicle_linked: true });
      expect(res.body.location_updated_at).not.toBeNull();
    });

    it('POST /driver/location refreshes the location while available', async () => {
      const res = await request(app.getHttpServer())
        .post('/driver/location')
        .set(driverHeaders(driver1Id))
        .send({ lat: 6.961, lng: -75.421 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('GET /driver/me shows the shift with no active trip yet', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/me')
        .set(driverHeaders(driver1Id));

      expect(res.status).toBe(200);
      expect(res.body.shift.status).toBe('available');
      expect(res.body.active_trip).toBeNull();
    });

    it('sets up an accepted assignment for driver1 (fixture, out of scope of this e2e)', async () => {
      tripRequestId = await makeTrip();
      await acceptAssignment(tripRequestId, driver1Id, vehicle1Id);
      expect(await getTripStatus(tripRequestId)).toBe('assigned');
    });

    it('POST /trips/:id/en-route -> 200 driver_en_route, not idempotent', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/en-route`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        trip_request_id: tripRequestId,
        status: 'driver_en_route',
        idempotent: false,
      });
    });

    it('POST /trips/:id/en-route again -> 200 idempotent=true', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/en-route`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(true);
    });

    it('POST /trips/:id/arrived -> 200 with arrived_at and no_show_available_at', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/arrived`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.idempotent).toBe(false);
      expect(res.body.arrived_at).toEqual(expect.any(String));
      expect(res.body.no_show_available_at).toEqual(expect.any(String));
      expect(new Date(res.body.no_show_available_at).getTime()).toBeGreaterThan(
        new Date(res.body.arrived_at).getTime(),
      );
    });

    it('GET /driver/me now shows the active trip as driver_en_route with arrived_at set', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/me')
        .set(driverHeaders(driver1Id));

      expect(res.status).toBe(200);
      expect(res.body.active_trip).toMatchObject({
        trip_request_id: tripRequestId,
        status: 'driver_en_route',
      });
      expect(res.body.active_trip.arrived_at).not.toBeNull();
      expect(res.body.active_trip.cash_collected_at).toBeNull();
    });

    it('POST /trips/:id/start -> 200 in_progress', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/start`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'in_progress', idempotent: false });
    });

    it('POST /trips/:id/start by a driver who is not assigned -> 403 NOT_THE_DRIVER', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/start`)
        .set(driverHeaders(driver2Id))
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOT_THE_DRIVER' });
    });

    it('POST /trips/:id/complete (cash_collected=false) -> 200 completed, net_earnings set, cash pending', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/complete`)
        .set(driverHeaders(driver1Id))
        .send({ cash_collected: false });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'completed', idempotent: false, net_earnings: 9200 });
      expect(res.body.cash_collected_at).toBeNull();
      expect(res.body.finished_at).toEqual(expect.any(String));
    });

    it('GET /driver/me no longer reports an active trip after completion', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/me')
        .set(driverHeaders(driver1Id));

      expect(res.status).toBe(200);
      expect(res.body.active_trip).toBeNull();
    });

    it('GET /driver/trips/cash-pending lists the completed trip awaiting cash confirmation', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/trips/cash-pending')
        .set(driverHeaders(driver1Id));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ trip_request_id: tripRequestId, fare: 10000 });
    });

    it('POST /trips/:id/cash-collected by a driver who is not the closing driver -> 403 NOT_THE_DRIVER', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/cash-collected`)
        .set(driverHeaders(driver2Id))
        .send({});

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOT_THE_DRIVER' });
    });

    it('POST /trips/:id/cash-collected -> 200 completed with cash_collected_at set', async () => {
      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/cash-collected`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'completed', idempotent: false });
      expect(res.body.cash_collected_at).toEqual(expect.any(String));
    });

    it('GET /driver/trips/cash-pending is now empty', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/trips/cash-pending')
        .set(driverHeaders(driver1Id));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('PUT /driver/shift (on_shift=false) ends the shift once the trip is fully closed', async () => {
      const res = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driver1Id))
        .send({ on_shift: false });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'off_shift', on_shift: false });
    });
  });

  describe('no-show path', () => {
    it('POST /trips/:id/no-show -> 200 no_show once the courtesy window elapsed', async () => {
      const tripRequestId = await makeTrip();
      await acceptAssignment(tripRequestId, driver2Id, vehicle2Id);
      await prisma.$executeRaw`
        UPDATE trips.trip_request
           SET status = 'driver_en_route'::trips."TripStatus",
               arrived_at = (now() AT TIME ZONE 'UTC') - interval '10 minutes'
         WHERE trip_request_id = ${tripRequestId}
      `;

      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/no-show`)
        .set(driverHeaders(driver2Id))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'no_show', idempotent: false });

      const home = await request(app.getHttpServer())
        .get('/driver/me')
        .set(driverHeaders(driver2Id));
      expect(home.body.active_trip).toBeNull();
    });
  });

  describe('edge cases: auth, tenancy and validation', () => {
    it('no auth headers at all -> 401 SESSION_REQUIRED', async () => {
      const res = await request(app.getHttpServer()).get('/driver/me');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    });

    it('a passenger cannot hit a driver-only route -> 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/driver/shift')
        .set({ 'x-passenger-id': String(passengerId) })
        .send({ on_shift: false });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('a driver header without company_id -> 403 OUT_OF_TENANT', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/me')
        .set({ 'x-driver-id': String(driver1Id) });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'OUT_OF_TENANT' });
    });

    it('PUT /driver/shift with on_shift=true but no location -> 400 INVALID_DATA (Zod)', async () => {
      const res = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driver1Id))
        .send({ on_shift: true });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
    });

    it('POST /trips/:id/start while still "assigned" (skipping en-route) -> 409 INVALID_TRIP_TRANSITION', async () => {
      const tripRequestId = await makeTrip();
      await acceptAssignment(tripRequestId, driver1Id, vehicle1Id);

      const res = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/start`)
        .set(driverHeaders(driver1Id))
        .send({});

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'INVALID_TRIP_TRANSITION' });
    });
  });
});
