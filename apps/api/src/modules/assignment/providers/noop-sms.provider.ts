import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import type { SmsProvider } from '../ports/sms-provider.port';

@Injectable()
export class NoopSmsProvider implements SmsProvider {
  private readonly logger = new Logger(NoopSmsProvider.name);

  constructor(private readonly env: EnvService) {}

  async send(phone: string, message: string): Promise<void> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(`[sms:dev] to=${mask(phone)} message="${message}"`);
    }
  }
}

function mask(phone: string): string {
  if (phone.length <= 4) return '****';
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}
