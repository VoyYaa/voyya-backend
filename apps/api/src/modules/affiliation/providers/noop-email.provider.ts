import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import type { EmailMessage, EmailProvider } from '../ports/email-provider.port';

@Injectable()
export class NoopEmailProvider implements EmailProvider {
  private readonly logger = new Logger(NoopEmailProvider.name);

  constructor(private readonly env: EnvService) {}

  async send(message: EmailMessage): Promise<void> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(`[email:dev] to=${mask(message.to)} subject="${message.subject}"`);
    }
  }
}

function mask(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '****';
  return `${user.slice(0, 2)}***@${domain}`;
}
