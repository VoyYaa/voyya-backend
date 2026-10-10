import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DriverStatus, ServiceType, TripStatus } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { requireTripLocation } from '../../shared/require-trip-location';

export interface DriverShiftRow {
  status: DriverStatus;
  currentVehicleId: number | null;
  locationUpdatedAt: Date | null;
}

export interface ActiveTripRow {
  tripRequestId: number;
  assignmentId: number;
  status: TripStatus;
  municipalityId: number;
  serviceType: ServiceType;
  pickupAddress: string;
  dropoffAddress: string;
  fare: number;
  commission: number;
  arrivedAt: Date | null;
  cashCollectedAt: Date | null;
  startCodeExempt: boolean;
  startCodeFailedAttempts: number;
  startCodeBlockedAt: Date | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  passengerName: string;
  passengerPhone: string | null;
}

export interface TripTrackingRow {
  windowAgeSec: number;
  lat: number | null;
  lng: number | null;
  ageSec: number | null;
}

export interface TrackingSnapshotParams {
  tripRequestId: number;
  companyId: number;
  driverId: number | null;
  hideSec: number;
}

export interface PendingCashTripRow {
  tripRequestId: number;
  finishedAt: Date;
  fare: number;
  dropoffAddress: string | null;
}

type RawShiftRow = {
  status: DriverStatus;
  current_vehicle_id: number | null;
  location_updated_at: Date | null;
};

function toShiftRow(row: RawShiftRow): DriverShiftRow {
  return {
    status: row.status,
    currentVehicleId: row.current_vehicle_id,
    locationUpdatedAt: row.location_updated_at,
  };
}

@Injectable()
export class DriverRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listCompanyIds(): Promise<number[]> {
    const companies = await this.prisma.company.findMany({ select: { companyId: true } });
    return companies.map((c) => c.companyId);
  }

  async purgeStaleLocations(
    tx: Prisma.TransactionClient,
    companyId: number,
    purgeHours: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ driver_id: number }>>`
      UPDATE fleet.driver
         SET current_lat = NULL,
             current_lng = NULL,
             location_updated_at = NULL,
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE company_id = ${companyId}
         AND (current_lat IS NOT NULL OR current_lng IS NOT NULL OR location_updated_at IS NOT NULL)
         AND ( status = 'off_shift'
            OR location_updated_at IS NULL
            OR location_updated_at < (now() AT TIME ZONE 'UTC') - (${purgeHours} * interval '1 hour') )
      RETURNING driver_id
    `;
    return rows.length;
  }

  async clearLocationAfterConsentRevoked(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE fleet.driver
         SET current_lat = NULL,
             current_lng = NULL,
             location_updated_at = NULL,
             status = CASE WHEN status = 'available'
                           THEN 'off_shift'::fleet."DriverStatus"
                           ELSE status END,
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
    `;
  }

  async getShiftRow(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<DriverShiftRow | null> {
    const d = await tx.driver.findFirst({
      where: { driverId, companyId },
      select: { status: true, currentVehicleId: true, locationUpdatedAt: true },
    });
    return d ?? null;
  }

  async startShift(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    lat: number,
    lng: number,
  ): Promise<DriverShiftRow | null> {
    const rows = await tx.$queryRaw<RawShiftRow[]>`
      UPDATE fleet.driver
         SET status = 'available', current_lat = ${lat}, current_lng = ${lng},
             location_updated_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
         AND status IN ('off_shift', 'available')
         AND current_vehicle_id IS NOT NULL
      RETURNING status, current_vehicle_id, location_updated_at
    `;
    const row = rows[0];
    return row ? toShiftRow(row) : null;
  }

  async refreshLocationWhileOnTrip(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    lat: number,
    lng: number,
  ): Promise<DriverShiftRow | null> {
    const rows = await tx.$queryRaw<RawShiftRow[]>`
      UPDATE fleet.driver
         SET current_lat = ${lat}, current_lng = ${lng},
             location_updated_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId} AND status = 'on_trip'
      RETURNING status, current_vehicle_id, location_updated_at
    `;
    const row = rows[0];
    return row ? toShiftRow(row) : null;
  }

  async endShift(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<DriverShiftRow | null> {
    const rows = await tx.$queryRaw<RawShiftRow[]>`
      UPDATE fleet.driver
         SET status = 'off_shift', current_lat = NULL, current_lng = NULL,
             location_updated_at = NULL, updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
         AND status IN ('off_shift', 'available')
      RETURNING status, current_vehicle_id, location_updated_at
    `;
    const row = rows[0];
    return row ? toShiftRow(row) : null;
  }

  async reportLocation(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    lat: number,
    lng: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ driver_id: number }>>`
      UPDATE fleet.driver
         SET current_lat = ${lat}, current_lng = ${lng},
             location_updated_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
         AND status IN ('available', 'on_trip')
      RETURNING driver_id
    `;
    return rows.length === 1;
  }

  async getActiveTrip(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<ActiveTripRow | null> {
    const rows = await tx.$queryRaw<
      Array<{
        trip_request_id: number;
        assignment_id: number;
        status: TripStatus;
        municipality_id: number;
        service_type: ServiceType;
        pickup_address: string | null;
        dropoff_address: string | null;
        fare: number;
        commission: number;
        arrived_at: Date | null;
        cash_collected_at: Date | null;
        start_code_exempt: boolean;
        start_code_failed_attempts: number;
        start_code_blocked_at: Date | null;
        pickup_lat: number | null;
        pickup_lng: number | null;
        dropoff_lat: number | null;
        dropoff_lng: number | null;
        first_name: string;
        last_name: string;
        phone: string | null;
      }>
    >`
      SELECT t.trip_request_id, a.assignment_id, t.status, t.municipality_id, t.service_type,
             t.pickup_address, t.dropoff_address,
             t.fare::float8 AS fare, t.commission::float8 AS commission,
             t.arrived_at, t.cash_collected_at,
             t.start_code_exempt, t.start_code_failed_attempts::int AS start_code_failed_attempts,
             t.start_code_blocked_at,
             t.pickup_lat, t.pickup_lng, t.dropoff_lat, t.dropoff_lng,
             u.first_name, u.last_name, u.phone
        FROM assignment.assignment a
        JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
        JOIN auth."user" u ON u.user_id = t.passenger_id
       WHERE a.driver_id = ${driverId}
         AND a.company_id = ${companyId}
         AND a.status = 'accepted'
       LIMIT 1
    `;
    const t = rows[0];
    if (!t) return null;
    return {
      tripRequestId: t.trip_request_id,
      assignmentId: t.assignment_id,
      status: t.status,
      municipalityId: t.municipality_id,
      serviceType: t.service_type,
      pickupAddress: requireTripLocation(t.pickup_address),
      dropoffAddress: requireTripLocation(t.dropoff_address),
      fare: t.fare,
      commission: t.commission,
      arrivedAt: t.arrived_at,
      cashCollectedAt: t.cash_collected_at,
      startCodeExempt: t.start_code_exempt,
      startCodeFailedAttempts: t.start_code_failed_attempts,
      startCodeBlockedAt: t.start_code_blocked_at,
      pickupLat: t.pickup_lat,
      pickupLng: t.pickup_lng,
      dropoffLat: t.dropoff_lat,
      dropoffLng: t.dropoff_lng,
      passengerName: `${t.first_name} ${t.last_name}`.trim(),
      passengerPhone: t.phone,
    };
  }

  async getWindowTripOfDriver(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ trip_request_id: number }>>`
      SELECT t.trip_request_id
        FROM assignment.assignment a
        JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
       WHERE a.driver_id = ${driverId}
         AND a.company_id = ${companyId}
         AND a.status = 'accepted'
         AND t.status IN ('assigned', 'driver_en_route')
       LIMIT 1
    `;
    return rows[0]?.trip_request_id ?? null;
  }

  async getAcceptedDriverId(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
    companyId: number,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ driver_id: number }>>`
      SELECT driver_id
        FROM assignment.assignment
       WHERE trip_request_id = ${tripRequestId}
         AND company_id = ${companyId}
         AND status = 'accepted'
       LIMIT 1
    `;
    return rows[0]?.driver_id ?? null;
  }

  async getTrackingSnapshot(
    tx: Prisma.TransactionClient,
    params: TrackingSnapshotParams,
  ): Promise<TripTrackingRow | null> {
    const rows = await tx.$queryRaw<
      Array<{ window_age_sec: number; lat: number | null; lng: number | null; age_sec: number | null }>
    >`
      SELECT greatest(0, floor(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - t.assigned_at)))::int) AS window_age_sec,
             p.lat, p.lng, p.age_sec
        FROM trips.trip_request t
        LEFT JOIN LATERAL (
          SELECT d.current_lat AS lat,
                 d.current_lng AS lng,
                 greatest(0, floor(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - d.location_updated_at)))::int) AS age_sec
            FROM assignment.assignment a
            JOIN fleet.driver d ON d.driver_id = a.driver_id AND d.company_id = ${params.companyId}
           WHERE a.trip_request_id = t.trip_request_id
             AND a.company_id = ${params.companyId}
             AND a.status = 'accepted'
             AND a.driver_id = ${params.driverId}::int
             AND d.current_lat IS NOT NULL AND d.current_lng IS NOT NULL
             AND d.location_updated_at >= t.assigned_at
             AND d.location_updated_at > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${params.hideSec}::float8)
        ) p ON true
       WHERE t.trip_request_id = ${params.tripRequestId}
         AND t.company_id = ${params.companyId}
         AND t.status IN ('assigned', 'driver_en_route')
    `;
    const row = rows[0];
    if (!row) return null;
    return { windowAgeSec: row.window_age_sec, lat: row.lat, lng: row.lng, ageSec: row.age_sec };
  }

  async listPendingCashTrips(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<PendingCashTripRow[]> {
    const rows = await tx.assignment.findMany({
      where: {
        driverId,
        companyId,
        status: 'completed',
        tripRequest: { status: 'completed', cashCollectedAt: null },
      },
      orderBy: { assignedAt: 'asc' },
      select: {
        tripRequest: {
          select: { tripRequestId: true, finishedAt: true, fare: true, dropoffAddress: true },
        },
      },
    });
    return rows
      .filter(
        (r): r is typeof r & { tripRequest: { finishedAt: Date } } =>
          r.tripRequest.finishedAt !== null,
      )
      .map((r) => ({
        tripRequestId: r.tripRequest.tripRequestId,
        finishedAt: r.tripRequest.finishedAt,
        fare: Number(r.tripRequest.fare),
        dropoffAddress: r.tripRequest.dropoffAddress,
      }));
  }
}
