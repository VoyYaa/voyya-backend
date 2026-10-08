import { Injectable, Logger } from '@nestjs/common';
import type { SmsKind, SmsProvider } from '../ports/sms-provider.port';
import { maskPhone } from './mask-phone';

export const CONSOLE_SMS_PREFIX = '[sms:console · SOLO DESARROLLO]';

@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  async send(phone: string, message: string, kind?: SmsKind): Promise<void> {
    this.logger.log(
      `${CONSOLE_SMS_PREFIX} to=${maskPhone(phone)} message=${message} kind=${kind ?? 'unknown'}`,
    );
  }
}
