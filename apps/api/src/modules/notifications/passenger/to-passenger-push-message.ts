import { ANDROID_TRIP_UPDATES_CHANNEL_ID, type PassengerPushNotificationType } from '@voyyaa/shared';
import type { PushMessage } from '../ports/push-transport.port';
import { PASSENGER_PUSH_MESSAGES } from './passenger-push.messages';

export function passengerReplaceKey(tripRequestId: number): string {
  return `trip-${tripRequestId}`;
}

export function toPassengerPushMessage(
  type: PassengerPushNotificationType,
  tripRequestId: number,
  ttlSec: number,
): PushMessage {
  const copy = PASSENGER_PUSH_MESSAGES[type];
  return {
    title: copy.title,
    body: copy.body,
    data: { type, trip_request_id: tripRequestId },
    channelId: ANDROID_TRIP_UPDATES_CHANNEL_ID,
    ttlSec,
    priority: 'high',
    sound: 'default',
    replaceKey: passengerReplaceKey(tripRequestId),
  };
}
