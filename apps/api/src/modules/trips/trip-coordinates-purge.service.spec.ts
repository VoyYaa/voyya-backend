import { Logger } from '@nestjs/common';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TripCoordinatesPurgeService } from './trip-coordinates-purge.service';
import type { TripsRepository } from './trips.repository';

function fakePrisma(executed: string[]): PrismaService {
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql);
      return 0;
    },
  };
  return {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
}

const env = { get: () => 90 } as unknown as EnvService;

describe('TripCoordinatesPurgeService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('purges batches until one comes back empty and reports only counts', async () => {
    const executed: string[] = [];
    const batch = jest.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(120).mockResolvedValueOnce(0);
    const repo = { purgeCoordinatesBatch: batch } as unknown as TripsRepository;
    const service = new TripCoordinatesPurgeService(fakePrisma(executed), repo, env);

    await service.purge();

    expect(batch).toHaveBeenCalledTimes(3);
    expect(batch).toHaveBeenCalledWith(expect.anything(), 90, 500);
    expect(Logger.prototype.log).toHaveBeenCalledWith('Trip coordinates purge: purged=620 batches=2');
    expect(executed.filter((sql) => sql.startsWith('SAVEPOINT'))).toHaveLength(3);
  });

  it('stops after 40 batches in one run', async () => {
    const batch = jest.fn().mockResolvedValue(500);
    const repo = { purgeCoordinatesBatch: batch } as unknown as TripsRepository;
    await new TripCoordinatesPurgeService(fakePrisma([]), repo, env).purge();
    expect(batch).toHaveBeenCalledTimes(40);
  });

  it('rolls back the failing batch, stops, and keeps earlier batches', async () => {
    const executed: string[] = [];
    const batch = jest.fn().mockResolvedValueOnce(500).mockRejectedValueOnce(new Error('boom'));
    const repo = { purgeCoordinatesBatch: batch } as unknown as TripsRepository;
    const service = new TripCoordinatesPurgeService(fakePrisma(executed), repo, env);

    await service.purge();

    expect(batch).toHaveBeenCalledTimes(2);
    expect(executed.some((sql) => sql.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(Logger.prototype.log).toHaveBeenCalledWith('Trip coordinates purge: purged=500 batches=1');
  });
});
