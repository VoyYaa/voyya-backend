import { ConflictException, HttpException } from '@nestjs/common';
import { DriverShiftService } from './driver-shift.service';
import type { DriverRepository, DriverShiftRow } from './driver.repository';
import type { OperationalParamsService } from './operational-params.service';
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
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

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
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

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
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

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
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

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
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

    const r = await service.updateShift(DRIVER_ID, COMPANY_ID, { on_shift: false });
    expect(r.status).toBe('off_shift');
    expect(r.on_shift).toBe(false);
  });
});

describe('DriverShiftService.reportLocation', () => {
  it('not on shift -> 409 NOT_ON_SHIFT', async () => {
    const repo = { async reportLocation() { return false; } } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

    const e = await capture(service.reportLocation(DRIVER_ID, COMPANY_ID, LOCATION));
    expect(e.getResponse()).toMatchObject({ code: 'NOT_ON_SHIFT' });
  });

  it('available or on_trip -> succeeds silently', async () => {
    const repo = { async reportLocation() { return true; } } as unknown as DriverRepository;
    const service = new DriverShiftService(fakePrisma(), repo, fakeParams());

    await expect(service.reportLocation(DRIVER_ID, COMPANY_ID, LOCATION)).resolves.toBeUndefined();
  });
});
