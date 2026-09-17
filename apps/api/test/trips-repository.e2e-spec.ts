import type { PrismaClient, TripRequest } from '@prisma/client';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

type FixtureStatus = 'pending_assignment' | 'assigned' | 'driver_en_route' | 'in_progress' | 'completed';

suite('TripsRepository raw SQL transitions against real Postgres (ADR-009)', () => {
  let raw: PrismaClient;
  let repo: TripsRepository;
  let municipalityId: number;
  let passengerId: number;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();

    repo = new TripsRepository(raw as unknown as PrismaService);

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
