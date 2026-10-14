import 'reflect-metadata';
import { CronExpression } from '@nestjs/schedule';
import type { EnvService } from '../../config/env.service';
import { SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

const mockLock = {
  keys: [] as number[],
  tx: { marker: 'tx' },
};

jest.mock('../../infrastructure/prisma/advisory-lock', () => ({
  runWithAdvisoryLock: async (
    _prisma: unknown,
    key: number,
    work: (tx: unknown) => Promise<void>,
  ): Promise<boolean> => {
    mockLock.keys.push(key);
    await work(mockLock.tx);
    return true;
  },
}));

import { PushTokenPurgeService } from './push-token-purge.service';
import type { PushTokenRepository } from './push-token.repository';

function service(ttlDays: number): { purge: PushTokenPurgeService; purgeStale: jest.Mock } {
  const purgeStale = jest.fn(async () => 3);
  const env = { get: (key: string) => (key === 'PUSH_TOKEN_TTL_DAYS' ? ttlDays : undefined) } as unknown as EnvService;
  return {
    purge: new PushTokenPurgeService({} as PrismaService, { purgeStale } as unknown as PushTokenRepository, env),
    purgeStale,
  };
}

beforeEach(() => {
  mockLock.keys = [];
});

describe('PushTokenPurgeService · guard 9 of the move (ADR-034 section 1.1)', () => {
  it('purges inside the advisory lock 91003, with the configured days', async () => {
    const { purge, purgeStale } = service(45);

    await purge.purge();

    expect(mockLock.keys).toEqual([91_003]);
    expect(purgeStale).toHaveBeenCalledWith(mockLock.tx, 45);
  });

  it('PUSH_TOKEN_TTL_DAYS = 0 disables the job: no lock, no delete', async () => {
    const { purge, purgeStale } = service(0);

    await purge.purge();

    expect(mockLock.keys).toEqual([]);
    expect(purgeStale).not.toHaveBeenCalled();
  });

  it('keeps the same scheduled job: daily at 3 am UTC under the push-token-purge name', () => {
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', PushTokenPurgeService.prototype.purge) as {
      cronTime: string;
      name: string;
      timeZone: string;
    };

    expect(SCHEDULED_JOBS.pushTokenPurge.slug).toBe('push-token-purge');
    expect(options).toMatchObject({
      cronTime: SCHEDULED_JOBS.pushTokenPurge.cron,
      name: 'push-token-purge',
      timeZone: 'UTC',
    });
    expect(options.cronTime).toBe(CronExpression.EVERY_DAY_AT_3AM);
  });
});
