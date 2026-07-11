import { z } from 'zod';
import { TripStatus } from './trips';

export const DriverStatus = z.enum([
  'available',
  'on_trip',
  'off_shift',
  'inactive',
  'suspended',
  'documents_blocked',
]);
export type DriverStatus = z.infer<typeof DriverStatus>;

export const AssignmentStatus = z.enum([
  'created',
  'notified',
  'accepted',
  'rejected',
  'timeout',
  'cancelled',
  'completed',
]);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

export const ASSIGNMENT_STATUS_TRANSITIONS = {
  created: ['notified', 'timeout'],
  notified: ['accepted', 'rejected', 'timeout'],
  accepted: ['cancelled', 'completed'],
  rejected: [],
  timeout: [],
  cancelled: [],
  completed: [],
} as const satisfies Record<AssignmentStatus, readonly AssignmentStatus[]>;

export function canTransitionAssignmentStatus(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return (ASSIGNMENT_STATUS_TRANSITIONS[from] as readonly AssignmentStatus[]).includes(to);
}

export const DriverCandidate = z.object({
  driver_id: z.number().int().positive(),
  vehicle_id: z.number().int().positive(),
  distance_m: z.number().nonnegative(),
  trips_last_3h: z.number().int().nonnegative(),
  attempt_order: z.number().int().positive(),
});
export type DriverCandidate = z.infer<typeof DriverCandidate>;

export const AssignmentNotification = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  origin: z.object({
    address: z.string(),
    lat: z.number(),
    lng: z.number(),
  }),
  dropoff_neighborhood: z.string(),
  total_fare: z.number().int().nonnegative(),
  distance_to_origin_m: z.number().nonnegative(),
  expires_at: z.string().datetime(),
  seconds_to_respond: z.number().int().positive(),
});
export type AssignmentNotification = z.infer<typeof AssignmentNotification>;

export const NearbyOffersResponse = z.array(AssignmentNotification);
export type NearbyOffersResponse = z.infer<typeof NearbyOffersResponse>;

export const AcceptAssignmentDTO = z.object({
  current_lat: z.number().optional(),
  current_lng: z.number().optional(),
});
export type AcceptAssignmentDTO = z.infer<typeof AcceptAssignmentDTO>;

export const AcceptAssignmentResult = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('accepted'),
    assignment_id: z.number().int().positive(),
    trip_request_id: z.number().int().positive(),
    trip_request_status: TripStatus,
    passenger: z.object({
      name: z.string(),
      contact_phone: z.string().nullable(),
      pickup_address: z.string(),
    }),
  }),
  z.object({
    result: z.literal('already_taken'),
    message: z.string(),
  }),
  z.object({
    result: z.literal('expired'),
    message: z.string(),
  }),
]);
export type AcceptAssignmentResult = z.infer<typeof AcceptAssignmentResult>;

export const RejectAssignmentDTO = z.object({
  reason: z.string().max(280).optional(),
});
export type RejectAssignmentDTO = z.infer<typeof RejectAssignmentDTO>;

export const CancelAssignmentByDriverDTO = z.object({
  reason: z.string().min(3).max(280),
});
export type CancelAssignmentByDriverDTO = z.infer<typeof CancelAssignmentByDriverDTO>;

export const CancelAssignmentByDriverResult = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  trip_request_status: TripStatus,
  searching_again: z.boolean(),
});
export type CancelAssignmentByDriverResult = z.infer<typeof CancelAssignmentByDriverResult>;

export const AssignmentErrorCode = z.enum([
  'ASSIGNMENT_NOT_FOUND',
  'NOT_THE_DRIVER',
  'INVALID_STATUS',
  'ASSIGNMENT_ALREADY_TAKEN',
  'ASSIGNMENT_EXPIRED',
  'OUT_OF_TENANT',
]);
export type AssignmentErrorCode = z.infer<typeof AssignmentErrorCode>;

export const AssignmentError = z.object({
  code: AssignmentErrorCode,
  message: z.string(),
});
export type AssignmentError = z.infer<typeof AssignmentError>;

export const ASSIGNMENT_EVENTS = {
  ASSIGNMENT_CREATED: 'assignment.created',
  ASSIGNMENT_NOTIFIED: 'assignment.notified',
  DRIVER_ASSIGNED: 'assignment.driver_assigned',
  ASSIGNMENT_REJECTED: 'assignment.rejected',
  ASSIGNMENT_EXPIRED: 'assignment.expired',
  ASSIGNMENT_CANCELLED_BY_DRIVER: 'assignment.cancelled_by_driver',
} as const;
export type AssignmentEventName = (typeof ASSIGNMENT_EVENTS)[keyof typeof ASSIGNMENT_EVENTS];

export const AssignmentCreatedEvent = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  attempt_order: z.number().int().positive(),
  expires_at: z.string().datetime(),
  occurred_at: z.string().datetime(),
});
export type AssignmentCreatedEvent = z.infer<typeof AssignmentCreatedEvent>;

export const DriverAssignedEvent = z.object({
  trip_request_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  vehicle_id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  occurred_at: z.string().datetime(),
});
export type DriverAssignedEvent = z.infer<typeof DriverAssignedEvent>;

export const AssignmentRejectedEvent = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  reason: z.string().nullable(),
  occurred_at: z.string().datetime(),
});
export type AssignmentRejectedEvent = z.infer<typeof AssignmentRejectedEvent>;

export const AssignmentExpiredEvent = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  attempt_order: z.number().int().positive(),
  occurred_at: z.string().datetime(),
});
export type AssignmentExpiredEvent = z.infer<typeof AssignmentExpiredEvent>;

export const AssignmentCancelledByDriverEvent = z.object({
  assignment_id: z.number().int().positive(),
  trip_request_id: z.number().int().positive(),
  driver_id: z.number().int().positive(),
  reason: z.string(),
  occurred_at: z.string().datetime(),
});
export type AssignmentCancelledByDriverEvent = z.infer<typeof AssignmentCancelledByDriverEvent>;
