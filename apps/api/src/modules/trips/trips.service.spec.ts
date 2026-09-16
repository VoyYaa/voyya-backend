import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { AssignedDriverSummary, CreateTripRequestDTO } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { AssignmentService } from '../assignment/assignment.service';
import type {
  CloseTripInput,
  CloseTripOutcome,
  TripClosingService,
} from '../assignment/trip-closing.service';
import type { HolidaysProvider } from './holidays/holidays.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

const SECRET = 'test-secret-0123456789';
const NO_HOLIDAYS: HolidaysProvider = { isHoliday: () => false };

function fakeEnv(ttl = 120): EnvService {
  const values: Record<string, unknown> = {
    QUOTE_TOKEN_TTL_SECONDS: ttl,
    QUOTE_TOKEN_SECRET: SECRET,
    CANCELLATION_WINDOW_MIN: 2,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

interface FakeTripRequest {
  tripRequestId: number;
  passengerId: number;
  status: string;
  assignedAt: Date | null;
  arrivedAt?: Date | null;
  updatedAt: Date;
  municipalityId?: number;
  serviceType?: string;
  fare?: number;
  commission?: number;
  requestedAt?: Date;
}
interface FakeState {
  covered?: boolean;
  active?: boolean;
  tripRequest?: FakeTripRequest | null;
  summary?: AssignedDriverSummary | null;
  tripClosingRejected?: boolean;
}

function fakeRepo(state: FakeState): TripsRepository {
  return {
    async isPointInCoverage(): Promise<boolean> {
      return state.covered ?? true;
    },
    async getActiveFareConfig(): Promise<unknown> {
      return {
        baseFare: 8000,
        nightSurchargePct: 20,
        holidaySurchargePct: 15,
        commissionPct: 8,
      };
    },
    async hasActiveTripRequest(): Promise<boolean> {
      return state.active ?? false;
    },
    async createTripRequest(): Promise<unknown> {
      return {
        tripRequestId: 123,
        passengerId: 1,
        municipalityId: 1,
        serviceType: 'taxi',
        pickupLat: 6.9639,
        pickupLng: -75.4186,
        requestedAt: new Date('2026-07-10T12:00:00.000Z'),
      };
    },
    async getTripRequest(): Promise<unknown> {
      return state.tripRequest ?? null;
    },
    async updateStatus(): Promise<void> {
      return undefined;
    },
  } as unknown as TripsRepository;
}

function fakeAssignment(
  summary: AssignedDriverSummary | null,
): AssignmentService & { getAssignedDriverSummary: jest.Mock } {
  return {
    getAssignedDriverSummary: jest.fn(async () => summary),
  } as unknown as AssignmentService & { getAssignedDriverSummary: jest.Mock };
}

function fakeTripClosing(rejected = false): TripClosingService {
  return {
    async closeTrip(input: CloseTripInput): Promise<CloseTripOutcome> {
      if (rejected) {
        return { kind: 'rejected', reason: 'invalid_status', status: 'cancelled_by_passenger' };
      }
      return {
        kind: 'applied',
        status: input.to,
        arrivedAt: null,
        finishedAt: new Date(),
        netEarnings: null,
        cashCollectedAt: null,
        penaltyRecorded: input.penaltyRecorded ?? false,
      };
    },
  } as unknown as TripClosingService;
}

const ORIGIN = { lat: 6.9639, lng: -75.4186, address: 'Parque principal' };
const DESTINATION = { lat: 6.97, lng: -75.42, address: 'Hospital' };

function createService(
  state: FakeState = {},
  ttl = 120,
): {
  service: TripsService;
  emitter: { emit: jest.Mock };
  assignment: AssignmentService & { getAssignedDriverSummary: jest.Mock };
} {
  const env = fakeEnv(ttl);
  const quote = new QuoteTokenService(env);
  const emitter = { emit: jest.fn(() => true) };
  const assignment = fakeAssignment(state.summary ?? null);
  const service = new TripsService(
    fakeRepo(state),
    quote,
    env,
    emitter as unknown as EventEmitter2,
    NO_HOLIDAYS,
    assignment,
    fakeTripClosing(state.tripClosingRejected ?? false),
  );
  return { service, emitter, assignment };
}

describe('TripsService.quote', () => {
  it('within coverage -> fixed closed fare + token + cash', async () => {
    const { service } = createService({ covered: true, active: false });
    const r = await service.quote({
      origin: ORIGIN,
      destination: DESTINATION,
      municipality_id: 1,
      service_type: 'taxi',
    });
    expect(r.within_coverage).toBe(true);
    expect(r.payment_method).toBe('cash');
    expect(r.fare.base_fare).toBe(8000);
    expect(r.fare.total).toBeGreaterThanOrEqual(8000);
    expect(r.quote_token.length).toBeGreaterThan(0);
    expect(r.eta).toBeNull();
  });

  it('out of coverage -> 409 OUT_OF_COVERAGE', async () => {
    const { service } = createService({ covered: false, active: false });
    await expect(
      service.quote({
        origin: ORIGIN,
        destination: DESTINATION,
        municipality_id: 1,
        service_type: 'taxi',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TripsService.create', () => {
  const dtoWith = (token: string): CreateTripRequestDTO => ({
    origin: ORIGIN,
    destination: DESTINATION,
    municipality_id: 1,
    service_type: 'taxi',
    payment_method: 'cash',
    quote_token: token,
  });
  async function validToken(service: TripsService): Promise<string> {
    const r = await service.quote({
      origin: ORIGIN,
      destination: DESTINATION,
      municipality_id: 1,
      service_type: 'taxi',
    });
    return r.quote_token;
  }

  it('with valid token -> creates, closes the fare and emits trip_request.created', async () => {
    const { service, emitter } = createService({ covered: true, active: false });
    const r = await service.create(dtoWith(await validToken(service)), 1);
    expect(r.trip_request_id).toBe(123);
    expect(r.status).toBe('pending_assignment');
    expect(r.fare.total).toBeGreaterThanOrEqual(8000);
    expect(emitter.emit).toHaveBeenCalledWith('trip_request.created', expect.anything());
  });

  it('idempotency: active trip request already exists -> 409 ACTIVE_TRIP_REQUEST_EXISTS', async () => {
    const { service } = createService({ covered: true, active: true });
    await expect(service.create(dtoWith(await validToken(service)), 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('revalidates coverage on create -> 409 even if the token is valid', async () => {
    const covered = createService({ covered: true });
    const token = await validToken(covered.service);
    const uncovered = createService({ covered: false, active: false });
    await expect(uncovered.service.create(dtoWith(token), 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('expired token -> 410 QUOTE_EXPIRED', async () => {
    const expirer = new QuoteTokenService(fakeEnv(-10));
    const expiredToken = expirer.sign({
      municipalityId: 1,
      serviceType: 'taxi',
      origin: { lat: ORIGIN.lat, lng: ORIGIN.lng },
      destination: { lat: DESTINATION.lat, lng: DESTINATION.lng },
      distanceKm: 1,
      fare: {
        base_fare: 8000,
        night_surcharge: 0,
        holiday_surcharge: 0,
        total: 8000,
        commission: 640,
        currency: 'COP',
      },
    });
    const { service } = createService({ covered: true, active: false });
    await expect(service.create(dtoWith(expiredToken), 1)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('TripsService.getStatus (GET /trips/:id)', () => {
  const base = (over: Partial<FakeTripRequest>): FakeTripRequest => ({
    tripRequestId: 9,
    passengerId: 1,
    status: 'pending_assignment',
    assignedAt: null,
    arrivedAt: null,
    updatedAt: new Date(),
    municipalityId: 1,
    serviceType: 'taxi',
    fare: 8000,
    commission: 640,
    requestedAt: new Date(),
    ...over,
  });
  const SUMMARY: AssignedDriverSummary = {
    name: 'Carlos Ruiz',
    plate: 'ABC123',
    model: 'Logan',
    contact_phone: '3001234567',
    eta: null,
  };

  it('pending -> driver null, ui "searching", closed fare', async () => {
    const { service } = createService({ tripRequest: base({}) });
    const r = await service.getStatus(9, 1);
    expect(r.status).toBe('pending_assignment');
    expect(r.ui).toBe('searching');
    expect(r.driver).toBeNull();
    expect(r.fare.total).toBe(8000);
    expect(r.fare.currency).toBe('COP');
  });

  it('assigned -> driver present, ui "driver_assigned", requests contact info (V-02)', async () => {
    const { service, assignment } = createService({
      tripRequest: base({ status: 'assigned', assignedAt: new Date() }),
      summary: SUMMARY,
    });
    const r = await service.getStatus(9, 1);
    expect(r.ui).toBe('driver_assigned');
    expect(r.driver).toEqual(SUMMARY);
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, true);
  });

  it('driver_en_route without arrival -> ui "driver_en_route", arrived_at null, requests contact info (V-02)', async () => {
    const { service, assignment } = createService({
      tripRequest: base({ status: 'driver_en_route', assignedAt: new Date() }),
      summary: SUMMARY,
    });
    const r = await service.getStatus(9, 1);
    expect(r.ui).toBe('driver_en_route');
    expect(r.arrived_at).toBeNull();
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, true);
  });

  it('driver_en_route with arrival -> ui "driver_waiting", arrived_at present, requests contact info (V-02)', async () => {
    const arrivedAt = new Date();
    const { service, assignment } = createService({
      tripRequest: base({ status: 'driver_en_route', assignedAt: new Date(), arrivedAt }),
      summary: SUMMARY,
    });
    const r = await service.getStatus(9, 1);
    expect(r.ui).toBe('driver_waiting');
    expect(r.arrived_at).toBe(arrivedAt.toISOString());
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, true);
  });

  it('in_progress -> driver present, does NOT request contact info (V-02: no phone/eta once boarded)', async () => {
    const { service, assignment } = createService({
      tripRequest: base({ status: 'in_progress', assignedAt: new Date() }),
      summary: SUMMARY,
    });
    const r = await service.getStatus(9, 1);
    expect(r.driver).toEqual(SUMMARY);
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, false);
  });

  it('completed -> driver still present, ui "trip_completed" (HU-VJ-11), does NOT request contact info (V-02)', async () => {
    const { service, assignment } = createService({
      tripRequest: base({ status: 'completed', assignedAt: new Date() }),
      summary: SUMMARY,
    });
    const r = await service.getStatus(9, 1);
    expect(r.ui).toBe('trip_completed');
    expect(r.driver).toEqual(SUMMARY);
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, false);
  });

  it('not the owner -> 403 NOT_OWNER', async () => {
    const { service } = createService({ tripRequest: base({ passengerId: 2 }) });
    await expect(service.getStatus(9, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('not found -> 404 TRIP_REQUEST_NOT_FOUND', async () => {
    const { service } = createService({ tripRequest: null });
    await expect(service.getStatus(9, 1)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripsService.cancel (free window from assignedAt)', () => {
  const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
  const tr = (over: Partial<FakeTripRequest>): FakeTripRequest => ({
    tripRequestId: 5,
    passengerId: 1,
    status: 'assigned',
    assignedAt: minutesAgo(1),
    updatedAt: minutesAgo(1),
    ...over,
  });

  it('pending_assignment -> free, no penalty, emits trip_request.cancelled', async () => {
    const { service, emitter } = createService({
      tripRequest: tr({
        status: 'pending_assignment',
        assignedAt: null,
        updatedAt: minutesAgo(10),
      }),
    });
    const r = await service.cancel(5, 1, {});
    expect(r.free_of_charge).toBe(true);
    expect(r.penalty_recorded).toBe(false);
    expect(r.status).toBe('cancelled_by_passenger');
    expect(emitter.emit).toHaveBeenCalledWith('trip_request.cancelled', expect.anything());
  });

  it('assigned <=2 min ago -> free', async () => {
    const { service } = createService({ tripRequest: tr({ assignedAt: minutesAgo(1) }) });
    const r = await service.cancel(5, 1, {});
    expect(r.free_of_charge).toBe(true);
    expect(r.penalty_recorded).toBe(false);
  });

  it('assigned >2 min ago -> penalty (measured from assignedAt, NOT updatedAt)', async () => {
    const { service } = createService({
      tripRequest: tr({ assignedAt: minutesAgo(5), updatedAt: minutesAgo(0) }),
    });
    const r = await service.cancel(5, 1, {});
    expect(r.free_of_charge).toBe(false);
    expect(r.penalty_recorded).toBe(true);
  });

  it('not the owner -> 403 NOT_OWNER', async () => {
    const { service } = createService({ tripRequest: tr({ passengerId: 2 }) });
    await expect(service.cancel(5, 1, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('not found -> 404 TRIP_REQUEST_NOT_FOUND', async () => {
    const { service } = createService({ tripRequest: null });
    await expect(service.cancel(5, 1, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('closeTrip rejects the transition (lost the race) -> 409 STATUS_NOT_CANCELLABLE', async () => {
    const { service } = createService({
      tripRequest: tr({ assignedAt: minutesAgo(1) }),
      tripClosingRejected: true,
    });
    await expect(service.cancel(5, 1, {})).rejects.toBeInstanceOf(ConflictException);
  });
});
