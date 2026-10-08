import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  QUOTE_TOKEN_SECRET: 'y'.repeat(32),
  AFFILIATION_TOKEN_SECRET: 'z'.repeat(32),
  AFFILIATION_PORTAL_URL: 'https://admin.voyya.test',
  API_PUBLIC_URL: 'https://api.voyya.test',
};

const twilio = {
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'AC123abc',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM_NUMBER: '+573001112233',
};

const production = {
  ...base,
  ...twilio,
  NODE_ENV: 'production',
  EMAIL_PROVIDER: 'sendgrid',
  SENDGRID_API_KEY: 'SG.key',
  EMAIL_FROM: 'no-reply@voyya.co',
  PUSH_PROVIDER: 'expo',
  EXPO_ACCESS_TOKEN: 'expo-token',
  CORS_ORIGINS: 'https://admin.voyya.co',
};

function failureOf(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('validateEnv — provider selection', () => {
  it('defaults every provider to noop outside production', () => {
    const env = validateEnv({ ...base, NODE_ENV: 'development' });
    expect(env.SMS_PROVIDER).toBe('noop');
    expect(env.EMAIL_PROVIDER).toBe('noop');
    expect(env.PUSH_PROVIDER).toBe('noop');
  });

  it('keeps noop even when real credentials are present but no provider is selected', () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: 'development',
      TWILIO_ACCOUNT_SID: 'AC123abc',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+573001112233',
    });
    expect(env.SMS_PROVIDER).toBe('noop');
  });

  it('rejects an unknown provider value', () => {
    expect(failureOf({ ...base, SMS_PROVIDER: 'sns' })).toContain('SMS_PROVIDER');
  });

  it.each([
    ['SMS_PROVIDER=twilio without credentials', { SMS_PROVIDER: 'twilio' }, 'TWILIO_ACCOUNT_SID'],
    [
      'EMAIL_PROVIDER=sendgrid without credentials',
      { EMAIL_PROVIDER: 'sendgrid' },
      'SENDGRID_API_KEY',
    ],
    ['PUSH_PROVIDER=expo without token', { PUSH_PROVIDER: 'expo' }, 'EXPO_ACCESS_TOKEN'],
  ])('rejects %s', (_label, extra, field) => {
    expect(failureOf({ ...base, ...extra })).toContain(field);
  });

  it('accepts a complete production configuration', () => {
    expect(failureOf(production)).toBe('');
  });

  it.each([
    ['SMS_PROVIDER', 'noop'],
    ['EMAIL_PROVIDER', 'noop'],
    ['PUSH_PROVIDER', 'noop'],
  ])('rejects %s=%s in production', (key, value) => {
    expect(failureOf({ ...production, [key]: value })).toContain(key);
  });

  it.each(['SMS_PROVIDER', 'EMAIL_PROVIDER', 'PUSH_PROVIDER'])(
    'rejects a missing %s in production',
    (key) => {
      const { [key]: _omitted, ...rest } = production as Record<string, unknown>;
      expect(failureOf(rest)).toContain(key);
    },
  );
});

describe('validateEnv — CORS_ORIGINS in production', () => {
  it('accepts a list of https origins', () => {
    const env = validateEnv({
      ...production,
      CORS_ORIGINS: 'https://admin.voyya.co, https://voyya.co',
    });
    expect(env.CORS_ORIGINS).toContain('https://admin.voyya.co');
  });

  it.each([
    ['empty', ''],
    ['only separators', ' , '],
    ['http origin', 'http://admin.voyya.co'],
    ['wildcard', '*'],
    ['path suffix', 'https://admin.voyya.co/app'],
    ['trailing slash', 'https://admin.voyya.co/'],
    ['not a url', 'admin.voyya.co'],
    ['one bad entry in a list', 'https://admin.voyya.co,http://evil.test'],
  ])('rejects %s', (_label, value) => {
    expect(failureOf({ ...production, CORS_ORIGINS: value })).toContain('CORS_ORIGINS');
  });

  it('rejects when it is omitted', () => {
    const { CORS_ORIGINS: _omitted, ...rest } = production;
    expect(failureOf(rest)).toContain('CORS_ORIGINS');
  });

  it('stays optional outside production', () => {
    expect(failureOf({ ...base, NODE_ENV: 'development' })).toBe('');
    expect(failureOf({ ...base, NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5173' })).toBe('');
  });
});
