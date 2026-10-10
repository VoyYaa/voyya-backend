import { z } from 'zod';
import { AmountCop, Coordinate, FareBreakdown, StartCode, TripStatus } from './trips';

export const DriverStatus = z.enum([
  'available',
  'on_trip',
  'off_shift',
  'inactive',
  'suspended',
  'documents_blocked',
]);
export type DriverStatus = z.infer<typeof DriverStatus>;

export const UpdateDriverShiftDTO = z.discriminatedUnion('on_shift', [
  z.object({ on_shift: z.literal(true), location: Coordinate }),
  z.object({ on_shift: z.literal(false) }),
]);
export type UpdateDriverShiftDTO = z.infer<typeof UpdateDriverShiftDTO>;

export const ReportDriverLocationDTO = Coordinate;
export type ReportDriverLocationDTO = z.infer<typeof ReportDriverLocationDTO>;

export const StartTripDTO = z.object({ start_code: StartCode.optional() });
export type StartTripDTO = z.infer<typeof StartTripDTO>;

export const DriverLocationSharing = z.object({
  trip_request_id: z.number().int().positive(),
  interval_sec: z.number().int().min(10).max(15),
});
export type DriverLocationSharing = z.infer<typeof DriverLocationSharing>;

export const ReportDriverLocationResult = z.object({
  ok: z.literal(true),
  location_sharing: DriverLocationSharing.nullable().default(null),
});
export type ReportDriverLocationResult = z.infer<typeof ReportDriverLocationResult>;

export const DriverShiftState = z.object({
  status: DriverStatus,
  on_shift: z.boolean(),
  vehicle_linked: z.boolean(),
  location_updated_at: z.string().datetime().nullable(),
});
export type DriverShiftState = z.infer<typeof DriverShiftState>;

export const DriverTripView = z.object({
  trip_request_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
  status: TripStatus,
  passenger: z.object({
    name: z.string(),
    contact_phone: z.string().nullable(),
  }),
  pickup_address: z.string(),
  dropoff_address: z.string(),
  fare: FareBreakdown,
  arrived_at: z.string().datetime().nullable(),
  no_show_available_at: z.string().datetime().nullable(),
  cash_collected_at: z.string().datetime().nullable(),
  start_code_required: z.boolean().default(false),
  start_attempts_remaining: z.number().int().min(0).max(5).nullable().default(null),
  start_blocked: z.boolean().default(false),
  pickup_location: Coordinate.nullable().default(null),
  dropoff_location: Coordinate.nullable().default(null),
  location_sharing: DriverLocationSharing.nullable().default(null),
});
export type DriverTripView = z.infer<typeof DriverTripView>;

export const DriverHomeState = z.object({
  shift: DriverShiftState,
  active_trip: DriverTripView.nullable(),
});
export type DriverHomeState = z.infer<typeof DriverHomeState>;

export const TripTransitionResult = z.object({
  trip_request_id: z.number().int().positive(),
  status: TripStatus,
  idempotent: z.boolean(),
  arrived_at: z.string().datetime().nullable().optional(),
  no_show_available_at: z.string().datetime().nullable().optional(),
  finished_at: z.string().datetime().nullable().optional(),
  net_earnings: AmountCop.nullable().optional(),
  cash_collected_at: z.string().datetime().nullable().optional(),
});
export type TripTransitionResult = z.infer<typeof TripTransitionResult>;

export const CompleteTripDTO = z.object({
  cash_collected: z.boolean().default(true),
});
export type CompleteTripDTO = z.infer<typeof CompleteTripDTO>;

export const PendingCashTrip = z.object({
  trip_request_id: z.number().int().positive(),
  finished_at: z.string().datetime(),
  fare: AmountCop,
  dropoff_address: z.string().nullable(),
});
export type PendingCashTrip = z.infer<typeof PendingCashTrip>;

export const PendingCashTripsResponse = z.array(PendingCashTrip);
export type PendingCashTripsResponse = z.infer<typeof PendingCashTripsResponse>;

export const DriverErrorCode = z.enum([
  'NO_VEHICLE_LINKED',
  'DRIVER_NOT_ELIGIBLE',
  'ACTIVE_TRIP_IN_PROGRESS',
  'NOT_ON_SHIFT',
  'LOCATION_CONSENT_REQUIRED',
]);
export type DriverErrorCode = z.infer<typeof DriverErrorCode>;

export const DriverError = z.object({
  code: DriverErrorCode,
  message: z.string(),
});
export type DriverError = z.infer<typeof DriverError>;
