import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { EnvService } from '../src/config/env.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { TripCoordinatesPurgeService } from '../src/modules/trips/trip-coordinates-purge.service';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const MUNICIPALITY_ID = 9151;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SETTLEMENT = '/admin/reports/settlement';
const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

function daysAgo(days: number, extraMs = 0): Date {
  return new Date(Date.now() - days * DAY_MS - extraMs);
}

function bogotaDay(instant: Date): string {
  return new Date(instant.getTime() - 5 * HOUR_MS).toISOString().slice(0, 10);
}

function fakeEnv(days: number): EnvService {
  return { get: (key: string) => (key === 'TRIP_COORDINATES_RETENTION_DAYS' ? days : undefined) } as unknown as EnvService;
}

suite('TripCoordinatesPurgeService against real Postgres as app_voyya (ADR-029 section 5, HU-PRV-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: TripCoordinatesPurgeService;
  let jwt: JwtService;
  let companyId: number;
  let passengerId: number;
  let driverId: number;
  let vehicleId: number;
  let adminAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_PURGE_HOURS = '0';
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    service = new TripCoordinatesPurgeService(prisma, new TripsRepository(prisma), fakeEnv(90));

    await prisma.municipality.upsert({
      where: { municipalityId: MUNICIPALITY_ID },
      update: {},
      create: {
        municipalityId: MUNICIPALITY_ID,
        name: '_TripPurgeMuni',
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
    const company = await prisma.company.upsert({
      where: { taxId: '_trip-purge-co' },
      update: { status: 'active' },
      create: {
        legalName: '_TripPurgeCo',
        taxId: '_trip-purge-co',
        type: 'cooperative',
        municipalityId: MUNICIPALITY_ID,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passenger = await prisma.user.create({
      data: { firstName: '_Purge', lastName: 'Passenger', phone: `_tp-${runId}-p`, role: 'passenger' },
    });
    await prisma.passenger.create({ data: { passengerId: passenger.userId } });
    passengerId = passenger.userId;

    const driver = await prisma.user.create({
      data: { firstName: '_Purge', lastName: 'Driver', phone: `_tp-${runId}-d`, role: 'driver', companyId },
    });
    driverId = driver.userId;
    await prisma.runInTenant(companyId, async (tx) => {
      const vehicle = await tx.vehicle.create({
        data: { companyId, plate: `_T${runId.slice(-9)}`, status: 'active' },
      });
      vehicleId = vehicle.vehicleId;
      await tx.driver.create({
        data: {
          driverId,
          companyId,
          nationalId: `_tp-${runId}`,
          pin: 'x',
          currentVehicleId: vehicleId,
        },
      });
    });
    adminAuth = `Bearer ${jwt.sign({ sub: 1, role: 'admin', type: 'access', company_id: companyId })}`;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  }, 20_000);

  async function seedTrip(options: {
    status: 'completed' | 'cancelled_by_passenger' | 'no_driver' | 'in_progress';
    requestedAt: Date;
    finishedAt?: Date | null;
    withAssignment?: boolean;
  }): Promise<number> {
    const trip = await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId: MUNICIPALITY_ID,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'Calle 10 # 5-20',
        dropoffAddress: 'Carrera 7 # 8-9',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status: options.status,
        requestedAt: options.requestedAt,
        finishedAt: options.finishedAt ?? null,
        cashCollectedAt: options.status === 'completed' ? options.finishedAt ?? null : null,
        netEarnings: options.status === 'completed' ? 9200 : null,
      },
    });
    if (options.withAssignment) {
      await prisma.runInTenant(companyId, (tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId,
            vehicleId,
            companyId,
            status: options.status === 'in_progress' ? 'accepted' : 'completed',
            assignedBy: 'system',
          },
        }),
      );
    }
    return trip.tripRequestId;
  }

  async function readTrip(tripRequestId: number) {
    return prisma.tripRequest.findUniqueOrThrow({ where: { tripRequestId } });
  }

  async function readPickupLocation(tripRequestId: number): Promise<string | null> {
    const rows = await prisma.$queryRaw<Array<{ location: string | null }>>`
      SELECT ST_AsText(pickup_location::geometry) AS location
        FROM trips.trip_request
       WHERE trip_request_id = ${tripRequestId}
    `;
    return rows[0]?.location ?? null;
  }

  function isPurged(trip: Awaited<ReturnType<typeof readTrip>>): boolean {
    return trip.locationPurgedAt !== null;
  }

  it('purges only terminal trips past the retention and leaves the rest untouched', async () => {
    const at89 = daysAgo(89);
    const at90 = daysAgo(90, HOUR_MS);
    const at91 = daysAgo(91);
    const kept = await seedTrip({ status: 'completed', requestedAt: at89, finishedAt: at89 });
    const boundary = await seedTrip({ status: 'completed', requestedAt: at90, finishedAt: at90 });
    const older = await seedTrip({ status: 'cancelled_by_passenger', requestedAt: at91, finishedAt: at91 });
    const neverFinished = await seedTrip({ status: 'no_driver', requestedAt: daysAgo(95), finishedAt: null });
    const activeAncient = await seedTrip({ status: 'in_progress', requestedAt: daysAgo(200) });

    const before = await readTrip(boundary);
    expect(await readPickupLocation(boundary)).toBe('POINT(0.1 0.1)');

    await service.purge();

    expect(isPurged(await readTrip(kept))).toBe(false);
    expect(isPurged(await readTrip(activeAncient))).toBe(false);
    expect(await readPickupLocation(kept)).toBe('POINT(0.1 0.1)');
    expect(await readPickupLocation(activeAncient)).toBe('POINT(0.1 0.1)');
    expect(await readTrip(activeAncient)).toMatchObject({ pickupLat: 0.1, pickupAddress: 'Calle 10 # 5-20' });

    for (const id of [boundary, older, neverFinished]) {
      const trip = await readTrip(id);
      expect(trip).toMatchObject({
        pickupLat: null,
        pickupLng: null,
        dropoffLat: null,
        dropoffLng: null,
        pickupAddress: null,
        dropoffAddress: null,
      });
      expect(trip.locationPurgedAt).toBeInstanceOf(Date);
      expect(await readPickupLocation(id)).toBeNull();
    }

    const after = await readTrip(boundary);
    expect(after).toMatchObject({
      status: 'completed',
      fare: before.fare,
      commission: before.commission,
      netEarnings: before.netEarnings,
      municipalityId: MUNICIPALITY_ID,
    });
    expect(after.finishedAt).toEqual(before.finishedAt);
    expect(after.cashCollectedAt).toEqual(before.cashCollectedAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('is idempotent: a second run does not change the purge timestamp', async () => {
    const at = daysAgo(120);
    const id = await seedTrip({ status: 'completed', requestedAt: at, finishedAt: at });
    await service.purge();
    const first = (await readTrip(id)).locationPurgedAt;
    expect(first).not.toBeNull();
    await service.purge();
    expect((await readTrip(id)).locationPurgedAt).toEqual(first);
  });

  it('keeps the settlement report totals identical before and after the purge', async () => {
    const finished = daysAgo(100);
    await seedTrip({ status: 'completed', requestedAt: finished, finishedAt: finished, withAssignment: true });
    const day = bogotaDay(finished);
    const read = () =>
      request(app.getHttpServer()).get(SETTLEMENT).query({ from: day, to: day }).set('Authorization', adminAuth);

    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.totals.trip_count).toBeGreaterThanOrEqual(1);

    await service.purge();

    const after = await read();
    expect(after.status).toBe(200);
    expect(after.body.totals).toEqual(before.body.totals);
    expect(after.body.rows).toEqual(before.body.rows);
  });

  it('runs without a tenant session and leaves no tenant setting behind that breaks the pool', async () => {
    await service.purge();
    const client = prisma as unknown as PrismaClient;
    const rows = await client.$transaction(async (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trips.trip_request`,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});
