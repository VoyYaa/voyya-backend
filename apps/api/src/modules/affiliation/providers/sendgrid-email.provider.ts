import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { EmailMessage, EmailProvider } from '../ports/email-provider.port';

export interface SendgridConfig {
  apiKey: string;
  from: string;
  fromName: string;
}

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

@Injectable()
export class SendgridEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SendgridEmailProvider.name);

  constructor(private readonly config: SendgridConfig) {}

  async send(message: EmailMessage): Promise<void> {
    try {
      const res = await fetch(SENDGRID_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: this.config.from, name: this.config.fromName },
          subject: message.subject,
          content: [{ type: 'text/plain', value: message.text }],
        }),
      });
      if (!res.ok) {
        throw new Error(`SendGrid responded ${res.status}`);
      }
      this.logger.log(`[email:sendgrid] sent to=${mask(message.to)}`);
    } catch {
      this.logger.error(`[email:sendgrid] send failed to=${mask(message.to)}`);
      throw new ServiceUnavailableException({
        code: 'EMAIL_SEND_FAILED',
        message: 'No se pudo enviar el correo',
      });
    }
  }
}

function mask(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '****';
  return `${user.slice(0, 2)}***@${domain}`;
}
