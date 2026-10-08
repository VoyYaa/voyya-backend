import type { EnvService } from '../../../config/env.service';
import { createEmailProvider } from './email.factory';
import { NoopEmailProvider } from './noop-email.provider';
import { SendgridEmailProvider } from './sendgrid-email.provider';

function env(vals: Record<string, unknown>): EnvService {
  return { get: (k: string) => vals[k] } as unknown as EnvService;
}

const credentials = {
  SENDGRID_API_KEY: 'SG.key',
  EMAIL_FROM: 'no-reply@voyya.co',
  EMAIL_FROM_NAME: 'VoyYa',
};

describe('createEmailProvider (explicit selection)', () => {
  it('EMAIL_PROVIDER=sendgrid with credentials -> SendgridEmailProvider', () => {
    const p = createEmailProvider(
      env({ EMAIL_PROVIDER: 'sendgrid', NODE_ENV: 'production', ...credentials }),
    );
    expect(p).toBeInstanceOf(SendgridEmailProvider);
  });

  it('credentials present but EMAIL_PROVIDER=noop in development -> NoopEmailProvider', () => {
    const p = createEmailProvider(
      env({ EMAIL_PROVIDER: 'noop', NODE_ENV: 'development', ...credentials }),
    );
    expect(p).toBeInstanceOf(NoopEmailProvider);
  });

  it('EMAIL_PROVIDER=sendgrid without credentials -> throws', () => {
    expect(() =>
      createEmailProvider(env({ EMAIL_PROVIDER: 'sendgrid', NODE_ENV: 'development' })),
    ).toThrow();
  });

  it('noop in production -> throws', () => {
    expect(() =>
      createEmailProvider(env({ EMAIL_PROVIDER: 'noop', NODE_ENV: 'production', ...credentials })),
    ).toThrow();
  });
});
