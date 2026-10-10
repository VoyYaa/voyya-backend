import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  type ActiveTripResponse,
  type AssignmentCancelledByDriverEvent,
  type CancelTripRequestDTO,
  type CreateTripRequestDTO,
  type FareBreakdown,
  type QuoteFareDTO,
  type QuoteResponse,
  type TripRequestCancelled,
  type TripRequestCreated,
  type TripRequestCreatedEvent,
  type TripRequestCancelledEvent,
  type TripRequestNoDriverEvent,
  type TripRequestStatus,
  type TripStatus,
  ASSIGNMENT_EVENTS,
  TRIPS_EVENTS,
  TripStateMachine,
} from '@voyyaa/shared';
import type { TripRequest } from '@prisma/client';
import { RequestContextService } from '../../infrastructure/observability/request-context.service';
import { requireTripLocation } from '../../shared/require-trip-location';
import { isInTripWindow } from '../../shared/trip-window';
import { isUniqueViolation } from '../../shared/unique-violation';
import { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import { OperationalParamsService } from '../service-config/operational-params.service';
import { ServiceCatalog } from '../service-config/service-catalog';
import { CompanyDirectory } from '../tenancy/company-directory';
import { DispatchCompaniesResolver } from '../tenancy/dispatch-companies.resolver';
import { AssignmentService } from '../assignment/assignment.service';
import { DriverTrackingService } from '../assignment/driver-tracking.service';
import { TripClosingService } from '../assignment/trip-closing.service';
import type { MunicipalityFareRow } from '../service-config/service-config.types';
import { calculateFare, type FareParams } from './domain/fare.calculator';
import { freeCancellationDeadline, isFreeCancellation } from './domain/free-cancellation';
import { haversineKm } from './domain/geo';
import { passengerUiState } from './domain/ui-state';
import { HOLIDAYS_PROVIDER, type HolidaysProvider } from './holidays/holidays.provider';
import { QuoteTokenService, type QuotePayload } from './quote-token.service';
import { TRIPS_MESSAGES } from './trips.messages';
import { TripsRepository } from './trips.repository';

const EPS = 1e-6;

const STATUSES_WITH_DRIVER: readonly TripStatus[] = [
  'assigned',
  'driver_en_route',
  'in_progress',
  'completed',
];

const STATUSES_WITH_DRIVER_CONTACT: readonly TripStatus[] = ['assigned', 'driver_en_route'];

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly repo: TripsRepository,
    private readonly quoteToken: QuoteTokenService,
    private readonly emitter: EventEmitter2,
    @Inject(HOLIDAYS_PROVIDER) private readonly holidays: HolidaysProvider,
    private readonly assignment: AssignmentService,
    private readonly tripClosing: TripClosingService,
    private readonly dispatchCompanies: DispatchCompaniesResolver,
    private readonly requestContext: RequestContextService,
    private readonly fares: MunicipalityFareReader,
    private readonly params: OperationalParamsService,
    private readonly catalog: ServiceCatalog,
    private readonly companyDirectory: CompanyDirectory,
    private readonly tracking: DriverTrackingService,
  ) {}

  async quote(dto: QuoteFareDTO): Promise<QuoteResponse> {
    this.catalog.assertActive(dto.service_type);
    await this.ensureCoverage(dto.municipality_id, dto.origin, dto.destination);

    const companyIds = await this.dispatchCompanies.resolve(dto.municipality_id, {
      serviceType: dto.service_type,
    });
    if (companyIds.length === 0) {
      throw new ConflictException({
        code: 'NO_COMPANY_AVAILABLE',
        message: TRIPS_MESSAGES.noCompanyAvailable,
      });
    }

    const config = await this.fares.getCurrent(dto.municipality_id, dto.service_type);
    if (!config) {
      throw new ConflictException({
        code: 'FARE_NOT_CONFIGURED',
        message: TRIPS_MESSAGES.fareNotConfigured,
      });
    }

    const distanceKm = round3(haversineKm(dto.origin, dto.destination));
    const fare = calculateFare(toFareParams(config), { date: new Date() }, this.holidays);

    const quote_token = this.quoteToken.sign({
      municipalityId: dto.municipality_id,
      municipalityFareId: config.municipalityFareId,
      serviceType: dto.service_type,
      origin: { lat: dto.origin.lat, lng: dto.origin.lng },
      destination: { lat: dto.destination.lat, lng: dto.destination.lng },
      distanceKm,
      fare,
    });

    return {
      within_coverage: true,
      service_type: dto.service_type,
      payment_method: 'cash',
      fare,
      distance_km: distanceKm,
      eta: null,
      quote_token,
    };
  }

  async create(dto: CreateTripRequestDTO, passengerId: number): Promise<TripRequestCreated> {
    this.catalog.assertActive(dto.service_type);
    const verification = this.quoteToken.verify(dto.quote_token);
    if (!verification.ok) {
      if (verification.reason === 'expired') {
        throw new GoneException({
          code: 'QUOTE_EXPIRED',
          message: TRIPS_MESSAGES.quoteExpired,
        });
      }
      throw new BadRequestException({
        code: 'QUOTE_INVALID',
        message: TRIPS_MESSAGES.quoteInvalid,
      });
    }

    const payload = verification.payload;
    if (!this.tokenMatchesDto(payload, dto)) {
      throw new BadRequestException({
        code: 'QUOTE_MISMATCH',
        message: TRIPS_MESSAGES.quoteMismatch,
      });
    }

    await this.ensureCoverage(dto.municipality_id, dto.origin, dto.destination);
    await this.ensureRequestedCompany(dto);

    const active = await this.repo.findActiveTripRequest(passengerId);
    if (active) throw activeTripConflict(active);

    const tripRequest = await this.insertTripRequest(passengerId, dto, payload);

    this.emitTripRequestCreated(tripRequest);

    return {
      trip_request_id: tripRequest.tripRequestId,
      status: 'pending_assignment',
      service_type: dto.service_type,
      payment_method: 'cash',
      fare: payload.fare,
      requested_at: tripRequest.requestedAt.toISOString(),
    };
  }

  private async insertTripRequest(
    passengerId: number,
    dto: CreateTripRequestDTO,
    payload: QuotePayload,
  ): Promise<TripRequest> {
    try {
      return await this.repo.createTripRequest({
        passengerId,
        municipalityId: dto.municipality_id,
        serviceType: dto.service_type,
        paymentMethod: 'cash',
        pickupAddress: dto.origin.address,
        dropoffAddress: dto.destination.address,
        pickupLat: dto.origin.lat,
        pickupLng: dto.origin.lng,
        dropoffLat: dto.destination.lat,
        dropoffLng: dto.destination.lng,
        distanceKm: payload.distanceKm,
        fareTotal: payload.fare.total,
        commission: 0,
        requestedCompanyId: dto.requested_company_id ?? null,
        municipalityFareId: payload.municipalityFareId,
      });
    } catch (error) {
      if (isRequestedCompanyRejected(error)) throw companyNotAvailable();
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.repo.findActiveTripRequest(passengerId);
      if (!winner) throw error;
      throw activeTripConflict(winner);
    }
  }

  private async ensureRequestedCompany(dto: CreateTripRequestDTO): Promise<void> {
    if (dto.requested_company_id == null) return;
    const [available] = await this.dispatchCompanies.resolve(dto.municipality_id, {
      serviceType: dto.service_type,
      requestedCompanyId: dto.requested_company_id,
    });
    if (available === undefined) throw companyNotAvailable();
  }

  async cancel(
    tripRequestId: number,
    passengerId: number,
    _dto: CancelTripRequestDTO,
  ): Promise<TripRequestCancelled> {
    const receivedAt = new Date();
    const tripRequest = await this.repo.getTripRequest(tripRequestId);
    if (!tripRequest) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: TRIPS_MESSAGES.tripNotFound,
      });
    }
    if (tripRequest.passengerId !== passengerId) {
      throw new ForbiddenException({ code: 'NOT_OWNER', message: TRIPS_MESSAGES.notOwner });
    }

    if (
      !TripStateMachine.tripRequest.canTransition(tripRequest.status, 'cancelled_by_passenger')
    ) {
      throw new ConflictException({
        code: 'STATUS_NOT_CANCELLABLE',
        message: TRIPS_MESSAGES.notCancellable,
      });
    }

    const { cancellationWindowMin } = await this.params.get(
      tripRequest.municipalityId,
      tripRequest.serviceType,
    );
    const freeOfCharge = isFreeCancellation(tripRequest, cancellationWindowMin, receivedAt);
    const penaltyRecorded = !freeOfCharge;

    const outcome = await this.tripClosing.closePassengerTrip({
      tripRequestId,
      passengerId,
      penaltyRecorded,
    });
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'STATUS_NOT_CANCELLABLE',
        message: TRIPS_MESSAGES.notCancellable,
      });
    }

    if (outcome.kind === 'applied') {
      const event: TripRequestCancelledEvent = {
        trip_request_id: tripRequestId,
        cancelled_by: 'passenger',
        released_driver_id: null,
        occurred_at: new Date().toISOString(),
      };
      this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_CANCELLED, event);
    }

    return {
      trip_request_id: tripRequestId,
      status: 'cancelled_by_passenger',
      free_of_charge: !outcome.penaltyRecorded,
      penalty_recorded: outcome.penaltyRecorded,
      cancelled_at: (outcome.finishedAt ?? new Date()).toISOString(),
    };
  }

  async getStatus(tripRequestId: number, passengerId: number): Promise<TripRequestStatus> {
    const t = await this.repo.getTripRequestForPassenger(tripRequestId);
    if (!t) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: TRIPS_MESSAGES.tripNotFound,
      });
    }
    if (t.passengerId !== passengerId) {
      throw new ForbiddenException({ code: 'NOT_OWNER', message: TRIPS_MESSAGES.notOwner });
    }
    return this.toStatusResponse(t);
  }

  async getActive(passengerId: number): Promise<ActiveTripResponse> {
    const active = await this.repo.findActiveTripRequest(passengerId);
    if (!active) return { active_trip: null };
    const withCode = await this.repo.getTripRequestForPassenger(active.tripRequestId);
    return { active_trip: withCode ? await this.toStatusResponse(withCode) : null };
  }

  private async toStatusResponse(t: TripRequest): Promise<TripRequestStatus> {
    const tripRequestId = t.tripRequestId;
    const driver = STATUSES_WITH_DRIVER.includes(t.status)
      ? await this.assignment.getAssignedDriverSummary(
          tripRequestId,
          STATUSES_WITH_DRIVER_CONTACT.includes(t.status),
        )
      : null;
    const requestedCompany =
      t.requestedCompanyId === null ? null : await this.companyDirectory.getRef(t.requestedCompanyId);
    const { cancellationWindowMin } = await this.params.get(t.municipalityId, t.serviceType);
    const tracking = await this.tracking.forPassenger({
      tripRequestId,
      companyId: t.companyId,
      status: t.status,
    });
    const code = startCodeView(t);

    return {
      trip_request_id: t.tripRequestId,
      status: t.status,
      ui: passengerUiState(t.status, t.arrivedAt),
      service_type: t.serviceType,
      requested_company: requestedCompany,
      fare: await this.rebuildFare(t),
      driver,
      arrived_at: t.arrivedAt ? t.arrivedAt.toISOString() : null,
      free_cancellation_until:
        freeCancellationDeadline(t, cancellationWindowMin)?.toISOString() ?? null,
      updated_at: t.updatedAt.toISOString(),
      server_time: new Date().toISOString(),
      start_code: code.start_code,
      start_code_state: code.start_code_state,
      driver_tracking: tracking,
    };
  }

  private async rebuildFare(t: TripRequest): Promise<FareBreakdown> {
    const total = Number(t.fare);
    const config =
      t.municipalityFareId === null ? null : await this.fares.getById(t.municipalityFareId);
    if (config) {
      const rebuilt = calculateFare(toFareParams(config), { date: t.requestedAt }, this.holidays);
      if (rebuilt.total === total) return rebuilt;
    }
    return {
      base_fare: total,
      night_surcharge: 0,
      holiday_surcharge: 0,
      total,
      commission: 0,
      currency: 'COP',
    };
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_NO_DRIVER)
  async onNoDriver(ev: TripRequestNoDriverEvent): Promise<void> {
    await this.markNoDriver(ev.trip_request_id);
  }

  @OnEvent(ASSIGNMENT_EVENTS.ASSIGNMENT_CANCELLED_BY_DRIVER)
  async onCancelledByDriver(ev: AssignmentCancelledByDriverEvent): Promise<void> {
    if (ev.trip_request_status !== 'pending_assignment') return;
    const tripRequest = await this.repo.getTripRequest(ev.trip_request_id);
    if (!tripRequest) return;
    this.emitTripRequestCreated(tripRequest);
  }

  private async markNoDriver(tripRequestId: number): Promise<void> {
    const applied = await this.repo.markNoDriverIfUnassigned(tripRequestId);
    if (!applied) {
      this.logger.warn(`no_driver ignored tripRequest=${tripRequestId}: no longer pending without a company`);
    }
  }

  private emitTripRequestCreated(tripRequest: TripRequest): void {
    this.requestContext.set({ tripRequestId: tripRequest.tripRequestId });
    const event: TripRequestCreatedEvent = {
      trip_request_id: tripRequest.tripRequestId,
      passenger_id: tripRequest.passengerId,
      municipality_id: tripRequest.municipalityId,
      service_type: tripRequest.serviceType,
      origin: {
        lat: requireTripLocation(tripRequest.pickupLat),
        lng: requireTripLocation(tripRequest.pickupLng),
      },
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_CREATED, event);
  }

  private async ensureCoverage(
    municipalityId: number,
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
  ): Promise<void> {
    const [originOk, destinationOk] = await Promise.all([
      this.repo.isPointInCoverage(municipalityId, origin.lng, origin.lat),
      this.repo.isPointInCoverage(municipalityId, destination.lng, destination.lat),
    ]);
    if (!originOk || !destinationOk) {
      throw new ConflictException({
        code: 'OUT_OF_COVERAGE',
        message: TRIPS_MESSAGES.outOfCoverage,
      });
    }
  }

  private tokenMatchesDto(payload: QuotePayload, dto: CreateTripRequestDTO): boolean {
    return (
      payload.municipalityId === dto.municipality_id &&
      payload.serviceType === dto.service_type &&
      almostEqual(payload.origin.lat, dto.origin.lat) &&
      almostEqual(payload.origin.lng, dto.origin.lng) &&
      almostEqual(payload.destination.lat, dto.destination.lat) &&
      almostEqual(payload.destination.lng, dto.destination.lng)
    );
  }
}

function startCodeView(
  t: Pick<TripRequest, 'status' | 'startCode' | 'startCodeBlockedAt' | 'startCodeExempt'>,
): Pick<TripRequestStatus, 'start_code' | 'start_code_state'> {
  if (!isInTripWindow(t.status)) return { start_code: null, start_code_state: 'not_applicable' };
  if (t.startCodeBlockedAt !== null) return { start_code: null, start_code_state: 'blocked' };
  if (t.startCode !== null) return { start_code: t.startCode, start_code_state: 'active' };
  return { start_code: null, start_code_state: t.startCodeExempt ? 'not_required' : 'not_applicable' };
}

function activeTripConflict(active: Pick<TripRequest, 'tripRequestId' | 'status'>): ConflictException {
  return new ConflictException({
    code: 'ACTIVE_TRIP_REQUEST_EXISTS',
    message: TRIPS_MESSAGES.activeTripExists,
    active_trip: { trip_request_id: active.tripRequestId, status: active.status },
  });
}
const REQUESTED_COMPANY_CONSTRAINT = 'trip_request_requested_company_available';
const REQUESTED_COMPANY_TRIGGER_MESSAGE = 'ADR-032: requested company';

function isRequestedCompanyRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(REQUESTED_COMPANY_CONSTRAINT) ||
      error.message.includes(REQUESTED_COMPANY_TRIGGER_MESSAGE))
  );
}

function companyNotAvailable(): ConflictException {
  return new ConflictException({
    code: 'COMPANY_NOT_AVAILABLE',
    message: TRIPS_MESSAGES.companyNotAvailable,
  });
}

function toFareParams(config: MunicipalityFareRow): FareParams {
  return {
    baseFare: config.baseFare,
    nightSurchargePct: config.nightSurchargePct,
    holidaySurchargePct: config.holidaySurchargePct,
    commissionPct: 0,
  };
}

function almostEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
