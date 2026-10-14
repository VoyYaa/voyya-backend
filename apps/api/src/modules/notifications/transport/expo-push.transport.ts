import { Injectable, Logger } from '@nestjs/common';
import type * as ExpoServerSdk from 'expo-server-sdk';
import { EnvService } from '../../../config/env.service';
import type {
  PushDelivery,
  PushLogRef,
  PushMessage,
  PushTransport,
} from '../ports/push-transport.port';
import { PushTokenRepository } from '../push-token.repository';
import { pushLagSuffix, pushOwner, pushSubject } from './push-log';

type ExpoClient = ExpoServerSdk.Expo;
type ExpoClientClass = typeof ExpoServerSdk.Expo;
type ExpoPushMessage = ExpoServerSdk.ExpoPushMessage;
type ExpoPushTicket = ExpoServerSdk.ExpoPushTicket;

function loadExpoClient(): ExpoClientClass {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('expo-server-sdk') as { Expo: ExpoClientClass }).Expo;
}

export function maskToken(token: string): string {
  if (token.length <= 6) return token;
  return `…${token.slice(-6)}`;
}

export function toExpoMessage(token: string, message: PushMessage): ExpoPushMessage {
  const base: ExpoPushMessage = {
    to: token,
    title: message.title,
    body: message.body,
    data: message.data,
    sound: message.sound,
    priority: message.priority,
    channelId: message.channelId,
    ttl: message.ttlSec,
  };
  if (message.replaceKey === null) return base;
  return { ...base, tag: message.replaceKey, collapseId: message.replaceKey };
}

@Injectable()
export class ExpoPushTransport implements PushTransport {
  private readonly logger = new Logger(ExpoPushTransport.name);
  private readonly ExpoClass = loadExpoClient();
  private readonly expo: ExpoClient;

  constructor(
    private readonly env: EnvService,
    private readonly tokens: PushTokenRepository,
    accessToken: string,
  ) {
    this.expo = new this.ExpoClass({ accessToken });
  }

  async send(userId: number, message: PushMessage, ref: PushLogRef): Promise<PushDelivery> {
    try {
      return await this.race(userId, ref, this.deliver(userId, message, ref));
    } catch {
      return { outcome: 'error' };
    }
  }

  private async race(
    userId: number,
    ref: PushLogRef,
    delivery: Promise<PushDelivery>,
  ): Promise<PushDelivery> {
    const timeoutMs = this.env.get('PUSH_SEND_TIMEOUT_MS');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PushDelivery>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(`[push:expo] timeout ${pushSubject(userId, ref)} ms=${timeoutMs}`);
        resolve({ outcome: 'timeout' });
      }, timeoutMs);
    });
    try {
      return await Promise.race([delivery, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async deliver(
    userId: number,
    message: PushMessage,
    ref: PushLogRef,
  ): Promise<PushDelivery> {
    try {
      const stored = await this.tokens.listByUser(userId);
      const messages = stored
        .filter((token) => this.ExpoClass.isExpoPushToken(token))
        .map((token) => toExpoMessage(token, message));

      if (messages.length === 0) {
        this.logger.log(`[push:expo] no-token ${pushSubject(userId, ref)}`);
        return { outcome: 'no_token' };
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
          this.handleFailedTicket(pushOwner(userId, ref), token, ticket);
        }
      }
      this.logger.log(
        `[push:expo] sent ${pushSubject(userId, ref)} tokens=${messages.length} ok=${ok} failed=${failed}${pushLagSuffix(ref, Date.now())}`,
      );
      return { outcome: 'sent', tokens: messages.length, ok, failed };
    } catch {
      this.logger.error(`[push:expo] send failed ${pushSubject(userId, ref)}`);
      return { outcome: 'error' };
    }
  }

  private handleFailedTicket(owner: string, token: string, ticket: ExpoPushTicket): void {
    const errorCode = ticket.status === 'error' ? ticket.details?.error : undefined;
    const masked = maskToken(token);
    switch (errorCode) {
      case 'DeviceNotRegistered':
        void this.tokens.drop(token).catch(() => undefined);
        this.logger.log(`[push:expo] dropped token=${masked} reason=device_not_registered ${owner}`);
        return;
      case 'MismatchSenderId':
        void this.tokens.drop(token).catch(() => undefined);
        this.logger.error(`[push:expo] dropped token=${masked} reason=mismatch_sender_id ${owner}`);
        return;
      case 'MessageTooBig':
        this.logger.error(`[push:expo] rejected token=${masked} reason=message_too_big ${owner}`);
        return;
      case 'MessageRateExceeded':
        this.logger.warn(`[push:expo] rejected token=${masked} reason=message_rate_exceeded ${owner}`);
        return;
      case 'InvalidCredentials':
        this.logger.error(`[push:expo] rejected token=${masked} reason=invalid_credentials ${owner}`);
        return;
      default:
        this.logger.error(`[push:expo] rejected token=${masked} reason=unknown ${owner}`);
    }
  }
}
