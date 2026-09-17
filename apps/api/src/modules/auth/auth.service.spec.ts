import {
  ForbiddenException,
  GoneException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { JwtService } from '@nestjs/jwt';
import type { EnvService } from '../../config/env.service';
import type { SmsProvider } from '../assignment/ports/sms-provider.port';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import type { Hasher } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

function fakeEnv(): EnvService {
  const v: Record<string, unknown> = {
    OTP_LENGTH: 4,
    OTP_TTL_SECONDS: 300,
    OTP_MAX_ATTEMPTS: 3,
    OTP_RATE_LIMIT_MAX: 3,
    OTP_RATE_LIMIT_WINDOW_SECONDS: 3600,
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    LOGIN_MAX_ATTEMPTS: 3,
    LOGIN_BLOCK_MINUTES: 15,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_DAYS: 30,
    BCRYPT_ROUNDS: 12,
  };
  return { get: (k: string) => v[k] } as unknown as EnvService;
}

type RepoMock = { [K in keyof AuthRepository]: jest.Mock };
type RefreshMock = { [K in keyof RefreshTokenService]: jest.Mock };

function create() {
  const repo = {
    countOtpSince: jest.fn(),
    lastOtpCreatedAt: jest.fn(),
    createOtp: jest.fn(),
    getActiveOtp: jest.fn(),
    incrementOtpAttempts: jest.fn(),
    consumeOtp: jest.fn().mockResolvedValue(true),
    getUserByPhone: jest.fn(),
    getUserByEmail: jest.fn(),
    getUser: jest.fn(),
    createPassengerAutoRegister: jest.fn(),
    getDriverByNationalId: jest.fn(),
    getDriverCompany: jest.fn(),
    registerDriverFailure: jest.fn(),
    resetDriverAttempts: jest.fn(),
  };
  const refreshTokens = {
    issue: jest.fn().mockResolvedValue('refresh-1'),
    rotate: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(0),
  };
  const jwt = { sign: jest.fn().mockReturnValue('access-jwt') };
  const emitter = { emit: jest.fn() };
  const sms = { send: jest.fn().mockResolvedValue(undefined) };
  const hasher: Hasher = {
    hash: jest.fn(async (x: string) => `hashed:${x}`),
    compare: jest.fn(async (x: string, h: string) => h === `hashed:${x}`),
  };
  const service = new AuthService(
    repo as unknown as AuthRepository,
    refreshTokens as unknown as RefreshTokenService,
    jwt as unknown as JwtService,
    fakeEnv(),
    emitter as unknown as EventEmitter2,
    hasher,
    sms as unknown as SmsProvider,
  );
  return { service, repo, refreshTokens, jwt, emitter, sms, hasher };
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

const inFuture = (): Date => new Date(Date.now() + 60_000);
const newPassengerUser = {
  userId: 10,
  firstName: '',
  lastName: '',
  email: null,
  passwordHash: null,
  role: 'passenger',
  accountStatus: 'active',
  companyId: null,
};

describe('AuthService.requestOtp', () => {
  it('happy: creates OTP, sends it by SMS and returns cooldown/TTL', async () => {
    const { service, repo, sms } = create();
    (repo as RepoMock).countOtpSince.mockResolvedValue(0);
    (repo as RepoMock).lastOtpCreatedAt.mockResolvedValue(null);
    (repo as RepoMock).createOtp.mockResolvedValue(undefined);

    const r = await service.requestOtp({ phone: '3001112233' });

    expect(r).toEqual({ sent: true, resend_in_sec: 30, expires_in_sec: 300 });
    expect((repo as RepoMock).createOtp).toHaveBeenCalledTimes(1);
    expect((sms as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
  });

  it('rate-limit by phone -> 429 OTP_RATE_LIMIT', async () => {
    const { service, repo } = create();
    (repo as RepoMock).countOtpSince.mockResolvedValue(3);
    const e = await capture(service.requestOtp({ phone: '3001112233' }));
    expect(e.getStatus()).toBe(429);
    expect(code(e)).toBe('OTP_RATE_LIMIT');
  });

  it('resend before cooldown -> 429 OTP_RATE_LIMIT', async () => {
    const { service, repo } = create();
    (repo as RepoMock).countOtpSince.mockResolvedValue(0);
    (repo as RepoMock).lastOtpCreatedAt.mockResolvedValue(new Date(Date.now() - 5_000));
    const e = await capture(service.requestOtp({ phone: '3001112233' }));
    expect(e.getStatus()).toBe(429);
  });
});

describe('AuthService.verifyOtp', () => {
  it('passenger auto-register + single use (consumed) + tokens', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getActiveOtp.mockResolvedValue({
      id: 1,
      codeHash: 'hashed:1234',
      attempts: 0,
      expiresAt: inFuture(),
    });
    (repo as RepoMock).getUserByPhone.mockResolvedValue(null);
    (repo as RepoMock).createPassengerAutoRegister.mockResolvedValue(newPassengerUser);

    const r = await service.verifyOtp({ phone: '3001112233', code: '1234' });

    expect((repo as RepoMock).consumeOtp).toHaveBeenCalledWith(1);
    expect((repo as RepoMock).createPassengerAutoRegister).toHaveBeenCalledTimes(1);
    expect(r.user.role).toBe('passenger');
    expect(r.user.profile_complete).toBe(false);
    expect(r.tokens.access_token).toBe('access-jwt');
    expect(r.tokens.refresh_token).toBe('refresh-1');
  });

  it('no active OTP (or expired) -> 410 OTP_EXPIRED', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getActiveOtp.mockResolvedValue(null);
    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '1234' }));
    expect(e).toBeInstanceOf(GoneException);
    expect(code(e)).toBe('OTP_EXPIRED');
  });

  it('wrong code -> increments attempts and 401 OTP_INVALID', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getActiveOtp.mockResolvedValue({
      id: 7,
      codeHash: 'hashed:9999',
      attempts: 0,
      expiresAt: inFuture(),
    });
    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '1234' }));
    expect((repo as RepoMock).incrementOtpAttempts).toHaveBeenCalledWith(7);
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(code(e)).toBe('OTP_INVALID');
  });

  it('atomic consume lost (count!==1) -> 401 OTP_INVALID (no double session)', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getActiveOtp.mockResolvedValue({
      id: 1,
      codeHash: 'hashed:1234',
      attempts: 0,
      expiresAt: inFuture(),
    });
    (repo as RepoMock).consumeOtp.mockResolvedValue(false);
    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '1234' }));
    expect(code(e)).toBe('OTP_INVALID');
  });

  it('code verification cap -> 429 OTP_MAX_ATTEMPTS', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getActiveOtp.mockResolvedValue({
      id: 7,
      codeHash: 'hashed:1234',
      attempts: 3,
      expiresAt: inFuture(),
    });
    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '1234' }));
    expect(e.getStatus()).toBe(429);
    expect(code(e)).toBe('OTP_MAX_ATTEMPTS');
  });
});

const driverBase = {
  driverId: 5,
  companyId: 2,
  pin: 'hashed:1234',
  status: 'available',
  failedAttempts: 0,
  blockedUntil: null,
  firstName: 'Juan',
  lastName: 'Pérez',
  accountStatus: 'active',
  pinDeliveredAt: new Date(),
};

describe('AuthService.driverLogin', () => {
  it('happy: tokens with driver role and companyId; resets attempts', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...driverBase });
    const r = await service.driverLogin({ national_id: '71000001', pin: '1234' });
    expect((repo as RepoMock).resetDriverAttempts).toHaveBeenCalledWith(5, 2);
    expect(r.user.role).toBe('driver');
    expect(r.user.company_id).toBe(2);
    expect(r.user.profile_complete).toBe(true);
  });

  it('wrong PIN (below cap) -> 401 INVALID_CREDENTIALS and records failure', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...driverBase, failedAttempts: 0 });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '0000' }));
    expect((repo as RepoMock).registerDriverFailure).toHaveBeenCalledWith(5, 2, null);
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });

  it('wrong PIN reaching the cap -> 429 ACCOUNT_TEMPORARILY_BLOCKED', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...driverBase, failedAttempts: 2 });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '0000' }));
    const call = (repo as RepoMock).registerDriverFailure.mock.calls[0];
    expect(call?.[1]).toBe(2);
    expect(call?.[2]).toBeInstanceOf(Date);
    expect(e.getStatus()).toBe(429);
    expect(code(e)).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
  });

  it('already blocked -> 429 without comparing PIN', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...driverBase,
      blockedUntil: inFuture(),
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '1234' }));
    expect(e.getStatus()).toBe(429);
  });

  it('suspended driver -> 403 ACCOUNT_SUSPENDED', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...driverBase, status: 'suspended' });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '1234' }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(code(e)).toBe('ACCOUNT_SUSPENDED');
  });

  it('non-existent national id -> 401 (generic, anti-enumeration)', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue(null);
    const e = await capture(service.driverLogin({ national_id: '99999999', pin: '1234' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });

  it('PIN never delivered -> 403 PIN_NOT_DELIVERED, checked after a successful PIN compare', async () => {
    const { service, repo, hasher } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...driverBase,
      pinDeliveredAt: null,
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '1234' }));
    expect((hasher.compare as jest.Mock)).toHaveBeenCalledWith('1234', 'hashed:1234');
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(code(e)).toBe('PIN_NOT_DELIVERED');
  });

  it('wrong PIN with pinDeliveredAt null -> 401 INVALID_CREDENTIALS, not PIN_NOT_DELIVERED', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...driverBase,
      pinDeliveredAt: null,
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '0000' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });
});

describe('AuthService.adminLogin', () => {
  const admin = {
    userId: 1,
    firstName: 'Admin',
    lastName: 'VoyYa',
    email: 'admin@voyya.co',
    passwordHash: 'hashed:Secret12',
    role: 'admin',
    accountStatus: 'active',
    companyId: 1,
  };

  it('happy: tokens with admin role and its company_id', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin });
    const r = await service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' });
    expect(r.user.role).toBe('admin');
    expect(r.user.company_id).toBe(1);
  });

  it('wrong password -> 401', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'wrong1234' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });

  it('user without admin/operator role -> 401', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin, role: 'passenger' });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
  });

  it('admin without a linked company -> 403 STAFF_WITHOUT_COMPANY', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin, companyId: null });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(code(e)).toBe('STAFF_WITHOUT_COMPANY');
  });
});

describe('AuthService.refresh / logout / revocation', () => {
  it('refresh: uses the rotated token and issues a new access', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 5, refreshToken: 'new-refresh' });
    (repo as RepoMock).getUser.mockResolvedValue({
      ...driverBase,
      userId: 5,
      role: 'driver',
      accountStatus: 'active',
    });
    (repo as RepoMock).getDriverCompany.mockResolvedValue({ companyId: 2, status: 'available' });

    const r = await service.refresh({ refresh_token: 'old' });
    expect(r.refresh_token).toBe('new-refresh');
    expect(r.access_token).toBe('access-jwt');
    expect(r.expires_in).toBe(900);
  });

  it('refresh of SUSPENDED passenger/admin -> 401 REFRESH_REVOKED + revokes family', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 10, refreshToken: 'new' });
    (repo as RepoMock).getUser.mockResolvedValue({
      userId: 10,
      firstName: 'Ana',
      lastName: 'P',
      email: null,
      passwordHash: null,
      role: 'passenger',
      accountStatus: 'suspended',
    });
    const e = await capture(service.refresh({ refresh_token: 'x' }));
    expect(code(e)).toBe('REFRESH_REVOKED');
    expect((refreshTokens as RefreshMock).revokeAllForUser).toHaveBeenCalledWith(10);
  });

  it('refresh of SUSPENDED driver -> 401 REFRESH_REVOKED + revokes family', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 5, refreshToken: 'new' });
    (repo as RepoMock).getUser.mockResolvedValue({
      userId: 5,
      firstName: 'J',
      lastName: 'P',
      email: null,
      passwordHash: null,
      role: 'driver',
      accountStatus: 'active',
    });
    (repo as RepoMock).getDriverCompany.mockResolvedValue({ companyId: 2, status: 'suspended' });
    const e = await capture(service.refresh({ refresh_token: 'x' }));
    expect(code(e)).toBe('REFRESH_REVOKED');
    expect((refreshTokens as RefreshMock).revokeAllForUser).toHaveBeenCalledWith(5);
  });

  it('refresh of an admin whose company got unlinked -> 401 REFRESH_REVOKED + revokes family', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 1, refreshToken: 'new' });
    (repo as RepoMock).getUser.mockResolvedValue({
      userId: 1,
      firstName: 'Admin',
      lastName: 'VoyYa',
      email: 'admin@voyya.co',
      passwordHash: 'hashed:Secret12',
      role: 'admin',
      accountStatus: 'active',
      companyId: null,
    });
    const e = await capture(service.refresh({ refresh_token: 'x' }));
    expect(code(e)).toBe('STAFF_WITHOUT_COMPANY');
    expect((refreshTokens as RefreshMock).revokeAllForUser).toHaveBeenCalledWith(1);
  });

  it('logout is idempotent -> { ok: true } and revokes', async () => {
    const { service, refreshTokens } = create();
    const r = await service.logout({ refresh_token: 'anything' });
    expect(r).toEqual({ ok: true });
    expect((refreshTokens as RefreshMock).revoke).toHaveBeenCalledWith('anything');
  });

  it('driver suspension -> revokes all their sessions', async () => {
    const { service, refreshTokens } = create();
    (refreshTokens as RefreshMock).revokeAllForUser.mockResolvedValue(2);
    await service.onDriverSuspended({
      driver_id: 5,
      company_id: 2,
      reason: 'suspended',
      occurred_at: new Date().toISOString(),
    });
    expect((refreshTokens as RefreshMock).revokeAllForUser).toHaveBeenCalledWith(5);
  });
});
