import { ConflictException, HttpException } from '@nestjs/common';
import { DriverShiftService } from './driver-shift.service';
import type { DriverRepository, DriverShiftRow } from './driver.repository';
import type { OperationalParamsService } from './operational-params.service';
import type { ConsentQueryService } from '../auth/consent-query.service';
import type { ConsentStatus } from '@voyyaa/shared';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

const DRIVER_ID = 7;
const COMPANY_ID = 1;
const LOCATION = { lat: 6.9639, lng: -75.4186 };

function fakePrisma(): PrismaService {
  return {
    async runInTenant<T>(_c: number, fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
  } as unknown as PrismaService;
}

function fakeParams(): OperationalParamsService {
  return { async get() { return { noShowGraceMin: 5 } as never; } } as unknown as OperationalParamsService;
}

function consentStatus(overrides: Partial<ConsentStatus> = {}): ConsentStatus {
  return {
    purpose: 'location',
    state: 'granted',
    notice_version: 'location-notice-v2',
    granted_at: '2026-10-08T10:00:00.000Z',
    revoked_at: null,
    current_notice_version: 'location-notice-v2',
    requires_acceptance: false,
    ...overrides,
  };
}

function fakeConsents(status: ConsentStatus = consentStatus()): ConsentQueryService {
  return { async locationStatus() { return status; } } as unknown as ConsentQueryService;
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

describe('DriverShiftService.updateShift (HU-CD-01/02)', () => {
  it('activates the shift and returns available + vehicle_linked=true', async () => {
    const row: DriverShiftRow = { status: 'available', currentVehicleId: 3, locationUpdatedAt: new Date() };
    const repo = {
      async startShift() {
        return row;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const r = await service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: true, location: LOCATION });
    expect(r.status).toBe('available');
    expect(r.on_shift).toBe(true);
    expect(r.vehicle_linked).toBe(true);
  });

  it('no vehicle linked -> 409 NO_VEHICLE_LINKED, status stays off_shift', async () => {
    const repo = {
      async startShift() {
        return null;
      },
      async getShiftRow() {
        return { status: 'off_shift', currentVehicleId: null, locationUpdatedAt: null } as DriverShiftRow;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const e = await capture(
      service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: true, location: LOCATION }),
    );
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'NO_VEHICLE_LINKED' });
  });

  it('already on_trip -> idempotent: refreshes location, keeps on_trip', async () => {
    const refreshed: DriverShiftRow = {
      status: 'on_trip',
      currentVehicleId: 3,
      locationUpdatedAt: new Date(),
    };
    const repo = {
      async startShift() {
        return null;
      },
      async getShiftRow() {
        return { status: 'on_trip', currentVehicleId: 3, locationUpdatedAt: new Date() } as DriverShiftRow;
      },
      async refreshLocationWhileOnTrip() {
        return refreshed;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const r = await service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: true, location: LOCATION });
    expect(r.status).toBe('on_trip');
    expect(r.on_shift).toBe(true);
  });

  it('ending shift with an active trip -> 409 ACTIVE_TRIP_IN_PROGRESS', async () => {
    const repo = {
      async endShift() {
        return null;
      },
      async getShiftRow() {
        return { status: 'on_trip', currentVehicleId: 3, locationUpdatedAt: new Date() } as DriverShiftRow;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const e = await capture(service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: false }));
    expect(e.getResponse()).toMatchObject({ code: 'ACTIVE_TRIP_IN_PROGRESS' });
  });

  it('repeating "end shift" while already off_shift -> idempotent success', async () => {
    const row: DriverShiftRow = { status: 'off_shift', currentVehicleId: 3, locationUpdatedAt: null };
    const repo = {
      async endShift() {
        return row;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const r = await service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: false });
    expect(r.status).toBe('off_shift');
    expect(r.on_shift).toBe(false);
  });
});

describe('DriverShiftService.reportLocation', () => {
  it('not on shift -> 409 NOT_ON_SHIFT', async () => {
    const repo = { async reportLocation() { return false; } } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    const e = await capture(service.reportLocation(DRIVER_ID, COMPANY_ID, LOCATION));
    expect(e.getResponse()).toMatchObject({ code: 'NOT_ON_SHIFT' });
  });

  it('available or on_trip -> succeeds silently', async () => {
    const repo = { async reportLocation() { return true; } } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents());

    await expect(service.reportLocation(DRIVER_ID, COMPANY_ID, LOCATION)).resolves.toBeUndefined();
  });
});

describe('DriverShiftService consent gate (ADR-029 §4)', () => {
  const location = { lat: 6.9639, lng: -75.4186 };
  const neverCalled = (name: string) => async () => {
    throw new Error(`${name} must not run without consent`);
  };
  const repo = {
    startShift: neverCalled('startShift'),
    reportLocation: neverCalled('reportLocation'),
  } as unknown as DriverRepository;

  const cases: Array<[string, ConsentStatus]> = [
    ['none', consentStatus({ state: 'none', notice_version: null, granted_at: null, requires_acceptance: true })],
    ['revoked', consentStatus({ state: 'revoked', revoked_at: '2026-10-08T11:00:00.000Z', requires_acceptance: true })],
  ];

  it.each(cases)('activating the shift with consent %s -> 403 LOCATION_CONSENT_REQUIRED', async (_label, status) => {
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents(status));
    const e = await capture(service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: true, location }));
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
  });

  it.each(cases)('reporting location with consent %s -> 403 LOCATION_CONSENT_REQUIRED', async (_label, status) => {
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents(status));
    const e = await capture(service.reportLocation(DRIVER_ID, COMPANY_ID, location));
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
  });

  it('an older accepted version blocks the shift but not location reports', async () => {
    const older = consentStatus({ notice_version: 'location-notice-v1', requires_acceptance: true });
    const reporting = {
      async reportLocation() {
        return true;
      },
    } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), reporting, fakeParams(), fakeConsents(older));

    await expect(service.reportLocation(DRIVER_ID, COMPANY_ID, location)).resolves.toBeUndefined();
    const e = await capture(
      new DriverShiftService(fakePrisma(), repo, fakeParams(), fakeConsents(older)).updateShift(
        DRIVER_ID,
        COMPANY_ID,
        { on_shift: true, location },
      ),
    );
    expect(e.getResponse()).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
  });

  it('ending the shift never requires consent', async () => {
    const ending = {
      async endShift() {
        return { status: 'off_shift', currentVehicleId: 3, locationUpdatedAt: null } as DriverShiftRow;
      },
    } as unknown as DriverRepository;
    const revoked = consentStatus({ state: 'revoked', requires_acceptance: true });
    const service = new DriverShiftService(fakePrisma(), ending, fakeParams(), fakeConsents(revoked));

    await expect(
      service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: false }),
    ).resolves.toMatchObject({ status: 'off_shift' });
  });
});
