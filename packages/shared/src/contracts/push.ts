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
} as const;
export type PushNotificationType =
  (typeof PUSH_NOTIFICATION_TYPES)[keyof typeof PUSH_NOTIFICATION_TYPES];

export const AssignmentOfferPushData = z.object({
  type: z.literal(PUSH_NOTIFICATION_TYPES.ASSIGNMENT_OFFER),
  assignment_id: z.coerce.number().int().positive(),
  trip_request_id: z.coerce.number().int().positive(),
  expires_at: z.string().datetime(),
});
export type AssignmentOfferPushData = z.infer<typeof AssignmentOfferPushData>;

export const PushNotificationData = z.discriminatedUnion('type', [AssignmentOfferPushData]);
export type PushNotificationData = z.infer<typeof PushNotificationData>;

export const ANDROID_ASSIGNMENT_CHANNEL_ID = 'assignment-offers';
