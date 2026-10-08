import { Injectable } from '@nestjs/common';
import type { Prisma, TripRequest } from '@prisma/client';
import {
  type TripStatus,
  ACTIVE_TRIP_STATUSES,
  type ServiceType,
  TERMINAL_TRIP_STATUSES,
} from '@voyyaa/shared';
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
  requestedCompanyId: number | null;
  municipalityFareId: number;
}

export interface MunicipalityAtPoint {
  municipalityId: number;
  name: string;
}

@Injectable()
export class TripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async purgeCoordinatesBatch(
    tx: Prisma.TransactionClient,
    retentionDays: number,
    batchSize: number,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ trip_request_id: number }>>`
      WITH batch AS (
        SELECT trip_request_id
          FROM trips.trip_request
         WHERE location_purged_at IS NULL
           AND status = ANY(${[...TERMINAL_TRIP_STATUSES]}::trips."TripStatus"[])
           AND COALESCE(finished_at, requested_at)
               < (now() AT TIME ZONE 'UTC') - make_interval(days => ${retentionDays}::int)
         ORDER BY trip_request_id
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE trips.trip_request t
         SET pickup_lat = NULL, pickup_lng = NULL,
             dropoff_lat = NULL, dropoff_lng = NULL,
             pickup_address = NULL, dropoff_address = NULL,
             location_purged_at = (now() AT TIME ZONE 'UTC')
        FROM batch
       WHERE t.trip_request_id = batch.trip_request_id
      RETURNING t.trip_request_id
    `;
    return rows.length;
  }

  async findMunicipalityAtPoint(lng: number, lat: number): Promise<MunicipalityAtPoint | null> {
    const rows = await this.prisma.$queryRaw<Array<{ municipality_id: number; name: string }>>`
      SELECT municipality_id, name
        FROM tenancy.municipality
       WHERE status = 'active'
         AND ST_Covers(coverage, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
       ORDER BY ST_Area(coverage) ASC, municipality_id ASC
       LIMIT 1
    `;
    const row = rows[0];
    return row ? { municipalityId: row.municipality_id, name: row.name } : null;
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

  async findActiveTripRequest(passengerId: number): Promise<TripRequest | null> {
    return this.prisma.tripRequest.findFirst({
      where: {
        passengerId,
        status: { in: [...ACTIVE_TRIP_STATUSES] },
      },
      orderBy: [{ requestedAt: 'desc' }, { tripRequestId: 'desc' }],
    });
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
        requestedCompanyId: data.requestedCompanyId,
        municipalityFareId: data.municipalityFareId,
        status: 'pending_assignment',
      },
    });
  }

  async getTripRequest(
    tripRequestId: number,
    tx?: Prisma.TransactionClient,
  ): Promise<TripRequest | null> {
    return (tx ?? this.prisma).tripRequest.findUnique({ where: { tripRequestId } });
  }

  async markNoDriverIfUnassigned(tripRequestId: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ trip_request_id: number }>>`
      UPDATE trips.trip_request
         SET status = 'no_driver'::trips."TripStatus", updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'pending_assignment'::trips."TripStatus"
         AND company_id IS NULL
      RETURNING trip_request_id
    `;
    return rows.length === 1;
  }

  async markEnRoute(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ updatedAt: Date }>> {
    const rows = await tx.$queryRaw<Array<{ updated_at: Date }>>`
      UPDATE trips.trip_request
         SET status = 'driver_en_route'::trips."TripStatus", updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'assigned'::trips."TripStatus"
      RETURNING updated_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { updatedAt: row.updated_at } };

    const current = await tx.tripRequest.findUnique({ where: { tripRequestId } });
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'driver_en_route') {
      return { kind: 'idempotent', row: { updatedAt: current.updatedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markArrived(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ arrivedAt: Date }>> {
    const rows = await tx.$queryRaw<Array<{ arrived_at: Date }>>`
      UPDATE trips.trip_request
         SET arrived_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'driver_en_route'::trips."TripStatus"
         AND arrived_at IS NULL
      RETURNING arrived_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { arrivedAt: row.arrived_at } };

    const current = await tx.tripRequest.findUnique({ where: { tripRequestId } });
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'driver_en_route' && current.arrivedAt !== null) {
      return { kind: 'idempotent', row: { arrivedAt: current.arrivedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markStarted(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ updatedAt: Date }>> {
    const rows = await tx.$queryRaw<Array<{ updated_at: Date }>>`
      UPDATE trips.trip_request
         SET status = 'in_progress'::trips."TripStatus", updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'driver_en_route'::trips."TripStatus"
      RETURNING updated_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { updatedAt: row.updated_at } };

    const current = await tx.tripRequest.findUnique({ where: { tripRequestId } });
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'in_progress') {
      return { kind: 'idempotent', row: { updatedAt: current.updatedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }

  async markCashCollected(
    tx: Prisma.TransactionClient,
    tripRequestId: number,
  ): Promise<TripTransitionOutcome<{ cashCollectedAt: Date }>> {
    const rows = await tx.$queryRaw<Array<{ cash_collected_at: Date }>>`
      UPDATE trips.trip_request
         SET cash_collected_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
       WHERE trip_request_id = ${tripRequestId}
         AND status = 'completed'::trips."TripStatus"
         AND cash_collected_at IS NULL
      RETURNING cash_collected_at
    `;
    const row = rows[0];
    if (row) return { kind: 'applied', row: { cashCollectedAt: row.cash_collected_at } };

    const current = await tx.tripRequest.findUnique({ where: { tripRequestId } });
    if (!current) return { kind: 'rejected', status: 'expired' };
    if (current.status === 'completed' && current.cashCollectedAt !== null) {
      return { kind: 'idempotent', row: { cashCollectedAt: current.cashCollectedAt } };
    }
    return { kind: 'rejected', status: current.status };
  }
}
