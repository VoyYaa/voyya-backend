import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DriverStatus, TripStatus } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface DriverShiftRow {
  status: DriverStatus;
  currentVehicleId: number | null;
  locationUpdatedAt: Date | null;
}

export interface ActiveTripRow {
  tripRequestId: number;
  assignmentId: number;
  status: TripStatus;
  pickupAddress: string;
  dropoffAddress: string;
  fare: number;
  commission: number;
  arrivedAt: Date | null;
  cashCollectedAt: Date | null;
  passengerName: string;
  passengerPhone: string | null;
}

export interface PendingCashTripRow {
  tripRequestId: number;
  finishedAt: Date;
  fare: number;
  dropoffAddress: string;
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

  async getCompanyMunicipality(companyId: number): Promise<number | null> {
    const company = await this.prisma.company.findUnique({
      where: { companyId },
      select: { municipalityId: true },
    });
    return company?.municipalityId ?? null;
  }

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
    const a = await tx.assignment.findFirst({
      where: { driverId, companyId, status: 'accepted' },
      select: {
        assignmentId: true,
        tripRequest: {
          select: {
            tripRequestId: true,
            status: true,
            pickupAddress: true,
            dropoffAddress: true,
            fare: true,
            commission: true,
            arrivedAt: true,
            cashCollectedAt: true,
            passenger: {
              select: { user: { select: { firstName: true, lastName: true, phone: true } } },
            },
          },
        },
      },
    });
    if (!a) return null;
    const t = a.tripRequest;
    const u = t.passenger.user;
    return {
      tripRequestId: t.tripRequestId,
      assignmentId: a.assignmentId,
      status: t.status,
      pickupAddress: t.pickupAddress,
      dropoffAddress: t.dropoffAddress,
      fare: Number(t.fare),
      commission: Number(t.commission),
      arrivedAt: t.arrivedAt,
      cashCollectedAt: t.cashCollectedAt,
      passengerName: `${u.firstName} ${u.lastName}`.trim(),
      passengerPhone: u.phone,
    };
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
