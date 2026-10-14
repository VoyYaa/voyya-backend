import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import type {
  PushDelivery,
  PushLogRef,
  PushMessage,
  PushTransport,
} from '../ports/push-transport.port';
import { pushSubject } from './push-log';

@Injectable()
export class NoopPushTransport implements PushTransport {
  private readonly logger = new Logger(NoopPushTransport.name);

  constructor(private readonly env: EnvService) {}

  async send(userId: number, _message: PushMessage, ref: PushLogRef): Promise<PushDelivery> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(`[push:noop] audience=${ref.audience} ${pushSubject(userId, ref)}`);
    }
    return { outcome: 'disabled' };
  }
}
