import type { ConfigOrigin, OPERATIONAL_PARAM_KEYS, ServiceType } from '@voyyaa/shared';

export type OperationalParamKey = (typeof OPERATIONAL_PARAM_KEYS)[number];

export interface ConfigAuthorRow {
  userId: number;
  name: string;
}

export interface VersionMeta {
  origin: ConfigOrigin;
  originCompanyName: string | null;
  validFrom: Date;
  validTo: Date | null;
  createdBy: ConfigAuthorRow | null;
}

export interface MunicipalityFareRow extends VersionMeta {
  municipalityFareId: number;
  municipalityId: number;
  serviceType: ServiceType;
  baseFare: number;
  nightSurchargePct: number;
  holidaySurchargePct: number;
  isOfficial: boolean;
  officialReference: string | null;
}

export interface FareValues {
  baseFare: number;
  nightSurchargePct: number;
  holidaySurchargePct: number;
  isOfficial: boolean;
  officialReference: string | null;
}

export interface NewFareVersion extends FareValues {
  municipalityId: number;
  serviceType: ServiceType;
  origin: ConfigOrigin;
  originCompanyId: number | null;
  createdBy: number | null;
}

export type NullableOperationalValues = Record<OperationalParamKey, number | null>;

export interface OperationalParamsRow extends VersionMeta {
  operationalParamsId: number;
  municipalityId: number;
  serviceType: ServiceType;
  values: NullableOperationalValues;
}

export interface NewOperationalParamsVersion {
  municipalityId: number;
  serviceType: ServiceType;
  values: NullableOperationalValues;
  origin: ConfigOrigin;
  originCompanyId: number | null;
  createdBy: number | null;
}

export interface CompanyCommissionRow extends VersionMeta {
  companyCommissionId: number;
  companyId: number;
  commissionPct: number;
}

export interface NewCompanyCommissionVersion {
  companyId: number;
  commissionPct: number;
  origin: ConfigOrigin;
  createdBy: number | null;
}

export interface VersionPage<T> {
  versions: T[];
  nextBefore: number | null;
}

export interface ConflictInfo {
  currentVersion: number | null;
  currentAuthorName: string | null;
}
