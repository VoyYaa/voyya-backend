import type { Assignment, Driver, Prisma, PrismaClient } from '@prisma/client';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import { TripClosingService } from '../src/modules/assignment/trip-closing.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

type FixtureStatus = 'in_progress' | 'driver_en_route';

suite('TripClosingService.closeTrip against real Postgres (ADR-009)', () => {
  let raw: PrismaClient;
  let repo: AssignmentRepository;
  let tripClosing: TripClosingService;
  let companyId: number;
  let municipalityId: number;
  let driverId: number;
  let vehicleId: number;
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

    const prismaService = {
      ...raw,
      runInTenant: async <T>(
        cId: number,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> =>
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_company', ${String(cId)}, true)`;
          return fn(tx);
        }),
    } as unknown as PrismaService;

    repo = new AssignmentRepository(prismaService);
    tripClosing = new TripClosingService(prismaService, repo);

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9001 },
      update: {},
      create: {
        municipalityId: 9001,
        name: '_TripClosingTestMuni',
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
      where: { taxId: '_trip-closing-test' },
      update: { status: 'active' },
      create: {
        legalName: '_TripClosingTestCo',
        taxId: '_trip-closing-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await raw.user.upsert({
      where: { phone: '_9990000001' },
      update: {},
      create: { firstName: '_Test', lastName: 'Passenger', phone: '_9990000001', role: 'passenger' },
    });
    await raw.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    const vehicle = await withTenant((tx) =>
      tx.vehicle.upsert({
        where: { plate: '_TCT001' },
        update: { status: 'active', companyId },
        create: { plate: '_TCT001', companyId, status: 'active' },
      }),
    );
    vehicleId = vehicle.vehicleId;

    const driverUser = await raw.user.upsert({
      where: { phone: '_9990000002' },
      update: {},
      create: { firstName: '_Test', lastName: 'Driver', phone: '_9990000002', role: 'driver' },
    });
    driverId = driverUser.userId;

    await withTenant((tx) =>
      tx.driver.upsert({
        where: { driverId },
        update: { companyId, status: 'on_trip', currentVehicleId: vehicleId, pin: 'x' },
        create: {
          driverId,
          companyId,
          nationalId: '_TCT-DRV-1',
          pin: 'x',
          status: 'on_trip',
          currentVehicleId: vehicleId,
        },
      }),
    );
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  async function makeTrip(status: FixtureStatus, arrivedMinutesAgo?: number) {
    const trip = await raw.tripRequest.create({
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
    if (arrivedMinutesAgo !== undefined) {
      await raw.$executeRaw`
        UPDATE trips.trip_request
           SET arrived_at = (now() AT TIME ZONE 'UTC') - (${arrivedMinutesAgo} * interval '1 minute')
         WHERE trip_request_id = ${trip.tripRequestId}
      `;
    }
    await withTenant((tx) =>
      tx.assignment.create({
        data: {
          tripRequestId: trip.tripRequestId,
          driverId,
          vehicleId,
          companyId,
          status: 'accepted',
          assignedBy: 'system',
        },
      }),
    );
    await withTenant((tx) => tx.driver.update({ where: { driverId }, data: { status: 'on_trip' } }));
    return trip;
  }

  async function getDriver(): Promise<Driver | null> {
    return withTenant((tx) => tx.driver.findFirst({ where: { driverId } }));
  }

  async function getAssignment(tripRequestId: number): Promise<Assignment | null> {
    return withTenant((tx) => tx.assignment.findFirst({ where: { tripRequestId } }));
  }

  it('completes an in_progress trip: net_earnings = fare - commission, releases the driver, closes the assignment', async () => {
    const trip = await makeTrip('in_progress');

    const outcome = await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'completed',
      companyId,
      cashCollected: true,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'rejected') {
      expect(outcome.netEarnings).toBe(9200);
      expect(outcome.cashCollectedAt).not.toBeNull();
    }

    const driver = await getDriver();
    expect(driver?.status).toBe('available');

    const assignment = await getAssignment(trip.tripRequestId);
    expect(assignment?.status).toBe('completed');
  });

  it('repeating the same close is idempotent: does not recompute net_earnings', async () => {
    const trip = await makeTrip('in_progress');
    await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'completed',
      companyId,
      cashCollected: true,
    });

    const second = await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'completed',
      companyId,
      cashCollected: false,
    });

    expect(second.kind).toBe('idempotent');
    if (second.kind !== 'rejected') {
      expect(second.netEarnings).toBe(9200);
      expect(second.cashCollectedAt).not.toBeNull();
    }
  });

  it('N concurrent closeTrip calls on the same trip -> exactly 1 applied (real Postgres row lock)', async () => {
    const trip = await makeTrip('in_progress');
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        tripClosing.closeTrip({
          tripRequestId: trip.tripRequestId,
          to: 'completed',
          companyId,
          cashCollected: true,
        }),
      ),
    );

    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'idempotent')).toHaveLength(N - 1);

    const driver = await getDriver();
    expect(driver?.status).toBe('available');
  });

  it('no_show is rejected as "not_arrived" when the driver never marked arrival', async () => {
    const trip = await makeTrip('driver_en_route');

    const outcome = await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'no_show',
      companyId,
      noShowGraceMin: 5,
    });

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'not_arrived' });
  });

  it('no_show is rejected as "grace_pending" (with remaining_seconds) before the courtesy elapses', async () => {
    const trip = await makeTrip('driver_en_route', 0);

    const outcome = await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'no_show',
      companyId,
      noShowGraceMin: 5,
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('grace_pending');
      expect(outcome.remainingSeconds).toBeGreaterThan(0);
    }
  });

  it('no_show applies once the courtesy already elapsed, and closes the assignment as completed', async () => {
    const trip = await makeTrip('driver_en_route', 10);

    const outcome = await tripClosing.closeTrip({
      tripRequestId: trip.tripRequestId,
      to: 'no_show',
      companyId,
      noShowGraceMin: 5,
    });

    expect(outcome.kind).toBe('applied');

    const assignment = await getAssignment(trip.tripRequestId);
    expect(assignment?.status).toBe('completed');

    const driver = await getDriver();
    expect(driver?.status).toBe('available');
  });

  it('V-09: penalty_recorded is monotonic, closeTripRequest never clears a previously recorded penalty', async () => {
    const trip = await raw.tripRequest.create({
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
        status: 'in_progress',
        penaltyRecorded: true,
      },
    });

    const row = await raw.$transaction((tx) =>
      repo.closeTripRequest(tx, {
        tripRequestId: trip.tripRequestId,
        to: 'completed',
        from: ['in_progress'],
        cashCollected: true,
        penaltyRecorded: false,
      }),
    );

    expect(row).not.toBeNull();
    expect(row?.penaltyRecorded).toBe(true);
  });
});
