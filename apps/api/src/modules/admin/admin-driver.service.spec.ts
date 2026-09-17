import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateDriverDTO } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { SmsProvider } from '../assignment/ports/sms-provider.port';
import type { Hasher } from '../auth/hasher.service';
import { AdminDriverRepository } from './admin-driver.repository';
import { AdminDriverService } from './admin-driver.service';

const COMPANY_ID = 7;

function fakeEnv(): EnvService {
  return { get: () => 6 } as unknown as EnvService;
}

function fakePrisma(): PrismaService {
  return {
    runInTenant: jest.fn((_companyId: number, fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PrismaService;
}

function p2002(modelName: string, target: string[] | null): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { modelName, target },
  });
}

const createdRow = {
  driverId: 42,
  nationalId: '71000099',
  firstName: 'Juan',
  lastName: 'Conductor',
  phone: '3009998877',
  email: null,
  status: 'off_shift' as const,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  vehicle: { vehicleId: 5, plate: 'ABC123', model: 'Renault Logan', year: 2020 },
};

const dto: CreateDriverDTO = {
  first_name: 'Juan',
  last_name: 'Conductor',
  national_id: '71000099',
  phone: '3009998877',
  vehicle: { plate: 'ABC123', model: 'Renault Logan' },
};

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
    createDriverWithVehicle: jest.fn().mockResolvedValue(createdRow),
    markPinDelivered: jest.fn().mockResolvedValue(new Date('2026-01-01T00:05:00.000Z')),
    rotatePin: jest.fn(),
  };
  const hasher: Hasher = {
    hash: jest.fn(async (x: string) => `hashed:${x}`),
    compare: jest.fn(),
  };
  const sms: SmsProvider = { send: jest.fn().mockResolvedValue(undefined) };
  const prisma = fakePrisma();
  const service = new AdminDriverService(
    prisma,
    repo as unknown as AdminDriverRepository,
    fakeEnv(),
    hasher,
    sms,
  );
  return { service, repo, hasher, sms, prisma };
}

describe('AdminDriverService.create', () => {
  it('happy: SMS succeeds -> pin_delivery=sent, response never carries the PIN', async () => {
    const { service, sms } = create();

    const result = await service.create(COMPANY_ID, dto);

    expect(result.pin_delivery).toBe('sent');
    expect(result.pin_delivered_at).toBe('2026-01-01T00:05:00.000Z');
    expect(result.driver_id).toBe(42);
    expect(result.vehicle.plate).toBe('ABC123');
    expect((sms.send as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/"pin"/i);
  });

  it('SMS fails -> 201-equivalent result with pin_delivery=failed and pin_delivered_at=null', async () => {
    const { service, sms } = create();
    (sms.send as jest.Mock).mockRejectedValueOnce(new Error('twilio down'));

    const result = await service.create(COMPANY_ID, dto);

    expect(result.pin_delivery).toBe('failed');
    expect(result.pin_delivered_at).toBeNull();
  });

  it('national_id collision -> 409 NATIONAL_ID_TAKEN (Prisma reports Driver with target=null in this setup)', async () => {
    const { service, repo } = create();
    repo.createDriverWithVehicle.mockRejectedValueOnce(p2002('Driver', null));

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'NATIONAL_ID_TAKEN' });
  });

  it('phone collision -> 409 PHONE_TAKEN (User model, target=[phone])', async () => {
    const { service, repo } = create();
    repo.createDriverWithVehicle.mockRejectedValueOnce(p2002('User', ['phone']));

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e.getResponse()).toMatchObject({ code: 'PHONE_TAKEN' });
  });

  it('email collision -> 409 EMAIL_TAKEN (User model, target=[email])', async () => {
    const { service, repo } = create();
    repo.createDriverWithVehicle.mockRejectedValueOnce(p2002('User', ['email']));

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e.getResponse()).toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('plate collision -> 409 PLATE_TAKEN (Prisma reports Vehicle with target=null in this setup)', async () => {
    const { service, repo } = create();
    repo.createDriverWithVehicle.mockRejectedValueOnce(p2002('Vehicle', null));

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e.getResponse()).toMatchObject({ code: 'PLATE_TAKEN' });
  });

  it('an unrelated error is rethrown as-is, not swallowed', async () => {
    const { service, repo } = create();
    const boom = new Error('connection reset');
    repo.createDriverWithVehicle.mockRejectedValueOnce(boom);

    await expect(service.create(COMPANY_ID, dto)).rejects.toBe(boom);
  });

  it('a P2002 on an unmapped model is rethrown, not silently turned into a generic 409', async () => {
    const { service, repo } = create();
    const err = p2002('SomeOtherModel', ['some_other_unique_column']);
    repo.createDriverWithVehicle.mockRejectedValueOnce(err);

    await expect(service.create(COMPANY_ID, dto)).rejects.toBe(err);
  });

  it('User model without a resolvable target is rethrown rather than guessing phone vs email', async () => {
    const { service, repo } = create();
    const err = p2002('User', null);
    repo.createDriverWithVehicle.mockRejectedValueOnce(err);

    await expect(service.create(COMPANY_ID, dto)).rejects.toBe(err);
  });
});

describe('AdminDriverService.resendPin', () => {
  it('rotates the pin and delivers it', async () => {
    const { service, repo, sms } = create();
    repo.rotatePin.mockResolvedValue({ driverId: 42, nationalId: '71000099', phone: '3009998877' });

    const result = await service.resendPin(COMPANY_ID, 42);

    expect(result.driver_id).toBe(42);
    expect(result.pin_delivery).toBe('sent');
    expect((sms.send as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/"pin"/i);
  });

  it('driver not found in this tenant -> 404 DRIVER_NOT_FOUND', async () => {
    const { service, repo } = create();
    repo.rotatePin.mockResolvedValue(null);

    await expect(service.resendPin(COMPANY_ID, 999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
