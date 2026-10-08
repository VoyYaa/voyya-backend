import { z } from 'zod';
import { DriverSuspensionReason, NationalId, Phone } from './auth';
import { DocumentStorageKey } from './documents';
import { DriverStatus } from './driver';
import { AmountCop, FareBreakdown, TripStatus } from './trips';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)');
export type IsoDate = z.infer<typeof IsoDate>;

export const VehiclePlate = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}\d{3}$/, 'Placa inválida (3 letras y 3 números, p. ej. ABC123)');
export type VehiclePlate = z.infer<typeof VehiclePlate>;

export const PinDeliveryStatus = z.enum(['sent', 'failed']);
export type PinDeliveryStatus = z.infer<typeof PinDeliveryStatus>;

export const CreateDriverVehicleDTO = z.object({
  plate: VehiclePlate,
  model: z.string().trim().min(1).max(100),
  year: z.number().int().min(1980).max(2100).optional(),
});
export type CreateDriverVehicleDTO = z.infer<typeof CreateDriverVehicleDTO>;

export const DriverDocumentType = z.enum([
  'license',
  'soat',
  'vehicle_inspection',
  'operation_card',
]);
export type DriverDocumentType = z.infer<typeof DriverDocumentType>;

export const REQUIRED_DRIVER_DOCUMENT_TYPES = [
  'license',
  'soat',
  'vehicle_inspection',
  'operation_card',
] as const satisfies readonly DriverDocumentType[];

export const DriverDocumentInput = z.object({
  type: DriverDocumentType,
  storage_key: DocumentStorageKey,
  issued_at: IsoDate.optional(),
  expires_at: IsoDate,
});
export type DriverDocumentInput = z.infer<typeof DriverDocumentInput>;

export const CreatedDriverDocument = z.object({
  driver_document_id: z.number().int().positive(),
  type: DriverDocumentType,
  file_name: z.string(),
  issued_at: IsoDate.nullable(),
  expires_at: IsoDate,
  uploaded_at: z.string().datetime(),
});
export type CreatedDriverDocument = z.infer<typeof CreatedDriverDocument>;

export const FleetQuota = z.object({
  declared: z.number().int().nullable(),
  used: z.number().int().nonnegative(),
  available: z.number().int().nullable(),
});
export type FleetQuota = z.infer<typeof FleetQuota>;

export const CreateDriverDTO = z.object({
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  national_id: NationalId,
  phone: Phone,
  email: z.string().trim().email().max(254).optional(),
  license: z.string().trim().min(3).max(30).optional(),
  vehicle: CreateDriverVehicleDTO,
  documents: z.array(DriverDocumentInput).min(1).max(4),
});
export type CreateDriverDTO = z.infer<typeof CreateDriverDTO>;

export const CreatedDriverVehicle = z.object({
  vehicle_id: z.number().int().positive(),
  plate: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
});
export type CreatedDriverVehicle = z.infer<typeof CreatedDriverVehicle>;

export const CreatedDriver = z.object({
  driver_id: z.number().int().positive(),
  national_id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  status: DriverStatus,
  vehicle: CreatedDriverVehicle,
  documents: z.array(CreatedDriverDocument),
  pin_delivery: PinDeliveryStatus,
  pin_delivered_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type CreatedDriver = z.infer<typeof CreatedDriver>;

export const ResendDriverPinResponse = z.object({
  driver_id: z.number().int().positive(),
  pin_delivery: PinDeliveryStatus,
  pin_delivered_at: z.string().datetime().nullable(),
});
export type ResendDriverPinResponse = z.infer<typeof ResendDriverPinResponse>;

export const SuspendDriverDTO = z.object({
  reason: DriverSuspensionReason,
});
export type SuspendDriverDTO = z.infer<typeof SuspendDriverDTO>;

export const SuspendDriverResponse = z.object({ ok: z.literal(true) });
export type SuspendDriverResponse = z.infer<typeof SuspendDriverResponse>;

export const BaseFareCop = z.number().int().min(1_000).max(1_000_000);
export type BaseFareCop = z.infer<typeof BaseFareCop>;

export const SurchargePct = z.number().min(0).max(100).multipleOf(0.01);
export type SurchargePct = z.infer<typeof SurchargePct>;

export const SearchRadiusKm = z.number().positive().max(50).multipleOf(0.1);
export type SearchRadiusKm = z.infer<typeof SearchRadiusKm>;

export const AcceptanceTimeoutSec = z.number().int().min(5).max(120);
export type AcceptanceTimeoutSec = z.infer<typeof AcceptanceTimeoutSec>;

export const UpdateConsoleSettingsDTO = z.object({
  version: z.string().min(1),
  base_fare: BaseFareCop,
  night_surcharge_pct: SurchargePct,
  holiday_surcharge_pct: SurchargePct,
  search_radius_km: SearchRadiusKm,
  acceptance_timeout_sec: AcceptanceTimeoutSec,
});
export type UpdateConsoleSettingsDTO = z.infer<typeof UpdateConsoleSettingsDTO>;

export const ConsoleSettings = z.object({
  version: z.string().min(1),
  base_fare: z.number().int().nonnegative(),
  night_surcharge_pct: z.number(),
  holiday_surcharge_pct: z.number(),
  commission_pct: z.number(),
  search_radius_km: z.number().positive(),
  expansion_radius_km: z.number().positive(),
  acceptance_timeout_sec: z.number().int().positive(),
  updated_at: z.string().datetime().nullable(),
});
export type ConsoleSettings = z.infer<typeof ConsoleSettings>;

export const OPS_QUEUE_POLL_INTERVAL_MS = 5000;
export const OPS_QUEUE_STALE_AFTER_MS = 15000;
export const OPS_QUEUE_TERMINAL_WINDOW_SEC = 60;
export const OPS_LIST_DEFAULT_LIMIT = 100;
export const OPS_LIST_MAX_LIMIT = 200;

export const OpsQueueStatusFilter = z.enum([
  'all',
  'pending',
  'assigned',
  'in_progress',
  'no_driver',
]);
export type OpsQueueStatusFilter = z.infer<typeof OpsQueueStatusFilter>;

export const OPS_QUEUE_FILTER_STATUSES = {
  pending: ['pending_assignment'],
  assigned: ['assigned', 'driver_en_route'],
  in_progress: ['in_progress'],
  no_driver: ['no_driver', 'expired'],
} as const satisfies Record<Exclude<OpsQueueStatusFilter, 'all'>, readonly TripStatus[]>;

export const OpsQueueQuery = z.object({
  status: OpsQueueStatusFilter.default('all'),
  limit: z.coerce.number().int().positive().max(OPS_LIST_MAX_LIMIT).default(OPS_LIST_DEFAULT_LIMIT),
});
export type OpsQueueQuery = z.infer<typeof OpsQueueQuery>;

export const OpsAssignedDriver = z.object({
  driver_id: z.number().int().positive(),
  name: z.string(),
  plate: z.string(),
});
export type OpsAssignedDriver = z.infer<typeof OpsAssignedDriver>;

export const OpsQueueRow = z.object({
  trip_request_id: z.number().int().positive(),
  status: TripStatus,
  requested_at: z.string().datetime(),
  status_since: z.string().datetime(),
  passenger_name: z.string(),
  pickup_address: z.string(),
  dropoff_address: z.string(),
  fare_total: AmountCop,
  driver: OpsAssignedDriver.nullable(),
});
export type OpsQueueRow = z.infer<typeof OpsQueueRow>;

export const OpsQueueResponse = z.object({
  server_time: z.string().datetime(),
  rows: z.array(OpsQueueRow),
});
export type OpsQueueResponse = z.infer<typeof OpsQueueResponse>;

export const OpsTripTimeline = z.object({
  requested_at: z.string().datetime(),
  assigned_at: z.string().datetime().nullable(),
  arrived_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable(),
});
export type OpsTripTimeline = z.infer<typeof OpsTripTimeline>;

export const OpsTripDetail = z.object({
  server_time: z.string().datetime(),
  trip_request_id: z.number().int().positive(),
  status: TripStatus,
  status_since: z.string().datetime(),
  pickup_address: z.string(),
  dropoff_address: z.string(),
  fare: FareBreakdown,
  passenger_name: z.string(),
  passenger_phone_masked: z.string().nullable(),
  driver: OpsAssignedDriver.nullable(),
  timeline: OpsTripTimeline,
  cash_collected_at: z.string().datetime().nullable(),
});
export type OpsTripDetail = z.infer<typeof OpsTripDetail>;

export const OpsDriverVehicle = z.object({
  vehicle_id: z.number().int().positive(),
  plate: z.string(),
  model: z.string().nullable(),
});
export type OpsDriverVehicle = z.infer<typeof OpsDriverVehicle>;

export const OpsDriverQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: DriverStatus.optional(),
  limit: z.coerce.number().int().positive().max(OPS_LIST_MAX_LIMIT).default(OPS_LIST_DEFAULT_LIMIT),
});
export type OpsDriverQuery = z.infer<typeof OpsDriverQuery>;

export const OpsDriverRow = z.object({
  driver_id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string(),
  national_id: z.string(),
  phone: z.string(),
  status: DriverStatus,
  vehicle: OpsDriverVehicle.nullable(),
  location_updated_at: z.string().datetime().nullable(),
  location_stale: z.boolean(),
  pin_delivered_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type OpsDriverRow = z.infer<typeof OpsDriverRow>;

export const OpsDriverListResponse = z.object({
  server_time: z.string().datetime(),
  rows: z.array(OpsDriverRow),
});
export type OpsDriverListResponse = z.infer<typeof OpsDriverListResponse>;

export const OpsDriverDetail = OpsDriverRow.extend({
  server_time: z.string().datetime(),
  license: z.string().nullable(),
  active_trip_request_id: z.number().int().positive().nullable(),
});
export type OpsDriverDetail = z.infer<typeof OpsDriverDetail>;

export const SettlementReportQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  driver_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['completed', 'cancelled']).optional(),
});
export type SettlementReportQuery = z.infer<typeof SettlementReportQuery>;

export const SettlementReportRow = z.object({
  driver_id: z.number().int().positive(),
  driver_name: z.string(),
  national_id: z.string(),
  plate: z.string().nullable(),
  trip_count: z.number().int().nonnegative(),
  total_cash_income: AmountCop,
  membership_fee_due: AmountCop.nullable(),
});
export type SettlementReportRow = z.infer<typeof SettlementReportRow>;

export const SettlementReportTotals = z.object({
  trip_count: z.number().int().nonnegative(),
  total_cash_income: AmountCop,
});
export type SettlementReportTotals = z.infer<typeof SettlementReportTotals>;

export const SettlementReportResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  generated_at: z.string().datetime(),
  rows: z.array(SettlementReportRow),
  totals: SettlementReportTotals,
});
export type SettlementReportResponse = z.infer<typeof SettlementReportResponse>;

export const AdminErrorCode = z.enum([
  'NATIONAL_ID_TAKEN',
  'PHONE_TAKEN',
  'EMAIL_TAKEN',
  'PLATE_TAKEN',
  'DRIVER_NOT_FOUND',
  'TRIP_REQUEST_NOT_FOUND',
  'SETTINGS_CONFLICT',
  'SETTINGS_OUT_OF_RANGE',
  'FARE_CONFIG_NOT_FOUND',
  'FLEET_LIMIT_REACHED',
  'DRIVER_DOCUMENTS_INCOMPLETE',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_STORAGE_UNAVAILABLE',
]);
export type AdminErrorCode = z.infer<typeof AdminErrorCode>;

export const AdminError = z.object({
  code: AdminErrorCode,
  message: z.string(),
  field: z.string().optional(),
  missing_documents: z.array(DriverDocumentType).optional(),
});
export type AdminError = z.infer<typeof AdminError>;
