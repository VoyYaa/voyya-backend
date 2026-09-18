import { ConflictException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { UpdateConsoleSettingsDTO } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminSettingsRepository, type SystemParameterRow } from './admin-settings.repository';
import { AdminSettingsService } from './admin-settings.service';

const COMPANY_ID = 1;
const USER_ID = 1;

const fareConfig = {
  fareConfigId: 100,
  baseFare: 8000,
  nightSurchargePct: 20,
  holidaySurchargePct: 15,
  commissionPct: 8,
  createdAt: new Date('2025-12-01T00:00:00.000Z'),
};

function paramRow(key: string, value: string, updatedAt: Date): SystemParameterRow {
  return { key, value, updatedAt };
}

const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-01-02T00:00:00.000Z');

const defaultParamRows: SystemParameterRow[] = [
  paramRow('search_radius_km', '2', T1),
  paramRow('acceptance_timeout_sec', '15', T2),
  paramRow('expansion_radius_km', '6', T1),
];

function fakeEnv(): EnvService {
  const v: Record<string, number> = {
    SEARCH_RADIUS_KM: 2,
    ACCEPTANCE_TIMEOUT_SEC: 15,
    EXPANSION_RADIUS_KM: 6,
  };
  return { get: (k: string) => v[k] } as unknown as EnvService;
}

function fakePrisma(): PrismaService {
  return {
    runInTenant: jest.fn((_companyId: number, fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PrismaService;
}

async function capture(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
  throw new Error('No exception thrown');
}

function create() {
  const repo = {
    getActiveFareConfig: jest.fn().mockResolvedValue(fareConfig),
    getParameters: jest.fn().mockResolvedValue(defaultParamRows),
    closeAndInsertFareConfig: jest.fn(),
    upsertParameters: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminSettingsService(
    fakePrisma(),
    repo as unknown as AdminSettingsRepository,
    fakeEnv(),
  );
  return { service, repo };
}

const validDto: UpdateConsoleSettingsDTO = {
  version: `fc:100|sp:${T2.getTime()}`,
  base_fare: 8000,
  night_surcharge_pct: 20,
  holiday_surcharge_pct: 15,
  search_radius_km: 2,
  acceptance_timeout_sec: 15,
};

describe('AdminSettingsService.get', () => {
  it('composes ConsoleSettings from the active fare config and resolved parameters', async () => {
    const { service } = create();

    const result = await service.get(COMPANY_ID);

    expect(result.base_fare).toBe(8000);
    expect(result.search_radius_km).toBe(2);
    expect(result.expansion_radius_km).toBe(6);
    expect(result.commission_pct).toBe(8);
    expect(result.version).toBe(`fc:100|sp:${T2.getTime()}`);
    expect(result.updated_at).toBe(T2.toISOString());
  });

  it('no active fare config -> 404 FARE_CONFIG_NOT_FOUND', async () => {
    const { service, repo } = create();
    repo.getActiveFareConfig.mockResolvedValue(null);

    const e = await capture(service.get(COMPANY_ID));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.getResponse()).toMatchObject({ code: 'FARE_CONFIG_NOT_FOUND' });
  });

  it('missing parameter rows fall back to env defaults with a null updated_at', async () => {
    const { service, repo } = create();
    repo.getParameters.mockResolvedValue([]);

    const result = await service.get(COMPANY_ID);

    expect(result.search_radius_km).toBe(2);
    expect(result.acceptance_timeout_sec).toBe(15);
    expect(result.expansion_radius_km).toBe(6);
    expect(result.updated_at).toBe(fareConfig.createdAt.toISOString());
  });
});

describe('AdminSettingsService.update', () => {
  it('a stale version -> 409 SETTINGS_CONFLICT, no repository writes', async () => {
    const { service, repo } = create();

    const e = await capture(
      service.update(COMPANY_ID, USER_ID, { ...validDto, version: 'fc:1|sp:1' }),
    );

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'SETTINGS_CONFLICT' });
    expect(repo.closeAndInsertFareConfig).not.toHaveBeenCalled();
    expect(repo.upsertParameters).not.toHaveBeenCalled();
  });

  it('search_radius_km above expansion_radius_km -> 422 SETTINGS_OUT_OF_RANGE, field set', async () => {
    const { service, repo } = create();

    const e = await capture(
      service.update(COMPANY_ID, USER_ID, { ...validDto, search_radius_km: 7 }),
    );

    expect(e).toBeInstanceOf(UnprocessableEntityException);
    expect(e.getResponse()).toMatchObject({
      code: 'SETTINGS_OUT_OF_RANGE',
      field: 'search_radius_km',
    });
    expect(repo.closeAndInsertFareConfig).not.toHaveBeenCalled();
  });

  it('only the radius changes -> no new fare_config version is created', async () => {
    const { service, repo } = create();
    repo.getParameters.mockResolvedValueOnce(defaultParamRows).mockResolvedValueOnce(defaultParamRows);

    await service.update(COMPANY_ID, USER_ID, { ...validDto, search_radius_km: 3 });

    expect(repo.closeAndInsertFareConfig).not.toHaveBeenCalled();
    expect(repo.upsertParameters).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      [
        { key: 'search_radius_km', value: '3' },
        { key: 'acceptance_timeout_sec', value: '15' },
      ],
      USER_ID,
    );
  });

  it('the base fare changes -> a new version is created, commission_pct is copied (not client-supplied)', async () => {
    const { service, repo } = create();
    repo.closeAndInsertFareConfig.mockResolvedValue({ ...fareConfig, fareConfigId: 101, baseFare: 9000 });

    await service.update(COMPANY_ID, USER_ID, { ...validDto, base_fare: 9000 });

    expect(repo.closeAndInsertFareConfig).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      fareConfig.fareConfigId,
      {
        baseFare: 9000,
        nightSurchargePct: 20,
        holidaySurchargePct: 15,
        commissionPct: 8,
      },
      USER_ID,
    );
  });

  it('B-13: the write lost the race after the version check passed (closeAndInsertFareConfig returns null) -> 409 SETTINGS_CONFLICT', async () => {
    const { service, repo } = create();
    repo.closeAndInsertFareConfig.mockResolvedValue(null);

    const e = await capture(service.update(COMPANY_ID, USER_ID, { ...validDto, base_fare: 9000 }));

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'SETTINGS_CONFLICT' });
  });
});
