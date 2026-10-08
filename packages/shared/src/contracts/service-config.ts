import { z } from 'zod';
import {
  AcceptanceTimeoutSec,
  BaseFareCop,
  CommissionPct,
  SearchRadiusKm,
  SurchargePct,
} from './admin';
import { ServiceType } from './trips';

export const ConfigOrigin = z.enum(['migrated', 'company_approval', 'platform_edit']);
export type ConfigOrigin = z.infer<typeof ConfigOrigin>;

export const ConfigAuthor = z.object({
  user_id: z.number().int().positive(),
  name: z.string(),
});
export type ConfigAuthor = z.infer<typeof ConfigAuthor>;

export const OfficialReference = z.string().trim().min(3).max(120);
export type OfficialReference = z.infer<typeof OfficialReference>;

export const ConfigHistoryQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).default(10),
});
export type ConfigHistoryQuery = z.infer<typeof ConfigHistoryQuery>;

export const MunicipalityFare = z.object({
  municipality_fare_id: z.number().int().positive(),
  municipality_id: z.number().int().positive(),
  service_type: ServiceType,
  base_fare: z.number().int().nonnegative(),
  night_surcharge_pct: z.number(),
  holiday_surcharge_pct: z.number(),
  is_official: z.boolean(),
  official_reference: z.string().nullable(),
  origin: ConfigOrigin,
  origin_company_name: z.string().nullable(),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable(),
  created_by: ConfigAuthor.nullable(),
});
export type MunicipalityFare = z.infer<typeof MunicipalityFare>;

export const MunicipalityFareHistory = z.object({
  server_time: z.string().datetime(),
  current: MunicipalityFare.nullable(),
  versions: z.array(MunicipalityFare),
  next_before: z.number().int().positive().nullable(),
});
export type MunicipalityFareHistory = z.infer<typeof MunicipalityFareHistory>;

export const UpdateMunicipalityFareDTO = z
  .object({
    version: z.number().int().positive(),
    base_fare: BaseFareCop,
    night_surcharge_pct: SurchargePct,
    holiday_surcharge_pct: SurchargePct,
    is_official: z.boolean(),
    official_reference: OfficialReference.nullable().optional(),
  })
  .refine((d) => d.is_official || d.official_reference == null, {
    message: 'Solo una tarifa oficial lleva referencia del acto',
    path: ['official_reference'],
  });
export type UpdateMunicipalityFareDTO = z.infer<typeof UpdateMunicipalityFareDTO>;

export const MaxAutoRetries = z.number().int().min(1).max(10);
export const TiebreakWindowHours = z.number().int().min(1).max(24);
export const LocationStaleMin = z.number().int().min(0).max(120);
export const AvgSpeedKmh = z.number().int().min(5).max(80);
export const CancellationWindowMin = z.number().int().min(1).max(30);
export const NoShowGraceMin = z.number().int().min(1).max(30);

export const OperationalParamsValues = z.object({
  search_radius_km: SearchRadiusKm,
  expansion_radius_km: SearchRadiusKm,
  acceptance_timeout_sec: AcceptanceTimeoutSec,
  max_auto_retries: MaxAutoRetries,
  tiebreak_window_hours: TiebreakWindowHours,
  location_stale_min: LocationStaleMin,
  avg_speed_kmh: AvgSpeedKmh,
  cancellation_window_min: CancellationWindowMin,
  no_show_grace_min: NoShowGraceMin,
});
export type OperationalParamsValues = z.infer<typeof OperationalParamsValues>;

export const OPERATIONAL_PARAM_KEYS = [
  'search_radius_km',
  'expansion_radius_km',
  'acceptance_timeout_sec',
  'max_auto_retries',
  'tiebreak_window_hours',
  'location_stale_min',
  'avg_speed_kmh',
  'cancellation_window_min',
  'no_show_grace_min',
] as const satisfies readonly (keyof OperationalParamsValues)[];

export const MunicipalityOperationalParams = z.object({
  operational_params_id: z.number().int().positive().nullable(),
  municipality_id: z.number().int().positive(),
  service_type: ServiceType,
  search_radius_km: z.number(),
  expansion_radius_km: z.number(),
  acceptance_timeout_sec: z.number(),
  max_auto_retries: z.number(),
  tiebreak_window_hours: z.number(),
  location_stale_min: z.number(),
  avg_speed_kmh: z.number(),
  cancellation_window_min: z.number(),
  no_show_grace_min: z.number(),
  platform_default_keys: z.array(z.enum(OPERATIONAL_PARAM_KEYS)),
  origin: ConfigOrigin.nullable(),
  origin_company_name: z.string().nullable(),
  valid_from: z.string().datetime().nullable(),
  created_by: ConfigAuthor.nullable(),
});
export type MunicipalityOperationalParams = z.infer<typeof MunicipalityOperationalParams>;

export const MunicipalityOperationalParamsHistory = z.object({
  server_time: z.string().datetime(),
  current: MunicipalityOperationalParams,
  versions: z.array(MunicipalityOperationalParams),
  next_before: z.number().int().positive().nullable(),
});
export type MunicipalityOperationalParamsHistory = z.infer<
  typeof MunicipalityOperationalParamsHistory
>;

export const UpdateMunicipalityOperationalParamsDTO = OperationalParamsValues.extend({
  version: z.number().int().positive().nullable(),
}).refine((d) => d.search_radius_km <= d.expansion_radius_km, {
  message: 'El radio de búsqueda no puede superar el radio de expansión',
  path: ['search_radius_km'],
});
export type UpdateMunicipalityOperationalParamsDTO = z.infer<
  typeof UpdateMunicipalityOperationalParamsDTO
>;

export const CompanyCommission = z.object({
  company_commission_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  commission_pct: z.number(),
  origin: ConfigOrigin,
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable(),
  created_by: ConfigAuthor.nullable(),
});
export type CompanyCommission = z.infer<typeof CompanyCommission>;

export const CompanyCommissionHistory = z.object({
  server_time: z.string().datetime(),
  current: CompanyCommission.nullable(),
  versions: z.array(CompanyCommission),
  next_before: z.number().int().positive().nullable(),
});
export type CompanyCommissionHistory = z.infer<typeof CompanyCommissionHistory>;

export const UpdateCompanyCommissionDTO = z.object({
  version: z.number().int().positive().nullable(),
  commission_pct: CommissionPct,
});
export type UpdateCompanyCommissionDTO = z.infer<typeof UpdateCompanyCommissionDTO>;

export const PlatformCommissionRow = z.object({
  company_id: z.number().int().positive(),
  legal_name: z.string(),
  display_name: z.string(),
  municipality_id: z.number().int().positive(),
  municipality_name: z.string(),
  commission: CompanyCommission.nullable(),
});
export type PlatformCommissionRow = z.infer<typeof PlatformCommissionRow>;

export const PlatformCommissionListResponse = z.object({
  server_time: z.string().datetime(),
  rows: z.array(PlatformCommissionRow),
});
export type PlatformCommissionListResponse = z.infer<typeof PlatformCommissionListResponse>;

export const PlatformServiceConfigRow = z.object({
  municipality_id: z.number().int().positive(),
  municipality_name: z.string(),
  department: z.string(),
  dane_code: z.string().nullable(),
  coverage_active: z.boolean(),
  service_type: ServiceType,
  active_company_count: z.number().int().nonnegative(),
  fare: MunicipalityFare.nullable(),
  operational_params: MunicipalityOperationalParams,
});
export type PlatformServiceConfigRow = z.infer<typeof PlatformServiceConfigRow>;

export const PlatformServiceConfigListResponse = z.object({
  server_time: z.string().datetime(),
  rows: z.array(PlatformServiceConfigRow),
});
export type PlatformServiceConfigListResponse = z.infer<typeof PlatformServiceConfigListResponse>;

export const ServiceConfigErrorCode = z.enum([
  'SERVICE_NOT_AVAILABLE',
  'MUNICIPALITY_NOT_FOUND',
  'COMPANY_NOT_FOUND',
  'FARE_NOT_FOUND',
  'SETTINGS_CONFLICT',
  'SETTINGS_OUT_OF_RANGE',
]);
export type ServiceConfigErrorCode = z.infer<typeof ServiceConfigErrorCode>;

export const ServiceConfigError = z.object({
  code: ServiceConfigErrorCode,
  message: z.string(),
  field: z.string().optional(),
  current_version: z.number().int().positive().optional(),
  current_author_name: z.string().optional(),
});
export type ServiceConfigError = z.infer<typeof ServiceConfigError>;
