import type {
  PushDelivery,
  PushLogRef,
  PushMessage,
  PushTransport,
} from './ports/push-transport.port';

export interface RecordedPush {
  userId: number;
  message: PushMessage;
  ref: PushLogRef;
}

export type RecordingMode = 'record' | 'reject' | 'hang';

export class RecordingPushTransport implements PushTransport {
  readonly sent: RecordedPush[] = [];
  mode: RecordingMode = 'record';
  beforeSend: ((index: number) => Promise<void>) | null = null;

  async send(userId: number, message: PushMessage, ref: PushLogRef): Promise<PushDelivery> {
    const index = this.sent.length;
    this.sent.push({ userId, message, ref });
    if (this.beforeSend) await this.beforeSend(index);
    if (this.mode === 'reject') throw new Error('push transport is down');
    if (this.mode === 'hang') return new Promise<PushDelivery>(() => undefined);
    return { outcome: 'sent', tokens: 1, ok: 1, failed: 0 };
  }

  reset(): void {
    this.sent.length = 0;
    this.mode = 'record';
    this.beforeSend = null;
  }
}
