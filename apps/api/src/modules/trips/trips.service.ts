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
import { EnvService } from '../../config/env.service';
import { AssignmentService } from '../assignment/assignment.service';
import { TripClosingService } from '../assignment/trip-closing.service';
import { calculateFare } from './domain/fare.calculator';
import { haversineKm } from './domain/geo';
import { passengerUiState } from './domain/ui-state';
import { HOLIDAYS_PROVIDER, type HolidaysProvider } from './holidays/holidays.provider';
import { QuoteTokenService, type QuotePayload } from './quote-token.service';
import { TripsRepository } from './trips.repository';

const EPS = 1e-6;

const STATUSES_WITH_DRIVER: readonly TripStatus[] = [
  'assigned',
  'driver_en_route',
  'in_progress',
  'completed',
];

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly repo: TripsRepository,
    private readonly quoteToken: QuoteTokenService,
    private readonly env: EnvService,
    private readonly emitter: EventEmitter2,
    @Inject(HOLIDAYS_PROVIDER) private readonly holidays: HolidaysProvider,
    private readonly assignment: AssignmentService,
    private readonly tripClosing: TripClosingService,
  ) {}

  async quote(dto: QuoteFareDTO): Promise<QuoteResponse> {
    await this.ensureCoverage(dto.municipality_id, dto.origin, dto.destination);

    const config = await this.repo.getActiveFareConfig(dto.municipality_id, dto.service_type);
    if (!config) {
      throw new ConflictException({
        code: 'FARE_NOT_CONFIGURED',
        message: 'No hay tarifa vigente para este municipio/servicio',
      });
    }

    const distanceKm = round3(haversineKm(dto.origin, dto.destination));
    const fare = calculateFare(
      {
        baseFare: Number(config.baseFare),
        nightSurchargePct: Number(config.nightSurchargePct),
        holidaySurchargePct: Number(config.holidaySurchargePct),
        commissionPct: Number(config.commissionPct),
      },
      { date: new Date() },
      this.holidays,
    );

    const quote_token = this.quoteToken.sign({
      municipalityId: dto.municipality_id,
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
    const verification = this.quoteToken.verify(dto.quote_token);
    if (!verification.ok) {
      if (verification.reason === 'expired') {
        throw new GoneException({
          code: 'QUOTE_EXPIRED',
          message: 'La cotización venció, vuelve a cotizar',
        });
      }
      throw new BadRequestException({
        code: 'QUOTE_INVALID',
        message: 'quote_token inválido',
      });
    }

    const payload = verification.payload;
    if (!this.tokenMatchesDto(payload, dto)) {
      throw new BadRequestException({
        code: 'QUOTE_MISMATCH',
        message: 'La cotización no corresponde a la solicitud enviada',
      });
    }

    await this.ensureCoverage(dto.municipality_id, dto.origin, dto.destination);

    if (await this.repo.hasActiveTripRequest(passengerId)) {
      throw new ConflictException({
        code: 'ACTIVE_TRIP_REQUEST_EXISTS',
        message: 'Ya tienes una solicitud en curso',
      });
    }

    const tripRequest = await this.repo.createTripRequest({
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
      commission: payload.fare.commission,
    });

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

  async cancel(
    tripRequestId: number,
    passengerId: number,
    _dto: CancelTripRequestDTO,
  ): Promise<TripRequestCancelled> {
    const tripRequest = await this.repo.getTripRequest(tripRequestId);
    if (!tripRequest) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: 'La solicitud no existe',
      });
    }
    if (tripRequest.passengerId !== passengerId) {
      throw new ForbiddenException({ code: 'NOT_OWNER', message: 'No eres el dueño' });
    }

    if (
      !TripStateMachine.tripRequest.canTransition(tripRequest.status, 'cancelled_by_passenger')
    ) {
      throw new ConflictException({
        code: 'STATUS_NOT_CANCELLABLE',
        message: 'La solicitud ya no se puede cancelar',
      });
    }

    const windowMin = this.env.get('CANCELLATION_WINDOW_MIN');
    let freeOfCharge = true;
    if (tripRequest.status !== 'pending_assignment') {
      const reference = tripRequest.assignedAt ?? tripRequest.updatedAt;
      freeOfCharge = minutesSince(reference) <= windowMin;
    }
    const penaltyRecorded = !freeOfCharge;

    const outcome = await this.tripClosing.closeTrip({
      tripRequestId,
      to: 'cancelled_by_passenger',
      penaltyRecorded,
    });
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'STATUS_NOT_CANCELLABLE',
        message: 'La solicitud ya no se puede cancelar',
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
    const t = await this.repo.getTripRequest(tripRequestId);
    if (!t) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: 'La solicitud no existe',
      });
    }
    if (t.passengerId !== passengerId) {
      throw new ForbiddenException({ code: 'NOT_OWNER', message: 'No eres el dueño' });
    }

    const driver = STATUSES_WITH_DRIVER.includes(t.status)
      ? await this.assignment.getAssignedDriverSummary(tripRequestId)
      : null;

    return {
      trip_request_id: t.tripRequestId,
      status: t.status,
      ui: passengerUiState(t.status, t.arrivedAt),
      fare: await this.rebuildFare(t),
      driver,
      arrived_at: t.arrivedAt ? t.arrivedAt.toISOString() : null,
      updated_at: t.updatedAt.toISOString(),
    };
  }

  private async rebuildFare(t: TripRequest): Promise<FareBreakdown> {
    const total = Number(t.fare);
    const commission = Number(t.commission);
    const config = await this.repo.getActiveFareConfig(t.municipalityId, t.serviceType);
    if (config) {
      const d = calculateFare(
        {
          baseFare: Number(config.baseFare),
          nightSurchargePct: Number(config.nightSurchargePct),
          holidaySurchargePct: Number(config.holidaySurchargePct),
          commissionPct: Number(config.commissionPct),
        },
        { date: t.requestedAt },
        this.holidays,
      );
      if (d.total === total) return { ...d, commission };
    }
    return {
      base_fare: total,
      night_surcharge: 0,
      holiday_surcharge: 0,
      total,
      commission,
      currency: 'COP',
    };
  }

  @OnEvent(TRIPS_EVENTS.TRIP_REQUEST_NO_DRIVER)
  async onNoDriver(ev: TripRequestNoDriverEvent): Promise<void> {
    await this.transition(ev.trip_request_id, 'no_driver');
  }

  @OnEvent(ASSIGNMENT_EVENTS.ASSIGNMENT_CANCELLED_BY_DRIVER)
  async onCancelledByDriver(ev: AssignmentCancelledByDriverEvent): Promise<void> {
    if (ev.trip_request_status !== 'pending_assignment') return;
    const tripRequest = await this.repo.getTripRequest(ev.trip_request_id);
    if (!tripRequest) return;
    this.emitTripRequestCreated(tripRequest);
  }

  private async transition(
    tripRequestId: number,
    to: Parameters<typeof TripStateMachine.tripRequest.assert>[1],
  ): Promise<void> {
    const tripRequest = await this.repo.getTripRequest(tripRequestId);
    if (!tripRequest) return;
    if (!TripStateMachine.tripRequest.canTransition(tripRequest.status, to)) {
      this.logger.warn(
        `Transition ignored tripRequest=${tripRequestId}: ${tripRequest.status} -> ${to}`,
      );
      return;
    }
    await this.repo.updateStatus(tripRequestId, to);
  }

  private emitTripRequestCreated(tripRequest: TripRequest): void {
    const event: TripRequestCreatedEvent = {
      trip_request_id: tripRequest.tripRequestId,
      passenger_id: tripRequest.passengerId,
      municipality_id: tripRequest.municipalityId,
      service_type: tripRequest.serviceType,
      origin: { lat: tripRequest.pickupLat, lng: tripRequest.pickupLng },
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
        message: 'El origen o el destino está fuera del área de cobertura',
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

function almostEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function minutesSince(date: Date): number {
  return (Date.now() - date.getTime()) / 60000;
}
