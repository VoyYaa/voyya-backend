import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DRIVER_SUSPENDED_EVENT, type CreateDriverDTO } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { FileStorageProvider } from '../affiliation/ports/file-storage.port';
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

const documentTypes = ['license', 'soat', 'vehicle_inspection', 'operation_card'] as const;

const dto: CreateDriverDTO = {
  first_name: 'Juan',
  last_name: 'Conductor',
  national_id: '71000099',
  phone: '3009998877',
  vehicle: { plate: 'ABC123', model: 'Renault Logan' },
  documents: documentTypes.map((type) => ({
    type,
    storage_key: `staging/2026/01/01/${type}-uuid.pdf`,
    expires_at: '2027-01-01',
  })),
};

const createdDocumentRows = documentTypes.map((type, i) => ({
  driverDocumentId: i + 1,
  type,
  fileName: `${type}.pdf`,
  issuedAt: null,
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
}));

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
    createDriverDocuments: jest.fn().mockResolvedValue(createdDocumentRows),
    lockFleetQuota: jest.fn().mockResolvedValue({ declared: null, used: 0 }),
    readFleetQuota: jest.fn().mockResolvedValue({ declared: null, used: 0 }),
    markPinDelivered: jest.fn().mockResolvedValue(new Date('2026-01-01T00:05:00.000Z')),
    rotatePin: jest.fn(),
    findIdInTenant: jest.fn(),
  };
  const hasher: Hasher = {
    hash: jest.fn(async (x: string) => `hashed:${x}`),
    compare: jest.fn(),
  };
  const sms: SmsProvider = { send: jest.fn().mockResolvedValue(undefined) };
  const storage: FileStorageProvider = {
    put: jest.fn(),
    stat: jest.fn().mockResolvedValue({
      storageKey: 'staging/2026/01/01/x.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    }),
    move: jest.fn().mockResolvedValue(undefined),
    signedUrl: jest.fn(),
    remove: jest.fn(),
    listOlderThan: jest.fn(),
  };
  const emitter = { emit: jest.fn() };
  const prisma = fakePrisma();
  const service = new AdminDriverService(
    prisma,
    repo as unknown as AdminDriverRepository,
    fakeEnv(),
    emitter as unknown as EventEmitter2,
    hasher,
    sms,
    storage,
  );
  return { service, repo, hasher, sms, storage, prisma, emitter };
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

  it('missing a required document type -> 422 DRIVER_DOCUMENTS_INCOMPLETE, nothing created', async () => {
    const { service, repo } = create();
    const incomplete: CreateDriverDTO = { ...dto, documents: dto.documents.slice(0, 3) };

    await expect(service.create(COMPANY_ID, incomplete)).rejects.toMatchObject({
      response: { code: 'DRIVER_DOCUMENTS_INCOMPLETE' },
    });
    expect(repo.createDriverWithVehicle).not.toHaveBeenCalled();
  });

  it('fleet quota reached (declared <= used) -> 409 FLEET_LIMIT_REACHED, driver not created', async () => {
    const { service, repo } = create();
    repo.lockFleetQuota.mockResolvedValueOnce({ declared: 5, used: 5 });

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e.getResponse()).toMatchObject({ code: 'FLEET_LIMIT_REACHED' });
    expect(repo.createDriverWithVehicle).not.toHaveBeenCalled();
  });

  it('vehicle_count is NULL (undeclared fleet, e.g. Cootrayal) -> never blocked by quota', async () => {
    const { service, repo } = create();
    repo.lockFleetQuota.mockResolvedValueOnce({ declared: null, used: 999 });

    const result = await service.create(COMPANY_ID, dto);
    expect(result.driver_id).toBe(42);
  });

  it('a staged document no longer exists in storage -> 409 DOCUMENT_NOT_FOUND', async () => {
    const { service, storage } = create();
    (storage.stat as jest.Mock).mockResolvedValueOnce(null);

    const e = await capture(service.create(COMPANY_ID, dto));
    expect(e.getResponse()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
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

describe('AdminDriverService.getFleetQuota', () => {
  it('declared fleet -> available = declared - used', async () => {
    const { service, repo } = create();
    repo.readFleetQuota.mockResolvedValueOnce({ declared: 10, used: 4 });

    await expect(service.getFleetQuota(COMPANY_ID)).resolves.toEqual({
      declared: 10,
      used: 4,
      available: 6,
    });
  });

  it('undeclared fleet (null) -> available is null, never negative', async () => {
    const { service, repo } = create();
    repo.readFleetQuota.mockResolvedValueOnce({ declared: null, used: 3 });

    await expect(service.getFleetQuota(COMPANY_ID)).resolves.toEqual({
      declared: null,
      used: 3,
      available: null,
    });
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

describe('AdminDriverService.suspend (B-02: must stay inside the caller tenant)', () => {
  it('driver belongs to the caller tenant -> emits fleet.driver_suspended scoped to that company', async () => {
    const { service, repo, emitter } = create();
    repo.findIdInTenant.mockResolvedValue(42);

    const result = await service.suspend(COMPANY_ID, 42, 'suspended');

    expect(result).toEqual({ ok: true });
    expect(repo.findIdInTenant).toHaveBeenCalledWith(expect.anything(), 42, COMPANY_ID);
    expect(emitter.emit).toHaveBeenCalledWith(
      DRIVER_SUSPENDED_EVENT,
      expect.objectContaining({ driver_id: 42, company_id: COMPANY_ID, reason: 'suspended' }),
    );
  });

  it('driver belongs to a different tenant (not found under this company_id) -> 404 DRIVER_NOT_FOUND, no event emitted', async () => {
    const { service, repo, emitter } = create();
    repo.findIdInTenant.mockResolvedValue(null);

    const e = await capture(service.suspend(COMPANY_ID, 999, 'suspended'));

    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.getResponse()).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
