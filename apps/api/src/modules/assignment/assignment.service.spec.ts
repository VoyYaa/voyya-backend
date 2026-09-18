import { NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { AssignmentStatus } from '@voyyaa/shared';
import { AssignmentService } from './assignment.service';
import type { AssignedDriverRow, AssignmentRepository, TripRequestInfo } from './assignment.repository';
import type { CandidateRepository } from './candidate.repository';
import type { OperationalParamsService } from './operational-params.service';
import type { PushProvider } from './ports/push-provider.port';
import type { TripClosingService } from './trip-closing.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ActiveCompanyResolver } from '../tenancy/active-company.resolver';

function fakeActiveCompanyResolver(companyId = 1): ActiveCompanyResolver {
  return { resolve: async () => companyId } as unknown as ActiveCompanyResolver;
}

interface DriverRow {
  status: string;
  companyId: number;
}
interface AssignmentRow {
  assignmentId: number;
  tripRequestId: number;
  driverId: number;
  companyId: number;
  status: string;
  expiresAt: Date | null;
}
interface TripRequestRow {
  status: string;
}

class FakeTx {
  companyId = 0;
  private undos: Array<() => void> = [];
  registerUndo(fn: () => void): void {
    this.undos.push(fn);
  }
  rollback(): void {
    for (let i = this.undos.length - 1; i >= 0; i--) {
      const u = this.undos[i];
      if (u) u();
    }
  }
}

class FakeDb {
  drivers = new Map<number, DriverRow>();
  assignments = new Map<number, AssignmentRow>();
  tripRequests = new Map<number, TripRequestRow>();

  takeDriver(tx: FakeTx, id: number, companyId: number): boolean {
    const d = this.drivers.get(id);
    if (d && d.status === 'available' && d.companyId === companyId) {
      d.status = 'on_trip';
      tx.registerUndo(() => {
        d.status = 'available';
      });
      return true;
    }
    return false;
  }
  acceptAssignment(tx: FakeTx, id: number): boolean {
    const a = this.assignments.get(id);
    if (a && a.status === 'notified') {
      a.status = 'accepted';
      tx.registerUndo(() => {
        a.status = 'notified';
      });
      return true;
    }
    return false;
  }
  assignTripRequest(tx: FakeTx, id: number): boolean {
    const t = this.tripRequests.get(id);
    if (t && t.status === 'pending_assignment') {
      t.status = 'assigned';
      tx.registerUndo(() => {
        t.status = 'pending_assignment';
      });
      return true;
    }
    return false;
  }
}

function buildService(db: FakeDb): AssignmentService {
  const prisma = {
    async runInTenant<T>(companyId: number, fn: (tx: FakeTx) => Promise<T>): Promise<T> {
      const tx = new FakeTx();
      tx.companyId = companyId;
      try {
        return await fn(tx);
      } catch (e) {
        tx.rollback();
        throw e;
      }
    },
  } as unknown as PrismaService;

  const repo = {
    async getAssignment(tx: FakeTx, id: number): Promise<AssignmentRow | null> {
      const a = db.assignments.get(id);
      if (!a || a.companyId !== tx.companyId) return null;
      return { ...a };
    },
    async takeDriver(tx: FakeTx, id: number, companyId: number): Promise<boolean> {
      return db.takeDriver(tx, id, companyId);
    },
    async markAssignmentAccepted(tx: FakeTx, id: number): Promise<boolean> {
      return db.acceptAssignment(tx, id);
    },
    async markTripRequestAssigned(tx: FakeTx, id: number): Promise<boolean> {
      return db.assignTripRequest(tx, id);
    },
    async getPassengerData(): Promise<{ name: string; phone: string; pickupAddress: string }> {
      return { name: 'Ana', phone: '3000000000', pickupAddress: 'Cra 1' };
    },
  } as unknown as AssignmentRepository;

  const emitter = { emit: () => true } as unknown as EventEmitter2;
  const push = { async sendAssignment() {} } as unknown as PushProvider;
  const candidateRepo = {} as unknown as CandidateRepository;
  const params = {} as unknown as OperationalParamsService;
  const tripClosing = {} as unknown as TripClosingService;

  return new AssignmentService(
    prisma,
    candidateRepo,
    repo,
    params,
    emitter,
    push,
    tripClosing,
    fakeActiveCompanyResolver(),
  );
}

const COMPANY = 1;
const TRIP_REQUEST = 500;
const inFuture = (): Date => new Date(Date.now() + 60_000);

describe('AssignmentService · ATOMIC SINGLE-TAKE (concurrency)', () => {
  it('N drivers compete for 1 trip request -> EXACTLY 1 wins; rest "already_taken"', async () => {
    const N = 25;
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment' });
    for (let i = 1; i <= N; i++) {
      db.drivers.set(i, { status: 'available', companyId: COMPANY });
      db.assignments.set(i, {
        assignmentId: i,
        tripRequestId: TRIP_REQUEST,
        driverId: i,
        companyId: COMPANY,
        status: 'notified',
        expiresAt: inFuture(),
      });
    }
    const service = buildService(db);

    const results = await Promise.all(
      Array.from({ length: N }, (_v, k) => service.accept(k + 1, k + 1, COMPANY, {})),
    );

    const winners = results.filter((r) => r.result === 'accepted');
    const losers = results.filter((r) => r.result === 'already_taken');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    expect(db.tripRequests.get(TRIP_REQUEST)?.status).toBe('assigned');
    const onTrip = [...db.drivers.values()].filter((d) => d.status === 'on_trip');
    const available = [...db.drivers.values()].filter((d) => d.status === 'available');
    expect(onTrip).toHaveLength(1);
    expect(available).toHaveLength(N - 1);
  });

  it('double-submit from the SAME driver -> 1 accepted, rest "already_taken"', async () => {
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment' });
    db.drivers.set(7, { status: 'available', companyId: COMPANY });
    db.assignments.set(70, {
      assignmentId: 70,
      tripRequestId: TRIP_REQUEST,
      driverId: 7,
      companyId: COMPANY,
      status: 'notified',
      expiresAt: inFuture(),
    });
    const service = buildService(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.accept(70, 7, COMPANY, {})),
    );

    expect(results.filter((r) => r.result === 'accepted')).toHaveLength(1);
    expect(db.drivers.get(7)?.status).toBe('on_trip');
  });

  it('multi-tenant isolation: accepting with a foreign companyId does NOT see the assignment (404)', async () => {
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment' });
    db.drivers.set(9, { status: 'available', companyId: 2 });
    db.assignments.set(90, {
      assignmentId: 90,
      tripRequestId: TRIP_REQUEST,
      driverId: 9,
      companyId: 2,
      status: 'notified',
      expiresAt: inFuture(),
    });
    const service = buildService(db);

    await expect(service.accept(90, 9, 1, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(db.drivers.get(9)?.status).toBe('available');
  });
});

describe('AssignmentService.listNearby (GET /assignments/nearby · polling)', () => {
  function build(getOffers: jest.Mock, getLocation: jest.Mock): AssignmentService {
    const prisma = {
      runInTenant: async <T>(_c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as unknown as PrismaService;
    const repo = {
      getPendingOffers: getOffers,
      getDriverLocation: getLocation,
    } as unknown as AssignmentRepository;
    const emitter = { emit: () => true } as unknown as EventEmitter2;
    const push = { async sendAssignment() {} } as unknown as PushProvider;
    const candidateRepo = {} as unknown as CandidateRepository;
    const params = {} as unknown as OperationalParamsService;
    const tripClosing = {} as unknown as TripClosingService;
    return new AssignmentService(
      prisma,
      candidateRepo,
      repo,
      params,
      emitter,
      push,
      tripClosing,
      fakeActiveCompanyResolver(),
    );
  }

  const offer = {
    assignmentId: 11,
    tripRequestId: 100,
    expiresAt: new Date(Date.now() + 15_000),
    pickupAddress: 'Cra 20 # 30-40',
    dropoffAddress: 'Barrio La Loma, calle 5',
    pickupLat: 6.963,
    pickupLng: -75.418,
    fare: 8000,
  };

  it('driver with a pending offer -> sees it shaped as AssignmentNotification', async () => {
    const getOffers = jest.fn().mockResolvedValue([offer]);
    const service = build(getOffers, jest.fn().mockResolvedValue({ lat: 6.965, lng: -75.42 }));

    const r = await service.listNearby(5, 1);

    expect(r).toHaveLength(1);
    const n = r[0];
    expect(n?.assignment_id).toBe(11);
    expect(n?.trip_request_id).toBe(100);
    expect(n?.origin).toEqual({ address: 'Cra 20 # 30-40', lat: 6.963, lng: -75.418 });
    expect(n?.dropoff_neighborhood).toBe('Barrio La Loma');
    expect(n?.total_fare).toBe(8000);
    expect(n?.distance_to_origin_m).toBeGreaterThan(0);
    expect(typeof n?.expires_at).toBe('string');
    expect(n?.seconds_to_respond).toBeGreaterThan(0);
    expect(getOffers).toHaveBeenCalledWith(expect.anything(), 5, 1);
  });

  it('driver without offers -> empty list', async () => {
    const service = build(jest.fn().mockResolvedValue([]), jest.fn().mockResolvedValue(null));
    expect(await service.listNearby(5, 1)).toEqual([]);
  });

  it('multi-tenant isolation: does not see offers of another company', async () => {
    const getOffers = jest.fn(async (_tx: unknown, _id: number, companyId: number) =>
      companyId === 1 ? [offer] : [],
    );
    const service = build(getOffers, jest.fn().mockResolvedValue(null));

    expect(await service.listNearby(5, 2)).toEqual([]);
    expect(await service.listNearby(5, 1)).toHaveLength(1);
    expect(getOffers).toHaveBeenCalledWith(expect.anything(), 5, 2);
  });
});

describe('AssignmentService.getAssignedDriverSummary (V-02: contact info only while active)', () => {
  const ROW: AssignedDriverRow = {
    name: 'Carlos Ruiz',
    phone: '3001234567',
    plate: 'ABC123',
    model: 'Logan',
    lat: 6.965,
    lng: -75.42,
  };

  function build(row: AssignedDriverRow | null): AssignmentService {
    const prisma = {
      runInTenant: async <T>(_c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as unknown as PrismaService;
    const repo = {
      async getTripRequestInfo(): Promise<TripRequestInfo> {
        return {
          tripRequestId: 1,
          passengerId: 1,
          municipalityId: 1,
          pickupAddress: 'Cra 1',
          dropoffAddress: 'Cra 2',
          pickupLat: 6.9639,
          pickupLng: -75.4186,
          fare: 8000,
          status: 'assigned',
        };
      },
      async getAssignedDriver(): Promise<AssignedDriverRow | null> {
        return row;
      },
    } as unknown as AssignmentRepository;
    const params = {
      async get() {
        return { avgSpeedKmh: 20 } as never;
      },
    } as unknown as OperationalParamsService;
    const emitter = { emit: () => true } as unknown as EventEmitter2;
    const push = { async sendAssignment() {} } as unknown as PushProvider;
    const candidateRepo = {} as unknown as CandidateRepository;
    const tripClosing = {} as unknown as TripClosingService;
    return new AssignmentService(
      prisma,
      candidateRepo,
      repo,
      params,
      emitter,
      push,
      tripClosing,
      fakeActiveCompanyResolver(),
    );
  }

  it('includeContact=true -> exposes contact_phone and computes eta', async () => {
    const service = build(ROW);
    const r = await service.getAssignedDriverSummary(1, true);
    expect(r?.name).toBe('Carlos Ruiz');
    expect(r?.plate).toBe('ABC123');
    expect(r?.contact_phone).toBe('3001234567');
    expect(r?.eta).not.toBeNull();
  });

  it('includeContact=false -> hides contact_phone and eta, keeps name/plate/model (HU-VJ-11)', async () => {
    const service = build(ROW);
    const r = await service.getAssignedDriverSummary(1, false);
    expect(r?.name).toBe('Carlos Ruiz');
    expect(r?.plate).toBe('ABC123');
    expect(r?.model).toBe('Logan');
    expect(r?.contact_phone).toBeNull();
    expect(r?.eta).toBeNull();
  });

  it('no assignment found -> null regardless of includeContact', async () => {
    const service = build(null);
    expect(await service.getAssignedDriverSummary(1, true)).toBeNull();
    expect(await service.getAssignedDriverSummary(1, false)).toBeNull();
  });
});

describe('AssignmentService.getAcceptedAssignment (V-01: allow-list, never "cancelled")', () => {
  function build(getAssignmentForDriver: jest.Mock): AssignmentService {
    const prisma = {
      runInTenant: async <T>(_c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    } as unknown as PrismaService;
    const repo = { getAssignmentForDriver } as unknown as AssignmentRepository;
    const emitter = { emit: () => true } as unknown as EventEmitter2;
    const push = { async sendAssignment() {} } as unknown as PushProvider;
    const candidateRepo = {} as unknown as CandidateRepository;
    const params = {} as unknown as OperationalParamsService;
    const tripClosing = {} as unknown as TripClosingService;
    return new AssignmentService(
      prisma,
      candidateRepo,
      repo,
      params,
      emitter,
      push,
      tripClosing,
      fakeActiveCompanyResolver(),
    );
  }

  it('defaults to allow=["accepted"] when the caller does not specify one', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);

    await service.getAcceptedAssignment(42, 7, 1);

    expect(getAssignmentForDriver).toHaveBeenCalledWith(expect.anything(), 42, 7, 1, ['accepted']);
  });

  it('forwards an explicit allow-list (e.g. ["completed"] for cash-collected) unchanged', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);
    const allow: AssignmentStatus[] = ['completed'];

    await service.getAcceptedAssignment(42, 7, 1, allow);

    expect(getAssignmentForDriver).toHaveBeenCalledWith(expect.anything(), 42, 7, 1, allow);
  });

  it('"cancelled" is never part of the default allow-list (V-01 regression guard)', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);

    await service.getAcceptedAssignment(42, 7, 1);

    const forwarded = getAssignmentForDriver.mock.calls[0]?.[4] as AssignmentStatus[];
    expect(forwarded).not.toContain('cancelled');
  });
});
