import { EnvService } from '../../../config/env.service';
import type { SmsProvider } from '../ports/sms-provider.port';
import { NoopSmsProvider } from './noop-sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

/**
 * Selección del proveedor SMS por ENTORNO (secretos solo por env):
 *   1. Si están las 3 credenciales de Twilio → `TwilioSmsProvider` (real).
 *   2. Si faltan y `NODE_ENV !== 'production'` → `NoopSmsProvider` (dev; loguea el OTP).
 *   3. Si faltan y `NODE_ENV === 'production'` → FAIL-FAST al arranque (login OTP quedaría
 *      inoperante). Nunca se usa el stub en producción.
 */
export function crearSmsProvider(env: EnvService): SmsProvider {
  const accountSid = env.get('TWILIO_ACCOUNT_SID');
  const authToken = env.get('TWILIO_AUTH_TOKEN');
  const fromNumber = env.get('TWILIO_FROM_NUMBER');

  if (accountSid && authToken && fromNumber) {
    return new TwilioSmsProvider({ accountSid, authToken, fromNumber });
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error(
      'SMS: faltan credenciales de Twilio (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / ' +
        'TWILIO_FROM_NUMBER) y el stub está prohibido en producción. Configúralas para habilitar el OTP.',
    );
  }

  return new NoopSmsProvider(env);
}
