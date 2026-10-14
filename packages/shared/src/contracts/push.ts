import { z } from 'zod';

export const PushTokenPlatform = z.enum(['android', 'ios']);
export type PushTokenPlatform = z.infer<typeof PushTokenPlatform>;

export const ExpoPushToken = z
  .string()
  .trim()
  .regex(/^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$/, 'Token de notificaciones inválido');
export type ExpoPushToken = z.infer<typeof ExpoPushToken>;

export const RegisterPushTokenDTO = z.object({
  token: ExpoPushToken,
  platform: PushTokenPlatform,
});
export type RegisterPushTokenDTO = z.infer<typeof RegisterPushTokenDTO>;

export const RevokePushTokenDTO = z.object({
  token: ExpoPushToken,
});
export type RevokePushTokenDTO = z.infer<typeof RevokePushTokenDTO>;

export const PUSH_NOTIFICATION_TYPES = {
  ASSIGNMENT_OFFER: 'assignment_offer',
  TRIP_DRIVER_ASSIGNED: 'trip_driver_assigned',
  TRIP_DRIVER_REASSIGNED: 'trip_driver_reassigned',
  TRIP_DRIVER_CANCELLED_SEARCHING: 'trip_driver_cancelled_searching',
  TRIP_DRIVER_CANCELLED_ENDED: 'trip_driver_cancelled_ended',
  TRIP_DRIVER_ARRIVED: 'trip_driver_arrived',
  TRIP_NO_DRIVER: 'trip_no_driver',
} as const;
export type PushNotificationType =
  (typeof PUSH_NOTIFICATION_TYPES)[keyof typeof PUSH_NOTIFICATION_TYPES];

export const PUSH_ENTITY_ID_MAX = 2_147_483_647;

const PushEntityId = z
  .union([z.string().regex(/^\d+$/), z.number()])
  .pipe(z.coerce.number().int().positive().max(PUSH_ENTITY_ID_MAX));

export const AssignmentOfferPushData = z.object({
  type: z.literal(PUSH_NOTIFICATION_TYPES.ASSIGNMENT_OFFER),
  assignment_id: PushEntityId,
  trip_request_id: PushEntityId,
  expires_at: z.string().datetime(),
});
export type AssignmentOfferPushData = z.infer<typeof AssignmentOfferPushData>;

export const DriverPushData = z.discriminatedUnion('type', [AssignmentOfferPushData]);
export type DriverPushData = z.infer<typeof DriverPushData>;

export const PASSENGER_PUSH_NOTIFICATION_TYPES = [
  PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_ASSIGNED,
  PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_REASSIGNED,
  PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_CANCELLED_SEARCHING,
  PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_CANCELLED_ENDED,
  PUSH_NOTIFICATION_TYPES.TRIP_DRIVER_ARRIVED,
  PUSH_NOTIFICATION_TYPES.TRIP_NO_DRIVER,
] as const;
export const PassengerPushNotificationType = z.enum(PASSENGER_PUSH_NOTIFICATION_TYPES);
export type PassengerPushNotificationType = z.infer<typeof PassengerPushNotificationType>;

export const PassengerPushData = z.object({
  type: PassengerPushNotificationType,
  trip_request_id: PushEntityId,
});
export type PassengerPushData = z.infer<typeof PassengerPushData>;

export const PushNotificationData = z.discriminatedUnion('type', [
  AssignmentOfferPushData,
  PassengerPushData,
]);
export type PushNotificationData = z.infer<typeof PushNotificationData>;

export const ANDROID_ASSIGNMENT_CHANNEL_ID = 'assignment-offers';

export const ANDROID_TRIP_UPDATES_CHANNEL_ID = 'trip-updates';
