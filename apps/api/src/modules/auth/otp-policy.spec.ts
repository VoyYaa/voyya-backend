import { OTP_DAILY_WINDOW_SECONDS } from '../../config/otp-limits';
import { validateEnv } from '../../config/env';
import type { EnvService } from '../../config/env.service';
import {
  crossesGlobalWarning,
  decideRefusal,
  OTP_ISSUE_CONCURRENCY,
  OTP_ISSUE_LOCK_NAMESPACE,
  OTP_ISSUE_QUEUE_MAX,
  OTP_ISSUE_QUEUE_TIMEOUT_MS,
  OTP_ISSUE_SATURATED_RETRY_SEC,
  otpRetentionSeconds,
  reachesGlobalLimit,
  readOtpIssuancePolicy,
} from './otp-policy';

const requiredEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  QUOTE_TOKEN_SECRET: 'y'.repeat(32),
  AFFILIATION_TOKEN_SECRET: 'z'.repeat(32),
  AFFILIATION_PORTAL_URL: 'https://admin.voyya.test',
  API_PUBLIC_URL: 'https://api.voyya.test',
};

function envServiceFor(overrides: Record<string, unknown> = {}): EnvService {
  const env = validateEnv({ ...requiredEnv, NODE_ENV: 'development', ...overrides });
  return { get: (key: keyof typeof env) => env[key] } as unknown as EnvService;
}

describe('the design constants of the OTP issuance (ADR-035 3.3 and 3.5)', () => {
  it('uses the registered advisory lock namespace and the limiter values of the ADR', () => {
    expect(OTP_ISSUE_LOCK_NAMESPACE).toBe(91_101);
    expect(OTP_ISSUE_CONCURRENCY).toBe(1);
    expect(OTP_ISSUE_QUEUE_MAX).toBe(5);
    expect(OTP_ISSUE_QUEUE_TIMEOUT_MS).toBe(6_000);
    expect(OTP_ISSUE_SATURATED_RETRY_SEC).toBe(5);
  });
});

describe('readOtpIssuancePolicy', () => {
  it('reads the defaults of the environment', () => {
    expect(readOtpIssuancePolicy(envServiceFor())).toEqual({
      ttlSec: 300,
      cooldownSec: 30,
      hourlyLimit: 5,
      hourlyWindowSec: 3_600,
      dailyLimit: 10,
      dailyWindowSec: OTP_DAILY_WINDOW_SECONDS,
      globalLimit: 300,
    });
  });

  it('reads the overrides of the environment', () => {
    const policy = readOtpIssuancePolicy(
      envServiceFor({
        OTP_TTL_SECONDS: '120',
        OTP_RESEND_COOLDOWN_SECONDS: '45',
        OTP_RATE_LIMIT_MAX: '3',
        OTP_RATE_LIMIT_WINDOW_SECONDS: '1800',
        OTP_PHONE_DAILY_LIMIT: '7',
        OTP_GLOBAL_DAILY_LIMIT: '50',
      }),
    );
    expect(policy).toEqual({
      ttlSec: 120,
      cooldownSec: 45,
      hourlyLimit: 3,
      hourlyWindowSec: 1_800,
      dailyLimit: 7,
      dailyWindowSec: OTP_DAILY_WINDOW_SECONDS,
      globalLimit: 50,
    });
  });
});

describe('otpRetentionSeconds (RN-EO-05: the cutoff follows the longest window)', () => {
  it('is the daily window', () => {
    expect(otpRetentionSeconds()).toBe(OTP_DAILY_WINDOW_SECONDS);
    expect(OTP_DAILY_WINDOW_SECONDS).toBe(86_400);
  });

  it.each([
    ['the cooldown', 'OTP_RESEND_COOLDOWN_SECONDS'],
    ['the hourly window', 'OTP_RATE_LIMIT_WINDOW_SECONDS'],
    ['the TTL', 'OTP_TTL_SECONDS'],
  ])('is at least %s even at the largest value the environment accepts', (_name, variable) => {
    const policy = readOtpIssuancePolicy(
      envServiceFor({ [variable]: String(OTP_DAILY_WINDOW_SECONDS) }),
    );
    const windows = [
      policy.cooldownSec,
      policy.hourlyWindowSec,
      policy.ttlSec,
      policy.dailyWindowSec,
    ];
    for (const window of windows) {
      expect(otpRetentionSeconds()).toBeGreaterThanOrEqual(window);
    }
  });

  it.each(['OTP_RESEND_COOLDOWN_SECONDS', 'OTP_RATE_LIMIT_WINDOW_SECONDS', 'OTP_TTL_SECONDS'])(
    'the environment rejects %s above the daily window',
    (variable) => {
      expect(() =>
        validateEnv({ ...requiredEnv, [variable]: String(OTP_DAILY_WINDOW_SECONDS + 1) }),
      ).toThrow(variable);
    },
  );
});

describe('decideRefusal: the largest wait wins (RN-EO-08)', () => {
  const none = { cooldown: null, hourly: null, daily: null, global: null };

  it('has no refusal when no cap is exhausted', () => {
    expect(decideRefusal(none)).toBeNull();
  });

  it.each([
    ['cooldown', { ...none, cooldown: 12 }],
    ['hourly', { ...none, hourly: 600 }],
    ['daily', { ...none, daily: 3_600 }],
    ['global', { ...none, global: 80_000 }],
  ] as const)('refuses by %s with its own wait', (cap, waits) => {
    const refusal = decideRefusal(waits);
    expect(refusal?.cap).toBe(cap);
    expect(refusal?.retryInSec).toBe(Object.values(waits).find((value) => value !== null));
    expect(refusal?.globalCapReached).toBe(cap === 'global');
  });

  it('answers the largest of several exhausted caps', () => {
    expect(decideRefusal({ cooldown: 10, hourly: 600, daily: 7_200, global: null })).toMatchObject({
      cap: 'daily',
      retryInSec: 7_200,
    });
    expect(decideRefusal({ cooldown: 29, hourly: 3_000, daily: 500, global: null })).toMatchObject({
      cap: 'hourly',
      retryInSec: 3_000,
    });
  });

  it('flags the global cap as reached even when it is not the largest wait', () => {
    expect(decideRefusal({ cooldown: null, hourly: 3_000, daily: null, global: 40 })).toEqual({
      cap: 'hourly',
      retryInSec: 3_000,
      globalCapReached: true,
    });
  });

  it('answers at least one second', () => {
    expect(decideRefusal({ ...none, hourly: 0 })?.retryInSec).toBe(1);
  });
});

describe('the global cap warnings (ADR-035 4.5)', () => {
  it('crosses 80% on the emission that makes the count reach ceil(0.8 x limit)', () => {
    const limit = 300;
    expect(crossesGlobalWarning(238, limit)).toBe(false);
    expect(crossesGlobalWarning(239, limit)).toBe(true);
    expect(crossesGlobalWarning(240, limit)).toBe(false);
  });

  it('handles a limit whose 80% is not an integer', () => {
    expect(crossesGlobalWarning(3, 5)).toBe(true);
    expect(crossesGlobalWarning(2, 5)).toBe(false);
    expect(crossesGlobalWarning(4, 5)).toBe(false);
  });

  it('reaches 100% on the emission that makes the count reach the limit', () => {
    expect(reachesGlobalLimit(298, 300)).toBe(false);
    expect(reachesGlobalLimit(299, 300)).toBe(true);
    expect(reachesGlobalLimit(300, 300)).toBe(true);
  });

  it('warns and reaches on the same emission when the limit is 1', () => {
    expect(crossesGlobalWarning(0, 1)).toBe(true);
    expect(reachesGlobalLimit(0, 1)).toBe(true);
  });
});
