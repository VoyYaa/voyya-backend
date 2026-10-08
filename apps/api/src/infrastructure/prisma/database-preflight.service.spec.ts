import { DatabasePreflightService } from './database-preflight.service';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from './prisma.service';

function baseResult(overrides: Partial<Record<string, boolean>> = {}): Record<string, boolean> {
  return {
    isSuperuser: false,
    bypassesRls: false,
    hasPostgis: true,
    hasGeoColumns: true,
    hasSingleTakeIndex: true,
    hasForcedRls: true,
    hasSafeTripProbe: true,
    ...overrides,
  };
}

function fakePrisma(row: Record<string, boolean>): PrismaService {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([row]),
  } as unknown as PrismaService;
}

function fakeEnv(nodeEnv: string): EnvService {
  return { get: (k: string) => (k === 'NODE_ENV' ? nodeEnv : undefined) } as unknown as EnvService;
}

describe('DatabasePreflightService — hasForcedRls threshold (ADR-018: 3 -> 5 tables, closes B-05)', () => {
  it('all 5 tables forced (hasForcedRls=true) and every other invariant OK -> healthy', async () => {
    const service = new DatabasePreflightService(fakePrisma(baseResult()), fakeEnv('test'));

    await service.onApplicationBootstrap();

    expect(service.isHealthy()).toBe(true);
    expect(service.getLastResult()?.hasForcedRls).toBe(true);
  });

  it('only 4 of 5 tables forced (query returns hasForcedRls=false) -> unhealthy, invariant listed', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasForcedRls: false })),
      fakeEnv('test'),
    );

    await service.onApplicationBootstrap();

    expect(service.isHealthy()).toBe(false);
  });

  it('production + hasForcedRls=false -> aborts startup (fail-closed, not just logged)', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasForcedRls: false })),
      fakeEnv('production'),
    );

    await expect(service.onApplicationBootstrap()).rejects.toThrow();
  });

  it('non-production + hasForcedRls=false -> does not throw, but reports unhealthy', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasForcedRls: false })),
      fakeEnv('development'),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(service.isHealthy()).toBe(false);
  });
});

describe('DatabasePreflightService — hasSafeTripProbe (CM-14)', () => {
  it('unsafe trip probe in production -> aborts startup naming the invariant', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasSafeTripProbe: false })),
      fakeEnv('production'),
    );

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/has_safe_trip_probe/);
  });

  it('unsafe trip probe outside production -> reports unhealthy without throwing', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasSafeTripProbe: false })),
      fakeEnv('development'),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(service.isHealthy()).toBe(false);
  });
});
