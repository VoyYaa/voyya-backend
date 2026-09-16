import { Injectable } from '@nestjs/common';
import type { FareConfig, TripRequest } from '@prisma/client';
import { type TripStatus, ACTIVE_TRIP_STATUSES, type ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export type TripTransitionOutcome<T> =
  | { kind: 'applied'; row: T }
  | { kind: 'idempotent'; row: T }
  | { kind: 'rejected'; status: TripStatus };

export interface CreateTripRequestData {
  passengerId: number;
  municipalityId: number;
  serviceType: ServiceType;
  paymentMethod: 'cash';
  pickupAddress: string;
  dropoffAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  distanceKm: number;
  fareTotal: number;
  commission: number;
}

@Injectable()
export class TripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveFareConfig(
    municipalityId: number,
    serviceType: ServiceType,
  ): Promise<FareConfig | null> {
    const today = new Date();
    return this.prisma.fareConfig.findFirst({
      where: {
        municipalityId,
        serviceType,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: today } }] },
          { OR: [{ validTo: null }, { validTo: { gte: today } }] },
        ],
      },
      orderBy: { validFrom: 'desc' },
    });
  }

  async isPointInCoverage(
    municipalityId: number,
    lng: number,
    lat: number,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ covered: boolean | null }>>`
      SELECT ST_Covers(coverage, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS covered
      FROM tenancy.municipality
      WHERE municipality_id = ${municipalityId}
    `;
    return rows.length > 0 && rows[0]?.covered === true;
  }

  async hasActiveTripRequest(passengerId: number): Promise<boolean> {
    const n = await this.prisma.tripRequest.count({
      where: {
        passengerId,
        status: { in: [...ACTIVE_TRIP_STATUSES] },
      },
    });
    return n > 0;
  }

  async createTripRequest(data: CreateTripRequestData): Promise<TripRequest> {
    return this.prisma.tripRequest.create({
      data: {
        passengerId: data.passengerId,
        municipalityId: data.municipalityId,
        serviceType: data.serviceType,
        paymentMethod: data.paymentMethod,
        pickupAddress: data.pickupAddress,
        dropoffAddress: data.dropoffAddress,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
        dropoffLat: data.dropoffLat,
        dropoffLng: data.dropoffLng,
        distance: data.distanceKm,
        fare: data.fareTotal,
        commission: data.commission,
        status: 'pending_assignment',
      },
    });
  }

  async getTripRequest(tripRequestId: number): Promise<TripRequest | null> {
    return this.prisma.tripRequest.findUnique({ where: { tripRequestId } });
  }

  async updateStatus(tripRequestId: number, status: TripStatus): Promise<void> {
    await this.prisma.tripRequest.update({
      where: { tripRequestId },
      data: { status },
    });
  }

  async markEnRoute(
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ updatedAt: Date }>> {
    const rows = await this.prisma.$queryRaw<Array<{ updated_at: Date }>>`
      UPDATE trips.trip_request
         SET status = 'driver_en_route'::trips."TripStatus", updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'assigned'::trips."TripStatus"
      RETURNING updated_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { updatedAt: row.updated_at } };

    const current = await this.getTripRequest(tripRequestId);
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'driver_en_route') {
      return { kind: 'idempotent', row: { updatedAt: current.updatedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markArrived(
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ arrivedAt: Date }>> {
    const rows = await this.prisma.$queryRaw<Array<{ arrived_at: Date }>>`
      UPDATE trips.trip_request
         SET arrived_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'driver_en_route'::trips."TripStatus"
         AND arrived_at IS NULL
      RETURNING arrived_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { arrivedAt: row.arrived_at } };

    const current = await this.getTripRequest(tripRequestId);
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'driver_en_route' && current.arrivedAt !== null) {
      return { kind: 'idempotent', row: { arrivedAt: current.arrivedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markStarted(
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ updatedAt: Date }>> {
    const rows = await this.prisma.$queryRaw<Array<{ updated_at: Date }>>`
      UPDATE trips.trip_request
         SET status = 'in_progress'::trips."TripStatus", updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'driver_en_route'::trips."TripStatus"
      RETURNING updated_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { updatedAt: row.updated_at } };

    const current = await this.getTripRequest(tripRequestId);
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'in_progress') {
      return { kind: 'idempotent', row: { updatedAt: current.updatedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markCashCollected(
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ cashCollectedAt: Date }>> {
    const rows = await this.prisma.$queryRaw<Array<{ cash_collected_at: Date }>>`
      UPDATE trips.trip_request
         SET cash_collected_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'completed'::trips."TripStatus"
         AND cash_collected_at IS NULL
      RETURNING cash_collected_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { cashCollectedAt: row.cash_collected_at } };

    const current = await this.getTripRequest(tripRequestId);
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'completed' && current.cashCollectedAt !== null) {
      return { kind: 'idempotent', row: { cashCollectedAt: current.cashCollectedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }
}
