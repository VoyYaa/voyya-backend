import { Injectable } from '@nestjs/common';
import type { Assignment, Prisma } from '@prisma/client';
import type { AssignmentStatus, ServiceType, TripStatus } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { requireTripLocation } from '../../shared/require-trip-location';

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
  serviceType: ServiceType;
  requestedCompanyId: number | null;
  companyId: number | null;
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

export interface TripTake {
  tripRequestId: number;
  assignmentId: number;
  driverId: number;
  companyId: number;
}

export interface LockedTrip {
  companyId: number | null;
  status: TripStatus;
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
        serviceType: true,
        requestedCompanyId: true,
        companyId: true,
      },
    });
    if (!t) return null;
    return {
      ...t,
      pickupAddress: requireTripLocation(t.pickupAddress),
      dropoffAddress: requireTripLocation(t.dropoffAddress),
      pickupLat: requireTripLocation(t.pickupLat),
      pickupLng: requireTripLocation(t.pickupLng),
      fare: Number(t.fare),
    };
  }

  async getPassengerData(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<PassengerData | null> {
    const t = await tx.tripRequest.findUnique({
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
      pickupAddress: requireTripLocation(t.pickupAddress),
    };
  }

  async createOfferIfDriverFree(
    tx: Prisma.TransactionClient,
    data: CreateAssignmentData,
  ): Promise<Assignment | null> {
    const locked = await tx.$queryRaw<Array<{ driver_id: number }>>`
      SELECT driver_id FROM fleet.driver
       WHERE driver_id = ${data.driverId}
         AND company_id = ${data.companyId}
         AND status = 'available'
       FOR UPDATE
    `;
    if (locked.length === 0) return null;

    const live = await tx.$queryRaw<Array<{ has_live_offer: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM assignment.assignment o
         WHERE o.driver_id = ${data.driverId}
           AND o.status IN ('created', 'notified')
           AND o.expires_at > (now() AT TIME ZONE 'UTC')
      ) AS has_live_offer
    `;
    if (live[0]?.has_live_offer !== false) return null;

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
    const rows = await tx.$queryRaw<
      Array<{
        assignment_id: number;
        trip_request_id: number;
        expires_at: Date;
        pickup_address: string | null;
        dropoff_address: string | null;
        pickup_lat: number | null;
        pickup_lng: number | null;
        fare: number;
      }>
    >`
      SELECT a.assignment_id, a.trip_request_id, a.expires_at,
             t.pickup_address, t.dropoff_address, t.pickup_lat, t.pickup_lng,
             t.fare::float8 AS fare
        FROM assignment.assignment a
        JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
       WHERE a.driver_id = ${driverId}
         AND a.company_id = ${companyId}
         AND a.status IN ('created', 'notified')
         AND a.expires_at > (now() AT TIME ZONE 'UTC')
         AND t.status = 'pending_assignment'
       ORDER BY a.assigned_at DESC
    `;
    return rows.map((r) => ({
      assignmentId: r.assignment_id,
      tripRequestId: r.trip_request_id,
      expiresAt: r.expires_at,
      pickupAddress: requireTripLocation(r.pickup_address),
      dropoffAddress: requireTripLocation(r.dropoff_address),
      pickupLat: requireTripLocation(r.pickup_lat),
      pickupLng: requireTripLocation(r.pickup_lng),
      fare: r.fare,
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
         SET status = CASE WHEN current_lat IS NULL OR current_lng IS NULL
                           THEN 'off_shift'::fleet."DriverStatus"
                           ELSE 'available'::fleet."DriverStatus" END,
             updated_at = (now() AT TIME ZONE 'UTC')
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
    take: TripTake,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ trip_request_id: number }>>`
      UPDATE trips.trip_request t
         SET status = 'assigned',
             assigned_at = (now() AT TIME ZONE 'UTC'),
             updated_at = (now() AT TIME ZONE 'UTC'),
             company_id = ${take.companyId},
             commission_pct = k.commission_pct,
             commission = round(t.fare * k.commission_pct / 100)
        FROM tenancy.company_commission k
       WHERE t.trip_request_id = ${take.tripRequestId}
         AND t.status = 'pending_assignment'
         AND (t.requested_company_id IS NULL OR t.requested_company_id = ${take.companyId})
         AND k.company_id = ${take.companyId}
         AND k.valid_to IS NULL
         AND EXISTS (
           SELECT 1 FROM tenancy.company c
            WHERE c.company_id = ${take.companyId} AND c.status = 'active'
         )
         AND EXISTS (
           SELECT 1 FROM assignment.assignment a
            WHERE a.assignment_id = ${take.assignmentId}
              AND a.trip_request_id = t.trip_request_id
              AND a.driver_id = ${take.driverId}
              AND a.company_id = ${take.companyId}
              AND a.status = 'notified'
              AND a.expires_at > (now() AT TIME ZONE 'UTC')
         )
      RETURNING t.trip_request_id
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

  async cancelOffer(
    tx: Prisma.TransactionClient,
    assignmentId: number,
    companyId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ assignment_id: number }>>`
      UPDATE assignment.assignment
         SET status = 'cancelled', responded_at = (now() AT TIME ZONE 'UTC')
       WHERE assignment_id = ${assignmentId}
         AND company_id = ${companyId}
         AND status = 'notified'
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
         SET status = 'pending_assignment',
             arrived_at = NULL,
             company_id = NULL,
             commission = 0,
             commission_pct = NULL,
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'assigned'
      RETURNING trip_request_id
    `;
    return rows.length === 1;
  }

  async lockTripForPassenger(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    passengerId: number,
  ): Promise<LockedTrip | null> {
    const rows = await tx.$queryRaw<Array<{ company_id: number | null; status: TripStatus }>>`
      SELECT company_id, status
        FROM trips.trip_request
       WHERE trip_request_id = ${tripRequestId}
         AND passenger_id = ${passengerId}
       FOR UPDATE
    `;
    const row = rows[0];
    return row ? { companyId: row.company_id, status: row.status } : null;
  }

  async closeTripRequest(
    tx: Prisma.TransactionClient,
    params: CloseTripRequestParams,
  ): Promise<TripClosingRow | null> {
    const graceMin = params.noShowGraceMin ?? 0;
    const unownedOnly = params.unownedOnly === true;
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
         AND (NOT ${unownedOnly} OR company_id IS NULL)
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
  unownedOnly?: boolean;
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
