import type { Prisma, PrismaClient, TripRequest } from '@prisma/client';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { createFreshPassenger } from './support/fresh-passenger';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

type FixtureStatus = 'pending_assignment' | 'assigned' | 'driver_en_route' | 'in_progress' | 'completed';

suite('TripsRepository raw SQL transitions against real Postgres (ADR-009)', () => {
  let raw: PrismaClient;
  let prismaService: PrismaService;
  let repo: TripsRepository;
  let municipalityId: number;
  let companyId: number;
  let passengerId: number;

  async function withTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();

    prismaService = Object.assign(raw, {
      runInTenant: async <T>(
        cId: number,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> =>
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_company', ${String(cId)}, true)`;
          return fn(tx);
        }),
    }) as unknown as PrismaService;

    repo = new TripsRepository(prismaService);

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9005 },
      update: {},
      create: {
        municipalityId: 9005,
        name: '_TripsRepoTestMuni',
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

    const company = await raw.company.upsert({
      where: { taxId: '_trips-repo-test' },
      update: { status: 'active' },
      create: {
        legalName: '_TripsRepoTestCo',
        taxId: '_trips-repo-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await raw.user.upsert({
      where: { phone: '_9990000301' },
      update: {},
      create: { firstName: '_TripsRepo', lastName: 'Passenger', phone: '_9990000301', role: 'passenger' },
    });
    await raw.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  async function makeTrip(status: FixtureStatus): Promise<TripRequest> {
    return raw.tripRequest.create({
      data: {
        passengerId: await createFreshPassenger(raw),
        municipalityId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        companyId,
        status,
      },
    });
  }

  async function getTrip(tripRequestId: number): Promise<TripRequest | null> {
    return raw.tripRequest.findUnique({ where: { tripRequestId } });
  }

  describe('markEnRoute', () => {
    it('applies assigned -> driver_en_route and persists the new status', async () => {
      const trip = await makeTrip('assigned');

      const outcome = await withTenant((tx) => repo.markEnRoute(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.status).toBe('driver_en_route');
    });

    it('is idempotent when the trip is already driver_en_route', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await withTenant((tx) => repo.markEnRoute(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('idempotent');
    });

    it('rejects when the trip is not yet assigned', async () => {
      const trip = await makeTrip('pending_assignment');

      const outcome = await withTenant((tx) => repo.markEnRoute(tx, trip.tripRequestId));

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'pending_assignment' });
    });

    it('rejects with status=expired when the trip does not exist', async () => {
      const outcome = await withTenant((tx) => repo.markEnRoute(tx, 999_999_999));

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'expired' });
    });
  });

  describe('markArrived', () => {
    it('applies driver_en_route (arrived_at null) -> sets arrived_at, keeps status driver_en_route', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await withTenant((tx) => repo.markArrived(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('applied');
      const persisted = await getTrip(trip.tripRequestId);
      expect(persisted?.status).toBe('driver_en_route');
      expect(persisted?.arrivedAt).not.toBeNull();
    });

    it('is idempotent once arrived_at is already set', async () => {
      const trip = await makeTrip('driver_en_route');
      const first = await withTenant((tx) => repo.markArrived(tx, trip.tripRequestId));
      expect(first.kind).toBe('applied');

      const second = await withTenant((tx) => repo.markArrived(tx, trip.tripRequestId));

      expect(second.kind).toBe('idempotent');
      if (first.kind !== 'rejected' && second.kind !== 'rejected') {
        expect(second.row.arrivedAt.getTime()).toBe(first.row.arrivedAt.getTime());
      }
    });

    it('rejects when the driver has not yet reported en-route', async () => {
      const trip = await makeTrip('assigned');

      const outcome = await withTenant((tx) => repo.markArrived(tx, trip.tripRequestId));

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'assigned' });
    });
  });

  describe('markStarted', () => {
    it('applies driver_en_route -> in_progress', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await withTenant((tx) => repo.markStarted(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.status).toBe('in_progress');
    });

    it('is idempotent when already in_progress', async () => {
      const trip = await makeTrip('in_progress');

      const outcome = await withTenant((tx) => repo.markStarted(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('idempotent');
    });

    it('rejects when the trip skipped driver_en_route', async () => {
      const trip = await makeTrip('assigned');

      const outcome = await withTenant((tx) => repo.markStarted(tx, trip.tripRequestId));

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'assigned' });
    });
  });

  describe('markNoDriverIfUnassigned (MD-05)', () => {
    it('moves a pending trip without company to no_driver', async () => {
      const trip = await raw.tripRequest.create({
        data: {
          passengerId: await createFreshPassenger(raw),
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'A',
          dropoffAddress: 'B',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10000,
          commission: 0,
          status: 'pending_assignment',
        },
      });

      const applied = await repo.markNoDriverIfUnassigned(trip.tripRequestId);

      expect(applied).toBe(true);
      expect((await getTrip(trip.tripRequestId))?.status).toBe('no_driver');
    });

    it('never overwrites a trip that a company already took', async () => {
      const trip = await makeTrip('assigned');

      const applied = await repo.markNoDriverIfUnassigned(trip.tripRequestId);

      expect(applied).toBe(false);
      expect((await getTrip(trip.tripRequestId))?.status).toBe('assigned');
    });

    it('never overwrites a pending trip that already carries a company', async () => {
      const trip = await makeTrip('pending_assignment');

      const applied = await repo.markNoDriverIfUnassigned(trip.tripRequestId);

      expect(applied).toBe(false);
      expect((await getTrip(trip.tripRequestId))?.status).toBe('pending_assignment');
    });
  });

  describe('markCashCollected', () => {
    it('applies completed (cash_collected_at null) -> sets cash_collected_at', async () => {
      const trip = await makeTrip('completed');

      const outcome = await withTenant((tx) => repo.markCashCollected(tx, trip.tripRequestId));

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.cashCollectedAt).not.toBeNull();
    });

    it('is idempotent once cash_collected_at is already set', async () => {
      const trip = await makeTrip('completed');
      const first = await withTenant((tx) => repo.markCashCollected(tx, trip.tripRequestId));
      expect(first.kind).toBe('applied');

      const second = await withTenant((tx) => repo.markCashCollected(tx, trip.tripRequestId));

      expect(second.kind).toBe('idempotent');
    });

    it('rejects when the trip is not completed yet', async () => {
      const trip = await makeTrip('in_progress');

      const outcome = await withTenant((tx) => repo.markCashCollected(tx, trip.tripRequestId));

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'in_progress' });
    });
  });
});
