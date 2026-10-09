import type { ConsentStatus } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { ConsentQueryService } from '../auth/consent-query.service';
import { DriverTrackingService } from './driver-tracking.service';
import type { DriverRepository, TrackingSnapshotParams, TripTrackingRow } from './driver.repository';

const COMPANY_ID = 3;
const DRIVER_ID = 7;

const ENV_VALUES: Record<string, number> = {
  DRIVER_LOCATION_SHARE_INTERVAL_SEC: 15,
  DRIVER_LOCATION_SHARE_STALE_SEC: 45,
  DRIVER_LOCATION_SHARE_HIDE_SEC: 300,
};

function consent(version: string | null, state: ConsentStatus['state'] = 'granted'): ConsentStatus {
  return {
    purpose: 'location',
    state,
    notice_version: version,
    granted_at: null,
    revoked_at: null,
    current_notice_version: 'location-notice-v3',
    requires_acceptance: version !== 'location-notice-v3',
  };
}

function build(options: {
  acceptedDriverId?: number | null;
  consent?: ConsentStatus;
  snapshot?: TripTrackingRow | null;
}) {
  const tenants: number[] = [];
  const snapshotParams: TrackingSnapshotParams[] = [];
  const prisma = {
    runInTenant: async <T>(companyId: number, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      tenants.push(companyId);
      return fn({});
    },
  } as unknown as PrismaService;
  const repo = {
    getAcceptedDriverId: async () => (options.acceptedDriverId === undefined ? DRIVER_ID : options.acceptedDriverId),
    getTrackingSnapshot: async (_tx: unknown, params: TrackingSnapshotParams) => {
      snapshotParams.push(params);
      return options.snapshot === undefined ? null : options.snapshot;
    },
  } as unknown as DriverRepository;
  const consents = {
    locationStatus: async () => options.consent ?? consent('location-notice-v3'),
  } as unknown as ConsentQueryService;
  const env = { get: (key: string) => ENV_VALUES[key] } as unknown as EnvService;
  return { service: new DriverTrackingService(prisma, repo, consents, env), tenants, snapshotParams };
}

const LIVE: TripTrackingRow = { windowAgeSec: 20, lat: 6.96, lng: -75.41, ageSec: 8 };

describe('DriverTrackingService.forPassenger (ADR-033 section 3.2)', () => {
  it.each(['pending_assignment', 'in_progress', 'completed', 'cancelled_by_passenger', 'no_show'] as const)(
    'outside the window (%s) -> null without touching the database',
    async (status) => {
      const { service, tenants } = build({ snapshot: LIVE });

      await expect(service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status })).resolves.toBeNull();
      expect(tenants).toEqual([]);
    },
  );

  it('a trip without company -> null', async () => {
    const { service } = build({ snapshot: LIVE });

    await expect(
      service.forPassenger({ tripRequestId: 9, companyId: null, status: 'assigned' }),
    ).resolves.toBeNull();
  });

  it('a live position -> thresholds from the environment plus the position with its server age', async () => {
    const { service, tenants } = build({ snapshot: LIVE });

    const result = await service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status: 'driver_en_route' });

    expect(result).toEqual({
      window_age_sec: 20,
      stale_after_sec: 45,
      hide_after_sec: 300,
      position: { lat: 6.96, lng: -75.41, age_sec: 8 },
    });
    expect(tenants).toEqual([COMPANY_ID]);
  });

  it('reads in the tenant of the trip company and asks for the driver whose consent was checked (C-5)', async () => {
    const { service, snapshotParams } = build({ snapshot: LIVE, acceptedDriverId: DRIVER_ID });

    await service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status: 'assigned' });

    expect(snapshotParams).toEqual([{ tripRequestId: 9, companyId: COMPANY_ID, driverId: DRIVER_ID, hideSec: 300 }]);
  });

  it.each([
    ['a v2 consent', consent('location-notice-v2')],
    ['a revoked consent', consent('location-notice-v3', 'revoked')],
    ['no consent', consent(null, 'none')],
  ])('%s -> the snapshot is asked without a driver, so the position is null but the thresholds travel', async (_label, status) => {
    const { service, snapshotParams } = build({
      consent: status,
      snapshot: { windowAgeSec: 10, lat: null, lng: null, ageSec: null },
    });

    const result = await service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status: 'assigned' });

    expect(snapshotParams[0]?.driverId).toBeNull();
    expect(result).toEqual({ window_age_sec: 10, stale_after_sec: 45, hide_after_sec: 300, position: null });
  });

  it('no accepted assignment -> asked without a driver', async () => {
    const { service, snapshotParams } = build({
      acceptedDriverId: null,
      snapshot: { windowAgeSec: 10, lat: null, lng: null, ageSec: null },
    });

    await service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status: 'assigned' });

    expect(snapshotParams[0]?.driverId).toBeNull();
  });

  it('the window closed between the status read and the snapshot -> null, never a position', async () => {
    const { service } = build({ snapshot: null });

    await expect(
      service.forPassenger({ tripRequestId: 9, companyId: COMPANY_ID, status: 'driver_en_route' }),
    ).resolves.toBeNull();
  });
});

describe('DriverTrackingService.sharingFor', () => {
  const { service } = build({});

  it('a window trip and a v3 consent -> the trip and the configured interval', () => {
    expect(service.sharingFor(42, consent('location-notice-v3'))).toEqual({ trip_request_id: 42, interval_sec: 15 });
  });

  it('no window trip -> null', () => {
    expect(service.sharingFor(null, consent('location-notice-v3'))).toBeNull();
  });

  it('a consent that does not cover sharing -> null', () => {
    expect(service.sharingFor(42, consent('location-notice-v2'))).toBeNull();
  });
});
