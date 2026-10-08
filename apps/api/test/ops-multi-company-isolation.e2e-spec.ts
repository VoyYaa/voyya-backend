import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AssignmentStatus, TripStatus } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { createFreshPassenger } from './support/fresh-passenger';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

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

interface QueueRow {
  trip_request_id: number;
  pickup_address: string;
  driver: { name: string } | null;
}

interface Owner {
  companyId: number;
  driverId: number;
  vehicleId: number;
}

suite('B-04: the ops console is scoped by company, not by municipality, with two companies in one municipality', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  let municipalityId: number;
  let companyAId: number;
  let companyBId: number;
  let driverAId: number;
  let driverBId: number;
  const trips: Record<string, number> = {};
  const run = randomUUID().slice(0, 8);

  function address(label: string): string {
    return `${label}-${run}`;
  }

  function authFor(companyId: number): string {
    return `Bearer ${jwt.sign({ sub: 900300 + companyId, role: 'operator', type: 'access', company_id: companyId })}`;
  }

  async function seedDriver(companyId: number, plate: string, label: string): Promise<Owner> {
    const vehicle = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate },
        update: { status: 'active', companyId },
        create: { plate, companyId, status: 'active' },
      }),
    );
    const user = await prisma.user.create({
      data: {
        firstName: label,
        lastName: `Driver-${run}`,
        phone: `3${randomInt(100_000_000, 999_999_999)}`,
        role: 'driver',
      },
    });
    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.create({
        data: {
          driverId: user.userId,
          companyId,
          nationalId: `_MC-${run}-${label}`,
          pin: 'hashed:x',
          status: 'available',
          currentVehicleId: vehicle.vehicleId,
          locationUpdatedAt: new Date(),
        },
      }),
    );
    return { companyId, driverId: user.userId, vehicleId: vehicle.vehicleId };
  }

  async function seedTrip(
    muniId: number,
    key: string,
    status: TripStatus,
    assignment: { owner: Owner; status: AssignmentStatus } | null,
  ): Promise<number> {
    const trip = await prisma.tripRequest.create({
      data: {
        passengerId: await createFreshPassenger(prisma, { firstName: `Pax-${key}` }),
        municipalityId: muniId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: address(`${key}-pickup`),
        dropoffAddress: address(`${key}-dropoff`),
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status,
      },
    });
    trips[key] = trip.tripRequestId;
    if (assignment) {
      await prisma.runInTenant(assignment.owner.companyId, (tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId: assignment.owner.driverId,
            vehicleId: assignment.owner.vehicleId,
            companyId: assignment.owner.companyId,
            status: assignment.status,
          },
        }),
      );
    }
    return trip.tripRequestId;
  }

  async function upsertMunicipality(id: number, name: string): Promise<number> {
    const row = await prisma.municipality.upsert({
      where: { municipalityId: id },
      update: {},
      create: { municipalityId: id, name, department: 'Test', coveragePolygon: poly, status: 'active' },
    });
    return row.municipalityId;
  }

  async function upsertCompany(taxId: string, muniId: number): Promise<number> {
    const row = await prisma.company.upsert({
      where: { taxId },
      update: { status: 'active' },
      create: { legalName: taxId, taxId, type: 'cooperative', municipalityId: muniId, status: 'active' },
    });
    return row.companyId;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    municipalityId = await upsertMunicipality(9211, '_MultiCoMuni');
    companyAId = await upsertCompany('_multico-a', municipalityId);
    companyBId = await upsertCompany('_multico-b', municipalityId);

    const a = await seedDriver(companyAId, '_MCA001', 'DrvA');
    const b = await seedDriver(companyBId, '_MCB001', 'DrvB');
    driverAId = a.driverId;
    driverBId = b.driverId;

    await seedTrip(municipalityId, 'a-unassigned', 'pending_assignment', null);
    await seedTrip(municipalityId, 'a-offered', 'pending_assignment', { owner: a, status: 'notified' });
    await seedTrip(municipalityId, 'a-assigned', 'assigned', { owner: a, status: 'accepted' });
    await seedTrip(municipalityId, 'a-completed', 'completed', { owner: a, status: 'completed' });
    await seedTrip(municipalityId, 'b-offered', 'pending_assignment', { owner: b, status: 'notified' });
    await seedTrip(municipalityId, 'b-assigned', 'assigned', { owner: b, status: 'accepted' });
    await seedTrip(municipalityId, 'b-completed', 'completed', { owner: b, status: 'completed' });
    await seedTrip(municipalityId, 'b-no-driver', 'no_driver', { owner: b, status: 'rejected' });
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function queueOf(companyId: number): Promise<QueueRow[]> {
    const res = await request(app.getHttpServer())
      .get('/ops/trip-requests?limit=200')
      .set('Authorization', authFor(companyId));
    expect(res.status).toBe(200);
    return (res.body.rows as QueueRow[]).filter((r) => r.pickup_address.endsWith(`-${run}`));
  }

  function pickups(keys: string[]): string[] {
    return keys.map((k) => address(`${k}-pickup`)).sort();
  }

  it('the dispatch-target company A sees its own trips plus the unassigned pending one, never B trips', async () => {
    const rows = await queueOf(companyAId);
    expect(rows.map((r) => r.pickup_address).sort()).toEqual(
      pickups(['a-unassigned', 'a-offered', 'a-assigned', 'a-completed']),
    );
  });

  it('company B sees only the trips of its own assignments, not the unassigned one nor A trips', async () => {
    const rows = await queueOf(companyBId);
    expect(rows.map((r) => r.pickup_address).sort()).toEqual(
      pickups(['b-offered', 'b-assigned', 'b-completed', 'b-no-driver']),
    );
  });

  it('the queue exposes the assigned driver of the viewer only', async () => {
    const rowsA = await queueOf(companyAId);
    const rowsB = await queueOf(companyBId);
    expect(rowsA.find((r) => r.pickup_address === address('a-assigned-pickup'))?.driver?.name).toContain('DrvA');
    expect(JSON.stringify(rowsA)).not.toContain('DrvB');
    expect(JSON.stringify(rowsB)).not.toContain('DrvA');
  });

  it('status filter chips keep the scope', async () => {
    const res = await request(app.getHttpServer())
      .get('/ops/trip-requests?status=no_driver&limit=200')
      .set('Authorization', authFor(companyAId));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(address('b-no-driver-pickup'));
  });

  it.each([
    ['a-assigned', 'b-assigned'],
    ['a-completed', 'b-completed'],
    ['a-offered', 'b-offered'],
  ])('detail: A reads %s (200) and gets 404 for %s of B', async (own, foreign) => {
    const ok = await request(app.getHttpServer())
      .get(`/ops/trip-requests/${trips[own]}`)
      .set('Authorization', authFor(companyAId));
    expect(ok.status).toBe(200);
    const denied = await request(app.getHttpServer())
      .get(`/ops/trip-requests/${trips[foreign]}`)
      .set('Authorization', authFor(companyAId));
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ code: 'TRIP_REQUEST_NOT_FOUND' });
    expect(JSON.stringify(denied.body)).not.toContain(address(`${foreign}-pickup`));
  });

  it('detail: B reads its own trips and gets 404 for every trip of A, including the unassigned one', async () => {
    for (const own of ['b-assigned', 'b-completed', 'b-offered', 'b-no-driver']) {
      const res = await request(app.getHttpServer())
        .get(`/ops/trip-requests/${trips[own]}`)
        .set('Authorization', authFor(companyBId));
      expect(res.status).toBe(200);
    }
    for (const foreign of ['a-assigned', 'a-completed', 'a-offered', 'a-unassigned']) {
      const res = await request(app.getHttpServer())
        .get(`/ops/trip-requests/${trips[foreign]}`)
        .set('Authorization', authFor(companyBId));
      expect(res.status).toBe(404);
    }
  });

  it('detail: A reads the unassigned pending trip of its municipality', async () => {
    const res = await request(app.getHttpServer())
      .get(`/ops/trip-requests/${trips['a-unassigned']}`)
      .set('Authorization', authFor(companyAId));
    expect(res.status).toBe(200);
  });

  it('drivers: each company lists and reads only its own drivers', async () => {
    const listA = await request(app.getHttpServer())
      .get('/ops/drivers?limit=200')
      .set('Authorization', authFor(companyAId));
    const listB = await request(app.getHttpServer())
      .get('/ops/drivers?limit=200')
      .set('Authorization', authFor(companyBId));
    const idsA = (listA.body.rows as Array<{ driver_id: number }>).map((r) => r.driver_id);
    const idsB = (listB.body.rows as Array<{ driver_id: number }>).map((r) => r.driver_id);
    expect(idsA).toContain(driverAId);
    expect(idsA).not.toContain(driverBId);
    expect(idsB).toContain(driverBId);
    expect(idsB).not.toContain(driverAId);
    const foreign = await request(app.getHttpServer())
      .get(`/ops/drivers/${driverBId}`)
      .set('Authorization', authFor(companyAId));
    expect(foreign.status).toBe(404);
  });

  it('single-company regression: the only company of a municipality sees its unassigned and assigned trips', async () => {
    const soloMunicipality = await upsertMunicipality(9212, '_MultiCoSolo');
    const soloCompany = await upsertCompany('_multico-solo', soloMunicipality);
    const solo = await seedDriver(soloCompany, '_MCS001', 'DrvS');
    const unassigned = await seedTrip(soloMunicipality, 'solo-unassigned', 'pending_assignment', null);
    const assigned = await seedTrip(soloMunicipality, 'solo-assigned', 'assigned', {
      owner: solo,
      status: 'accepted',
    });

    const rows = await queueOf(soloCompany);
    expect(rows.map((r) => r.trip_request_id).sort()).toEqual([unassigned, assigned].sort());
    const detail = await request(app.getHttpServer())
      .get(`/ops/trip-requests/${unassigned}`)
      .set('Authorization', authFor(soloCompany));
    expect(detail.status).toBe(200);
  });
});
