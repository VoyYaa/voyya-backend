import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ConfigOrigin, ServiceType } from '@voyyaa/shared';
import type { MunicipalityFareRow, NewFareVersion } from './service-config.types';
import { authorName } from './version-history';

const FARE_INCLUDE = {
  originCompany: { select: { legalName: true } },
  createdByUser: { select: { firstName: true, lastName: true } },
} as const;

type FareRecord = Prisma.MunicipalityFareGetPayload<{ include: typeof FARE_INCLUDE }>;

@Injectable()
export class MunicipalityFareRepository {
  async findCurrent(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    serviceType: ServiceType,
  ): Promise<MunicipalityFareRow | null> {
    const row = await tx.municipalityFare.findFirst({
      where: { municipalityId, serviceType, validTo: null },
      include: FARE_INCLUDE,
    });
    return row ? toFareRow(row) : null;
  }

  async findById(tx: Prisma.TransactionClient, municipalityFareId: number): Promise<MunicipalityFareRow | null> {
    const row = await tx.municipalityFare.findUnique({
      where: { municipalityFareId },
      include: FARE_INCLUDE,
    });
    return row ? toFareRow(row) : null;
  }

  async listVersions(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    serviceType: ServiceType,
    before: number | null,
    take: number,
  ): Promise<MunicipalityFareRow[]> {
    const rows = await tx.municipalityFare.findMany({
      where: {
        municipalityId,
        serviceType,
        ...(before !== null ? { municipalityFareId: { lt: before } } : {}),
      },
      orderBy: { municipalityFareId: 'desc' },
      take,
      include: FARE_INCLUDE,
    });
    return rows.map(toFareRow);
  }

  async listCurrentForMunicipalities(
    tx: Prisma.TransactionClient,
    municipalityIds: readonly number[],
  ): Promise<MunicipalityFareRow[]> {
    const rows = await tx.municipalityFare.findMany({
      where: { municipalityId: { in: [...municipalityIds] }, validTo: null },
      include: FARE_INCLUDE,
    });
    return rows.map(toFareRow);
  }

  async replaceOpenVersion(
    tx: Prisma.TransactionClient,
    expectedVersion: number,
    next: NewFareVersion,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      WITH closed AS (
        UPDATE trips.municipality_fare
           SET valid_to = GREATEST(valid_from, now() AT TIME ZONE 'UTC')
         WHERE municipality_fare_id = ${expectedVersion}
           AND municipality_id = ${next.municipalityId}
           AND service_type = ${next.serviceType}::trips."ServiceType"
           AND valid_to IS NULL
        RETURNING valid_to
      )
      INSERT INTO trips.municipality_fare
        (municipality_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct,
         is_official, official_reference, origin, origin_company_id, valid_from, created_by)
      SELECT ${next.municipalityId}, ${next.serviceType}::trips."ServiceType", ${next.baseFare},
             ${next.nightSurchargePct}, ${next.holidaySurchargePct}, ${next.isOfficial},
             ${next.officialReference}, ${next.origin}, ${next.originCompanyId}, closed.valid_to,
             ${next.createdBy}
        FROM closed
      RETURNING municipality_fare_id AS id`;
    return rows[0]?.id ?? null;
  }

  async insertIfNoOpenVersion(tx: Prisma.TransactionClient, next: NewFareVersion): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO trips.municipality_fare
        (municipality_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct,
         is_official, official_reference, origin, origin_company_id, valid_from, created_by)
      VALUES
        (${next.municipalityId}, ${next.serviceType}::trips."ServiceType", ${next.baseFare},
         ${next.nightSurchargePct}, ${next.holidaySurchargePct}, ${next.isOfficial},
         ${next.officialReference}, ${next.origin}, ${next.originCompanyId},
         now() AT TIME ZONE 'UTC', ${next.createdBy})
      ON CONFLICT (municipality_id, service_type) WHERE valid_to IS NULL DO NOTHING
      RETURNING municipality_fare_id AS id`;
    return rows[0]?.id ?? null;
  }
}

function toFareRow(row: FareRecord): MunicipalityFareRow {
  return {
    municipalityFareId: row.municipalityFareId,
    municipalityId: row.municipalityId,
    serviceType: row.serviceType,
    baseFare: Number(row.baseFare),
    nightSurchargePct: Number(row.nightSurchargePct),
    holidaySurchargePct: Number(row.holidaySurchargePct),
    isOfficial: row.isOfficial,
    officialReference: row.officialReference,
    origin: row.origin as ConfigOrigin,
    originCompanyName: row.originCompany?.legalName ?? null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    createdBy:
      row.createdBy !== null && row.createdByUser !== null
        ? { userId: row.createdBy, name: authorName(row.createdByUser) }
        : null,
  };
}
