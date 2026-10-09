import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { AssignedDriverSummary, CreateTripRequestDTO } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import { RequestContextService } from '../../infrastructure/observability/request-context.service';
import type { AssignmentService } from '../assignment/assignment.service';
import type {
  ClosePassengerTripInput,
  CloseTripOutcome,
  TripClosingService,
} from '../assignment/trip-closing.service';
import type { HolidaysProvider } from './holidays/holidays.provider';
import { QuoteTokenService } from './quote-token.service';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';
import type { DispatchCompaniesResolver } from '../tenancy/dispatch-companies.resolver';
import type { CompanyDirectory } from '../tenancy/company-directory';
import type { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import type { MunicipalityFareRow } from '../service-config/service-config.types';
import type { OperationalParamsService } from '../service-config/operational-params.service';
import { ServiceCatalog } from '../service-config/service-catalog';

const FARE_ROW = {
  municipalityFareId: 31,
  baseFare: 8000,
  nightSurchargePct: 20,
  holidaySurchargePct: 15,
} as MunicipalityFareRow;

function fakeFares(row: MunicipalityFareRow | null = FARE_ROW): MunicipalityFareReader {
  return {
    getCurrent: async () => row,
    getById: async () => row,
  } as unknown as MunicipalityFareReader;
}

function fakeParams(cancellationWindowMin = 2): OperationalParamsService {
  return { get: async () => ({ cancellationWindowMin }) } as unknown as OperationalParamsService;
}

function fakeCatalog(active: readonly string[] = ['taxi']): ServiceCatalog {
  return new ServiceCatalog({ get: () => active } as never);
}

function fakeDirectory(): CompanyDirectory {
  return {
    getRef: async (companyId: number) => ({ company_id: companyId, display_name: `Empresa ${companyId}` }),
  } as unknown as CompanyDirectory;
}

function fakeDispatchCompaniesResolver(companyIds: number[] = [1]): DispatchCompaniesResolver & { resolve: jest.Mock } {
  return { resolve: jest.fn(async () => companyIds) } as unknown as DispatchCompaniesResolver & {
    resolve: jest.Mock;
  };
}

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
  requestedCompanyId?: number | null;
  municipalityFareId?: number | null;
}
interface FakeState {
  covered?: boolean;
  active?: boolean;
  activeRow?: FakeTripRequest | null;
  createRaces?: boolean;
  tripRequest?: FakeTripRequest | null;
  summary?: AssignedDriverSummary | null;
  tripClosingRejected?: boolean;
  companyIds?: number[];
  fare?: MunicipalityFareRow | null;
  activeServices?: readonly string[];
  createError?: Error;
  noDriverApplied?: boolean;
  windowMin?: number;
}

interface FakeRepoCalls {
  created: Array<Record<string, unknown>>;
  noDriver: number[];
}

function fakeRepo(state: FakeState, calls: FakeRepoCalls): TripsRepository {
  let activeLookups = 0;
  return {
    async isPointInCoverage(): Promise<boolean> {
      return state.covered ?? true;
    },
    async findActiveTripRequest(): Promise<unknown> {
      activeLookups += 1;
      if (state.createRaces && activeLookups === 1) return null;
      if (state.activeRow) return state.activeRow;
      return state.active ? { tripRequestId: 77, status: 'driver_en_route' } : null;
    },
    async createTripRequest(data: Record<string, unknown>): Promise<unknown> {
      calls.created.push(data);
      if (state.createError) throw state.createError;
      if (state.createRaces) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
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
    async markNoDriverIfUnassigned(tripRequestId: number): Promise<boolean> {
      calls.noDriver.push(tripRequestId);
      return state.noDriverApplied ?? true;
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
    async closePassengerTrip(input: ClosePassengerTripInput): Promise<CloseTripOutcome> {
      if (rejected) {
        return { kind: 'rejected', reason: 'invalid_status', status: 'cancelled_by_passenger' };
      }
      return {
        kind: 'applied',
        status: 'cancelled_by_passenger',
        arrivedAt: null,
        finishedAt: new Date(),
        netEarnings: null,
        cashCollectedAt: null,
        penaltyRecorded: input.penaltyRecorded,
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
  calls: FakeRepoCalls;
  dispatch: DispatchCompaniesResolver & { resolve: jest.Mock };
} {
  const env = fakeEnv(ttl);
  const quote = new QuoteTokenService(env);
  const emitter = { emit: jest.fn(() => true) };
  const assignment = fakeAssignment(state.summary ?? null);
  const calls: FakeRepoCalls = { created: [], noDriver: [] };
  const dispatch = fakeDispatchCompaniesResolver(state.companyIds);
  const service = new TripsService(
    fakeRepo(state, calls),
    quote,
    emitter as unknown as EventEmitter2,
    NO_HOLIDAYS,
    assignment,
    fakeTripClosing(state.tripClosingRejected ?? false),
    dispatch,
    new RequestContextService(),
    fakeFares(state.fare === undefined ? FARE_ROW : state.fare),
    fakeParams(state.windowMin),
    fakeCatalog(state.activeServices),
    fakeDirectory(),
  );
  return { service, emitter, assignment, calls, dispatch };
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

  it('idempotency: active trip request already exists -> 409 ACTIVE_TRIP_REQUEST_EXISTS with the active_trip reference', async () => {
    const { service } = createService({ covered: true, active: true });
    const error = await service
      .create(dtoWith(await validToken(service)), 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'ACTIVE_TRIP_REQUEST_EXISTS',
      message: 'Ya tienes un viaje en curso',
      active_trip: { trip_request_id: 77, status: 'driver_en_route' },
    });
  });

  it('race: the unique index rejects the insert -> same 409 with the winner reference, never a 500', async () => {
    const { service, emitter } = createService({
      covered: true,
      createRaces: true,
      activeRow: {
        tripRequestId: 88,
        passengerId: 1,
        status: 'pending_assignment',
        assignedAt: null,
        updatedAt: new Date(),
      },
    });
    const error = await service
      .create(dtoWith(await validToken(service)), 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'ACTIVE_TRIP_REQUEST_EXISTS',
      active_trip: { trip_request_id: 88, status: 'pending_assignment' },
    });
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('a unique violation with no visible winner is rethrown, not disguised as a conflict', async () => {
    const { service } = createService({ covered: true });
    const token = await validToken(service);
    const failing = createService({ covered: true, createRaces: true, activeRow: null });
    await expect(failing.service.create(dtoWith(token), 1)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
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
      municipalityFareId: 31,
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
    company: { company_id: 1, display_name: 'Cootrayal' },
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

describe('TripsService.getActive (GET /trips/active)', () => {
  const activeRow = (over: Partial<FakeTripRequest> = {}): FakeTripRequest => ({
    tripRequestId: 9,
    passengerId: 1,
    status: 'driver_en_route',
    assignedAt: new Date(),
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
    company: { company_id: 1, display_name: 'Cootrayal' },
  };

  it('no active trip -> { active_trip: null }', async () => {
    const { service } = createService({});
    await expect(service.getActive(1)).resolves.toEqual({ active_trip: null });
  });

  it('active trip -> the same TripRequestStatus as GET /trips/:id', async () => {
    const { service, assignment } = createService({ activeRow: activeRow(), summary: SUMMARY });
    const r = await service.getActive(1);
    expect(r.active_trip).toMatchObject({
      trip_request_id: 9,
      status: 'driver_en_route',
      ui: 'driver_en_route',
      driver: SUMMARY,
    });
    expect(assignment.getAssignedDriverSummary).toHaveBeenCalledWith(9, true);
  });

  it('active trip carries free_cancellation_until (assignedAt + window) and server_time', async () => {
    const assignedAt = new Date(Date.now() - 30_000);
    const { service } = createService({
      activeRow: activeRow({ assignedAt, updatedAt: new Date() }),
      summary: SUMMARY,
    });
    const r = await service.getActive(1);
    expect(r.active_trip?.free_cancellation_until).toBe(
      new Date(assignedAt.getTime() + 2 * 60_000).toISOString(),
    );
    expect(Math.abs(Date.now() - new Date(r.active_trip?.server_time ?? 0).getTime())).toBeLessThan(5_000);
  });

  it('pending trip -> free_cancellation_until is null', async () => {
    const { service } = createService({
      activeRow: activeRow({ status: 'pending_assignment', assignedAt: null }),
    });
    const r = await service.getActive(1);
    expect(r.active_trip?.free_cancellation_until).toBeNull();
  });

  it('in_progress trip -> free_cancellation_until is null', async () => {
    const { service } = createService({
      activeRow: activeRow({ status: 'in_progress' }),
      summary: SUMMARY,
    });
    const r = await service.getActive(1);
    expect(r.active_trip?.free_cancellation_until).toBeNull();
  });

  it('pending trip -> ui searching and no driver lookup', async () => {
    const { service, assignment } = createService({
      activeRow: activeRow({ status: 'pending_assignment', assignedAt: null }),
    });
    const r = await service.getActive(1);
    expect(r.active_trip?.ui).toBe('searching');
    expect(assignment.getAssignedDriverSummary).not.toHaveBeenCalled();
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
  describe('boundary matches free_cancellation_until', () => {
    const ASSIGNED = new Date('2026-10-08T15:00:00.000Z');
    const DEADLINE_MS = ASSIGNED.getTime() + 2 * 60_000;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      ['exactly at the deadline', DEADLINE_MS, true],
      ['1 ms before the deadline', DEADLINE_MS - 1, true],
      ['1 ms after the deadline', DEADLINE_MS + 1, false],
    ])('cancel %s -> free_of_charge=%s', async (_label, nowMs, expectedFree) => {
      jest.setSystemTime(nowMs);
      const { service } = createService({
        tripRequest: tr({ assignedAt: ASSIGNED, updatedAt: ASSIGNED }),
      });
      const r = await service.cancel(5, 1, {});
      expect(r.free_of_charge).toBe(expectedFree);
      expect(r.penalty_recorded).toBe(!expectedFree);
    });
  });
});

describe('TripsService.quote · municipality fare (ADR-032 §4.1)', () => {
  const quoteDto = {
    origin: ORIGIN,
    destination: DESTINATION,
    municipality_id: 1,
    service_type: 'taxi' as const,
  };

  it('prices with the municipality fare and never carries a commission to the passenger', async () => {
    const { service } = createService({ fare: { ...FARE_ROW, baseFare: 9500 } });

    const r = await service.quote(quoteDto);

    expect(r.fare.base_fare).toBe(9500);
    expect(r.fare.commission).toBe(0);
  });

  it('signs the version of the fare it used (token v2)', async () => {
    const { service } = createService();
    const quoter = new QuoteTokenService(fakeEnv());

    const r = await service.quote(quoteDto);

    const verification = quoter.verify(r.quote_token);
    expect(verification.ok && verification.payload).toMatchObject({ version: 2, municipalityFareId: 31 });
  });

  it('asks the resolver for the companies that offer the service in the municipality', async () => {
    const { service, dispatch } = createService();

    await service.quote(quoteDto);

    expect(dispatch.resolve).toHaveBeenCalledWith(1, { serviceType: 'taxi' });
  });

  it('no company offers the service -> 409 NO_COMPANY_AVAILABLE', async () => {
    const { service } = createService({ companyIds: [] });

    const error = await service.quote(quoteDto).catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'NO_COMPANY_AVAILABLE' });
  });

  it('no fare for the municipality -> 409 FARE_NOT_CONFIGURED', async () => {
    const { service } = createService({ fare: null });

    const error = await service.quote(quoteDto).catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'FARE_NOT_CONFIGURED' });
  });

  it('an inactive service -> 409 SERVICE_NOT_AVAILABLE before anything else', async () => {
    const { service, dispatch } = createService({ activeServices: ['taxi'] });

    const error = await service
      .quote({ ...quoteDto, service_type: 'comfort' as never })
      .catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
    expect(dispatch.resolve).not.toHaveBeenCalled();
  });
});

describe('TripsService.create · preference and fare version (ADR-032 §3, §7.2)', () => {
  const dtoWith = (token: string, over: Partial<CreateTripRequestDTO> = {}): CreateTripRequestDTO => ({
    origin: ORIGIN,
    destination: DESTINATION,
    municipality_id: 1,
    service_type: 'taxi',
    payment_method: 'cash',
    quote_token: token,
    ...over,
  });
  async function tokenFrom(service: TripsService): Promise<string> {
    const r = await service.quote({
      origin: ORIGIN,
      destination: DESTINATION,
      municipality_id: 1,
      service_type: 'taxi',
    });
    return r.quote_token;
  }

  it('stores the requested company, the fare version and a zero commission', async () => {
    const { service, calls } = createService({ companyIds: [4] });

    await service.create(dtoWith(await tokenFrom(service), { requested_company_id: 4 }), 1);

    expect(calls.created[0]).toMatchObject({
      requestedCompanyId: 4,
      municipalityFareId: 31,
      commission: 0,
    });
  });

  it('"Cualquiera" (no preference) stores a null requested company', async () => {
    const { service, calls } = createService();

    await service.create(dtoWith(await tokenFrom(service)), 1);

    expect(calls.created[0]).toMatchObject({ requestedCompanyId: null });
  });

  it('a requested company that is not available -> 409 COMPANY_NOT_AVAILABLE and nothing is created', async () => {
    const { service, calls, dispatch } = createService();
    const token = await tokenFrom(service);
    dispatch.resolve.mockResolvedValueOnce([]);

    const error = await service
      .create(dtoWith(token, { requested_company_id: 99 }), 1)
      .catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'COMPANY_NOT_AVAILABLE' });
    expect(calls.created).toHaveLength(0);
  });

  it('the trigger rejecting the company between validation and insert -> the same 409', async () => {
    const { service } = createService({
      createError: new Error(
        'new row for relation "trip_request" violates check constraint "trip_request_requested_company_available"',
      ),
    });

    const error = await service
      .create(dtoWith(await tokenFrom(service), { requested_company_id: 4 }), 1)
      .catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'COMPANY_NOT_AVAILABLE' });
  });

  it('the trigger message surfaced by Prisma without the constraint name -> the same 409', async () => {
    const { service } = createService({
      createError: new Error(
        'Error occurred during query execution: PostgresError { code: "23514", message: "ADR-032: requested company 7 is not available for this trip" }',
      ),
    });

    const error = await service
      .create(dtoWith(await tokenFrom(service), { requested_company_id: 7 }), 1)
      .catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'COMPANY_NOT_AVAILABLE' });
  });

  it('an inactive service -> 409 SERVICE_NOT_AVAILABLE', async () => {
    const { service } = createService({ activeServices: ['taxi'] });
    const token = await tokenFrom(service);

    const error = await service
      .create(dtoWith(token, { service_type: 'comfort' as never }), 1)
      .catch((e: unknown) => e);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
  });

  it('a token without the v2 marker -> 410 QUOTE_EXPIRED', async () => {
    const { service } = createService();
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(
      JSON.stringify({
        municipalityId: 1,
        serviceType: 'taxi',
        origin: { lat: ORIGIN.lat, lng: ORIGIN.lng },
        destination: { lat: DESTINATION.lat, lng: DESTINATION.lng },
        distanceKm: 1,
        fare: { base_fare: 8000, night_surcharge: 0, holiday_surcharge: 0, total: 8000, commission: 640, currency: 'COP' },
        exp: Math.floor(Date.now() / 1000) + 120,
      }),
    ).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(body).digest().toString('base64url');

    await expect(service.create(dtoWith(`${body}.${signature}`), 1)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('TripsService.getStatus · company fields (ADR-032 §7.2)', () => {
  const trip = (over: Partial<FakeTripRequest>): FakeTripRequest => ({
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
    requestedCompanyId: null,
    municipalityFareId: 31,
    ...over,
  });

  it('exposes the service type and null requested_company for "Cualquiera"', async () => {
    const { service } = createService({ tripRequest: trip({}) });

    const r = await service.getStatus(9, 1);

    expect(r.service_type).toBe('taxi');
    expect(r.requested_company).toBeNull();
  });

  it('names the requested company', async () => {
    const { service } = createService({ tripRequest: trip({ requestedCompanyId: 4 }) });

    const r = await service.getStatus(9, 1);

    expect(r.requested_company).toEqual({ company_id: 4, display_name: 'Empresa 4' });
  });

  it('rebuilds the fare from the stored version and always reports a zero commission', async () => {
    const { service } = createService({ tripRequest: trip({ commission: 640 }) });

    const r = await service.getStatus(9, 1);

    expect(r.fare.base_fare).toBe(8000);
    expect(r.fare.commission).toBe(0);
  });

  it('a trip without a stored version falls back to the flat fare', async () => {
    const { service } = createService({ tripRequest: trip({ municipalityFareId: null, fare: 8500 }) });

    const r = await service.getStatus(9, 1);

    expect(r.fare).toMatchObject({ base_fare: 8500, total: 8500, commission: 0 });
  });

  it('the free-cancellation window comes from the municipality parameters', async () => {
    const assignedAt = new Date(Date.now() - 30_000);
    const { service } = createService({
      tripRequest: trip({ status: 'assigned', assignedAt }),
      windowMin: 7,
    });

    const r = await service.getStatus(9, 1);

    expect(r.free_cancellation_until).toBe(new Date(assignedAt.getTime() + 7 * 60_000).toISOString());
  });
});

describe('TripsService.onNoDriver (MD-05)', () => {
  it('moves the trip to no_driver through the conditional update', async () => {
    const { service, calls } = createService();

    await service.onNoDriver({
      trip_request_id: 12,
      attempts_made: 3,
      final_radius_km: 5,
      occurred_at: new Date().toISOString(),
    });

    expect(calls.noDriver).toEqual([12]);
  });

  it('a trip that was taken meanwhile is left alone and nothing throws', async () => {
    const { service } = createService({ noDriverApplied: false });

    await expect(
      service.onNoDriver({
        trip_request_id: 12,
        attempts_made: 3,
        final_radius_km: 5,
        occurred_at: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });
});
