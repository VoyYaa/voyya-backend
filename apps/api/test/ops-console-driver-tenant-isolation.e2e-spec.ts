import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { SMS_PROVIDER } from '../src/modules/assignment/ports/sms-provider.port';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniquePhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
}

const poly = {
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
};

suite('Ops/Admin console — driver reads and writes never cross company_id, even within one municipality', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let sms: { send: jest.Mock };

  let municipalityId: number;
  let companyAId: number;
  let companyBId: number;
  let driverAId: number;
  let driverBId: number;
  let driverBNationalId: string;
  let driverBPinHashBefore: string | null;
  let adminAAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '15';

    sms = { send: jest.fn().mockResolvedValue(undefined) };

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9161 },
      update: {},
      create: {
        municipalityId: 9161,
        name: '_TenantDriverMuni',
        department: 'Test',
        coveragePolygon: poly,
        status: 'active',
      },
    });
    municipalityId = municipality.municipalityId;

    const companyA = await prisma.company.upsert({
      where: { taxId: '_tenant-driver-co-a' },
      update: { status: 'active' },
      create: {
        legalName: '_TenantDriverCoA',
        taxId: '_tenant-driver-co-a',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyAId = companyA.companyId;

    const companyB = await prisma.company.upsert({
      where: { taxId: '_tenant-driver-co-b' },
      update: { status: 'active' },
      create: {
        legalName: '_TenantDriverCoB',
        taxId: '_tenant-driver-co-b',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyBId = companyB.companyId;

    const phoneA = uniquePhone();
    const vehicleA = await prisma.runInTenant(companyAId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_TDA001' },
        update: { status: 'active', companyId: companyAId },
        create: { plate: '_TDA001', companyId: companyAId, status: 'active' },
      }),
    );
    const driverAUser = await prisma.user.upsert({
      where: { phone: phoneA },
      update: {},
      create: { firstName: '_Tenant', lastName: 'DriverA', phone: phoneA, role: 'driver' },
    });
    driverAId = driverAUser.userId;
    await prisma.runInTenant(companyAId, (tx) =>
      tx.driver.upsert({
        where: { driverId: driverAId },
        update: { companyId: companyAId, currentVehicleId: vehicleA.vehicleId },
        create: {
          driverId: driverAId,
          companyId: companyAId,
          nationalId: `_TD-DRV-A-${phoneA}`,
          pin: 'hashed:a',
          status: 'available',
          currentVehicleId: vehicleA.vehicleId,
          locationUpdatedAt: new Date(),
          currentLat: 6.96,
          currentLng: -75.42,
        },
      }),
    );

    const phoneB = uniquePhone();
    driverBNationalId = `_TD-DRV-B-${phoneB}`;
    const vehicleB = await prisma.runInTenant(companyBId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_TDB001' },
        update: { status: 'active', companyId: companyBId },
        create: { plate: '_TDB001', companyId: companyBId, status: 'active' },
      }),
    );
    const driverBUser = await prisma.user.upsert({
      where: { phone: phoneB },
      update: {},
      create: { firstName: '_Tenant', lastName: 'DriverB', phone: phoneB, role: 'driver' },
    });
    driverBId = driverBUser.userId;
    await prisma.runInTenant(companyBId, (tx) =>
      tx.driver.upsert({
        where: { driverId: driverBId },
        update: { companyId: companyBId, currentVehicleId: vehicleB.vehicleId },
        create: {
          driverId: driverBId,
          companyId: companyBId,
          nationalId: driverBNationalId,
          pin: 'hashed:b-original',
          status: 'available',
          currentVehicleId: vehicleB.vehicleId,
          locationUpdatedAt: new Date(),
          currentLat: 6.97,
          currentLng: -75.43,
        },
      }),
    );
    const driverBBefore = await prisma.runInTenant(companyBId, (tx) =>
      tx.driver.findUnique({ where: { driverId: driverBId } }),
    );
    driverBPinHashBefore = driverBBefore?.pin ?? null;

    const token = jwt.sign({ sub: 900201, role: 'admin', type: 'access', company_id: companyAId });
    adminAAuth = `Bearer ${token}`;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('GET /ops/drivers/:id', () => {
    it("company A's admin reading its OWN driver -> 200 with full detail", async () => {
      const res = await request(app.getHttpServer())
        .get(`/ops/drivers/${driverAId}`)
        .set('Authorization', adminAAuth);

      expect(res.status).toBe(200);
      expect(res.body.driver_id).toBe(driverAId);
      expect(res.body.status).toBe('available');
      expect(res.body.vehicle.plate).toBe('_TDA001');
      expect(res.body.server_time).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/current_lat|current_lng/);
    });

    it("company A's admin reading company B's driver by its REAL id -> 404 DRIVER_NOT_FOUND, no data leaks", async () => {
      const res = await request(app.getHttpServer())
        .get(`/ops/drivers/${driverBId}`)
        .set('Authorization', adminAAuth);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
      expect(JSON.stringify(res.body)).not.toContain(driverBNationalId);
      expect(JSON.stringify(res.body)).not.toContain('_TDB001');
    });

    it("company A's roster never lists company B's driver", async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/drivers')
        .set('Authorization', adminAAuth);

      expect(res.status).toBe(200);
      const nationalIds = res.body.rows.map((r: { national_id: string }) => r.national_id);
      expect(nationalIds).not.toContain(driverBNationalId);
    });
  });

  describe('POST /admin/drivers/:driverId/pin/resend across tenants', () => {
    it("company A's admin cannot rotate company B's REAL driver PIN -> 404, zero mutation, zero SMS", async () => {
      sms.send.mockClear();

      const res = await request(app.getHttpServer())
        .post(`/admin/drivers/${driverBId}/pin/resend`)
        .set('Authorization', adminAAuth)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
      expect(sms.send).not.toHaveBeenCalled();

      const driverBAfter = await prisma.runInTenant(companyBId, (tx) =>
        tx.driver.findUnique({ where: { driverId: driverBId } }),
      );
      expect(driverBAfter?.pin).toBe(driverBPinHashBefore);
      expect(driverBAfter?.pinDeliveredAt).toBeNull();
    });
  });

  describe('GET /ops/trip-requests/:id', () => {
    it('a trip request in the admin\'s own municipality returns full detail (200)', async () => {
      const passengerPhone = uniquePhone();
      const passengerUser = await prisma.user.upsert({
        where: { phone: passengerPhone },
        update: {},
        create: {
          firstName: '_Tenant',
          lastName: 'Passenger',
          phone: passengerPhone,
          role: 'passenger',
        },
      });
      await prisma.passenger.upsert({
        where: { passengerId: passengerUser.userId },
        update: {},
        create: { passengerId: passengerUser.userId },
      });

      const trip = await prisma.tripRequest.create({
        data: {
          passengerId: passengerUser.userId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: '_TenantDetail pickup',
          dropoffAddress: '_TenantDetail dropoff',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 12000,
          commission: 960,
          status: 'pending_assignment',
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/ops/trip-requests/${trip.tripRequestId}`)
        .set('Authorization', adminAAuth);

      expect(res.status).toBe(200);
      expect(res.body.trip_request_id).toBe(trip.tripRequestId);
      expect(res.body.pickup_address).toBe('_TenantDetail pickup');
      expect(res.body.fare).toMatchObject({ total: 12000, commission: 960, currency: 'COP' });
      expect(res.body.driver).toBeNull();
      expect(res.body.timeline.requested_at).toEqual(expect.any(String));
      expect(res.body.passenger_phone_masked).toBe(`***${passengerPhone.slice(-4)}`);
      expect(JSON.stringify(res.body)).not.toContain(passengerPhone);
    });

    it('a trip request from a DIFFERENT municipality -> 404 TRIP_REQUEST_NOT_FOUND (the WHERE clause is the only guard, and it must hold)', async () => {
      const otherMunicipality = await prisma.municipality.upsert({
        where: { municipalityId: 9162 },
        update: {},
        create: {
          municipalityId: 9162,
          name: '_TenantDriverOtherMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });

      const passengerPhone = uniquePhone();
      const passengerUser = await prisma.user.upsert({
        where: { phone: passengerPhone },
        update: {},
        create: {
          firstName: '_Tenant',
          lastName: 'OtherMuniPassenger',
          phone: passengerPhone,
          role: 'passenger',
        },
      });
      await prisma.passenger.upsert({
        where: { passengerId: passengerUser.userId },
        update: {},
        create: { passengerId: passengerUser.userId },
      });

      const trip = await prisma.tripRequest.create({
        data: {
          passengerId: passengerUser.userId,
          municipalityId: otherMunicipality.municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: '_OtherMuni pickup',
          dropoffAddress: '_OtherMuni dropoff',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10000,
          commission: 800,
          status: 'pending_assignment',
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/ops/trip-requests/${trip.tripRequestId}`)
        .set('Authorization', adminAAuth);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'TRIP_REQUEST_NOT_FOUND' });
    });
  });
});
