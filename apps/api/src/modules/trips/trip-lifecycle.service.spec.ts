import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { TripStatus } from '@voyyaa/shared';
import { TripLifecycleService } from './trip-lifecycle.service';
import type { TripTransitionOutcome } from './trips.repository';
import { TripsRepository } from './trips.repository';
import type { AssignmentService } from '../assignment/assignment.service';
import type { OperationalParamsService } from '../assignment/operational-params.service';
import type { CloseTripOutcome } from '../assignment/trip-closing.service';
import { TripClosingService } from '../assignment/trip-closing.service';

const TRIP_REQUEST_ID = 42;
const DRIVER_ID = 7;
const COMPANY_ID = 1;

function buildAssignment(owns: boolean): AssignmentService {
  return {
    async getAcceptedAssignment(): Promise<{ assignmentId: number } | null> {
      return owns ? { assignmentId: 1 } : null;
    },
  } as unknown as AssignmentService;
}

function buildParams(noShowGraceMin = 5): OperationalParamsService {
  return {
    async get() {
      return { noShowGraceMin } as never;
    },
  } as unknown as OperationalParamsService;
}

function buildRepo(overrides: Partial<TripsRepository>): TripsRepository {
  return {
    async getTripRequest() {
      return { passengerId: 1, municipalityId: 1 } as never;
    },
    ...overrides,
  } as unknown as TripsRepository;
}

function buildTripClosing(outcome: CloseTripOutcome): TripClosingService {
  return {
    async closeTrip() {
      return outcome;
    },
  } as unknown as TripClosingService;
}

function buildEmitter(): EventEmitter2 {
  return { emit: jest.fn(() => true) } as unknown as EventEmitter2;
}

describe('TripLifecycleService · ownership (403 NOT_THE_DRIVER)', () => {
  it('rejects any transition when the driver has no accepted/closed assignment for the trip', async () => {
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(false),
      buildTripClosing({ kind: 'rejected', reason: 'invalid_status', status: 'assigned' }),
      buildParams(),
      buildEmitter(),
    );

    await expect(
      service.markEnRoute(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TripLifecycleService.markEnRoute', () => {
  it('applied -> idempotent=false, status driver_en_route', async () => {
    const outcome: TripTransitionOutcome<{ updatedAt: Date }> = {
      kind: 'applied',
      row: { updatedAt: new Date() },
    };
    const service = new TripLifecycleService(
      buildRepo({ markEnRoute: async () => outcome }),
      buildAssignment(true),
      buildTripClosing({ kind: 'rejected', reason: 'invalid_status', status: 'assigned' }),
      buildParams(),
      buildEmitter(),
    );

    const r = await service.markEnRoute(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID);
    expect(r.status).toBe('driver_en_route');
    expect(r.idempotent).toBe(false);
  });

  it('repeated call -> idempotent=true, no error', async () => {
    const outcome: TripTransitionOutcome<{ updatedAt: Date }> = {
      kind: 'idempotent',
      row: { updatedAt: new Date() },
    };
    const service = new TripLifecycleService(
      buildRepo({ markEnRoute: async () => outcome }),
      buildAssignment(true),
      buildTripClosing({ kind: 'rejected', reason: 'invalid_status', status: 'assigned' }),
      buildParams(),
      buildEmitter(),
    );

    const r = await service.markEnRoute(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID);
    expect(r.idempotent).toBe(true);
  });

  it('wrong order (e.g. still pending_assignment) -> 409 INVALID_TRIP_TRANSITION', async () => {
    const rejected: TripTransitionOutcome<{ updatedAt: Date }> = {
      kind: 'rejected',
      status: 'pending_assignment' as TripStatus,
    };
    const service = new TripLifecycleService(
      buildRepo({ markEnRoute: async () => rejected }),
      buildAssignment(true),
      buildTripClosing({ kind: 'rejected', reason: 'invalid_status', status: 'assigned' }),
      buildParams(),
      buildEmitter(),
    );

    await expect(
      service.markEnRoute(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

async function capture(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
  throw new Error('No exception thrown');
}

describe('TripLifecycleService.declareNoShow', () => {
  it('grace pending -> 409 NO_SHOW_GRACE_PENDING with remaining_seconds', async () => {
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(true),
      buildTripClosing({
        kind: 'rejected',
        reason: 'grace_pending',
        status: 'driver_en_route',
        remainingSeconds: 120,
      }),
      buildParams(),
      buildEmitter(),
    );

    const e = await capture(service.declareNoShow(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'NO_SHOW_GRACE_PENDING', remaining_seconds: 120 });
  });

  it('not arrived -> 409 ARRIVAL_NOT_MARKED', async () => {
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(true),
      buildTripClosing({ kind: 'rejected', reason: 'not_arrived', status: 'driver_en_route' }),
      buildParams(),
      buildEmitter(),
    );

    const e = await capture(service.declareNoShow(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID));
    expect(e.getResponse()).toMatchObject({ code: 'ARRIVAL_NOT_MARKED' });
  });

  it('applied -> status no_show, idempotent=false, emits trip_request.no_show', async () => {
    const emitter = buildEmitter();
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(true),
      buildTripClosing({
        kind: 'applied',
        status: 'no_show',
        arrivedAt: new Date(),
        finishedAt: new Date(),
        netEarnings: null,
        cashCollectedAt: null,
        penaltyRecorded: false,
      }),
      buildParams(),
      emitter,
    );

    const r = await service.declareNoShow(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID);
    expect(r.status).toBe('no_show');
    expect(r.idempotent).toBe(false);
    expect(emitter.emit).toHaveBeenCalledWith('trip_request.no_show', expect.anything());
  });

  it('idempotent -> does not re-emit trip_request.no_show', async () => {
    const emitter = buildEmitter();
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(true),
      buildTripClosing({
        kind: 'idempotent',
        status: 'no_show',
        arrivedAt: new Date(),
        finishedAt: new Date(),
        netEarnings: null,
        cashCollectedAt: null,
        penaltyRecorded: false,
      }),
      buildParams(),
      emitter,
    );

    await service.declareNoShow(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID);
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});

describe('TripLifecycleService.complete', () => {
  it('applied -> status completed, net_earnings and finished_at populated, emits trip_request.completed', async () => {
    const finishedAt = new Date();
    const emitter = buildEmitter();
    const service = new TripLifecycleService(
      buildRepo({}),
      buildAssignment(true),
      buildTripClosing({
        kind: 'applied',
        status: 'completed',
        arrivedAt: null,
        finishedAt,
        netEarnings: 9200,
        cashCollectedAt: finishedAt,
        penaltyRecorded: false,
      }),
      buildParams(),
      emitter,
    );

    const r = await service.complete(TRIP_REQUEST_ID, DRIVER_ID, COMPANY_ID, { cash_collected: true });
    expect(r.status).toBe('completed');
    expect(r.net_earnings).toBe(9200);
    expect(r.finished_at).toBe(finishedAt.toISOString());
    expect(emitter.emit).toHaveBeenCalledWith('trip_request.completed', expect.anything());
  });
});
