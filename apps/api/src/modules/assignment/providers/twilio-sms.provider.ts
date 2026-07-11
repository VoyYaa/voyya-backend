import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import twilio from 'twilio';
import type { SmsProvider } from '../ports/sms-provider.port';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: ReturnType<typeof twilio>;
  private readonly from: string;

  constructor(config: TwilioConfig) {
    this.client = twilio(config.accountSid, config.authToken);
    this.from = config.fromNumber;
  }

  async send(phone: string, message: string): Promise<void> {
    const to = toE164(phone);
    try {
      await this.client.messages.create({ to, from: this.from, body: message });
      this.logger.log(`[sms:twilio] sent to=${mask(to)}`);
    } catch {
      this.logger.error(`[sms:twilio] send failed to=${mask(to)}`);
      throw new ServiceUnavailableException({
        code: 'SMS_SEND_FAILED',
        message: 'No se pudo enviar el SMS',
      });
    }
  }
}

function toE164(phone: string): string {
  const t = phone.trim();
  if (t.startsWith('+')) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `+57${d}`;
  if (d.length === 12 && d.startsWith('57')) return `+${d}`;
  return `+${d}`;
}

function mask(phone: string): string {
  if (phone.length <= 4) return '****';
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}
