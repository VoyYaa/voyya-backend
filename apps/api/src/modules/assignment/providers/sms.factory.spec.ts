import type { EnvService } from '../../../config/env.service';
import { ConsoleSmsProvider } from './console-sms.provider';
import { NoopSmsProvider } from './noop-sms.provider';
import { createSmsProvider } from './sms.factory';
import { TwilioSmsProvider } from './twilio-sms.provider';

function env(vals: Record<string, unknown>): EnvService {
  return { get: (k: string) => vals[k] } as unknown as EnvService;
}

const credentials = {
  TWILIO_ACCOUNT_SID: 'AC123abc',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM_NUMBER: '+573001112233',
};

describe('createSmsProvider (explicit selection)', () => {
  it('SMS_PROVIDER=twilio with credentials -> TwilioSmsProvider', () => {
    const p = createSmsProvider(
      env({ SMS_PROVIDER: 'twilio', NODE_ENV: 'production', ...credentials }),
    );
    expect(p).toBeInstanceOf(TwilioSmsProvider);
  });

  it('credentials present but SMS_PROVIDER=noop in development -> NoopSmsProvider', () => {
    const p = createSmsProvider(
      env({ SMS_PROVIDER: 'noop', NODE_ENV: 'development', ...credentials }),
    );
    expect(p).toBeInstanceOf(NoopSmsProvider);
  });

  it('SMS_PROVIDER=twilio without credentials -> throws', () => {
    expect(() =>
      createSmsProvider(env({ SMS_PROVIDER: 'twilio', NODE_ENV: 'development' })),
    ).toThrow();
  });

  it('noop in production -> throws, even with credentials present', () => {
    expect(() =>
      createSmsProvider(env({ SMS_PROVIDER: 'noop', NODE_ENV: 'production', ...credentials })),
    ).toThrow();
  });

  it('SMS_PROVIDER=console in development -> ConsoleSmsProvider', () => {
    const p = createSmsProvider(env({ SMS_PROVIDER: 'console', NODE_ENV: 'development' }));
    expect(p).toBeInstanceOf(ConsoleSmsProvider);
  });

  it('SMS_PROVIDER=console in test -> ConsoleSmsProvider', () => {
    const p = createSmsProvider(env({ SMS_PROVIDER: 'console', NODE_ENV: 'test' }));
    expect(p).toBeInstanceOf(ConsoleSmsProvider);
  });

  it('console in production -> throws, even with credentials present', () => {
    expect(() =>
      createSmsProvider(env({ SMS_PROVIDER: 'console', NODE_ENV: 'production', ...credentials })),
    ).toThrow();
  });
});
