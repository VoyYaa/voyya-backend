import type {
  CompanyCommission,
  ConfigAuthor,
  MunicipalityFare,
  MunicipalityOperationalParams,
  ServiceType,
} from '@voyyaa/shared';
import type { OperationalParamsSnapshot } from './operational-params.service';
import type {
  CompanyCommissionRow,
  ConfigAuthorRow,
  MunicipalityFareRow,
} from './service-config.types';

function toAuthor(author: ConfigAuthorRow | null): ConfigAuthor | null {
  return author ? { user_id: author.userId, name: author.name } : null;
}

export function toFareDto(row: MunicipalityFareRow): MunicipalityFare {
  return {
    municipality_fare_id: row.municipalityFareId,
    municipality_id: row.municipalityId,
    service_type: row.serviceType,
    base_fare: row.baseFare,
    night_surcharge_pct: row.nightSurchargePct,
    holiday_surcharge_pct: row.holidaySurchargePct,
    is_official: row.isOfficial,
    official_reference: row.officialReference,
    origin: row.origin,
    origin_company_name: row.originCompanyName,
    valid_from: row.validFrom.toISOString(),
    valid_to: row.validTo ? row.validTo.toISOString() : null,
    created_by: toAuthor(row.createdBy),
  };
}

export function toNullableFareDto(row: MunicipalityFareRow | null): MunicipalityFare | null {
  return row ? toFareDto(row) : null;
}

export function toCommissionDto(row: CompanyCommissionRow): CompanyCommission {
  return {
    company_commission_id: row.companyCommissionId,
    company_id: row.companyId,
    commission_pct: row.commissionPct,
    origin: row.origin,
    valid_from: row.validFrom.toISOString(),
    valid_to: row.validTo ? row.validTo.toISOString() : null,
    created_by: toAuthor(row.createdBy),
  };
}

export function toOperationalParamsDto(
  snapshot: OperationalParamsSnapshot,
  municipalityId: number,
  serviceType: ServiceType,
): MunicipalityOperationalParams {
  const row = snapshot.row;
  return {
    operational_params_id: row ? row.operationalParamsId : null,
    municipality_id: municipalityId,
    service_type: serviceType,
    ...snapshot.values,
    platform_default_keys: snapshot.platformDefaultKeys,
    origin: row ? row.origin : null,
    origin_company_name: row ? row.originCompanyName : null,
    valid_from: row ? row.validFrom.toISOString() : null,
    created_by: row ? toAuthor(row.createdBy) : null,
  };
}
