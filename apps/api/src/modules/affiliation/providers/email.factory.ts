import { EnvService } from '../../../config/env.service';
import type { EmailProvider } from '../ports/email-provider.port';
import { NoopEmailProvider } from './noop-email.provider';
import { SendgridEmailProvider } from './sendgrid-email.provider';

export function createEmailProvider(env: EnvService): EmailProvider {
  const apiKey = env.get('SENDGRID_API_KEY');
  const from = env.get('EMAIL_FROM');

  if (apiKey && from) {
    return new SendgridEmailProvider({ apiKey, from, fromName: env.get('EMAIL_FROM_NAME') });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error(
      'EMAIL: missing SendGrid credentials (SENDGRID_API_KEY / EMAIL_FROM) ' +
        'and the stub is forbidden in production. Configure them to enable notifications.',
    );
  }

  return new NoopEmailProvider(env);
}
