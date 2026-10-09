import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ConfigOrigin, ServiceType } from '@voyyaa/shared';
import type {
  NewOperationalParamsVersion,
  NullableOperationalValues,
  OperationalParamsRow,
} from './service-config.types';
import { authorName } from './version-history';

const PARAMS_INCLUDE = {
  originCompany: { select: { legalName: true } },
  createdByUser: { select: { firstName: true, lastName: true } },
} as const;

type ParamsRecord = Prisma.MunicipalityOperationalParamsGetPayload<{ include: typeof PARAMS_INCLUDE }>;

@Injectable()
export class OperationalParamsRepository {
  async findCurrent(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    serviceType: ServiceType,
  ): Promise<OperationalParamsRow | null> {
    const row = await tx.municipalityOperationalParams.findFirst({
      where: { municipalityId, serviceType, validTo: null },
      include: PARAMS_INCLUDE,
    });
    return row ? toParamsRow(row) : null;
  }

  async listVersions(
    tx: Prisma.TransactionClient,
    municipalityId: number,
    serviceType: ServiceType,
    before: number | null,
    take: number,
  ): Promise<OperationalParamsRow[]> {
    const rows = await tx.municipalityOperationalParams.findMany({
      where: {
        municipalityId,
        serviceType,
        ...(before !== null ? { operationalParamsId: { lt: before } } : {}),
      },
      orderBy: { operationalParamsId: 'desc' },
      take,
      include: PARAMS_INCLUDE,
    });
    return rows.map(toParamsRow);
  }

  async listCurrentForMunicipalities(
    tx: Prisma.TransactionClient,
    municipalityIds: readonly number[],
  ): Promise<OperationalParamsRow[]> {
    const rows = await tx.municipalityOperationalParams.findMany({
      where: { municipalityId: { in: [...municipalityIds] }, validTo: null },
      include: PARAMS_INCLUDE,
    });
    return rows.map(toParamsRow);
  }

  async replaceOpenVersion(
    tx: Prisma.TransactionClient,
    expectedVersion: number,
    next: NewOperationalParamsVersion,
  ): Promise<number | null> {
    const v = next.values;
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      WITH closed AS (
        UPDATE admin.municipality_operational_params
           SET valid_to = GREATEST(valid_from, now() AT TIME ZONE 'UTC')
         WHERE operational_params_id = ${expectedVersion}
           AND municipality_id = ${next.municipalityId}
           AND service_type = ${next.serviceType}::trips."ServiceType"
           AND valid_to IS NULL
        RETURNING valid_to
      )
      INSERT INTO admin.municipality_operational_params
        (municipality_id, service_type, search_radius_km, expansion_radius_km, acceptance_timeout_sec,
         max_auto_retries, tiebreak_window_hours, location_stale_min, avg_speed_kmh,
         cancellation_window_min, no_show_grace_min, origin, origin_company_id, valid_from, created_by)
      SELECT ${next.municipalityId}, ${next.serviceType}::trips."ServiceType",
             ${v.search_radius_km}::numeric, ${v.expansion_radius_km}::numeric, ${v.acceptance_timeout_sec}::int,
             ${v.max_auto_retries}::int, ${v.tiebreak_window_hours}::int, ${v.location_stale_min}::int,
             ${v.avg_speed_kmh}::int, ${v.cancellation_window_min}::int, ${v.no_show_grace_min}::int,
             ${next.origin}, ${next.originCompanyId}, closed.valid_to, ${next.createdBy}
        FROM closed
      RETURNING operational_params_id AS id`;
    return rows[0]?.id ?? null;
  }

  async insertIfNoOpenVersion(
    tx: Prisma.TransactionClient,
    next: NewOperationalParamsVersion,
  ): Promise<number | null> {
    const v = next.values;
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO admin.municipality_operational_params
        (municipality_id, service_type, search_radius_km, expansion_radius_km, acceptance_timeout_sec,
         max_auto_retries, tiebreak_window_hours, location_stale_min, avg_speed_kmh,
         cancellation_window_min, no_show_grace_min, origin, origin_company_id, valid_from, created_by)
      VALUES
        (${next.municipalityId}, ${next.serviceType}::trips."ServiceType",
         ${v.search_radius_km}::numeric, ${v.expansion_radius_km}::numeric, ${v.acceptance_timeout_sec}::int,
         ${v.max_auto_retries}::int, ${v.tiebreak_window_hours}::int, ${v.location_stale_min}::int,
         ${v.avg_speed_kmh}::int, ${v.cancellation_window_min}::int, ${v.no_show_grace_min}::int,
         ${next.origin}, ${next.originCompanyId}, now() AT TIME ZONE 'UTC', ${next.createdBy})
      ON CONFLICT (municipality_id, service_type) WHERE valid_to IS NULL DO NOTHING
      RETURNING operational_params_id AS id`;
    return rows[0]?.id ?? null;
  }
}

function nullableNumber(value: Prisma.Decimal | number | null): number | null {
  return value === null ? null : Number(value);
}

function toParamsRow(row: ParamsRecord): OperationalParamsRow {
  const values: NullableOperationalValues = {
    search_radius_km: nullableNumber(row.searchRadiusKm),
    expansion_radius_km: nullableNumber(row.expansionRadiusKm),
    acceptance_timeout_sec: row.acceptanceTimeoutSec,
    max_auto_retries: row.maxAutoRetries,
    tiebreak_window_hours: row.tiebreakWindowHours,
    location_stale_min: row.locationStaleMin,
    avg_speed_kmh: row.avgSpeedKmh,
    cancellation_window_min: row.cancellationWindowMin,
    no_show_grace_min: row.noShowGraceMin,
  };
  return {
    operationalParamsId: row.operationalParamsId,
    municipalityId: row.municipalityId,
    serviceType: row.serviceType,
    values,
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
