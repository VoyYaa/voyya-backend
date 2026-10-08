import { EnvService } from '../../../config/env.service';
import type { SmsProvider } from '../ports/sms-provider.port';
import { NoopSmsProvider } from './noop-sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

export function createSmsProvider(env: EnvService): SmsProvider {
  if (env.get('SMS_PROVIDER') === 'twilio') {
    const accountSid = env.get('TWILIO_ACCOUNT_SID');
    const authToken = env.get('TWILIO_AUTH_TOKEN');
    const fromNumber = env.get('TWILIO_FROM_NUMBER');
    if (!accountSid || !authToken || !fromNumber) {
      throw new Error(
        'SMS: SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.',
      );
    }
    return new TwilioSmsProvider({ accountSid, authToken, fromNumber });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error('SMS: the stub is forbidden in production. Set SMS_PROVIDER=twilio.');
  }

  return new NoopSmsProvider(env);
}
