import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { OperationalParamsRepository } from './operational-params.repository';
import { OperationalParamsService } from './operational-params.service';
import type { NullableOperationalValues, OperationalParamsRow } from './service-config.types';

const ENV_DEFAULTS: Record<string, number> = {
  SEARCH_RADIUS_KM: 2,
  EXPANSION_RADIUS_KM: 6,
  ACCEPTANCE_TIMEOUT_SEC: 15,
  MAX_AUTO_RETRIES: 3,
  TIEBREAK_WINDOW_HOURS: 3,
  LOCATION_STALE_MIN: 15,
  AVG_SPEED_KMH: 20,
  CANCELLATION_WINDOW_MIN: 2,
  NO_SHOW_GRACE_MIN: 5,
};

const ALL_NULL: NullableOperationalValues = {
  search_radius_km: null,
  expansion_radius_km: null,
  acceptance_timeout_sec: null,
  max_auto_retries: null,
  tiebreak_window_hours: null,
  location_stale_min: null,
  avg_speed_kmh: null,
  cancellation_window_min: null,
  no_show_grace_min: null,
};

function rowWith(values: Partial<NullableOperationalValues>): OperationalParamsRow {
  return {
    operationalParamsId: 9,
    municipalityId: 4,
    serviceType: 'taxi',
    values: { ...ALL_NULL, ...values },
    origin: 'platform_edit',
    originCompanyName: null,
    validFrom: new Date('2026-02-01T00:00:00.000Z'),
    validTo: null,
    createdBy: null,
  };
}

function create(row: OperationalParamsRow | null) {
  const repo = { findCurrent: jest.fn().mockResolvedValue(row) };
  const env = { get: (key: string) => ENV_DEFAULTS[key] } as unknown as EnvService;
  const prisma = {} as PrismaService;
  const service = new OperationalParamsService(prisma, repo as unknown as OperationalParamsRepository, env);
  return { service, repo };
}

describe('OperationalParamsService', () => {
  it('without a row every value is the platform default and the nine keys are flagged', async () => {
    const { service } = create(null);

    const snapshot = await service.snapshot(4, 'taxi');

    expect(snapshot.params).toEqual({
      searchRadiusKm: 2,
      expansionRadiusKm: 6,
      acceptanceTimeoutSec: 15,
      maxAutoRetries: 3,
      tiebreakWindowHours: 3,
      avgSpeedKmh: 20,
      noShowGraceMin: 5,
      locationStaleMin: 15,
      cancellationWindowMin: 2,
    });
    expect(snapshot.platformDefaultKeys).toHaveLength(9);
    expect(snapshot.row).toBeNull();
  });

  it('the cancellation window comes from the environment when the municipality value is null (H-2)', async () => {
    const { service } = create(rowWith({ acceptance_timeout_sec: 30 }));

    const params = await service.get(4, 'taxi');

    expect(params.acceptanceTimeoutSec).toBe(30);
    expect(params.cancellationWindowMin).toBe(2);
  });

  it('a stored value wins over the environment and is not flagged as a default', async () => {
    const { service } = create(rowWith({ cancellation_window_min: 7, search_radius_km: 1.5 }));

    const snapshot = await service.snapshot(4, 'taxi');

    expect(snapshot.params.cancellationWindowMin).toBe(7);
    expect(snapshot.params.searchRadiusKm).toBe(1.5);
    expect(snapshot.platformDefaultKeys).not.toContain('cancellation_window_min');
    expect(snapshot.platformDefaultKeys).toContain('expansion_radius_km');
  });

  it('a stored 0 for the location staleness (no expiry) is kept, not replaced by the default', async () => {
    const { service } = create(rowWith({ location_stale_min: 0 }));

    expect((await service.get(4)).locationStaleMin).toBe(0);
  });

  it('reads the open version of the municipality and the service given, taxi by default', async () => {
    const { service, repo } = create(null);

    await service.get(4);
    await service.get(5, 'comfort');

    expect(repo.findCurrent).toHaveBeenNthCalledWith(1, expect.anything(), 4, 'taxi');
    expect(repo.findCurrent).toHaveBeenNthCalledWith(2, expect.anything(), 5, 'comfort');
  });

  it('uses the transaction it is given', async () => {
    const { service, repo } = create(null);
    const tx = { marker: true };

    await service.get(4, 'taxi', tx as never);

    expect(repo.findCurrent.mock.calls[0]?.[0]).toBe(tx);
  });
});
