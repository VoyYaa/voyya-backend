import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  AssignmentStatus,
  CompleteTripDTO,
  TripRequestCompletedEvent,
  TripRequestNoShowEvent,
  TripStatus,
  TripTransitionResult,
} from '@voyyaa/shared';
import { TRIPS_EVENTS } from '@voyyaa/shared';
import type { CloseTripOutcome } from '../assignment/trip-closing.service';
import { AssignmentService } from '../assignment/assignment.service';
import { OperationalParamsService } from '../assignment/operational-params.service';
import { TripClosingService } from '../assignment/trip-closing.service';
import type { TripTransitionOutcome } from './trips.repository';
import { TripsRepository } from './trips.repository';

@Injectable()
export class TripLifecycleService {
  constructor(
    private readonly repo: TripsRepository,
    private readonly assignment: AssignmentService,
    private readonly tripClosing: TripClosingService,
    private readonly params: OperationalParamsService,
    private readonly emitter: EventEmitter2,
  ) {}

  async markEnRoute(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId);
    const outcome = await this.repo.markEnRoute(tripRequestId);
    return this.fromTransitionOutcome(tripRequestId, 'driver_en_route', outcome, {});
  }

  async markArrived(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId);
    const outcome = await this.repo.markArrived(tripRequestId);
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: `No puedes marcar la llegada: el viaje está en ${outcome.status}`,
      });
    }
    const tripRequest = await this.getTripRequestOrThrow(tripRequestId);
    const graceMin = (await this.params.get(tripRequest.municipalityId)).noShowGraceMin;
    const arrivedAt = outcome.row.arrivedAt;
    return {
      trip_request_id: tripRequestId,
      status: 'driver_en_route',
      idempotent: outcome.kind === 'idempotent',
      arrived_at: arrivedAt.toISOString(),
      no_show_available_at: new Date(arrivedAt.getTime() + graceMin * 60_000).toISOString(),
    };
  }

  async markStarted(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId);
    const outcome = await this.repo.markStarted(tripRequestId);
    return this.fromTransitionOutcome(tripRequestId, 'in_progress', outcome, {});
  }

  async confirmCashCollected(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId, ['completed']);
    const outcome = await this.repo.markCashCollected(tripRequestId);
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: `No puedes confirmar el cobro: el viaje está en ${outcome.status}`,
      });
    }
    return {
      trip_request_id: tripRequestId,
      status: 'completed',
      idempotent: outcome.kind === 'idempotent',
      cash_collected_at: outcome.row.cashCollectedAt.toISOString(),
    };
  }

  async complete(
    tripRequestId: number,
    driverId: number,
    companyId: number,
    dto: CompleteTripDTO,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId);
    const tripRequest = await this.getTripRequestOrThrow(tripRequestId);
    const outcome = await this.tripClosing.closeTrip({
      tripRequestId,
      to: 'completed',
      companyId,
      driverId,
      cashCollected: dto.cash_collected,
    });
    if (outcome.kind === 'applied') {
      const ev: TripRequestCompletedEvent = {
        trip_request_id: tripRequestId,
        passenger_id: tripRequest.passengerId,
        driver_id: driverId,
        company_id: companyId,
        net_earnings: outcome.netEarnings ?? 0,
        cash_collected: outcome.cashCollectedAt !== null,
        occurred_at: new Date().toISOString(),
      };
      this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_COMPLETED, ev);
    }
    return this.fromCloseOutcome(tripRequestId, outcome);
  }

  async declareNoShow(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    await this.assertOwnership(tripRequestId, driverId, companyId);
    const tripRequest = await this.getTripRequestOrThrow(tripRequestId);
    const graceMin = (await this.params.get(tripRequest.municipalityId)).noShowGraceMin;
    const outcome = await this.tripClosing.closeTrip({
      tripRequestId,
      to: 'no_show',
      companyId,
      driverId,
      noShowGraceMin: graceMin,
    });
    if (outcome.kind === 'applied') {
      const ev: TripRequestNoShowEvent = {
        trip_request_id: tripRequestId,
        passenger_id: tripRequest.passengerId,
        driver_id: driverId,
        company_id: companyId,
        arrived_at: outcome.arrivedAt ? outcome.arrivedAt.toISOString() : new Date().toISOString(),
        occurred_at: new Date().toISOString(),
      };
      this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_NO_SHOW, ev);
    }
    return this.fromCloseOutcome(tripRequestId, outcome);
  }

  private async assertOwnership(
    tripRequestId: number,
    driverId: number,
    companyId: number,
    allow: readonly AssignmentStatus[] = ['accepted'],
  ): Promise<void> {
    const owned = await this.assignment.getAcceptedAssignment(
      tripRequestId,
      driverId,
      companyId,
      allow,
    );
    if (!owned) {
      throw new ForbiddenException({
        code: 'NOT_THE_DRIVER',
        message: 'No eres el conductor asignado a este viaje',
      });
    }
  }

  private async getTripRequestOrThrow(
    tripRequestId: number,
  ): Promise<{ passengerId: number; municipalityId: number }> {
    const tripRequest = await this.repo.getTripRequest(tripRequestId);
    if (!tripRequest) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: 'La solicitud no existe',
      });
    }
    return tripRequest;
  }

  private fromTransitionOutcome<T extends { updatedAt: Date }>(
    tripRequestId: number,
    status: TripStatus,
    outcome: TripTransitionOutcome<T>,
    extra: Partial<TripTransitionResult>,
  ): TripTransitionResult {
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: `No puedes hacer esta transición: el viaje está en ${outcome.status}`,
      });
    }
    return {
      trip_request_id: tripRequestId,
      status,
      idempotent: outcome.kind === 'idempotent',
      ...extra,
    };
  }

  private fromCloseOutcome(
    tripRequestId: number,
    outcome: CloseTripOutcome,
  ): TripTransitionResult {
    if (outcome.kind === 'rejected') {
      if (outcome.reason === 'not_arrived') {
        throw new ConflictException({
          code: 'ARRIVAL_NOT_MARKED',
          message: 'Primero marca tu llegada al punto de recogida',
        });
      }
      if (outcome.reason === 'grace_pending') {
        throw new ConflictException({
          code: 'NO_SHOW_GRACE_PENDING',
          message: 'Aún no pasa la cortesía de espera',
          remaining_seconds: outcome.remainingSeconds,
        });
      }
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: `No puedes hacer esta transición: el viaje está en ${outcome.status}`,
      });
    }
    return {
      trip_request_id: tripRequestId,
      status: outcome.status,
      idempotent: outcome.kind === 'idempotent',
      finished_at: outcome.finishedAt ? outcome.finishedAt.toISOString() : null,
      net_earnings: outcome.netEarnings,
      cash_collected_at: outcome.cashCollectedAt ? outcome.cashCollectedAt.toISOString() : null,
    };
  }
}
