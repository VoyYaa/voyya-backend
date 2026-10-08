import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import type { SmsKind, SmsProvider } from '../ports/sms-provider.port';
import { maskPhone } from './mask-phone';

@Injectable()
export class NoopSmsProvider implements SmsProvider {
  private readonly logger = new Logger(NoopSmsProvider.name);

  constructor(private readonly env: EnvService) {}

  async send(phone: string, message: string, kind?: SmsKind): Promise<void> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(
        `[sms:dev] to=${maskPhone(phone)} kind=${kind ?? 'unknown'} length=${message.length}`,
      );
    }
  }
}
