import { ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { AssignmentStatus, TripRequestCreatedEvent } from '@voyyaa/shared';
import { AssignmentService } from './assignment.service';
import type {
  AssignedDriverRow,
  AssignmentRepository,
  TripRequestInfo,
  TripTake,
} from './assignment.repository';
import type { CandidateRepository, DbCandidate } from './candidate.repository';
import type { OperationalParams, OperationalParamsService } from '../service-config/operational-params.service';
import type { CompanyCommissionReader } from '../service-config/company-commission.reader';
import type { PushProvider } from './ports/push-provider.port';
import type { TripClosingService } from './trip-closing.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { CompanyDirectory } from '../tenancy/company-directory';
import type { DispatchCompaniesResolver } from '../tenancy/dispatch-companies.resolver';

const PARAMS: OperationalParams = {
  searchRadiusKm: 5,
  expansionRadiusKm: 10,
  acceptanceTimeoutSec: 15,
  maxAutoRetries: 3,
  tiebreakWindowHours: 24,
  locationStaleMin: 30,
  avgSpeedKmh: 25,
  noShowGraceMin: 5,
  cancellationWindowMin: 2,
};

interface Collaborators {
  prisma: PrismaService;
  candidateRepo: CandidateRepository;
  repo: AssignmentRepository;
  params: OperationalParamsService;
  emitter: EventEmitter2;
  push: PushProvider;
  tripClosing: TripClosingService;
  dispatchCompanies: DispatchCompaniesResolver;
  commissions: CompanyCommissionReader;
  companyDirectory: CompanyDirectory;
}

function passthroughPrisma(): PrismaService {
  return {
    runInTenant: async <T>(_c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as PrismaService;
}

function collaborators(overrides: Partial<Collaborators> = {}): Collaborators {
  return {
    prisma: passthroughPrisma(),
    candidateRepo: {} as unknown as CandidateRepository,
    repo: {} as unknown as AssignmentRepository,
    params: { get: async () => PARAMS } as unknown as OperationalParamsService,
    emitter: { emit: () => true } as unknown as EventEmitter2,
    push: { async sendAssignment() {} } as unknown as PushProvider,
    tripClosing: {} as unknown as TripClosingService,
    dispatchCompanies: { resolve: async () => [1] } as unknown as DispatchCompaniesResolver,
    commissions: { getCurrent: async () => ({ commissionPct: 8 }) } as unknown as CompanyCommissionReader,
    companyDirectory: {
      getRef: async (companyId: number) => ({ company_id: companyId, display_name: `Empresa ${companyId}` }),
    } as unknown as CompanyDirectory,
    ...overrides,
  };
}

function buildService(overrides: Partial<Collaborators> = {}): AssignmentService {
  const c = collaborators(overrides);
  return new AssignmentService(
    c.prisma,
    c.candidateRepo,
    c.repo,
    c.params,
    c.emitter,
    c.push,
    c.tripClosing,
    c.dispatchCompanies,
    c.commissions,
    c.companyDirectory,
  );
}

function prismaError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });
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
  companyId: number | null;
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
  assignTripRequest(tx: FakeTx, take: TripTake): boolean {
    const t = this.tripRequests.get(take.tripRequestId);
    if (t && t.status === 'pending_assignment') {
      t.status = 'assigned';
      t.companyId = take.companyId;
      tx.registerUndo(() => {
        t.status = 'pending_assignment';
        t.companyId = null;
      });
      return true;
    }
    return false;
  }
}

function buildConcurrentService(db: FakeDb): AssignmentService {
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
    async markTripRequestAssigned(tx: FakeTx, take: TripTake): Promise<boolean> {
      return db.assignTripRequest(tx, take);
    },
    async getPassengerData(): Promise<{ name: string; phone: string; pickupAddress: string }> {
      return { name: 'Ana', phone: '3000000000', pickupAddress: 'Cra 1' };
    },
  } as unknown as AssignmentRepository;

  return buildService({ prisma, repo });
}

const COMPANY = 1;
const TRIP_REQUEST = 500;
const inFuture = (): Date => new Date(Date.now() + 60_000);

describe('AssignmentService · ATOMIC SINGLE-TAKE (concurrency)', () => {
  it('N drivers compete for 1 trip request -> EXACTLY 1 wins; rest "already_taken"', async () => {
    const N = 25;
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment', companyId: null });
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
    const service = buildConcurrentService(db);

    const results = await Promise.all(
      Array.from({ length: N }, (_v, k) => service.accept(k + 1, k + 1, COMPANY, {})),
    );

    const winners = results.filter((r) => r.result === 'accepted');
    const losers = results.filter((r) => r.result === 'already_taken');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    expect(db.tripRequests.get(TRIP_REQUEST)?.status).toBe('assigned');
    expect(db.tripRequests.get(TRIP_REQUEST)?.companyId).toBe(COMPANY);
    const onTrip = [...db.drivers.values()].filter((d) => d.status === 'on_trip');
    const available = [...db.drivers.values()].filter((d) => d.status === 'available');
    expect(onTrip).toHaveLength(1);
    expect(available).toHaveLength(N - 1);
  });

  it('two companies compete for the same trip -> exactly 1 wins and the trip takes the winner company', async () => {
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment', companyId: null });
    db.drivers.set(1, { status: 'available', companyId: 1 });
    db.drivers.set(2, { status: 'available', companyId: 2 });
    db.assignments.set(10, {
      assignmentId: 10,
      tripRequestId: TRIP_REQUEST,
      driverId: 1,
      companyId: 1,
      status: 'notified',
      expiresAt: inFuture(),
    });
    db.assignments.set(20, {
      assignmentId: 20,
      tripRequestId: TRIP_REQUEST,
      driverId: 2,
      companyId: 2,
      status: 'notified',
      expiresAt: inFuture(),
    });
    const service = buildConcurrentService(db);

    const results = await Promise.all([service.accept(10, 1, 1, {}), service.accept(20, 2, 2, {})]);

    expect(results.filter((r) => r.result === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'already_taken')).toHaveLength(1);
    const winnerCompany = db.tripRequests.get(TRIP_REQUEST)?.companyId;
    expect(db.drivers.get(winnerCompany ?? 0)?.status).toBe('on_trip');
    expect(db.drivers.get(winnerCompany === 1 ? 2 : 1)?.status).toBe('available');
  });

  it('double-submit from the SAME driver -> 1 accepted, rest "already_taken"', async () => {
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment', companyId: null });
    db.drivers.set(7, { status: 'available', companyId: COMPANY });
    db.assignments.set(70, {
      assignmentId: 70,
      tripRequestId: TRIP_REQUEST,
      driverId: 7,
      companyId: COMPANY,
      status: 'notified',
      expiresAt: inFuture(),
    });
    const service = buildConcurrentService(db);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.accept(70, 7, COMPANY, {})),
    );

    expect(results.filter((r) => r.result === 'accepted')).toHaveLength(1);
    expect(db.drivers.get(7)?.status).toBe('on_trip');
  });

  it('multi-tenant isolation: accepting with a foreign companyId does NOT see the assignment (404)', async () => {
    const db = new FakeDb();
    db.tripRequests.set(TRIP_REQUEST, { status: 'pending_assignment', companyId: null });
    db.drivers.set(9, { status: 'available', companyId: 2 });
    db.assignments.set(90, {
      assignmentId: 90,
      tripRequestId: TRIP_REQUEST,
      driverId: 9,
      companyId: 2,
      status: 'notified',
      expiresAt: inFuture(),
    });
    const service = buildConcurrentService(db);

    await expect(service.accept(90, 9, 1, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(db.drivers.get(9)?.status).toBe('available');
  });
});

describe('AssignmentService.accept · the take of ADR-032 §2', () => {
  const OFFER: AssignmentRow = {
    assignmentId: 70,
    tripRequestId: TRIP_REQUEST,
    driverId: 7,
    companyId: COMPANY,
    status: 'notified',
    expiresAt: inFuture(),
  };

  interface TakeHarness {
    service: AssignmentService;
    calls: string[];
    repo: Record<string, jest.Mock>;
    commissions: { getCurrent: jest.Mock };
  }

  function harness(
    options: {
      offer?: Partial<AssignmentRow>;
      tripAssigned?: boolean | Error;
      commission?: unknown;
    } = {},
  ): TakeHarness {
    const calls: string[] = [];
    const assigned = options.tripAssigned ?? true;
    const repo = {
      getAssignment: jest.fn(async () => ({ ...OFFER, ...options.offer })),
      markTripRequestAssigned: jest.fn(async () => {
        calls.push('trip');
        if (assigned instanceof Error) throw assigned;
        return assigned;
      }),
      takeDriver: jest.fn(async () => {
        calls.push('driver');
        return true;
      }),
      markAssignmentAccepted: jest.fn(async () => {
        calls.push('assignment');
        return true;
      }),
      getPassengerData: jest.fn(async () => ({ name: 'Ana', phone: '3000000000', pickupAddress: 'Cra 1' })),
    };
    const commissions = {
      getCurrent: jest.fn(async () => ('commission' in options ? options.commission : { commissionPct: 8 })),
    };
    const service = buildService({
      repo: repo as unknown as AssignmentRepository,
      commissions: commissions as unknown as CompanyCommissionReader,
    });
    return { service, calls, repo, commissions };
  }

  it('locks the trip first, then the driver, then the assignment', async () => {
    const h = harness();

    const result = await h.service.accept(70, 7, COMPANY, {});

    expect(result.result).toBe('accepted');
    expect(h.calls).toEqual(['trip', 'driver', 'assignment']);
  });

  it('passes the concrete offer to the trip update (MD-15)', async () => {
    const h = harness();

    await h.service.accept(70, 7, COMPANY, {});

    expect(h.repo.markTripRequestAssigned).toHaveBeenCalledWith(expect.anything(), {
      tripRequestId: TRIP_REQUEST,
      assignmentId: 70,
      driverId: 7,
      companyId: COMPANY,
    });
  });

  it('reads the passenger inside the same transaction (MD-10)', async () => {
    const h = harness();

    const result = await h.service.accept(70, 7, COMPANY, {});

    expect(h.repo.getPassengerData).toHaveBeenCalledWith(expect.anything(), TRIP_REQUEST);
    expect(result).toMatchObject({ passenger: { name: 'Ana', contact_phone: '3000000000' } });
  });

  it('0 rows in the trip update -> already_taken without touching the driver or the assignment', async () => {
    const h = harness({ tripAssigned: false });

    const result = await h.service.accept(70, 7, COMPANY, {});

    expect(result.result).toBe('already_taken');
    expect(h.calls).toEqual(['trip']);
  });

  it('a company without commission fails visibly and never takes the trip (500 COMMISSION_NOT_CONFIGURED)', async () => {
    const h = harness({ commission: null });

    const failure = await h.service.accept(70, 7, COMPANY, {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(InternalServerErrorException);
    expect((failure as InternalServerErrorException).getResponse()).toMatchObject({
      code: 'COMMISSION_NOT_CONFIGURED',
    });
    expect(h.calls).toEqual([]);
  });

  it('a unique violation of the accepted-per-trip index -> already_taken', async () => {
    const h = harness({ tripAssigned: prismaError('P2010', { code: '23505' }) });

    await expect(h.service.accept(70, 7, COMPANY, {})).resolves.toMatchObject({ result: 'already_taken' });
  });

  it('a deadlock is retried once and the second attempt wins', async () => {
    const h = harness();
    h.repo.markTripRequestAssigned
      ?.mockRejectedValueOnce(prismaError('P2010', { code: '40P01' }))
      .mockResolvedValueOnce(true);

    const result = await h.service.accept(70, 7, COMPANY, {});

    expect(result.result).toBe('accepted');
    expect(h.repo.markTripRequestAssigned).toHaveBeenCalledTimes(2);
  });

  it('a deadlock that repeats -> already_taken, never an error', async () => {
    const h = harness({ tripAssigned: prismaError('P2010', { code: '40P01' }) });

    await expect(h.service.accept(70, 7, COMPANY, {})).resolves.toMatchObject({ result: 'already_taken' });
    expect(h.repo.markTripRequestAssigned).toHaveBeenCalledTimes(2);
  });

  it('an unrelated database error is not swallowed', async () => {
    const h = harness({ tripAssigned: new Error('connection lost') });

    await expect(h.service.accept(70, 7, COMPANY, {})).rejects.toThrow('connection lost');
  });

  it.each([
    ['rejected', 'already_taken'],
    ['cancelled', 'already_taken'],
    ['accepted', 'already_taken'],
    ['timeout', 'expired'],
  ])('an offer in status %s -> %s and the trip is not touched', async (status, expected) => {
    const h = harness({ offer: { status } });

    const result = await h.service.accept(70, 7, COMPANY, {});

    expect(result.result).toBe(expected);
    expect(h.calls).toEqual([]);
  });

  it('a notified offer past its expiry -> expired', async () => {
    const h = harness({ offer: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(h.service.accept(70, 7, COMPANY, {})).resolves.toMatchObject({ result: 'expired' });
    expect(h.calls).toEqual([]);
  });

  it('the offer of another driver -> 403 NOT_THE_DRIVER and the trip is not touched', async () => {
    const h = harness({ offer: { driverId: 99 } });

    await expect(h.service.accept(70, 7, COMPANY, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.calls).toEqual([]);
  });
});

describe('AssignmentService.listNearby (GET /assignments/nearby · polling)', () => {
  function build(getOffers: jest.Mock, getLocation: jest.Mock): AssignmentService {
    const repo = {
      getPendingOffers: getOffers,
      getDriverLocation: getLocation,
    } as unknown as AssignmentRepository;
    return buildService({ repo });
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

  function info(companyId: number | null): TripRequestInfo {
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
      serviceType: 'taxi',
      requestedCompanyId: null,
      companyId,
    };
  }

  function build(row: AssignedDriverRow | null, companyId: number | null = 1) {
    const tenants: number[] = [];
    const prisma = {
      runInTenant: async <T>(c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => {
        tenants.push(c);
        return fn({});
      },
    } as unknown as PrismaService;
    const repo = {
      getTripRequestInfo: async () => info(companyId),
      getAssignedDriver: async (): Promise<AssignedDriverRow | null> => row,
    } as unknown as AssignmentRepository;
    const params = { get: async () => ({ avgSpeedKmh: 20 }) as never } as unknown as OperationalParamsService;
    return { service: buildService({ prisma, repo, params }), tenants };
  }

  it('includeContact=true -> exposes contact_phone and computes eta', async () => {
    const { service } = build(ROW);
    const r = await service.getAssignedDriverSummary(1, true);
    expect(r?.name).toBe('Carlos Ruiz');
    expect(r?.plate).toBe('ABC123');
    expect(r?.contact_phone).toBe('3001234567');
    expect(r?.eta).not.toBeNull();
  });

  it('includeContact=false -> hides contact_phone and eta, keeps name/plate/model (HU-VJ-11)', async () => {
    const { service } = build(ROW);
    const r = await service.getAssignedDriverSummary(1, false);
    expect(r?.name).toBe('Carlos Ruiz');
    expect(r?.plate).toBe('ABC123');
    expect(r?.model).toBe('Logan');
    expect(r?.contact_phone).toBeNull();
    expect(r?.eta).toBeNull();
  });

  it('no assignment found -> null regardless of includeContact', async () => {
    const { service } = build(null);
    expect(await service.getAssignedDriverSummary(1, true)).toBeNull();
    expect(await service.getAssignedDriverSummary(1, false)).toBeNull();
  });

  it('reads the driver in the tenant of the trip company and names that company (H-1)', async () => {
    const { service, tenants } = build(ROW, 7);

    const r = await service.getAssignedDriverSummary(1, true);

    expect(tenants).toEqual([7]);
    expect(r?.company).toEqual({ company_id: 7, display_name: 'Empresa 7' });
  });

  it('a trip without company has no driver summary', async () => {
    const { service, tenants } = build(ROW, null);

    expect(await service.getAssignedDriverSummary(1, true)).toBeNull();
    expect(tenants).toEqual([]);
  });
});

describe('AssignmentService.getOwnedAssignment (V-01: allow-list, never "cancelled")', () => {
  function build(getAssignmentForDriver: jest.Mock): AssignmentService {
    const repo = { getAssignmentForDriver } as unknown as AssignmentRepository;
    return buildService({ repo });
  }

  it('defaults to allow=["accepted"] when the caller does not specify one', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);

    await service.getOwnedAssignment({} as never, 42, 7, 1);

    expect(getAssignmentForDriver).toHaveBeenCalledWith(expect.anything(), 42, 7, 1, ['accepted']);
  });

  it('forwards an explicit allow-list (e.g. ["completed"] for cash-collected) unchanged', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);
    const allow: AssignmentStatus[] = ['completed'];

    await service.getOwnedAssignment({} as never, 42, 7, 1, allow);

    expect(getAssignmentForDriver).toHaveBeenCalledWith(expect.anything(), 42, 7, 1, allow);
  });

  it('"cancelled" is never part of the default allow-list (V-01 regression guard)', async () => {
    const getAssignmentForDriver = jest.fn().mockResolvedValue(null);
    const service = build(getAssignmentForDriver);

    await service.getOwnedAssignment({} as never, 42, 7, 1);

    const forwarded = getAssignmentForDriver.mock.calls[0]?.[4] as AssignmentStatus[];
    expect(forwarded).not.toContain('cancelled');
  });
});

describe('AssignmentService chain · reparto between companies (ADR-032 §1)', () => {
  const tripEvent: TripRequestCreatedEvent = {
    trip_request_id: 500,
    passenger_id: 1,
    municipality_id: 1,
    service_type: 'taxi',
    origin: { lat: 6.96, lng: -75.41 },
    occurred_at: new Date().toISOString(),
  };

  const info: TripRequestInfo = {
    tripRequestId: 500,
    passengerId: 1,
    municipalityId: 1,
    pickupAddress: 'Cra 1',
    dropoffAddress: 'Calle 2',
    pickupLat: 6.96,
    pickupLng: -75.41,
    fare: 8000,
    status: 'pending_assignment',
    serviceType: 'taxi',
    requestedCompanyId: null,
    companyId: null,
  };

  interface ChainHarness {
    service: AssignmentService;
    tenants: number[];
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    offers: jest.Mock;
    resolve: jest.Mock;
    cancelOffer: jest.Mock;
    findCandidates: jest.Mock;
  }

  function harness(options: {
    companyIds: number[];
    candidates: Record<number, DbCandidate[]>;
    requestedCompanyId?: number | null;
    offerResults?: Array<{ assignmentId: number } | null>;
  }): ChainHarness {
    const tenants: number[] = [];
    const prisma = {
      runInTenant: async <T>(c: number, fn: (tx: unknown) => Promise<T>): Promise<T> => {
        tenants.push(c);
        return fn({});
      },
    } as unknown as PrismaService;
    const offerResults = [...(options.offerResults ?? [{ assignmentId: 900 }])];
    const offers = jest.fn(async () => offerResults.shift() ?? null);
    const cancelOffer = jest.fn(async () => true);
    const repo = {
      getTripRequestInfo: async () => ({ ...info, requestedCompanyId: options.requestedCompanyId ?? null }),
      createOfferIfDriverFree: offers,
      cancelOffer,
    } as unknown as AssignmentRepository;
    const findCandidates = jest.fn(async (_tx: unknown, q: { companyId: number; exclude: number[] }) =>
      (options.candidates[q.companyId] ?? []).filter((c) => !q.exclude.includes(c.driverId)),
    );
    const candidateRepo = { findCandidates } as unknown as CandidateRepository;
    const resolve = jest.fn(async () => options.companyIds);
    const events: ChainHarness['events'] = [];
    const emitter = {
      emit: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }),
    } as unknown as EventEmitter2;
    const service = buildService({
      prisma,
      repo,
      candidateRepo,
      emitter,
      dispatchCompanies: { resolve } as unknown as DispatchCompaniesResolver,
    });
    return { service, tenants, events, offers, resolve, cancelOffer, findCandidates };
  }

  const cand = (driverId: number, distanceM: number, tripsLast3h = 0): DbCandidate => ({
    driverId,
    vehicleId: driverId + 100,
    distanceM,
    tripsLast3h,
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('"Cualquiera" with two companies offers the trip to the globally nearest driver', async () => {
    const h = harness({
      companyIds: [3, 9],
      candidates: { 3: [cand(31, 800)], 9: [cand(91, 200)] },
    });

    await h.service.onTripRequestCreated(tripEvent);

    expect(h.offers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ driverId: 91, companyId: 9, attemptOrder: 1 }),
    );
    expect(h.events.find((e) => e.name === 'assignment.created')?.payload).toMatchObject({
      company_id: 9,
      driver_id: 91,
    });
  });

  it('searches every company in its own tenant and asks for one candidate each', async () => {
    const h = harness({ companyIds: [3, 9], candidates: { 3: [cand(31, 800)], 9: [cand(91, 200)] } });

    await h.service.onTripRequestCreated(tripEvent);

    expect(h.findCandidates.mock.calls.map((call) => call[1].companyId)).toEqual([3, 9]);
    expect(h.findCandidates.mock.calls.every((call) => call[1].limit === 1)).toBe(true);
  });

  it('with a requested company the resolver is asked for that company only', async () => {
    const h = harness({
      companyIds: [3],
      requestedCompanyId: 3,
      candidates: { 3: [cand(31, 800)] },
    });

    await h.service.onTripRequestCreated(tripEvent);

    expect(h.resolve).toHaveBeenCalledWith(1, { serviceType: 'taxi', requestedCompanyId: 3 });
    expect(h.offers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId: 3 }));
  });

  it('a driver who stopped being free does not consume a retry: the next candidate gets attempt 1', async () => {
    const h = harness({
      companyIds: [3],
      candidates: { 3: [cand(31, 100), cand(32, 400)] },
      offerResults: [null, { assignmentId: 901 }],
    });

    await h.service.onTripRequestCreated(tripEvent);

    expect(h.offers).toHaveBeenCalledTimes(2);
    expect(h.offers.mock.calls[1]?.[1]).toMatchObject({ driverId: 32, attemptOrder: 1 });
  });

  it('with no active company the trip ends as no driver', async () => {
    const h = harness({ companyIds: [], candidates: {} });

    await h.service.onTripRequestCreated(tripEvent);

    expect(h.events.map((e) => e.name)).toEqual(['trip_request.no_driver']);
    expect(h.offers).not.toHaveBeenCalled();
  });

  it('with candidates nowhere the radius is widened once and then the trip ends as no driver', async () => {
    const h = harness({ companyIds: [3, 9], candidates: {} });

    await h.service.onTripRequestCreated(tripEvent);

    const radii = h.findCandidates.mock.calls.map((call) => call[1].radiusKm);
    expect(radii).toEqual([5, 5, 10, 10]);
    expect(h.events.map((e) => e.name)).toEqual(['trip_request.no_driver']);
  });

  it('the passenger cancelling cancels the live offer in the tenant of the offering company', async () => {
    const h = harness({ companyIds: [9], candidates: { 9: [cand(91, 200)] } });
    await h.service.onTripRequestCreated(tripEvent);

    await h.service.onTripRequestCancelled({
      trip_request_id: 500,
      cancelled_by: 'passenger',
      released_driver_id: null,
      occurred_at: new Date().toISOString(),
    });

    expect(h.cancelOffer).toHaveBeenCalledWith(expect.anything(), 900, 9);
    expect(h.tenants.at(-1)).toBe(9);
  });
});

describe('AssignmentService.onTripRequestCreated · push never gates the assignment chain (ADR-022 §3.1)', () => {
  function build(push: PushProvider): {
    service: AssignmentService;
    events: unknown[];
    setTimeoutSpy: jest.SpyInstance;
  } {
    const info: TripRequestInfo = {
      tripRequestId: 500,
      passengerId: 1,
      municipalityId: 1,
      pickupAddress: 'Cra 1',
      dropoffAddress: 'Calle 2',
      pickupLat: 6.96,
      pickupLng: -75.41,
      fare: 8000,
      status: 'pending_assignment',
      serviceType: 'taxi',
      requestedCompanyId: null,
      companyId: null,
    };

    const candidate: DbCandidate = {
      driverId: 7,
      vehicleId: 3,
      distanceM: 350,
      tripsLast3h: 0,
    };

    const repo = {
      getTripRequestInfo: jest.fn().mockResolvedValue(info),
      createOfferIfDriverFree: jest.fn().mockResolvedValue({ assignmentId: 999 }),
    } as unknown as AssignmentRepository;

    const candidateRepo = {
      findCandidates: jest.fn().mockResolvedValue([candidate]),
    } as unknown as CandidateRepository;

    const events: unknown[] = [];
    const emitter = { emit: (_name: string, payload: unknown) => events.push(payload) } as unknown as EventEmitter2;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const service = buildService({ repo, candidateRepo, emitter, push });

    return { service, events, setTimeoutSpy };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const tripEvent: TripRequestCreatedEvent = {
    trip_request_id: 500,
    passenger_id: 1,
    municipality_id: 1,
    service_type: 'taxi',
    origin: { lat: 6.96, lng: -75.41 },
    occurred_at: new Date().toISOString(),
  };

  it('emits ASSIGNMENT_CREATED and arms the timeout BEFORE the push promise settles, even if push is slow', async () => {
    let releasePush: (() => void) | null = null;
    const pushStarted = new Promise<void>((resolve) => {
      releasePush = resolve as unknown as () => void;
    });
    const push: PushProvider = {
      sendAssignment: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            (releasePush as unknown as () => void)?.();
            setTimeout(resolve, 50);
          }),
      ),
    };

    const { service, events, setTimeoutSpy } = build(push);

    const chainPromise = service.onTripRequestCreated(tripEvent);
    await pushStarted;

    expect(events).toHaveLength(1);
    expect(setTimeoutSpy).toHaveBeenCalled();

    await chainPromise;
    expect(push.sendAssignment).toHaveBeenCalledTimes(1);
  });

  it('a push that never resolves does not prevent the chain from completing', async () => {
    const push: PushProvider = {
      sendAssignment: jest.fn(() => new Promise<void>(() => {})),
    };

    const { service, events } = build(push);

    await expect(
      Promise.race([
        service.onTripRequestCreated(tripEvent),
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]),
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
  });

  it('a push that rejects synchronously does not abort onTripRequestCreated nor the chain', async () => {
    const push: PushProvider = {
      sendAssignment: jest.fn().mockRejectedValue(new Error('boom')),
    };

    const { service, events } = build(push);

    await expect(service.onTripRequestCreated(tripEvent)).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });
});
