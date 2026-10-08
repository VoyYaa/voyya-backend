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
    hasMunicipalityCatalog: true,
    hasServiceConfig: true,
    hasTripCompanyScope: true,
    ...overrides,
  };
}

function fakePrisma(row: Record<string, boolean>, probe: jest.Mock = jest.fn().mockResolvedValue(0)): PrismaService {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([row]),
    $executeRawUnsafe: probe,
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

describe.each([
  ['hasMunicipalityCatalog', 'has_municipality_catalog'],
  ['hasServiceConfig', 'has_service_config'],
  ['hasTripCompanyScope', 'has_trip_company_scope'],
])('DatabasePreflightService — %s (ADR-032 section 12.3)', (flag, invariant) => {
  it('missing in production -> aborts startup naming the invariant', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ [flag]: false })),
      fakeEnv('production'),
    );

    await expect(service.onApplicationBootstrap()).rejects.toThrow(new RegExp(invariant));
  });

  it('missing outside production -> reports unhealthy without throwing', async () => {
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ [flag]: false })),
      fakeEnv('development'),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(service.isHealthy()).toBe(false);
  });
});

describe('DatabasePreflightService — residual GUC probe (MD-01)', () => {
  it('runs the probe once the static trip scope checks pass', async () => {
    const probe = jest.fn().mockResolvedValue(0);
    const service = new DatabasePreflightService(fakePrisma(baseResult(), probe), fakeEnv('test'));

    await service.onApplicationBootstrap();

    expect(probe).toHaveBeenCalledTimes(1);
    const sql = String(probe.mock.calls[0]?.[0]);
    expect(sql).toContain("set_config('app.current_company', '', true)");
    expect(sql).toContain('EXPLAIN SELECT count(*) FROM trips.trip_request');
    expect(service.getLastResult()?.hasTripCompanyScope).toBe(true);
  });

  it('a probe that errors (the intermittent 500 of the passenger) -> hasTripCompanyScope false and production aborts', async () => {
    const probe = jest
      .fn()
      .mockRejectedValue(new Error('invalid input syntax for type integer: ""'));
    const service = new DatabasePreflightService(fakePrisma(baseResult(), probe), fakeEnv('production'));

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/has_trip_company_scope/);
    expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
  });

  it('skips the probe when the static trip scope checks already failed', async () => {
    const probe = jest.fn().mockResolvedValue(0);
    const service = new DatabasePreflightService(
      fakePrisma(baseResult({ hasTripCompanyScope: false }), probe),
      fakeEnv('test'),
    );

    await service.onApplicationBootstrap();

    expect(probe).not.toHaveBeenCalled();
    expect(service.isHealthy()).toBe(false);
  });
});
