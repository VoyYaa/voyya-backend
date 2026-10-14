import type { PassengerPushNotificationType, PushNotificationData } from '@voyyaa/shared';

export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

export interface PushMessage {
  title: string;
  body: string;
  data: PushNotificationData;
  channelId: string;
  ttlSec: number;
  priority: 'high';
  sound: 'default';
  replaceKey: string | null;
}

export type PushLogRef =
  | { audience: 'driver'; assignmentId: number }
  | {
      audience: 'passenger';
      tripRequestId: number;
      type: PassengerPushNotificationType;
      occurredAtMs: number;
    };

export type PushDelivery =
  | { outcome: 'sent'; tokens: number; ok: number; failed: number }
  | { outcome: 'no_token' }
  | { outcome: 'timeout' }
  | { outcome: 'error' }
  | { outcome: 'disabled' };

export interface PushTransport {
  send(userId: number, message: PushMessage, ref: PushLogRef): Promise<PushDelivery>;
}
