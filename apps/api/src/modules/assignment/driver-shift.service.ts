import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  DriverHomeState,
  DriverShiftState,
  DriverTripView,
  PendingCashTripsResponse,
  ReportDriverLocationDTO,
  UpdateDriverShiftDTO,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DriverRepository, type DriverShiftRow } from './driver.repository';
import { OperationalParamsService } from './operational-params.service';

@Injectable()
export class DriverShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DriverRepository,
    private readonly params: OperationalParamsService,
  ) {}

  async updateShift(
    driverId: number,
    companyId: number,
    dto: UpdateDriverShiftDTO,
  ): Promise<DriverShiftState> {
    if (dto.on_shift) {
      return this.startShift(driverId, companyId, dto.location.lat, dto.location.lng);
    }
    return this.endShift(driverId, companyId);
  }

  async reportLocation(
    driverId: number,
    companyId: number,
    dto: ReportDriverLocationDTO,
  ): Promise<void> {
    const ok = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.reportLocation(tx, driverId, companyId, dto.lat, dto.lng),
    );
    if (!ok) {
      throw new ConflictException({ code: 'NOT_ON_SHIFT', message: 'No estás en turno' });
    }
  }

  async getHome(driverId: number, companyId: number): Promise<DriverHomeState> {
    const { shift, activeTrip } = await this.prisma.runInTenant(companyId, async (tx) => ({
      shift: await this.repo.getShiftRow(tx, driverId, companyId),
      activeTrip: await this.repo.getActiveTrip(tx, driverId, companyId),
    }));
    if (!shift) {
      throw new NotFoundException({ code: 'DRIVER_NOT_ELIGIBLE', message: 'Conductor no encontrado' });
    }

    let activeTripView: DriverTripView | null = null;
    if (activeTrip) {
      const graceMin = await this.noShowGraceMinFor(companyId);
      activeTripView = {
        trip_request_id: activeTrip.tripRequestId,
        assignment_id: activeTrip.assignmentId,
        status: activeTrip.status,
        passenger: { name: activeTrip.passengerName, contact_phone: activeTrip.passengerPhone },
        pickup_address: activeTrip.pickupAddress,
        dropoff_address: activeTrip.dropoffAddress,
        fare: flatFareBreakdown(activeTrip.fare, activeTrip.commission),
        arrived_at: activeTrip.arrivedAt ? activeTrip.arrivedAt.toISOString() : null,
        no_show_available_at: noShowAvailableAt(activeTrip.arrivedAt, graceMin),
        cash_collected_at: activeTrip.cashCollectedAt ? activeTrip.cashCollectedAt.toISOString() : null,
      };
    }

    return { shift: toShiftState(shift), active_trip: activeTripView };
  }

  async listPendingCashTrips(
    driverId: number,
    companyId: number,
  ): Promise<PendingCashTripsResponse> {
    const rows = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.listPendingCashTrips(tx, driverId, companyId),
    );
    return rows.map((r) => ({
      trip_request_id: r.tripRequestId,
      finished_at: r.finishedAt.toISOString(),
      fare: r.fare,
      dropoff_address: r.dropoffAddress,
    }));
  }

  private async startShift(
    driverId: number,
    companyId: number,
    lat: number,
    lng: number,
  ): Promise<DriverShiftState> {
    const row = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.startShift(tx, driverId, companyId, lat, lng),
    );
    if (row) return toShiftState(row);

    const current = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.getShiftRow(tx, driverId, companyId),
    );
    if (!current) {
      throw new NotFoundException({ code: 'DRIVER_NOT_ELIGIBLE', message: 'Conductor no encontrado' });
    }
    if (current.currentVehicleId === null) {
      throw new ConflictException({
        code: 'NO_VEHICLE_LINKED',
        message: 'No tienes un vehículo vinculado, contacta al administrador',
      });
    }
    if (current.status === 'on_trip') {
      const refreshed = await this.prisma.runInTenant(companyId, (tx) =>
        this.repo.refreshLocationWhileOnTrip(tx, driverId, companyId, lat, lng),
      );
      return toShiftState(refreshed ?? current);
    }
    throw new ConflictException({
      code: 'DRIVER_NOT_ELIGIBLE',
      message: 'Tu cuenta no puede activar turno en este momento',
    });
  }

  private async endShift(driverId: number, companyId: number): Promise<DriverShiftState> {
    const row = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.endShift(tx, driverId, companyId),
    );
    if (row) return toShiftState(row);

    const current = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.getShiftRow(tx, driverId, companyId),
    );
    if (!current) {
      throw new NotFoundException({ code: 'DRIVER_NOT_ELIGIBLE', message: 'Conductor no encontrado' });
    }
    if (current.status === 'on_trip') {
      throw new ConflictException({
        code: 'ACTIVE_TRIP_IN_PROGRESS',
        message: 'No puedes salir de turno con un viaje en curso; finalízalo o cancélalo primero',
      });
    }
    return toShiftState(current);
  }

  private async noShowGraceMinFor(companyId: number): Promise<number> {
    const municipalityId = await this.repo.getCompanyMunicipality(companyId);
    if (municipalityId === null) return 0;
    return (await this.params.get(municipalityId)).noShowGraceMin;
  }
}

function toShiftState(row: DriverShiftRow): DriverShiftState {
  return {
    status: row.status,
    on_shift: row.status === 'available' || row.status === 'on_trip',
    vehicle_linked: row.currentVehicleId !== null,
    location_updated_at: row.locationUpdatedAt ? row.locationUpdatedAt.toISOString() : null,
  };
}

function flatFareBreakdown(total: number, commission: number): DriverTripView['fare'] {
  return {
    base_fare: total,
    night_surcharge: 0,
    holiday_surcharge: 0,
    total,
    commission,
    currency: 'COP',
  };
}

function noShowAvailableAt(arrivedAt: Date | null, graceMin: number): string | null {
  if (arrivedAt === null) return null;
  return new Date(arrivedAt.getTime() + graceMin * 60_000).toISOString();
}
