import type { ThrottlerOptions } from '@nestjs/throttler';
import { skipUnlessOptedIn } from './opt-in-throttle';
import { PER_USER, PER_USER_DEFAULT_LIMIT } from './user-throttler.guard';

export const AFFILIATION_DOCS_HOURLY = 'affiliation_docs_hour';

export const AFFILIATION_DOCS_HOURLY_LIMIT = { limit: 30, ttl: 3_600_000 } as const;

export function buildThrottlers(defaults: { ttlMs: number; limit: number }): ThrottlerOptions[] {
  return [
    { name: 'default', ttl: defaults.ttlMs, limit: defaults.limit },
    {
      name: AFFILIATION_DOCS_HOURLY,
      ...AFFILIATION_DOCS_HOURLY_LIMIT,
      skipIf: skipUnlessOptedIn(AFFILIATION_DOCS_HOURLY),
    },
    { name: PER_USER, ...PER_USER_DEFAULT_LIMIT, skipIf: () => true },
  ];
}
