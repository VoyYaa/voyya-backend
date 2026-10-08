import { CronExpression } from '@nestjs/schedule';

export const JOB_TIMEZONE = 'UTC';

export interface ScheduledJob {
  readonly slug: string;
  readonly cron: string;
  readonly checkinMarginMin: number;
  readonly maxRuntimeMin: number;
}

export const SCHEDULED_JOBS = {
  authCleanup: {
    slug: 'auth-cleanup',
    cron: CronExpression.EVERY_HOUR,
    checkinMarginMin: 10,
    maxRuntimeMin: 10,
  },
  driverLocationPurge: {
    slug: 'driver-location-purge',
    cron: CronExpression.EVERY_HOUR,
    checkinMarginMin: 10,
    maxRuntimeMin: 10,
  },
  affiliationStagingPurge: {
    slug: 'affiliation-staging-purge',
    cron: CronExpression.EVERY_DAY_AT_3AM,
    checkinMarginMin: 30,
    maxRuntimeMin: 30,
  },
  pushTokenPurge: {
    slug: 'push-token-purge',
    cron: CronExpression.EVERY_DAY_AT_3AM,
    checkinMarginMin: 30,
    maxRuntimeMin: 30,
  },
  tripCoordinatesPurge: {
    slug: 'trip-coordinates-purge',
    cron: CronExpression.EVERY_DAY_AT_4AM,
    checkinMarginMin: 30,
    maxRuntimeMin: 30,
  },
} as const satisfies Record<string, ScheduledJob>;

export function cronOptions(job: ScheduledJob): { name: string; timeZone: string } {
  return { name: job.slug, timeZone: JOB_TIMEZONE };
}
