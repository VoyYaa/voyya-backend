import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SessionResponse } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthService } from './auth.service';
import type { DriverPinRepository, LockedDriver } from './driver-pin.repository';
import { DriverPinService } from './driver-pin.service';
import type { Hasher } from './hasher.service';
import type { RefreshTokenService } from './refresh-token.service';

const DRIVER_ID = 5;
const COMPANY_ID = 2;
const SESSION = { tokens: { access_token: 'new-access' } } as unknown as SessionResponse;

const pendingDriver: LockedDriver = {
  driverId: DRIVER_ID,
  pin: 'hashed:482915',
  status: 'off_shift',
  accountStatus: 'active',
  failedAttempts: 0,
  blockedUntil: null,
  pinMustChange: true,
  temporaryPinExpiresAt: new Date(Date.now() + 3_600_000),
  pinChangedAt: null,
  nationalId: '71123456',
  phone: '3001234567',
  firstName: 'Juan',
  lastName: 'Perez',
};

const alreadyChanged = (pinChangedAt: Date): LockedDriver => ({
  ...pendingDriver,
  pin: 'hashed:739204',
  pinMustChange: false,
  temporaryPinExpiresAt: null,
  pinChangedAt,
});

function create() {
  const repo = {
    lockDriver: jest.fn(),
    registerFailure: jest.fn().mockResolvedValue(undefined),
    applyNewPin: jest.fn().mockResolvedValue(undefined),
  };
  const tx = {} as Prisma.TransactionClient;
  const prisma = {
    runInTenant: jest.fn(async (_companyId: number, fn: (t: Prisma.TransactionClient) => unknown) =>
      fn(tx),
    ),
  };
  const hasher: Hasher = {
    hash: jest.fn(async (x: string) => `hashed:${x}`),
    compare: jest.fn(async (x: string, h: string) => h === `hashed:${x}`),
  };
  const values: Record<string, unknown> = { LOGIN_MAX_ATTEMPTS: 3, LOGIN_BLOCK_MINUTES: 15 };
  const env = { get: (k: string) => values[k] } as unknown as EnvService;
  const refreshTokens = { revokeAllForUser: jest.fn().mockResolvedValue(1) };
  const auth = { issueSession: jest.fn().mockResolvedValue(SESSION) };
  const service = new DriverPinService(
    prisma as unknown as PrismaService,
    repo as unknown as DriverPinRepository,
    hasher,
    env,
    refreshTokens as unknown as RefreshTokenService,
    auth as unknown as AuthService,
  );
  return { service, repo, hasher, refreshTokens, auth };
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

function code(e: HttpException): string {
  const r = e.getResponse();
  return typeof r === 'object' && r !== null && 'code' in r ? String((r as { code: unknown }).code) : '';
}

const dto = { current_pin: '482915', new_pin: '739204' };

describe('DriverPinService.changePin', () => {
  it('happy: stores the hash, revokes every session, then issues a new session without the claim', async () => {
    const { service, repo, refreshTokens, auth } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver });

    const result = await service.changePin(DRIVER_ID, COMPANY_ID, dto, 'ua');

    expect(result).toBe(SESSION);
    expect(repo.applyNewPin).toHaveBeenCalledWith(expect.anything(), DRIVER_ID, COMPANY_ID, 'hashed:739204');
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith(DRIVER_ID);
    expect(auth.issueSession).toHaveBeenCalledWith(
      { userId: DRIVER_ID, firstName: 'Juan', lastName: 'Perez', role: 'driver' },
      COMPANY_ID,
      'ua',
    );
    expect(refreshTokens.revokeAllForUser.mock.invocationCallOrder[0]).toBeLessThan(
      auth.issueSession.mock.invocationCallOrder[0] as number,
    );
  });

  it('wrong current PIN below the cap -> 401 INVALID_CREDENTIALS and counts the failure', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver });
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, { ...dto, current_pin: '000111' }));
    expect(e.getStatus()).toBe(401);
    expect(code(e)).toBe('INVALID_CREDENTIALS');
    expect(repo.registerFailure).toHaveBeenCalledWith(expect.anything(), DRIVER_ID, COMPANY_ID, null);
    expect(repo.applyNewPin).not.toHaveBeenCalled();
  });

  it('wrong current PIN reaching the cap -> 429 ACCOUNT_TEMPORARILY_BLOCKED with the block recorded', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver, failedAttempts: 2 });
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, { ...dto, current_pin: '000111' }));
    expect(e.getStatus()).toBe(429);
    expect(code(e)).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
    expect(repo.registerFailure.mock.calls[0]?.[3]).toBeInstanceOf(Date);
  });

  it('already blocked -> 429 without comparing the PIN', async () => {
    const { service, repo, hasher } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver, blockedUntil: new Date(Date.now() + 60_000) });
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, dto));
    expect(e.getStatus()).toBe(429);
    expect(hasher.compare).not.toHaveBeenCalled();
  });

  it('driver not found -> 401 INVALID_CREDENTIALS', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue(null);
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, dto));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });

  it('expired temporary PIN with the right current PIN -> 401 TEMPORARY_PIN_EXPIRED, no failure counted', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue({
      ...pendingDriver,
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, dto));
    expect(code(e)).toBe('TEMPORARY_PIN_EXPIRED');
    expect(repo.registerFailure).not.toHaveBeenCalled();
    expect(repo.applyNewPin).not.toHaveBeenCalled();
  });

  it('new PIN made of the last digits of the national id or phone -> 422 PIN_TOO_WEAK', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver });
    const fromNationalId = await capture(
      service.changePin(DRIVER_ID, COMPANY_ID, { ...dto, new_pin: '123456' }),
    );
    expect(fromNationalId.getStatus()).toBe(422);
    expect(code(fromNationalId)).toBe('PIN_TOO_WEAK');
    const fromPhone = await capture(
      service.changePin(DRIVER_ID, COMPANY_ID, { ...dto, new_pin: '234567' }),
    );
    expect(code(fromPhone)).toBe('PIN_TOO_WEAK');
    expect(repo.applyNewPin).not.toHaveBeenCalled();
  });

  it('suspended driver -> 403 ACCOUNT_SUSPENDED', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue({ ...pendingDriver, status: 'suspended' });
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, dto));
    expect(e.getStatus()).toBe(403);
    expect(code(e)).toBe('ACCOUNT_SUSPENDED');
  });

  it('second submit of the same change within 60 s -> new session, nothing written, no failure counted', async () => {
    const { service, repo, auth } = create();
    repo.lockDriver.mockResolvedValue(alreadyChanged(new Date(Date.now() - 5_000)));
    const result = await service.changePin(DRIVER_ID, COMPANY_ID, dto);
    expect(result).toBe(SESSION);
    expect(repo.applyNewPin).not.toHaveBeenCalled();
    expect(repo.registerFailure).not.toHaveBeenCalled();
    expect(auth.issueSession).toHaveBeenCalledTimes(1);
  });

  it('same retry after the 60 s window counts as a wrong current PIN', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue(alreadyChanged(new Date(Date.now() - 120_000)));
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, dto));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
    expect(repo.registerFailure).toHaveBeenCalledTimes(1);
  });

  it('retry with a different new PIN is not idempotent and counts', async () => {
    const { service, repo } = create();
    repo.lockDriver.mockResolvedValue(alreadyChanged(new Date(Date.now() - 5_000)));
    const e = await capture(service.changePin(DRIVER_ID, COMPANY_ID, { ...dto, new_pin: '846205' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });
});
