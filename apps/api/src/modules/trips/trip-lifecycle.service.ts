import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import type {
  AssignmentStatus,
  ServiceType,
  CompleteTripDTO,
  TripRequestCompletedEvent,
  TripRequestNoShowEvent,
  TripStatus,
  TripTransitionResult,
} from '@voyyaa/shared';
import { TRIPS_EVENTS } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { CloseTripOutcome } from '../assignment/trip-closing.service';
import { AssignmentService } from '../assignment/assignment.service';
import { OperationalParamsService } from '../service-config/operational-params.service';
import { TripClosingService } from '../assignment/trip-closing.service';
import { TRIPS_MESSAGES } from './trips.messages';
import type { TripTransitionOutcome } from './trips.repository';
import { TripsRepository } from './trips.repository';

const CLOSED_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['completed'];

interface TripSubject {
  passengerId: number;
  municipalityId: number;
  serviceType: ServiceType;
}

@Injectable()
export class TripLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
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
    const outcome = await this.inOwnedTrip(tripRequestId, driverId, companyId, ['accepted'], (tx) =>
      this.repo.markEnRoute(tx, tripRequestId),
    );
    return this.fromTransitionOutcome(tripRequestId, 'driver_en_route', outcome, {});
  }

  async markArrived(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    const { outcome, graceMin } = await this.inOwnedTrip(
      tripRequestId,
      driverId,
      companyId,
      ['accepted'],
      async (tx) => {
        const marked = await this.repo.markArrived(tx, tripRequestId);
        if (marked.kind === 'rejected') return { outcome: marked, graceMin: 0 };
        const trip = await this.getTripRequestOrThrow(tripRequestId, tx);
        return { outcome: marked, graceMin: await this.noShowGraceMinOf(trip, tx) };
      },
    );
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: TRIPS_MESSAGES.cannotMarkArrival(outcome.status),
      });
    }
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
    const outcome = await this.inOwnedTrip(tripRequestId, driverId, companyId, ['accepted'], (tx) =>
      this.repo.markStarted(tx, tripRequestId),
    );
    return this.fromTransitionOutcome(tripRequestId, 'in_progress', outcome, {});
  }

  async confirmCashCollected(
    tripRequestId: number,
    driverId: number,
    companyId: number,
  ): Promise<TripTransitionResult> {
    const outcome = await this.inOwnedTrip(tripRequestId, driverId, companyId, ['completed'], (tx) =>
      this.repo.markCashCollected(tx, tripRequestId),
    );
    if (outcome.kind === 'rejected') {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: TRIPS_MESSAGES.cannotConfirmCash(outcome.status),
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
    const { trip, outcome } = await this.inOwnedTrip(
      tripRequestId,
      driverId,
      companyId,
      ['accepted'],
      async (tx) => ({
        trip: await this.getTripRequestOrThrow(tripRequestId, tx),
        outcome: await this.tripClosing.closeTripInTx(tx, companyId, {
          tripRequestId,
          to: 'completed',
          driverId,
          cashCollected: dto.cash_collected,
        }),
      }),
    );
    if (outcome.kind === 'applied') {
      const ev: TripRequestCompletedEvent = {
        trip_request_id: tripRequestId,
        passenger_id: trip.passengerId,
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
    const { trip, outcome } = await this.inOwnedTrip(
      tripRequestId,
      driverId,
      companyId,
      ['accepted'],
      async (tx) => {
        const subject = await this.getTripRequestOrThrow(tripRequestId, tx);
        return {
          trip: subject,
          outcome: await this.tripClosing.closeTripInTx(tx, companyId, {
            tripRequestId,
            to: 'no_show',
            driverId,
            noShowGraceMin: await this.noShowGraceMinOf(subject, tx),
          }),
        };
      },
    );
    if (outcome.kind === 'applied') {
      const ev: TripRequestNoShowEvent = {
        trip_request_id: tripRequestId,
        passenger_id: trip.passengerId,
        driver_id: driverId,
        company_id: companyId,
        arrived_at: outcome.arrivedAt ? outcome.arrivedAt.toISOString() : new Date().toISOString(),
        occurred_at: new Date().toISOString(),
      };
      this.emitter.emit(TRIPS_EVENTS.TRIP_REQUEST_NO_SHOW, ev);
    }
    return this.fromCloseOutcome(tripRequestId, outcome);
  }

  private inOwnedTrip<T>(
    tripRequestId: number,
    driverId: number,
    companyId: number,
    allow: readonly AssignmentStatus[],
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      await this.assertOwnership(tx, tripRequestId, driverId, companyId, allow);
      return run(tx);
    });
  }

  private async assertOwnership(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    driverId: number,
    companyId: number,
    allow: readonly AssignmentStatus[],
  ): Promise<void> {
    const owned = await this.assignment.getOwnedAssignment(tx, tripRequestId, driverId, companyId, allow);
    if (owned) return;
    const closed = await this.assignment.getOwnedAssignment(
      tx,
      tripRequestId,
      driverId,
      companyId,
      CLOSED_ASSIGNMENT_STATUSES,
    );
    if (closed) {
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: TRIPS_MESSAGES.tripAlreadyClosed,
      });
    }
    throw new ForbiddenException({
      code: 'NOT_THE_DRIVER',
      message: TRIPS_MESSAGES.notAssignedDriver,
    });
  }

  private async noShowGraceMinOf(trip: TripSubject, tx: Prisma.TransactionClient): Promise<number> {
    return (await this.params.get(trip.municipalityId, trip.serviceType, tx)).noShowGraceMin;
  }

  private async getTripRequestOrThrow(
    tripRequestId: number,
    tx: Prisma.TransactionClient,
  ): Promise<TripSubject> {
    const tripRequest = await this.repo.getTripRequest(tripRequestId, tx);
    if (!tripRequest) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: TRIPS_MESSAGES.tripNotFound,
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
        message: TRIPS_MESSAGES.invalidTransition(outcome.status),
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
          message: TRIPS_MESSAGES.arrivalNotMarked,
        });
      }
      if (outcome.reason === 'grace_pending') {
        throw new ConflictException({
          code: 'NO_SHOW_GRACE_PENDING',
          message: TRIPS_MESSAGES.noShowGracePending,
          remaining_seconds: outcome.remainingSeconds,
        });
      }
      throw new ConflictException({
        code: 'INVALID_TRIP_TRANSITION',
        message: TRIPS_MESSAGES.invalidTransition(outcome.status),
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
