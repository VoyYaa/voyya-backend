import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface DbCandidate {
  driverId: number;
  vehicleId: number;
  distanceM: number;
  tripsLast3h: number;
}

export interface CandidateSearch {
  companyId: number;
  tripRequestId: number;
  lat: number;
  lng: number;
  radiusKm: number;
  tiebreakWindowHours: number;
  locationStaleMin: number;
  limit: number;
  exclude: number[];
}

@Injectable()
export class CandidateRepository {
  async findCandidates(
    tx: Prisma.TransactionClient,
    q: CandidateSearch,
  ): Promise<DbCandidate[]> {
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography`;
    const radiusMeters = q.radiusKm * 1000;
    const exclusion = q.exclude.length
      ? Prisma.sql`AND d.driver_id NOT IN (${Prisma.join(q.exclude)})`
      : Prisma.empty;

    return tx.$queryRaw<DbCandidate[]>(Prisma.sql`
      SELECT
        d.driver_id          AS "driverId",
        d.current_vehicle_id AS "vehicleId",
        ST_Distance(d.current_location, ${point}) AS "distanceM",
        (
          SELECT COUNT(*)::int
          FROM assignment.assignment a
          WHERE a.driver_id = d.driver_id
            AND a.status = 'accepted'
            AND a.assigned_at > now() - (${q.tiebreakWindowHours} * interval '1 hour')
        ) AS "tripsLast3h"
      FROM fleet.driver d
      WHERE d.company_id = ${q.companyId}
        AND d.status = 'available'
        AND d.pin_must_change = false
        AND d.current_vehicle_id IS NOT NULL
        AND d.current_location IS NOT NULL
        AND ST_DWithin(d.current_location, ${point}, ${radiusMeters})
        AND (
          ${q.locationStaleMin} <= 0
          OR (
            d.location_updated_at IS NOT NULL
            AND (d.location_updated_at AT TIME ZONE 'UTC') > now() - (${q.locationStaleMin} * interval '1 minute')
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM assignment.assignment o
          WHERE o.driver_id = d.driver_id
            AND o.status IN ('created', 'notified')
            AND o.expires_at > (now() AT TIME ZONE 'UTC')
        )
        AND NOT EXISTS (
          SELECT 1 FROM assignment.assignment r
          WHERE r.driver_id = d.driver_id
            AND r.trip_request_id = ${q.tripRequestId}
            AND r.status IN ('rejected', 'timeout', 'cancelled')
        )
        ${exclusion}
      ORDER BY "distanceM" ASC, "tripsLast3h" ASC
      LIMIT ${q.limit}
    `);
  }

  async hasAvailableDrivers(
    tx: Prisma.TransactionClient,
    companyId: number,
    locationStaleMin: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ available: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM fleet.driver d
        WHERE d.company_id = ${companyId}
          AND d.status = 'available'
          AND d.pin_must_change = false
          AND d.current_vehicle_id IS NOT NULL
          AND d.current_location IS NOT NULL
          AND (
            ${locationStaleMin} <= 0
            OR (
              d.location_updated_at IS NOT NULL
              AND (d.location_updated_at AT TIME ZONE 'UTC') > now() - (${locationStaleMin} * interval '1 minute')
            )
          )
      ) AS available
    `;
    return rows[0]?.available === true;
  }
}
