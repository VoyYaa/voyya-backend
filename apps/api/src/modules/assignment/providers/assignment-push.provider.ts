import { Inject, Injectable } from '@nestjs/common';
import {
  ANDROID_ASSIGNMENT_CHANNEL_ID,
  PUSH_NOTIFICATION_TYPES,
  type AssignmentNotification,
} from '@voyyaa/shared';
import {
  PUSH_TRANSPORT,
  type PushMessage,
  type PushTransport,
} from '../../notifications/ports/push-transport.port';
import type { PushProvider } from '../ports/push-provider.port';

export function formatCop(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function toAssignmentPushMessage(notification: AssignmentNotification): PushMessage {
  return {
    title: 'Nuevo viaje disponible',
    body: `$${formatCop(notification.total_fare)} · recogida a ${notification.distance_to_origin_m} m`,
    data: {
      type: PUSH_NOTIFICATION_TYPES.ASSIGNMENT_OFFER,
      assignment_id: notification.assignment_id,
      trip_request_id: notification.trip_request_id,
      expires_at: notification.expires_at,
    },
    channelId: ANDROID_ASSIGNMENT_CHANNEL_ID,
    ttlSec: notification.seconds_to_respond,
    priority: 'high',
    sound: 'default',
    replaceKey: null,
  };
}

@Injectable()
export class AssignmentPushProvider implements PushProvider {
  constructor(@Inject(PUSH_TRANSPORT) private readonly transport: PushTransport) {}

  async sendAssignment(
    target: { driverId: number },
    notification: AssignmentNotification,
  ): Promise<void> {
    try {
      await this.transport.send(target.driverId, toAssignmentPushMessage(notification), {
        audience: 'driver',
        assignmentId: notification.assignment_id,
      });
    } catch {
      return;
    }
  }
}
