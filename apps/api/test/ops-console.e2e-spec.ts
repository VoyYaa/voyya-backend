import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniquePhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
}

suite('Ops console — live queue polling and driver roster (ADR-015)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let companyId: number;
  let municipalityId: number;
  let passengerId: number;
  let operatorAuth: string;
  let freshNationalId: string;
  let staleNationalId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9141 },
      update: {},
      create: {
        municipalityId: 9141,
        name: '_OpsMuni',
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
      where: { taxId: '_ops-console-co' },
      update: { status: 'active' },
      create: {
        legalName: '_OpsConsoleCo',
        taxId: '_ops-console-co',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    await prisma.runInTenant(companyId, (tx) =>
      tx.systemParameter.upsert({
        where: { key_companyId: { key: 'location_stale_min', companyId } },
        update: { value: '15' },
        create: { key: 'location_stale_min', value: '15', companyId },
      }),
    );

    const passengerPhone = uniquePhone();
    const passengerUser = await prisma.user.upsert({
      where: { phone: passengerPhone },
      update: {},
      create: { firstName: '_Ops', lastName: 'Passenger', phone: passengerPhone, role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    const freshPhone = uniquePhone();
    freshNationalId = `_OPS-DRV-FRESH-${freshPhone}`;
    const freshVehicle = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_OPS001' },
        update: { status: 'active', companyId },
        create: { plate: '_OPS001', companyId, status: 'active' },
      }),
    );
    const freshDriverUser = await prisma.user.upsert({
      where: { phone: freshPhone },
      update: {},
      create: { firstName: '_Ops', lastName: 'FreshDriver', phone: freshPhone, role: 'driver' },
    });
    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: freshDriverUser.userId },
        update: {
          companyId,
          status: 'available',
          currentVehicleId: freshVehicle.vehicleId,
          currentLat: 6.96,
          currentLng: -75.42,
          locationUpdatedAt: new Date(),
          pin: 'x',
        },
        create: {
          driverId: freshDriverUser.userId,
          companyId,
          nationalId: freshNationalId,
          pin: 'x',
          status: 'available',
          currentVehicleId: freshVehicle.vehicleId,
          currentLat: 6.96,
          currentLng: -75.42,
          locationUpdatedAt: new Date(),
        },
      }),
    );

    const stalePhone = uniquePhone();
    staleNationalId = `_OPS-DRV-STALE-${stalePhone}`;
    const staleVehicle = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_OPS002' },
        update: { status: 'active', companyId },
        create: { plate: '_OPS002', companyId, status: 'active' },
      }),
    );
    const staleDriverUser = await prisma.user.upsert({
      where: { phone: stalePhone },
      update: {},
      create: { firstName: '_Ops', lastName: 'StaleDriver', phone: stalePhone, role: 'driver' },
    });
    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: staleDriverUser.userId },
        update: {
          companyId,
          status: 'available',
          currentVehicleId: staleVehicle.vehicleId,
          currentLat: 6.97,
          currentLng: -75.43,
          locationUpdatedAt: new Date(Date.now() - 30 * 60_000),
          pin: 'x',
        },
        create: {
          driverId: staleDriverUser.userId,
          companyId,
          nationalId: staleNationalId,
          pin: 'x',
          status: 'available',
          currentVehicleId: staleVehicle.vehicleId,
          currentLat: 6.97,
          currentLng: -75.43,
          locationUpdatedAt: new Date(Date.now() - 30 * 60_000),
        },
      }),
    );

    const token = jwt.sign({ sub: 6000, role: 'operator', type: 'access', company_id: companyId });
    operatorAuth = `Bearer ${token}`;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function makeTrip(status: 'pending_assignment' | 'completed', pickup: string): Promise<number> {
    const t = await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: pickup,
        dropoffAddress: 'destino',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status,
      },
    });
    return t.tripRequestId;
  }

  describe('drivers roster', () => {
    it('server_time is present and no coordinates leak to the console', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/drivers')
        .set('Authorization', operatorAuth);

      expect(res.status).toBe(200);
      expect(res.body.server_time).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/current_lat|current_lng|"lat"|"lng"/);
    });

    it('location_stale is true past location_stale_min, false when fresh', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/drivers')
        .set('Authorization', operatorAuth);

      const fresh = res.body.rows.find((r: { national_id: string }) => r.national_id === freshNationalId);
      const stale = res.body.rows.find((r: { national_id: string }) => r.national_id === staleNationalId);
      expect(fresh.location_stale).toBe(false);
      expect(stale.location_stale).toBe(true);
    });

    it('searching by national_id finds the driver', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/drivers')
        .query({ search: freshNationalId })
        .set('Authorization', operatorAuth);
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].national_id).toBe(freshNationalId);
    });
  });

  describe('trip-requests queue: terminal window of 60s', () => {
    it('a completed trip 30s old is in the queue; one 90s old is not', async () => {
      const recentId = await makeTrip('completed', '_recent-completed');
      const oldId = await makeTrip('completed', '_old-completed');

      await prisma.$executeRaw`
        UPDATE trips.trip_request SET updated_at = (now() AT TIME ZONE 'UTC') - interval '30 seconds'
         WHERE trip_request_id = ${recentId}
      `;
      await prisma.$executeRaw`
        UPDATE trips.trip_request SET updated_at = (now() AT TIME ZONE 'UTC') - interval '90 seconds'
         WHERE trip_request_id = ${oldId}
      `;

      const res = await request(app.getHttpServer())
        .get('/ops/trip-requests')
        .set('Authorization', operatorAuth);

      expect(res.status).toBe(200);
      expect(res.body.server_time).toEqual(expect.any(String));
      const addresses = res.body.rows.map((r: { pickup_address: string }) => r.pickup_address);
      expect(addresses).toContain('_recent-completed');
      expect(addresses).not.toContain('_old-completed');
    });

    it('a pending_assignment request is always in the queue regardless of age', async () => {
      const id = await makeTrip('pending_assignment', '_pending-active');
      await prisma.$executeRaw`
        UPDATE trips.trip_request SET updated_at = (now() AT TIME ZONE 'UTC') - interval '2 hours'
         WHERE trip_request_id = ${id}
      `;

      const res = await request(app.getHttpServer())
        .get('/ops/trip-requests')
        .set('Authorization', operatorAuth);

      const addresses = res.body.rows.map((r: { pickup_address: string }) => r.pickup_address);
      expect(addresses).toContain('_pending-active');
    });
  });
});
