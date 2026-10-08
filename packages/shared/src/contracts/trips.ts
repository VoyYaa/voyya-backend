import { z } from 'zod';

export const ServiceType = z.enum(['taxi', 'motorcycle', 'comfort', 'delivery']);
export type ServiceType = z.infer<typeof ServiceType>;

export const PaymentMethod = z.enum(['cash', 'nequi', 'daviplata', 'card']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const TripStatus = z.enum([
  'pending_assignment',
  'assigned',
  'driver_en_route',
  'in_progress',
  'completed',
  'cancelled_by_passenger',
  'cancelled_by_driver',
  'no_driver',
  'no_show',
  'expired',
]);
export type TripStatus = z.infer<typeof TripStatus>;

export const TRIP_STATUS_TRANSITIONS = {
  pending_assignment: ['assigned', 'no_driver', 'cancelled_by_passenger', 'expired'],
  assigned: [
    'driver_en_route',
    'pending_assignment',
    'cancelled_by_passenger',
    'cancelled_by_driver',
  ],
  driver_en_route: ['in_progress', 'cancelled_by_passenger', 'cancelled_by_driver', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled_by_passenger: [],
  cancelled_by_driver: [],
  no_driver: [],
  no_show: [],
  expired: [],
} as const satisfies Record<TripStatus, readonly TripStatus[]>;

export function canTransitionTripStatus(from: TripStatus, to: TripStatus): boolean {
  return (TRIP_STATUS_TRANSITIONS[from] as readonly TripStatus[]).includes(to);
}

export const PassengerUiState = z.enum([
  'calculating_fare',
  'searching',
  'driver_assigned',
  'driver_en_route',
  'driver_waiting',
  'trip_in_progress',
  'trip_completed',
  'trip_no_show',
  'trip_cancelled',
  'no_driver',
  'out_of_coverage',
  'offline',
]);
export type PassengerUiState = z.infer<typeof PassengerUiState>;

export const Coordinate = z.object({
  lat: z.number().min(-4.5).max(16),
  lng: z.number().min(-82).max(-66),
});
export type Coordinate = z.infer<typeof Coordinate>;

export const Location = Coordinate.extend({
  address: z.string().min(3).max(255),
});
export type Location = z.infer<typeof Location>;

export const AmountCop = z.number().int().nonnegative();
export type AmountCop = z.infer<typeof AmountCop>;

export const FareBreakdown = z.object({
  base_fare: AmountCop,
  night_surcharge: AmountCop,
  holiday_surcharge: AmountCop,
  total: AmountCop,
  commission: AmountCop,
  currency: z.literal('COP'),
});
export type FareBreakdown = z.infer<typeof FareBreakdown>;

export const EstimatedEta = z.object({
  min_minutes: z.number().int().nonnegative(),
  max_minutes: z.number().int().nonnegative(),
  is_estimate: z.literal(true),
});
export type EstimatedEta = z.infer<typeof EstimatedEta>;

export const QuoteFareDTO = z.object({
  origin: Location,
  destination: Location,
  municipality_id: z.number().int().positive(),
  service_type: ServiceType.default('taxi'),
});
export type QuoteFareDTO = z.infer<typeof QuoteFareDTO>;

export const QuoteResponse = z.object({
  within_coverage: z.literal(true),
  service_type: ServiceType,
  payment_method: z.literal('cash'),
  fare: FareBreakdown,
  distance_km: z.number().nonnegative(),
  eta: EstimatedEta.nullable(),
  quote_token: z.string().min(1),
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

export const CreateTripRequestDTO = z.object({
  origin: Location,
  destination: Location,
  municipality_id: z.number().int().positive(),
  service_type: ServiceType.default('taxi'),
  payment_method: PaymentMethod.default('cash'),
  quote_token: z.string().min(1),
});
export type CreateTripRequestDTO = z.infer<typeof CreateTripRequestDTO>;

export const TripRequestCreated = z.object({
  trip_request_id: z.number().int().positive(),
  status: TripStatus,
  service_type: ServiceType,
  payment_method: PaymentMethod,
  fare: FareBreakdown,
  requested_at: z.string().datetime(),
});
export type TripRequestCreated = z.infer<typeof TripRequestCreated>;

export const CancelTripRequestDTO = z.object({
  reason: z.string().max(280).optional(),
});
export type CancelTripRequestDTO = z.infer<typeof CancelTripRequestDTO>;

export const TripRequestCancelled = z.object({
  trip_request_id: z.number().int().positive(),
  status: z.literal('cancelled_by_passenger'),
  free_of_charge: z.boolean(),
  penalty_recorded: z.boolean(),
  cancelled_at: z.string().datetime(),
});
export type TripRequestCancelled = z.infer<typeof TripRequestCancelled>;

export const AssignedDriverSummary = z.object({
  name: z.string(),
  plate: z.string(),
  model: z.string().nullable(),
  contact_phone: z.string().nullable(),
  eta: EstimatedEta.nullable(),
});
export type AssignedDriverSummary = z.infer<typeof AssignedDriverSummary>;

export const TripRequestStatus = z.object({
  trip_request_id: z.number().int().positive(),
  status: TripStatus,
  ui: PassengerUiState,
  fare: FareBreakdown,
  driver: AssignedDriverSummary.nullable(),
  arrived_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
});
export type TripRequestStatus = z.infer<typeof TripRequestStatus>;

export const TripErrorCode = z.enum([
  'OUT_OF_COVERAGE',
  'QUOTE_EXPIRED',
  'ACTIVE_TRIP_REQUEST_EXISTS',
  'STATUS_NOT_CANCELLABLE',
  'NOT_OWNER',
  'TRIP_REQUEST_NOT_FOUND',
  'FARE_NOT_CONFIGURED',
  'NO_COMPANY_AVAILABLE',
  'INVALID_TRIP_TRANSITION',
  'NOT_THE_DRIVER',
  'NO_ACTIVE_ASSIGNMENT',
  'ARRIVAL_NOT_MARKED',
  'NO_SHOW_GRACE_PENDING',
]);
export type TripErrorCode = z.infer<typeof TripErrorCode>;

export const TripError = z.object({
  code: TripErrorCode,
  message: z.string(),
  remaining_seconds: z.number().int().nonnegative().optional(),
});
export type TripError = z.infer<typeof TripError>;

export const TRIPS_EVENTS = {
  TRIP_REQUEST_CREATED: 'trip_request.created',
  TRIP_REQUEST_CANCELLED: 'trip_request.cancelled',
  TRIP_REQUEST_NO_DRIVER: 'trip_request.no_driver',
  TRIP_REQUEST_EXPIRED: 'trip_request.expired',
  TRIP_REQUEST_COMPLETED: 'trip_request.completed',
  TRIP_REQUEST_NO_SHOW: 'trip_request.no_show',
} as const;
export type TripsEventName = (typeof TRIPS_EVENTS)[keyof typeof TRIPS_EVENTS];

export const TripRequestCreatedEvent = z.object({
  trip_request_id: z.number().int().positive(),
  passenger_id: z.number().int().positive(),
  municipality_id: z.number().int().positive(),
  service_type: ServiceType,
  origin: Coordinate,
  occurred_at: z.string().datetime(),
});
export type TripRequestCreatedEvent = z.infer<typeof TripRequestCreatedEvent>;

export const TripRequestCancelledEvent = z.object({
  trip_request_id: z.number().int().positive(),
  cancelled_by: z.literal('passenger'),
  released_driver_id: z.number().int().positive().nullable(),
  occurred_at: z.string().datetime(),
});
export type TripRequestCancelledEvent = z.infer<typeof TripRequestCancelledEvent>;

export const TripRequestNoDriverEvent = z.object({
  trip_request_id: z.number().int().positive(),
  attempts_made: z.number().int().nonnegative(),
  final_radius_km: z.number().positive(),
  occurred_at: z.string().datetime(),
});
export type TripRequestNoDriverEvent = z.infer<typeof TripRequestNoDriverEvent>;

export const TripRequestExpiredEvent = z.object({
  trip_request_id: z.number().int().positive(),
  occurred_at: z.string().datetime(),
});
export type TripRequestExpiredEvent = z.infer<typeof TripRequestExpiredEvent>;

export const TripRequestCompletedEvent = z.object({
  trip_request_id: z.number().int().positive(),
  passenger_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  net_earnings: AmountCop,
  cash_collected: z.boolean(),
  occurred_at: z.string().datetime(),
});
export type TripRequestCompletedEvent = z.infer<typeof TripRequestCompletedEvent>;

export const TripRequestNoShowEvent = z.object({
  trip_request_id: z.number().int().positive(),
  passenger_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  arrived_at: z.string().datetime(),
  occurred_at: z.string().datetime(),
});
export type TripRequestNoShowEvent = z.infer<typeof TripRequestNoShowEvent>;
