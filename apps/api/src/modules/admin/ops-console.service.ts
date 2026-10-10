import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OPS_QUEUE_FILTER_STATUSES,
  OPS_QUEUE_TERMINAL_WINDOW_SEC,
  type FareBreakdown,
  type OpsDriverDetail,
  type OpsDriverListResponse,
  type OpsDriverQuery,
  type OpsDriverRow,
  type OpsQueueQuery,
  type OpsQueueResponse,
  type OpsTripDetail,
  type TripStatus,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OperationalParamsService } from '../service-config/operational-params.service';
import { CompanyMunicipalityResolver } from './company-municipality.resolver';
import { driverPinStatus } from './driver-pin-status';
import { OpsConsoleRepository, type OpsDriverDbRow } from './ops-console.repository';

@Injectable()
export class OpsConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OpsConsoleRepository,
    private readonly companyMunicipality: CompanyMunicipalityResolver,
    private readonly params: OperationalParamsService,
  ) {}

  async listTripRequests(companyId: number, query: OpsQueueQuery): Promise<OpsQueueResponse> {
    const statuses: readonly TripStatus[] | null =
      query.status === 'all' ? null : OPS_QUEUE_FILTER_STATUSES[query.status];

    const rows = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.listTripRequests(
        tx,
        companyId,
        statuses,
        query.limit,
        OPS_QUEUE_TERMINAL_WINDOW_SEC,
      ),
    );

    return {
      server_time: new Date().toISOString(),
      rows: rows.map((r) => ({
        trip_request_id: r.tripRequestId,
        status: r.status,
        requested_at: r.requestedAt.toISOString(),
        status_since: r.statusSince.toISOString(),
        passenger_name: r.passengerName,
        pickup_address: r.pickupAddress,
        dropoff_address: r.dropoffAddress,
        fare_total: r.fareTotal,
        driver: r.driver
          ? { driver_id: r.driver.driverId, name: r.driver.name, plate: r.driver.plate }
          : null,
        start_failed_attempts: r.startFailedAttempts,
        start_blocked_at: r.startBlockedAt ? r.startBlockedAt.toISOString() : null,
      })),
    };
  }

  async getTripRequest(companyId: number, tripRequestId: number): Promise<OpsTripDetail> {
    const row = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.getTripRequest(tx, companyId, tripRequestId),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'TRIP_REQUEST_NOT_FOUND',
        message: 'La solicitud no existe',
      });
    }

    return {
      server_time: new Date().toISOString(),
      trip_request_id: row.tripRequestId,
      status: row.status,
      status_since: row.statusSince.toISOString(),
      pickup_address: row.pickupAddress,
      dropoff_address: row.dropoffAddress,
      fare: toFareBreakdown(row.fareTotal, row.status === 'completed' ? row.commission : 0),
      passenger_name: row.passengerName,
      passenger_phone_masked: row.passengerPhone ? maskPhone(row.passengerPhone) : null,
      driver: row.driver
        ? { driver_id: row.driver.driverId, name: row.driver.name, plate: row.driver.plate }
        : null,
      timeline: {
        requested_at: row.requestedAt.toISOString(),
        assigned_at: row.assignedAt ? row.assignedAt.toISOString() : null,
        arrived_at: row.arrivedAt ? row.arrivedAt.toISOString() : null,
        finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
        started_at: row.startedAt ? row.startedAt.toISOString() : null,
      },
      cash_collected_at: row.cashCollectedAt ? row.cashCollectedAt.toISOString() : null,
      start_failed_attempts: row.startFailedAttempts,
      start_blocked_at: row.startBlockedAt ? row.startBlockedAt.toISOString() : null,
    };
  }

  private async staleMinutes(companyId: number): Promise<number> {
    const scope = await this.companyMunicipality.resolve(companyId);
    return (await this.params.get(scope.municipalityId, scope.serviceType)).locationStaleMin;
  }

  async listDrivers(companyId: number, query: OpsDriverQuery): Promise<OpsDriverListResponse> {
    const staleMin = await this.staleMinutes(companyId);

    const rows = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.listDrivers(tx, companyId, query.search ?? null, query.status ?? null, query.limit),
    );

    const now = Date.now();
    return {
      server_time: new Date().toISOString(),
      rows: rows.map((r) => toOpsDriverRow(r, staleMin, now)),
    };
  }

  async getDriver(companyId: number, driverId: number): Promise<OpsDriverDetail> {
    const staleMin = await this.staleMinutes(companyId);

    const row = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.getDriver(tx, companyId, driverId),
    );
    if (!row) {
      throw new NotFoundException({ code: 'DRIVER_NOT_FOUND', message: 'El conductor no existe' });
    }

    const now = Date.now();
    return {
      ...toOpsDriverRow(row, staleMin, now),
      server_time: new Date().toISOString(),
      license: row.license,
      active_trip_request_id: row.activeTripRequestId,
    };
  }
}

function toOpsDriverRow(row: OpsDriverDbRow, staleMin: number, now: number): OpsDriverRow {
  return {
    driver_id: row.driverId,
    first_name: row.firstName,
    last_name: row.lastName,
    national_id: row.nationalId,
    phone: row.phone,
    status: row.status,
    vehicle: row.vehicle
      ? { vehicle_id: row.vehicle.vehicleId, plate: row.vehicle.plate, model: row.vehicle.model }
      : null,
    location_updated_at: row.locationUpdatedAt ? row.locationUpdatedAt.toISOString() : null,
    location_stale: isLocationStale(row.locationUpdatedAt, staleMin, now),
    pin_delivered_at: row.pinDeliveredAt ? row.pinDeliveredAt.toISOString() : null,
    pin_status: driverPinStatus(row, now),
    temporary_pin_expires_at:
      row.pinMustChange && row.temporaryPinExpiresAt ? row.temporaryPinExpiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

function isLocationStale(updatedAt: Date | null, staleMin: number, now: number): boolean {
  if (staleMin <= 0) return false;
  if (!updatedAt) return true;
  return now - updatedAt.getTime() >= staleMin * 60_000;
}

function toFareBreakdown(total: number, commission: number): FareBreakdown {
  return {
    base_fare: total,
    night_surcharge: 0,
    holiday_surcharge: 0,
    total,
    commission,
    currency: 'COP',
  };
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  return `***${phone.slice(-4)}`;
}
