import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AssignmentStatus, TripStatus } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

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

const PREFIX = '_MultiCo';

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

function acceptedStatusFor(tripStatus: TripStatus): AssignmentStatus {
  if (tripStatus === 'completed') return 'completed';
  if (tripStatus === 'cancelled_by_passenger') return 'cancelled';
  return 'accepted';
}

interface TripSeed {
  status: TripStatus;
  requestedCompanyId?: number;
  companyId?: number;
  offer?: { owner: Owner; status: AssignmentStatus; expired?: boolean };
  accepted?: Owner;
}

suite('HU-MS-08 and HU-MS-09: the ops console is scoped by the trip company, with two or more companies in one municipality', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  let municipalityId: number;
  let companyAId: number;
  let companyBId: number;
  let companyCId: number;
  let driverAId: number;
  let driverBId: number;
  let ownerA: Owner;
  let ownerB: Owner;
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

  async function seedTrip(muniId: number, key: string, seed: TripSeed): Promise<number> {
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
        commission: seed.companyId ? 800 : 0,
        commissionPct: seed.companyId ? 8 : null,
        status: seed.status,
        requestedCompanyId: seed.requestedCompanyId ?? null,
        companyId: seed.companyId ?? null,
      },
    });
    trips[key] = trip.tripRequestId;
    for (const link of [
      seed.accepted ? { owner: seed.accepted, status: acceptedStatusFor(seed.status), expired: false } : null,
      seed.offer ?? null,
    ]) {
      if (!link) continue;
      await prisma.runInTenant(link.owner.companyId, (tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId: link.owner.driverId,
            vehicleId: link.owner.vehicleId,
            companyId: link.owner.companyId,
            status: link.status,
            expiresAt: new Date(Date.now() + (link.expired ? -3_600_000 : 60_000)),
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
      update: { status: 'active', municipalityId: muniId },
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

    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    municipalityId = await upsertMunicipality(9211, `${PREFIX}Muni`);
    companyAId = await upsertCompany('_multico-a', municipalityId);
    companyBId = await upsertCompany('_multico-b', municipalityId);
    companyCId = await upsertCompany('_multico-c', municipalityId);

    ownerA = await seedDriver(companyAId, '_MCA001', 'DrvA');
    ownerB = await seedDriver(companyBId, '_MCB001', 'DrvB');
    driverAId = ownerA.driverId;
    driverBId = ownerB.driverId;

    await seedTrip(municipalityId, 'a-accepted', { status: 'assigned', companyId: companyAId, accepted: ownerA });
    await seedTrip(municipalityId, 'a-completed', { status: 'completed', companyId: companyAId, accepted: ownerA });
    await seedTrip(municipalityId, 'a-directed-pending', { status: 'pending_assignment', requestedCompanyId: companyAId });
    await seedTrip(municipalityId, 'a-directed-no-driver', { status: 'no_driver', requestedCompanyId: companyAId });
    await seedTrip(municipalityId, 'a-directed-cancelled', {
      status: 'cancelled_by_passenger',
      requestedCompanyId: companyAId,
    });
    await seedTrip(municipalityId, 'b-accepted', { status: 'assigned', companyId: companyBId, accepted: ownerB });
    await seedTrip(municipalityId, 'b-completed', { status: 'completed', companyId: companyBId, accepted: ownerB });
    await seedTrip(municipalityId, 'b-directed-pending', { status: 'pending_assignment', requestedCompanyId: companyBId });
    await seedTrip(municipalityId, 'b-directed-no-driver', { status: 'no_driver', requestedCompanyId: companyBId });
    await seedTrip(municipalityId, 'b-cancelled-after-accept', {
      status: 'cancelled_by_passenger',
      companyId: companyBId,
      accepted: ownerB,
    });
    await seedTrip(municipalityId, 'any-pending', { status: 'pending_assignment' });
    await seedTrip(municipalityId, 'any-no-driver', { status: 'no_driver' });
    await seedTrip(municipalityId, 'any-offered-to-a', {
      status: 'pending_assignment',
      offer: { owner: ownerA, status: 'notified' },
    });
    await seedTrip(municipalityId, 'any-lost-offer-taken-by-b', {
      status: 'assigned',
      companyId: companyBId,
      accepted: ownerB,
      offer: { owner: ownerA, status: 'rejected' },
    });
    await seedTrip(municipalityId, 'any-expired-offer-taken-by-b', {
      status: 'assigned',
      companyId: companyBId,
      accepted: ownerB,
      offer: { owner: ownerA, status: 'notified', expired: true },
    });
  }, 60_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    if (app) await app.close();
  }, 60_000);

  async function queueOf(companyId: number, muniScoped = true): Promise<QueueRow[]> {
    const res = await request(app.getHttpServer())
      .get('/ops/trip-requests?limit=200')
      .set('Authorization', authFor(companyId));
    expect(res.status).toBe(200);
    return (res.body.rows as QueueRow[]).filter((r) => !muniScoped || r.pickup_address.endsWith(`-${run}`));
  }

  function pickups(keys: string[]): string[] {
    return keys.map((k) => address(`${k}-pickup`)).sort();
  }

  function detailOf(companyId: number, key: string) {
    return request(app.getHttpServer())
      .get(`/ops/trip-requests/${trips[key]}`)
      .set('Authorization', authFor(companyId));
  }

  it('company A sees what its drivers accepted and what was directed to it, in any status', async () => {
    const rows = await queueOf(companyAId);
    expect(rows.map((r) => r.pickup_address).sort()).toEqual(
      pickups([
        'a-accepted',
        'a-completed',
        'a-directed-pending',
        'a-directed-no-driver',
        'a-directed-cancelled',
      ]),
    );
  });

  it('company B sees what its drivers accepted, including a trip cancelled after the acceptance, and what was directed to it', async () => {
    const rows = await queueOf(companyBId);
    expect(rows.map((r) => r.pickup_address).sort()).toEqual(
      pickups([
        'b-accepted',
        'b-completed',
        'b-cancelled-after-accept',
        'b-directed-pending',
        'b-directed-no-driver',
        'any-lost-offer-taken-by-b',
        'any-expired-offer-taken-by-b',
      ]),
    );
  });

  it('company C has no trips of its own and sees none of A or B', async () => {
    expect(await queueOf(companyCId)).toEqual([]);
  });

  it('an undirected trip with two or more companies reaches no queue: not in progress, not without a driver, not offered', async () => {
    for (const companyId of [companyAId, companyBId, companyCId]) {
      const pickupsSeen = (await queueOf(companyId)).map((r) => r.pickup_address);
      expect(pickupsSeen).not.toContain(address('any-pending-pickup'));
      expect(pickupsSeen).not.toContain(address('any-no-driver-pickup'));
      expect(pickupsSeen).not.toContain(address('any-offered-to-a-pickup'));
    }
  });

  it('an offer is not a permission: a lost, rejected or expired offer gives no queue entry and no detail', async () => {
    expect((await queueOf(companyAId)).map((r) => r.pickup_address)).not.toContain(
      address('any-lost-offer-taken-by-b-pickup'),
    );
    for (const key of ['any-lost-offer-taken-by-b', 'any-expired-offer-taken-by-b', 'any-offered-to-a']) {
      const denied = await detailOf(companyAId, key);
      expect(denied.status).toBe(404);
      expect(denied.body).toMatchObject({ code: 'TRIP_REQUEST_NOT_FOUND' });
      expect(JSON.stringify(denied.body)).not.toContain(address(`${key}-pickup`));
    }
    expect((await detailOf(companyBId, 'any-lost-offer-taken-by-b')).status).toBe(200);
  });

  it('the queue exposes the assigned driver of the viewer only', async () => {
    const rowsA = await queueOf(companyAId);
    const rowsB = await queueOf(companyBId);
    expect(rowsA.find((r) => r.pickup_address === address('a-accepted-pickup'))?.driver?.name).toContain('DrvA');
    expect(JSON.stringify(rowsA)).not.toContain('DrvB');
    expect(JSON.stringify(rowsB)).not.toContain('DrvA');
  });

  it('status filter chips keep the scope', async () => {
    const res = await request(app.getHttpServer())
      .get('/ops/trip-requests?status=no_driver&limit=200')
      .set('Authorization', authFor(companyAId));
    expect(res.status).toBe(200);
    const seen = JSON.stringify(res.body);
    expect(seen).toContain(address('a-directed-no-driver-pickup'));
    expect(seen).not.toContain(address('b-directed-no-driver-pickup'));
    expect(seen).not.toContain(address('any-no-driver-pickup'));
  });

  it.each([
    ['a-accepted', 'b-accepted'],
    ['a-completed', 'b-completed'],
    ['a-directed-pending', 'b-directed-pending'],
    ['a-directed-no-driver', 'b-directed-no-driver'],
  ])('detail: A reads %s (200) and gets 404 for %s of B, with no data of the foreign passenger', async (own, foreign) => {
    expect((await detailOf(companyAId, own)).status).toBe(200);
    const denied = await detailOf(companyAId, foreign);
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ code: 'TRIP_REQUEST_NOT_FOUND' });
    expect(JSON.stringify(denied.body)).not.toContain(address(`${foreign}-pickup`));
    expect(JSON.stringify(denied.body)).not.toContain(`Pax-${foreign}`);
  });

  it('detail: B reads its own trips and gets 404 for every trip of A and every undirected one', async () => {
    for (const own of ['b-accepted', 'b-completed', 'b-cancelled-after-accept', 'b-directed-pending']) {
      expect((await detailOf(companyBId, own)).status).toBe(200);
    }
    for (const foreign of [
      'a-accepted',
      'a-completed',
      'a-directed-pending',
      'a-directed-cancelled',
      'any-pending',
      'any-no-driver',
      'any-offered-to-a',
    ]) {
      expect((await detailOf(companyBId, foreign)).status).toBe(404);
    }
  });

  it('detail: nobody reads an undirected trip with two or more companies', async () => {
    for (const companyId of [companyAId, companyBId, companyCId]) {
      expect((await detailOf(companyId, 'any-pending')).status).toBe(404);
      expect((await detailOf(companyId, 'any-no-driver')).status).toBe(404);
    }
  });

  it('the detail shows commission 0 while the trip is not completed, accepted or not', async () => {
    const accepted = await detailOf(companyAId, 'a-accepted');
    expect(accepted.body.fare.commission).toBe(0);
    const directed = await detailOf(companyAId, 'a-directed-pending');
    expect(directed.body.fare.commission).toBe(0);
  });

  it('the trip changes company: B stops seeing it when it returns to the search and only C sees it once C takes it', async () => {
    const tripId = await seedTrip(municipalityId, 'moves-b-to-c', {
      status: 'assigned',
      companyId: companyBId,
      accepted: ownerB,
    });
    expect((await detailOf(companyBId, 'moves-b-to-c')).status).toBe(200);

    await prisma.runInTenant(companyBId, async (tx) => {
      await tx.tripRequest.update({
        where: { tripRequestId: tripId },
        data: { companyId: null, status: 'pending_assignment', commission: 0, commissionPct: null },
      });
      await tx.assignment.updateMany({
        where: { tripRequestId: tripId, companyId: companyBId },
        data: { status: 'cancelled' },
      });
    });
    expect((await detailOf(companyBId, 'moves-b-to-c')).status).toBe(404);
    expect((await queueOf(companyBId)).map((r) => r.trip_request_id)).not.toContain(tripId);

    const ownerC = await seedDriver(companyCId, '_MCC001', 'DrvC');
    await prisma.runInTenant(companyCId, async (tx) => {
      await tx.assignment.create({
        data: {
          tripRequestId: tripId,
          driverId: ownerC.driverId,
          vehicleId: ownerC.vehicleId,
          companyId: companyCId,
          status: 'accepted',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await tx.tripRequest.update({
        where: { tripRequestId: tripId },
        data: { companyId: companyCId, status: 'assigned' },
      });
    });
    expect((await detailOf(companyCId, 'moves-b-to-c')).status).toBe(200);
    expect((await detailOf(companyBId, 'moves-b-to-c')).status).toBe(404);
    expect((await detailOf(companyAId, 'moves-b-to-c')).status).toBe(404);
  });

  it('a platform_admin gets no trip data from the ops endpoints', async () => {
    const platformAuth = `Bearer ${jwt.sign({ sub: 900399, role: 'platform_admin', type: 'access' })}`;
    const list = await request(app.getHttpServer()).get('/ops/trip-requests').set('Authorization', platformAuth);
    expect(list.status).toBe(403);
    const detail = await request(app.getHttpServer())
      .get(`/ops/trip-requests/${trips['a-accepted']}`)
      .set('Authorization', platformAuth);
    expect(detail.status).toBe(403);
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

  it('single-company regression (RT-3): an undirected trip of a municipality with one company is its own, unassigned or assigned', async () => {
    const soloMunicipality = await upsertMunicipality(9212, `${PREFIX}Solo`);
    const soloCompany = await upsertCompany('_multico-solo', soloMunicipality);
    const solo = await seedDriver(soloCompany, '_MCS001', 'DrvS');
    const unassigned = await seedTrip(soloMunicipality, 'solo-unassigned', { status: 'pending_assignment' });
    const noDriver = await seedTrip(soloMunicipality, 'solo-no-driver', { status: 'no_driver' });
    const assigned = await seedTrip(soloMunicipality, 'solo-assigned', {
      status: 'assigned',
      companyId: soloCompany,
      accepted: solo,
    });

    const rows = await queueOf(soloCompany);
    expect(rows.map((r) => r.trip_request_id).sort()).toEqual([unassigned, noDriver, assigned].sort());
    expect((await detailOf(soloCompany, 'solo-unassigned')).status).toBe(200);
  });

  it('a second company that appears after the trip was created does not inherit it: the addressee was fixed at creation', async () => {
    const lateMunicipality = await upsertMunicipality(9215, `${PREFIX}Late`);
    const firstCompany = await upsertCompany('_multico-late-1', lateMunicipality);
    const secondCompany = await upsertCompany('_multico-late-2', lateMunicipality);
    await prisma.company.update({ where: { companyId: secondCompany }, data: { status: 'suspended' } });
    const tripId = await seedTrip(lateMunicipality, 'late-any', { status: 'pending_assignment' });
    await prisma.company.update({ where: { companyId: secondCompany }, data: { status: 'active' } });

    expect((await detailOf(firstCompany, 'late-any')).status).toBe(200);
    expect(tripId).toBeGreaterThan(0);
    expect((await detailOf(secondCompany, 'late-any')).status).toBe(404);
  });
});
