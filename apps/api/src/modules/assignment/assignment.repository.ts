import { Injectable } from '@nestjs/common';
import type { Assignment, Prisma } from '@prisma/client';
import type { AssignmentStatus, TripStatus } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface TripRequestInfo {
  tripRequestId: number;
  passengerId: number;
  municipalityId: number;
  pickupAddress: string;
  dropoffAddress: string;
  pickupLat: number;
  pickupLng: number;
  fare: number;
  status: string;
}

export interface PassengerData {
  name: string;
  phone: string;
  pickupAddress: string;
}

export interface AssignedDriverRow {
  name: string;
  phone: string;
  plate: string;
  model: string | null;
  lat: number | null;
  lng: number | null;
}

export interface PendingOffer {
  assignmentId: number;
  tripRequestId: number;
  expiresAt: Date;
  pickupAddress: string;
  dropoffAddress: string;
  pickupLat: number;
  pickupLng: number;
  fare: number;
}

export interface CreateAssignmentData {
  tripRequestId: number;
  driverId: number;
  vehicleId: number;
  companyId: number;
  attemptOrder: number;
  expiresAt: Date;
}

@Injectable()
export class AssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveActiveCompany(municipalityId: number): Promise<number | null> {
    const company = await this.prisma.company.findFirst({
      where: { municipalityId, status: 'active' },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
    });
    return company?.companyId ?? null;
  }

  async getTripRequestInfo(tripRequestId: number): Promise<TripRequestInfo | null> {
    const t = await this.prisma.tripRequest.findUnique({
      where: { tripRequestId },
      select: {
        tripRequestId: true,
        passengerId: true,
        municipalityId: true,
        pickupAddress: true,
        dropoffAddress: true,
        pickupLat: true,
        pickupLng: true,
        fare: true,
        status: true,
      },
    });
    if (!t) return null;
    return { ...t, fare: Number(t.fare) };
  }

  async getPassengerData(tripRequestId: number): Promise<PassengerData | null> {
    const t = await this.prisma.tripRequest.findUnique({
      where: { tripRequestId },
      select: {
        pickupAddress: true,
        passenger: {
          select: { user: { select: { firstName: true, lastName: true, phone: true } } },
        },
      },
    });
    if (!t) return null;
    const u = t.passenger.user;
    return {
      name: `${u.firstName} ${u.lastName}`.trim(),
      phone: u.phone,
      pickupAddress: t.pickupAddress,
    };
  }

  async createNotifiedAssignment(
    tx: Prisma.TransactionClient,
    data: CreateAssignmentData,
  ): Promise<Assignment> {
    return tx.assignment.create({
      data: {
        tripRequestId: data.tripRequestId,
        driverId: data.driverId,
        vehicleId: data.vehicleId,
        companyId: data.companyId,
        status: 'notified',
        assignedBy: 'system',
        attemptOrder: data.attemptOrder,
        notifiedAt: new Date(),
        expiresAt: data.expiresAt,
      },
    });
  }

  async getAssignment(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
  ): Promise<Assignment | null> {
    return tx.assignment.findFirst({
      where: { assignmentId, companyId },
    });
  }

  async getAssignmentForDriver(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    driverId: number,
    companyId: number,
    statuses: readonly AssignmentStatus[],
  ): Promise<{ assignmentId: number } | null> {
    const a = await tx.assignment.findFirst({
      where: {
        tripRequestId,
        driverId,
        companyId,
        status: { in: [...statuses] },
      },
      orderBy: { assignmentId: 'desc' },
      select: { assignmentId: true },
    });
    return a ? { assignmentId: a.assignmentId } : null;
  }

  async getAssignedDriver(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    companyId: number,
  ): Promise<AssignedDriverRow | null> {
    const a = await tx.assignment.findFirst({
      where: { tripRequestId, companyId, status: { in: ['accepted', 'completed'] } },
      select: {
        driver: {
          select: {
            currentLat: true,
            currentLng: true,
            user: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
        vehicle: { select: { plate: true, model: true } },
      },
    });
    if (!a) return null;
    const u = a.driver.user;
    return {
      name: `${u.firstName} ${u.lastName}`.trim(),
      phone: u.phone,
      plate: a.vehicle.plate,
      model: a.vehicle.model,
      lat: a.driver.currentLat,
      lng: a.driver.currentLng,
    };
  }

  async getPendingOffers(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<PendingOffer[]> {
    const rows = await tx.assignment.findMany({
      where: {
        driverId,
        companyId,
        status: { in: ['created', 'notified'] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { assignedAt: 'desc' },
      select: {
        assignmentId: true,
        tripRequestId: true,
        expiresAt: true,
        tripRequest: {
          select: {
            pickupAddress: true,
            dropoffAddress: true,
            pickupLat: true,
            pickupLng: true,
            fare: true,
          },
        },
      },
    });
    return rows
      .filter((r): r is typeof r & { expiresAt: Date } => r.expiresAt !== null)
      .map((r) => ({
        assignmentId: r.assignmentId,
        tripRequestId: r.tripRequestId,
        expiresAt: r.expiresAt,
        pickupAddress: r.tripRequest.pickupAddress,
        dropoffAddress: r.tripRequest.dropoffAddress,
        pickupLat: r.tripRequest.pickupLat,
        pickupLng: r.tripRequest.pickupLng,
        fare: Number(r.tripRequest.fare),
      }));
  }

  async getDriverLocation(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<{ lat: number | null; lng: number | null } | null> {
    const d = await tx.driver.findFirst({
      where: { driverId, companyId },
      select: { currentLat: true, currentLng: true },
    });
    if (!d) return null;
    return { lat: d.currentLat, lng: d.currentLng };
  }

  async takeDriver(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ driver_id: number }>>`
      UPDATE fleet.driver
         SET status = 'on_trip', updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId}
         AND status = 'available'
         AND company_id = ${companyId}
      RETURNING driver_id
    `;
    return rows.length === 1;
  }

  async releaseDriver(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE fleet.driver
         SET status = 'available', updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId}
         AND status = 'on_trip'
         AND company_id = ${companyId}
    `;
  }

  async markAssignmentAccepted(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ assignment_id: number }>>`
      UPDATE assignment.assignment
         SET status = 'accepted', responded_at = (now() AT TIME ZONE 'UTC')
       WHERE assignment_id = ${assignmentId}
         AND company_id = ${companyId}
         AND status = 'notified'
      RETURNING assignment_id
    `;
    return rows.length === 1;
  }

  async markTripRequestAssigned(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ trip_request_id: number }>>`
      UPDATE trips.trip_request
         SET status = 'assigned',
             assigned_at = (now() AT TIME ZONE 'UTC'),
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'pending_assignment'
      RETURNING trip_request_id
    `;
    return rows.length === 1;
  }

  async markTimeout(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
  ): Promise<{ assignmentId: number; driverId: number } | null> {
    const rows = await tx.$queryRaw<Array<{ assignment_id: number; driver_id: number }>>`
      UPDATE assignment.assignment
         SET status = 'timeout', responded_at = (now() AT TIME ZONE 'UTC')
       WHERE assignment_id = ${assignmentId}
         AND company_id = ${companyId}
         AND status = 'notified'
      RETURNING assignment_id, driver_id
    `;
    const row = rows[0];
    if (!row) return null;
    return { assignmentId: row.assignment_id, driverId: row.driver_id };
  }

  async markRejected(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
    reason: string | null,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ assignment_id: number }>>`
      UPDATE assignment.assignment
         SET status = 'rejected', responded_at = (now() AT TIME ZONE 'UTC'), cancellation_reason = ${reason}
       WHERE assignment_id = ${assignmentId}
         AND company_id = ${companyId}
         AND status = 'notified'
      RETURNING assignment_id
    `;
    return rows.length === 1;
  }

  async markCancelledByDriver(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
    reason: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ assignment_id: number }>>`
      UPDATE assignment.assignment
         SET status = 'cancelled', responded_at = (now() AT TIME ZONE 'UTC'), cancellation_reason = ${reason}
       WHERE assignment_id = ${assignmentId}
         AND company_id = ${companyId}
         AND status = 'accepted'
      RETURNING assignment_id
    `;
    return rows.length === 1;
  }

  async reopenTripRequest(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ trip_request_id: number }>>`
      UPDATE trips.trip_request
         SET status = 'pending_assignment', arrived_at = NULL, updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'assigned'
      RETURNING trip_request_id
    `;
    return rows.length === 1;
  }

  async closeTripRequest(
    tx: Prisma.TransactionClient,
    params: CloseTripRequestParams,
  ): Promise<TripClosingRow | null> {
    const graceMin = params.noShowGraceMin ?? 0;
    const rows = await tx.$queryRaw<
      Array<{
        status: TripStatus;
        arrived_at: Date | null;
        finished_at: Date | null;
        net_earnings: number | null;
        cash_collected_at: Date | null;
        penalty_recorded: boolean;
      }>
    >`
      UPDATE trips.trip_request
         SET status = ${params.to}::trips."TripStatus",
             finished_at = (now() AT TIME ZONE 'UTC'),
             updated_at = (now() AT TIME ZONE 'UTC'),
             net_earnings = CASE WHEN ${params.to} = 'completed' THEN fare - commission ELSE net_earnings END,
             cash_collected_at = CASE WHEN ${params.cashCollected} THEN (now() AT TIME ZONE 'UTC') ELSE cash_collected_at END,
             penalty_recorded = penalty_recorded OR ${params.penaltyRecorded}
       WHERE trip_request_id = ${params.tripRequestId}
         AND status = ANY(${[...params.from]}::trips."TripStatus"[])
         AND (
           ${params.to} <> 'no_show'
           OR (
             arrived_at IS NOT NULL
             AND (arrived_at AT TIME ZONE 'UTC') <= now() - (${graceMin} * interval '1 minute')
           )
         )
      RETURNING
        status,
        arrived_at,
        finished_at,
        net_earnings::float8 AS net_earnings,
        cash_collected_at,
        penalty_recorded
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      arrivedAt: row.arrived_at,
      finishedAt: row.finished_at,
      netEarnings: row.net_earnings,
      cashCollectedAt: row.cash_collected_at,
      penaltyRecorded: row.penalty_recorded,
    };
  }

  async getTripClosingSnapshot(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<TripClosingRow | null> {
    const t = await tx.tripRequest.findUnique({
      where: { tripRequestId },
      select: {
        status: true,
        arrivedAt: true,
        finishedAt: true,
        netEarnings: true,
        cashCollectedAt: true,
        penaltyRecorded: true,
      },
    });
    if (!t) return null;
    return {
      status: t.status,
      arrivedAt: t.arrivedAt,
      finishedAt: t.finishedAt,
      netEarnings: t.netEarnings === null ? null : Number(t.netEarnings),
      cashCollectedAt: t.cashCollectedAt,
      penaltyRecorded: t.penaltyRecorded,
    };
  }

  async closeAssignmentsForTrip(
    tx: Prisma.TransactionClient,
    params: {
      tripRequestId: number;
      companyId: number;
      status: 'completed' | 'cancelled';
      reason: string | null;
      driverId?: number;
    },
  ): Promise<ClosedAssignmentRow | null> {
    const driverId = params.driverId ?? null;
    const rows = await tx.$queryRaw<Array<{ assignment_id: number; driver_id: number }>>`
      UPDATE assignment.assignment
         SET status = ${params.status}::assignment."AssignmentStatus",
             responded_at = (now() AT TIME ZONE 'UTC'),
             cancellation_reason = ${params.reason}
       WHERE trip_request_id = ${params.tripRequestId}
         AND company_id = ${params.companyId}
         AND status IN ('notified', 'accepted')
         AND (${driverId}::int IS NULL OR driver_id = ${driverId}::int)
      RETURNING assignment_id, driver_id
    `;
    const row = rows[0];
    if (!row) return null;
    return { assignmentId: row.assignment_id, driverId: row.driver_id };
  }

  async getNoShowRemainingSeconds(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    graceMin: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ remaining_seconds: number | null }>>`
      SELECT GREATEST(
               0,
               CEIL(
                 EXTRACT(
                   EPOCH FROM (
                     (arrived_at AT TIME ZONE 'UTC') + (${graceMin} * interval '1 minute') - now()
                   )
                 )
               )
             )::int AS remaining_seconds
        FROM trips.trip_request
       WHERE trip_request_id = ${tripRequestId}
    `;
    return rows[0]?.remaining_seconds ?? 0;
  }
}

export interface CloseTripRequestParams {
  tripRequestId: number;
  to: TripStatus;
  from: readonly TripStatus[];
  cashCollected: boolean;
  penaltyRecorded: boolean;
  noShowGraceMin?: number;
}

export interface TripClosingRow {
  status: TripStatus;
  arrivedAt: Date | null;
  finishedAt: Date | null;
  netEarnings: number | null;
  cashCollectedAt: Date | null;
  penaltyRecorded: boolean;
}

export interface ClosedAssignmentRow {
  assignmentId: number;
  driverId: number;
}
