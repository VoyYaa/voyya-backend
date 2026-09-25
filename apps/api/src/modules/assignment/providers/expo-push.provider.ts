import { Injectable, Logger } from '@nestjs/common';
import type * as ExpoServerSdk from 'expo-server-sdk';
import {
  ANDROID_ASSIGNMENT_CHANNEL_ID,
  PUSH_NOTIFICATION_TYPES,
  type AssignmentNotification,
} from '@voyyaa/shared';
import { EnvService } from '../../../config/env.service';
import type { PushProvider } from '../ports/push-provider.port';
import { PushTokenRepository } from '../push-token.repository';

type ExpoClient = ExpoServerSdk.Expo;
type ExpoClientClass = typeof ExpoServerSdk.Expo;
type ExpoPushMessage = ExpoServerSdk.ExpoPushMessage;
type ExpoPushTicket = ExpoServerSdk.ExpoPushTicket;

function loadExpoClient(): ExpoClientClass {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('expo-server-sdk') as { Expo: ExpoClientClass }).Expo;
}

export interface AssignmentPushMessage {
  title: string;
  body: string;
  data: {
    type: typeof PUSH_NOTIFICATION_TYPES.ASSIGNMENT_OFFER;
    assignment_id: number;
    trip_request_id: number;
    expires_at: string;
  };
}

export function toAssignmentPushMessage(
  notification: AssignmentNotification,
): AssignmentPushMessage {
  return {
    title: 'Nuevo viaje disponible',
    body: `$${formatCop(notification.total_fare)} · recogida a ${notification.distance_to_origin_m} m`,
    data: {
      type: PUSH_NOTIFICATION_TYPES.ASSIGNMENT_OFFER,
      assignment_id: notification.assignment_id,
      trip_request_id: notification.trip_request_id,
      expires_at: notification.expires_at,
    },
  };
}

export function formatCop(amount: number): string {
  return Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function maskToken(token: string): string {
  if (token.length <= 6) return token;
  return `…${token.slice(-6)}`;
}

@Injectable()
export class ExpoPushProvider implements PushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);
  private readonly ExpoClass = loadExpoClient();
  private readonly expo: ExpoClient;

  constructor(
    private readonly env: EnvService,
    private readonly tokens: PushTokenRepository,
    accessToken: string,
  ) {
    this.expo = new this.ExpoClass({ accessToken });
  }

  async sendAssignment(
    target: { driverId: number },
    notification: AssignmentNotification,
  ): Promise<void> {
    try {
      await this.race(target.driverId, notification, this.deliver(target.driverId, notification));
    } catch {
      return;
    }
  }

  private async race(
    driverId: number,
    notification: AssignmentNotification,
    delivery: Promise<void>,
  ): Promise<void> {
    const timeoutMs = this.env.get('PUSH_SEND_TIMEOUT_MS');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `[push:expo] timeout driver=${driverId} assignment=${notification.assignment_id} ms=${timeoutMs}`,
        );
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([delivery, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async deliver(driverId: number, notification: AssignmentNotification): Promise<void> {
    try {
      const tokens = await this.tokens.listByUser(driverId);
      if (tokens.length === 0) {
        this.logger.log(`[push:expo] no-token driver=${driverId} assignment=${notification.assignment_id}`);
        return;
      }

      const message = toAssignmentPushMessage(notification);
      const messages: ExpoPushMessage[] = tokens
        .filter((token) => this.ExpoClass.isExpoPushToken(token))
        .map((token) => ({
          to: token,
          title: message.title,
          body: message.body,
          data: message.data,
          sound: 'default',
          priority: 'high',
          channelId: ANDROID_ASSIGNMENT_CHANNEL_ID,
          ttl: notification.seconds_to_respond,
        }));

      if (messages.length === 0) {
        this.logger.log(`[push:expo] no-token driver=${driverId} assignment=${notification.assignment_id}`);
        return;
      }

      let ok = 0;
      let failed = 0;
      const chunks = this.expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < tickets.length; i += 1) {
          const ticket = tickets[i];
          const token = chunk[i]?.to;
          if (!ticket || typeof token !== 'string') continue;
          if (ticket.status === 'ok') {
            ok += 1;
            continue;
          }
          failed += 1;
          this.handleFailedTicket(driverId, token, ticket);
        }
      }
      this.logger.log(
        `[push:expo] sent driver=${driverId} assignment=${notification.assignment_id} tokens=${messages.length} ok=${ok} failed=${failed}`,
      );
    } catch {
      this.logger.error(
        `[push:expo] send failed driver=${driverId} assignment=${notification.assignment_id}`,
      );
    }
  }

  private handleFailedTicket(driverId: number, token: string, ticket: ExpoPushTicket): void {
    const errorCode = ticket.status === 'error' ? ticket.details?.error : undefined;
    const masked = maskToken(token);
    switch (errorCode) {
      case 'DeviceNotRegistered':
        void this.tokens.drop(token);
        this.logger.log(`[push:expo] dropped token=${masked} reason=device_not_registered driver=${driverId}`);
        return;
      case 'MismatchSenderId':
        void this.tokens.drop(token);
        this.logger.error(`[push:expo] dropped token=${masked} reason=mismatch_sender_id driver=${driverId}`);
        return;
      case 'MessageTooBig':
        this.logger.error(`[push:expo] rejected token=${masked} reason=message_too_big driver=${driverId}`);
        return;
      case 'MessageRateExceeded':
        this.logger.warn(`[push:expo] rejected token=${masked} reason=message_rate_exceeded driver=${driverId}`);
        return;
      case 'InvalidCredentials':
        this.logger.error(`[push:expo] rejected token=${masked} reason=invalid_credentials driver=${driverId}`);
        return;
      default:
        this.logger.error(`[push:expo] rejected token=${masked} reason=unknown driver=${driverId}`);
    }
  }
}
