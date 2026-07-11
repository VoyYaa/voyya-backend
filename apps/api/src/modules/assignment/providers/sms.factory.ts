import { EnvService } from '../../../config/env.service';
import type { SmsProvider } from '../ports/sms-provider.port';
import { NoopSmsProvider } from './noop-sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

export function createSmsProvider(env: EnvService): SmsProvider {
  const accountSid = env.get('TWILIO_ACCOUNT_SID');
  const authToken = env.get('TWILIO_AUTH_TOKEN');
  const fromNumber = env.get('TWILIO_FROM_NUMBER');

  if (accountSid && authToken && fromNumber) {
    return new TwilioSmsProvider({ accountSid, authToken, fromNumber });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error(
      'SMS: missing Twilio credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER) ' +
        'and the stub is forbidden in production. Configure them to enable OTP.',
    );
  }

  return new NoopSmsProvider(env);
}
