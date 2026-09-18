import type { Prisma, PrismaClient, TripRequest } from '@prisma/client';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

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
        passengerId,
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

      const outcome = await repo.markEnRoute(trip.tripRequestId);

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.status).toBe('driver_en_route');
    });

    it('is idempotent when the trip is already driver_en_route', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await repo.markEnRoute(trip.tripRequestId);

      expect(outcome.kind).toBe('idempotent');
    });

    it('rejects when the trip is not yet assigned', async () => {
      const trip = await makeTrip('pending_assignment');

      const outcome = await repo.markEnRoute(trip.tripRequestId);

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'pending_assignment' });
    });

    it('rejects with status=expired when the trip does not exist', async () => {
      const outcome = await repo.markEnRoute(999_999_999);

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'expired' });
    });
  });

  describe('markArrived', () => {
    it('applies driver_en_route (arrived_at null) -> sets arrived_at, keeps status driver_en_route', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await repo.markArrived(trip.tripRequestId);

      expect(outcome.kind).toBe('applied');
      const persisted = await getTrip(trip.tripRequestId);
      expect(persisted?.status).toBe('driver_en_route');
      expect(persisted?.arrivedAt).not.toBeNull();
    });

    it('is idempotent once arrived_at is already set', async () => {
      const trip = await makeTrip('driver_en_route');
      const first = await repo.markArrived(trip.tripRequestId);
      expect(first.kind).toBe('applied');

      const second = await repo.markArrived(trip.tripRequestId);

      expect(second.kind).toBe('idempotent');
      if (first.kind !== 'rejected' && second.kind !== 'rejected') {
        expect(second.row.arrivedAt.getTime()).toBe(first.row.arrivedAt.getTime());
      }
    });

    it('rejects when the driver has not yet reported en-route', async () => {
      const trip = await makeTrip('assigned');

      const outcome = await repo.markArrived(trip.tripRequestId);

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'assigned' });
    });
  });

  describe('markStarted', () => {
    it('applies driver_en_route -> in_progress', async () => {
      const trip = await makeTrip('driver_en_route');

      const outcome = await repo.markStarted(trip.tripRequestId);

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.status).toBe('in_progress');
    });

    it('is idempotent when already in_progress', async () => {
      const trip = await makeTrip('in_progress');

      const outcome = await repo.markStarted(trip.tripRequestId);

      expect(outcome.kind).toBe('idempotent');
    });

    it('rejects when the trip skipped driver_en_route', async () => {
      const trip = await makeTrip('assigned');

      const outcome = await repo.markStarted(trip.tripRequestId);

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'assigned' });
    });
  });

  describe('getActiveFareConfig (ADR-014 regression: NULLS FIRST no longer wins; ADR-018: scoped by company_id)', () => {
    it('an older, already-closed fareConfig row does not shadow the open one (B-13: one open row per company+service)', async () => {
      await withTenant((tx) => tx.fareConfig.deleteMany({ where: { companyId, serviceType: 'taxi' } }));
      const old = await withTenant((tx) =>
        tx.fareConfig.create({
          data: {
            companyId,
            serviceType: 'taxi',
            baseFare: 5000,
            validFrom: new Date('2020-01-01'),
            validTo: new Date('2020-01-02'),
          },
        }),
      );
      const fresh = await withTenant((tx) =>
        tx.fareConfig.create({
          data: { companyId, serviceType: 'taxi', baseFare: 9000 },
        }),
      );

      const active = await repo.getActiveFareConfig(companyId, 'taxi');

      expect(active?.fareConfigId).toBe(fresh.fareConfigId);
      expect(Number(active?.baseFare)).toBe(9000);
      expect(active?.fareConfigId).not.toBe(old.fareConfigId);
    });

    it('two versions valid the same day: the higher fareConfigId wins the tiebreak', async () => {
      await withTenant((tx) => tx.fareConfig.deleteMany({ where: { companyId, serviceType: 'comfort' } }));
      const today = new Date();
      const first = await withTenant((tx) =>
        tx.fareConfig.create({
          data: { companyId, serviceType: 'comfort', baseFare: 6000, validTo: today },
        }),
      );
      const second = await withTenant((tx) =>
        tx.fareConfig.create({ data: { companyId, serviceType: 'comfort', baseFare: 7000 } }),
      );
      expect(second.fareConfigId).toBeGreaterThan(first.fareConfigId);

      const active = await repo.getActiveFareConfig(companyId, 'comfort');

      expect(active?.fareConfigId).toBe(second.fareConfigId);
      expect(Number(active?.baseFare)).toBe(7000);
    });

    it('a fare config from another company is never resolved, even with the same municipality (RLS + WHERE)', async () => {
      const otherCompany = await raw.company.upsert({
        where: { taxId: '_trips-repo-test-other' },
        update: { status: 'active' },
        create: {
          legalName: '_TripsRepoTestCoOther',
          taxId: '_trips-repo-test-other',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      await raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company', ${String(otherCompany.companyId)}, true)`;
        await tx.fareConfig.deleteMany({
          where: { companyId: otherCompany.companyId, serviceType: 'delivery' },
        });
        await tx.fareConfig.create({
          data: { companyId: otherCompany.companyId, serviceType: 'delivery', baseFare: 4000 },
        });
      });

      const active = await repo.getActiveFareConfig(companyId, 'delivery');

      expect(active).toBeNull();
    });
  });

  describe('markCashCollected', () => {
    it('applies completed (cash_collected_at null) -> sets cash_collected_at', async () => {
      const trip = await makeTrip('completed');

      const outcome = await repo.markCashCollected(trip.tripRequestId);

      expect(outcome.kind).toBe('applied');
      expect((await getTrip(trip.tripRequestId))?.cashCollectedAt).not.toBeNull();
    });

    it('is idempotent once cash_collected_at is already set', async () => {
      const trip = await makeTrip('completed');
      const first = await repo.markCashCollected(trip.tripRequestId);
      expect(first.kind).toBe('applied');

      const second = await repo.markCashCollected(trip.tripRequestId);

      expect(second.kind).toBe('idempotent');
    });

    it('rejects when the trip is not completed yet', async () => {
      const trip = await makeTrip('in_progress');

      const outcome = await repo.markCashCollected(trip.tripRequestId);

      expect(outcome).toMatchObject({ kind: 'rejected', status: 'in_progress' });
    });
  });
});
