import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TRIP_STATUS_TRANSITIONS, type TripStatus } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AssignmentRepository } from './assignment.repository';

export type TripClosingTarget =
  | 'completed'
  | 'no_show'
  | 'cancelled_by_passenger'
  | 'cancelled_by_driver';

export interface CloseTripInput {
  tripRequestId: number;
  to: TripClosingTarget;
  companyId?: number;
  driverId?: number;
  cashCollected?: boolean;
  penaltyRecorded?: boolean;
  cancellationReason?: string | null;
  noShowGraceMin?: number;
}

export type CloseTripRejectionReason = 'invalid_status' | 'not_arrived' | 'grace_pending';

interface CloseTripRow {
  status: TripStatus;
  arrivedAt: Date | null;
  finishedAt: Date | null;
  netEarnings: number | null;
  cashCollectedAt: Date | null;
  penaltyRecorded: boolean;
}

export type CloseTripOutcome =
  | ({ kind: 'applied' | 'idempotent' } & CloseTripRow)
  | { kind: 'rejected'; reason: CloseTripRejectionReason; status: TripStatus; remainingSeconds?: number };

const ASSIGNMENT_STATUS_BY_TARGET: Record<TripClosingTarget, 'completed' | 'cancelled'> = {
  completed: 'completed',
  no_show: 'completed',
  cancelled_by_passenger: 'cancelled',
  cancelled_by_driver: 'cancelled',
};

export function sourceStatusesFor(to: TripStatus): TripStatus[] {
  return (Object.keys(TRIP_STATUS_TRANSITIONS) as TripStatus[]).filter((from) =>
    (TRIP_STATUS_TRANSITIONS[from] as readonly TripStatus[]).includes(to),
  );
}

@Injectable()
export class TripClosingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AssignmentRepository,
  ) {}

  async closeTrip(input: CloseTripInput): Promise<CloseTripOutcome> {
    const companyId = input.companyId ?? (await this.resolveCompanyId(input.tripRequestId));
    return this.prisma.runInTenant(companyId, (tx) => this.closeTripInTx(tx, companyId, input));
  }

  async closeTripInTx(
    tx: Prisma.TransactionClient,
    companyId: number,
    input: CloseTripInput,
  ): Promise<CloseTripOutcome> {
    const from = sourceStatusesFor(input.to);
    const applied = await this.repo.closeTripRequest(tx, {
      tripRequestId: input.tripRequestId,
      to: input.to,
      from,
      cashCollected: input.cashCollected ?? false,
      penaltyRecorded: input.penaltyRecorded ?? false,
      noShowGraceMin: input.noShowGraceMin,
    });

    const resolution = applied
      ? { kind: 'applied' as const, row: applied }
      : await this.resolveRejection(tx, input, from);

    if (resolution.kind === 'rejected') return resolution;

    const closedAssignment = await this.repo.closeAssignmentsForTrip(tx, {
      tripRequestId: input.tripRequestId,
      companyId,
      status: ASSIGNMENT_STATUS_BY_TARGET[input.to],
      reason: input.cancellationReason ?? null,
      driverId: input.driverId,
    });
    if (closedAssignment) {
      await this.repo.releaseDriver(tx, closedAssignment.driverId, companyId);
    }

    return { kind: resolution.kind, ...resolution.row };
  }

  private async resolveRejection(
    tx: Prisma.TransactionClient,
    input: CloseTripInput,
    from: readonly TripStatus[],
  ): Promise<{ kind: 'idempotent'; row: CloseTripRow } | { kind: 'rejected'; reason: CloseTripRejectionReason; status: TripStatus; remainingSeconds?: number }> {
    const current = await this.repo.getTripClosingSnapshot(tx, input.tripRequestId);
    if (!current) {
      return { kind: 'rejected', reason: 'invalid_status', status: 'expired' };
    }
    if (current.status === input.to) {
      return { kind: 'idempotent', row: current };
    }
    if (input.to === 'no_show' && from.includes(current.status)) {
      if (current.arrivedAt === null) {
        return { kind: 'rejected', reason: 'not_arrived', status: current.status };
      }
      const remainingSeconds = await this.repo.getNoShowRemainingSeconds(
        tx,
        input.tripRequestId,
        input.noShowGraceMin ?? 0,
      );
      return { kind: 'rejected', reason: 'grace_pending', status: current.status, remainingSeconds };
    }
    return { kind: 'rejected', reason: 'invalid_status', status: current.status };
  }

  private async resolveCompanyId(tripRequestId: number): Promise<number> {
    const info = await this.repo.getTripRequestInfo(tripRequestId);
    if (!info) {
      throw new Error(`Trip request ${tripRequestId} not found while closing`);
    }
    const companyId = await this.repo.resolveActiveCompany(info.municipalityId);
    if (companyId === null) {
      throw new Error(`No active company for municipality ${info.municipalityId}`);
    }
    return companyId;
  }
}
