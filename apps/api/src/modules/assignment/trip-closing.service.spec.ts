import type { TripStatus } from '@voyyaa/shared';
import { TripClosingService } from './trip-closing.service';
import type {
  AssignmentRepository,
  ClosedAssignmentRow,
  CloseTripRequestParams,
  TripClosingRow,
} from './assignment.repository';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ActiveCompanyResolver } from '../tenancy/active-company.resolver';

interface FakeTripRow {
  status: TripStatus;
  arrivedAt: Date | null;
  finishedAt: Date | null;
  netEarnings: number | null;
  cashCollectedAt: Date | null;
  penaltyRecorded: boolean;
  fare: number;
  commission: number;
}

interface FakeAssignmentRow {
  status: 'notified' | 'accepted' | 'completed' | 'cancelled';
  driverId: number;
}

interface FakeDriverRow {
  status: 'available' | 'on_trip';
}

class FakeDb {
  trip: FakeTripRow;
  assignment: FakeAssignmentRow;
  driver: FakeDriverRow;

  constructor(trip: FakeTripRow, assignment: FakeAssignmentRow, driver: FakeDriverRow) {
    this.trip = trip;
    this.assignment = assignment;
    this.driver = driver;
  }
}

function snapshot(db: FakeDb): TripClosingRow {
  return {
    status: db.trip.status,
    arrivedAt: db.trip.arrivedAt,
    finishedAt: db.trip.finishedAt,
    netEarnings: db.trip.netEarnings,
    cashCollectedAt: db.trip.cashCollectedAt,
    penaltyRecorded: db.trip.penaltyRecorded,
  };
}

function buildRepo(db: FakeDb): AssignmentRepository {
  return {
    async closeTripRequest(
      _tx: unknown,
      params: CloseTripRequestParams,
    ): Promise<TripClosingRow | null> {
      if (!params.from.includes(db.trip.status)) return null;
      if (params.to === 'no_show') {
        if (db.trip.arrivedAt === null) return null;
        const graceMs = (params.noShowGraceMin ?? 0) * 60_000;
        if (Date.now() - db.trip.arrivedAt.getTime() < graceMs) return null;
      }
      db.trip.status = params.to;
      db.trip.finishedAt = new Date();
      if (params.to === 'completed') {
        db.trip.netEarnings = db.trip.fare - db.trip.commission;
      }
      if (params.cashCollected) db.trip.cashCollectedAt = new Date();
      db.trip.penaltyRecorded = params.penaltyRecorded;
      return snapshot(db);
    },
    async getTripClosingSnapshot(): Promise<TripClosingRow | null> {
      return snapshot(db);
    },
    async getNoShowRemainingSeconds(
      _tx: unknown,
      _tripRequestId: number,
      graceMin: number,
    ): Promise<number> {
      if (db.trip.arrivedAt === null) return 0;
      const graceMs = graceMin * 60_000;
      const elapsedMs = Date.now() - db.trip.arrivedAt.getTime();
      return Math.max(0, Math.ceil((graceMs - elapsedMs) / 1000));
    },
    async closeAssignmentsForTrip(
      _tx: unknown,
      params: { status: 'completed' | 'cancelled'; driverId?: number },
    ): Promise<ClosedAssignmentRow | null> {
      if (db.assignment.status !== 'notified' && db.assignment.status !== 'accepted') return null;
      if (params.driverId !== undefined && params.driverId !== db.assignment.driverId) return null;
      const driverId = db.assignment.driverId;
      db.assignment.status = params.status;
      return { assignmentId: 1, driverId };
    },
    async releaseDriver(_tx: unknown, _driverId: number): Promise<void> {
      if (db.driver.status === 'on_trip') db.driver.status = 'available';
    },
  } as unknown as AssignmentRepository;
}

function buildService(db: FakeDb): TripClosingService {
  const prisma = {} as unknown as PrismaService;
  const activeCompanyResolver = {} as unknown as ActiveCompanyResolver;
  return new TripClosingService(prisma, buildRepo(db), activeCompanyResolver);
}

describe('TripClosingService.closeTripInTx', () => {
  it('completed: applies once, computes net_earnings = fare - commission, closes assignment, releases driver', async () => {
    const db = new FakeDb(
      { status: 'in_progress', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'completed',
      cashCollected: true,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'rejected') {
      expect(outcome.netEarnings).toBe(9200);
      expect(outcome.cashCollectedAt).not.toBeNull();
    }
    expect(db.assignment.status).toBe('completed');
    expect(db.driver.status).toBe('available');
  });

  it('repeating the close is idempotent: does not recompute net_earnings nor touch assignment/driver again', async () => {
    const db = new FakeDb(
      { status: 'in_progress', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    await service.closeTripInTx({} as never, 1, { tripRequestId: 1, to: 'completed', cashCollected: true });
    const second = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'completed',
      cashCollected: false,
    });

    expect(second.kind).toBe('idempotent');
    if (second.kind !== 'rejected') {
      expect(second.netEarnings).toBe(9200);
      expect(second.cashCollectedAt).not.toBeNull();
    }
  });

  it('N concurrent closeTripInTx calls on the same trip -> exactly 1 applied, N-1 idempotent', async () => {
    const N = 20;
    const db = new FakeDb(
      { status: 'in_progress', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        service.closeTripInTx({} as never, 1, { tripRequestId: 1, to: 'completed', cashCollected: true }),
      ),
    );

    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'idempotent')).toHaveLength(N - 1);
    expect(db.driver.status).toBe('available');
  });

  it('wrong origin status -> rejected with the current status', async () => {
    const db = new FakeDb(
      { status: 'completed', arrivedAt: null, finishedAt: new Date(), netEarnings: 9200, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'completed', driverId: 7 },
      { status: 'available' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'cancelled_by_driver',
    });

    expect(outcome).toEqual({ kind: 'rejected', reason: 'invalid_status', status: 'completed' });
  });

  it('no_show: rejected as "not_arrived" when the driver never marked arrival', async () => {
    const db = new FakeDb(
      { status: 'driver_en_route', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'no_show',
      noShowGraceMin: 5,
    });

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'not_arrived' });
  });

  it('no_show: rejected as "grace_pending" with remaining_seconds before the courtesy elapses', async () => {
    const db = new FakeDb(
      { status: 'driver_en_route', arrivedAt: new Date(), finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'no_show',
      noShowGraceMin: 5,
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('grace_pending');
      expect(outcome.remainingSeconds).toBeGreaterThan(0);
    }
  });

  it('no_show: applies once the courtesy already elapsed, closes assignment as completed', async () => {
    const past = new Date(Date.now() - 10 * 60_000);
    const db = new FakeDb(
      { status: 'driver_en_route', arrivedAt: past, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'no_show',
      noShowGraceMin: 5,
    });

    expect(outcome.kind).toBe('applied');
    expect(db.assignment.status).toBe('completed');
    expect(db.driver.status).toBe('available');
  });

  it('assignment only "notified" (never accepted) -> driver release is a harmless no-op', async () => {
    const db = new FakeDb(
      { status: 'pending_assignment', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'notified', driverId: 7 },
      { status: 'available' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'cancelled_by_passenger',
      penaltyRecorded: true,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'rejected') expect(outcome.penaltyRecorded).toBe(true);
    expect(db.driver.status).toBe('available');
  });

  it('V-01 defense in depth: a driverId that does not own the assignment closes nothing and does not release the driver', async () => {
    const db = new FakeDb(
      { status: 'in_progress', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'completed',
      cashCollected: true,
      driverId: 999,
    });

    expect(outcome.kind).toBe('applied');
    expect(db.assignment.status).toBe('accepted');
    expect(db.driver.status).toBe('on_trip');
  });

  it('V-01 defense in depth: the owning driverId closes the assignment and releases the driver as usual', async () => {
    const db = new FakeDb(
      { status: 'in_progress', arrivedAt: null, finishedAt: null, netEarnings: null, cashCollectedAt: null, penaltyRecorded: false, fare: 10000, commission: 800 },
      { status: 'accepted', driverId: 7 },
      { status: 'on_trip' },
    );
    const service = buildService(db);

    const outcome = await service.closeTripInTx({} as never, 1, {
      tripRequestId: 1,
      to: 'completed',
      cashCollected: true,
      driverId: 7,
    });

    expect(outcome.kind).toBe('applied');
    expect(db.assignment.status).toBe('completed');
    expect(db.driver.status).toBe('available');
  });
});
