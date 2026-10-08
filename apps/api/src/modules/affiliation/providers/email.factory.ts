import { EnvService } from '../../../config/env.service';
import type { EmailProvider } from '../ports/email-provider.port';
import { NoopEmailProvider } from './noop-email.provider';
import { SendgridEmailProvider } from './sendgrid-email.provider';

export function createEmailProvider(env: EnvService): EmailProvider {
  if (env.get('EMAIL_PROVIDER') === 'sendgrid') {
    const apiKey = env.get('SENDGRID_API_KEY');
    const from = env.get('EMAIL_FROM');
    if (!apiKey || !from) {
      throw new Error('EMAIL: EMAIL_PROVIDER=sendgrid requires SENDGRID_API_KEY / EMAIL_FROM.');
    }
    return new SendgridEmailProvider({ apiKey, from, fromName: env.get('EMAIL_FROM_NAME') });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error('EMAIL: the stub is forbidden in production. Set EMAIL_PROVIDER=sendgrid.');
  }

  return new NoopEmailProvider(env);
}
