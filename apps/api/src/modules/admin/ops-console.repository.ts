import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ACTIVE_TRIP_STATUSES, type DriverStatus, type TripStatus } from '@voyyaa/shared';

export interface OpsAssignedDriverRow {
  driverId: number;
  name: string;
  plate: string;
}

export interface OpsQueueDbRow {
  tripRequestId: number;
  status: TripStatus;
  requestedAt: Date;
  statusSince: Date;
  passengerName: string;
  pickupAddress: string;
  dropoffAddress: string;
  fareTotal: number;
  driver: OpsAssignedDriverRow | null;
}

export interface OpsTripDetailRow {
  tripRequestId: number;
  status: TripStatus;
  statusSince: Date;
  pickupAddress: string;
  dropoffAddress: string;
  fareTotal: number;
  commission: number;
  passengerName: string;
  passengerPhone: string | null;
  driver: OpsAssignedDriverRow | null;
  requestedAt: Date;
  assignedAt: Date | null;
  arrivedAt: Date | null;
  finishedAt: Date | null;
  cashCollectedAt: Date | null;
}

export interface OpsDriverVehicleRow {
  vehicleId: number;
  plate: string;
  model: string | null;
}

export interface OpsDriverDbRow {
  driverId: number;
  firstName: string;
  lastName: string;
  nationalId: string;
  phone: string;
  status: DriverStatus;
  vehicle: OpsDriverVehicleRow | null;
  locationUpdatedAt: Date | null;
  pinDeliveredAt: Date | null;
  createdAt: Date;
}

export interface OpsDriverDetailDbRow extends OpsDriverDbRow {
  license: string | null;
  activeTripRequestId: number | null;
}

@Injectable()
export class OpsConsoleRepository {
  async listTripRequests(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    statuses: readonly TripStatus[] | null,
    limit: number,
    terminalWindowSec: number,
  ): Promise<OpsQueueDbRow[]> {
    const cutoff = new Date(Date.now() - terminalWindowSec * 1000);
    const rows = await tx.tripRequest.findMany({
      where: {
        municipalityId,
        AND: [
          {
            OR: [
              { status: { in: [...ACTIVE_TRIP_STATUSES] } },
              {
                AND: [
                  { status: { notIn: [...ACTIVE_TRIP_STATUSES] } },
                  { updatedAt: { gt: cutoff } },
                ],
              },
            ],
          },
          ...(statuses ? [{ status: { in: [...statuses] } }] : []),
        ],
      },
      orderBy: { requestedAt: 'asc' },
      take: limit,
      select: {
        tripRequestId: true,
        status: true,
        requestedAt: true,
        updatedAt: true,
        pickupAddress: true,
        dropoffAddress: true,
        fare: true,
        passenger: { select: { user: { select: { firstName: true, lastName: true } } } },
        assignments: {
          where: { status: 'accepted' },
          take: 1,
          select: {
            driver: {
              select: { driverId: true, user: { select: { firstName: true, lastName: true } } },
            },
            vehicle: { select: { plate: true } },
          },
        },
      },
    });

    return rows.map((r) => ({
      tripRequestId: r.tripRequestId,
      status: r.status,
      requestedAt: r.requestedAt,
      statusSince: r.updatedAt,
      passengerName: fullName(r.passenger.user.firstName, r.passenger.user.lastName),
      pickupAddress: r.pickupAddress,
      dropoffAddress: r.dropoffAddress,
      fareTotal: Number(r.fare),
      driver: toAssignedDriver(r.assignments[0]),
    }));
  }

  async getTripRequest(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    tripRequestId: number,
  ): Promise<OpsTripDetailRow | null> {
    const t = await tx.tripRequest.findFirst({
      where: { tripRequestId, municipalityId },
      select: {
        tripRequestId: true,
        status: true,
        updatedAt: true,
        requestedAt: true,
        assignedAt: true,
        arrivedAt: true,
        finishedAt: true,
        pickupAddress: true,
        dropoffAddress: true,
        fare: true,
        commission: true,
        cashCollectedAt: true,
        passenger: {
          select: { user: { select: { firstName: true, lastName: true, phone: true } } },
        },
        assignments: {
          where: { status: { in: ['accepted', 'completed'] } },
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: {
            driver: {
              select: { driverId: true, user: { select: { firstName: true, lastName: true } } },
            },
            vehicle: { select: { plate: true } },
          },
        },
      },
    });
    if (!t) return null;
    const passenger = t.passenger.user;
    return {
      tripRequestId: t.tripRequestId,
      status: t.status,
      statusSince: t.updatedAt,
      pickupAddress: t.pickupAddress,
      dropoffAddress: t.dropoffAddress,
      fareTotal: Number(t.fare),
      commission: Number(t.commission),
      passengerName: fullName(passenger.firstName, passenger.lastName),
      passengerPhone: passenger.phone,
      driver: toAssignedDriver(t.assignments[0]),
      requestedAt: t.requestedAt,
      assignedAt: t.assignedAt,
      arrivedAt: t.arrivedAt,
      finishedAt: t.finishedAt,
      cashCollectedAt: t.cashCollectedAt,
    };
  }

  async listDrivers(
    tx: Prisma.TransactionClient,
    companyId: number,
    search: string | null,
    status: DriverStatus | null,
    limit: number,
  ): Promise<OpsDriverDbRow[]> {
    const rows = await tx.driver.findMany({
      where: {
        companyId,
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { nationalId: { contains: search, mode: 'insensitive' } },
                { user: { firstName: { contains: search, mode: 'insensitive' } } },
                { user: { lastName: { contains: search, mode: 'insensitive' } } },
                { currentVehicle: { plate: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: driverSelect,
    });
    return rows.map(toDriverRow);
  }

  async getDriver(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverId: number,
  ): Promise<OpsDriverDetailDbRow | null> {
    const d = await tx.driver.findFirst({
      where: { driverId, companyId },
      select: {
        ...driverSelect,
        license: true,
        assignments: {
          where: { status: 'accepted' },
          take: 1,
          select: { tripRequestId: true },
        },
      },
    });
    if (!d) return null;
    return {
      ...toDriverRow(d),
      license: d.license,
      activeTripRequestId: d.assignments[0]?.tripRequestId ?? null,
    };
  }
}

const driverSelect = {
  driverId: true,
  nationalId: true,
  status: true,
  locationUpdatedAt: true,
  pinDeliveredAt: true,
  createdAt: true,
  user: { select: { firstName: true, lastName: true, phone: true } },
  currentVehicle: { select: { vehicleId: true, plate: true, model: true } },
} as const;

interface DriverSelectResult {
  driverId: number;
  nationalId: string;
  status: DriverStatus;
  locationUpdatedAt: Date | null;
  pinDeliveredAt: Date | null;
  createdAt: Date;
  user: { firstName: string; lastName: string; phone: string };
  currentVehicle: { vehicleId: number; plate: string; model: string | null } | null;
}

function toDriverRow(d: DriverSelectResult): OpsDriverDbRow {
  return {
    driverId: d.driverId,
    firstName: d.user.firstName,
    lastName: d.user.lastName,
    nationalId: d.nationalId,
    phone: d.user.phone,
    status: d.status,
    vehicle: d.currentVehicle
      ? { vehicleId: d.currentVehicle.vehicleId, plate: d.currentVehicle.plate, model: d.currentVehicle.model }
      : null,
    locationUpdatedAt: d.locationUpdatedAt,
    pinDeliveredAt: d.pinDeliveredAt,
    createdAt: d.createdAt,
  };
}

function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

interface AssignedDriverJoin {
  driver: { driverId: number; user: { firstName: string; lastName: string } };
  vehicle: { plate: string };
}

function toAssignedDriver(row: AssignedDriverJoin | undefined): OpsAssignedDriverRow | null {
  if (!row) return null;
  return {
    driverId: row.driver.driverId,
    name: fullName(row.driver.user.firstName, row.driver.user.lastName),
    plate: row.vehicle.plate,
  };
}
