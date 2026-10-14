import {
  ForbiddenException,
  GoneException,
  HttpException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { JwtService } from '@nestjs/jwt';
import { OTP_LENGTH } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import { captureError } from '../../infrastructure/observability/sentry';
import type { SmsProvider } from '../assignment/ports/sms-provider.port';
import { OtpGlobalDailyCapReachedError } from './auth-errors';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import type { Hasher } from './hasher.service';
import { RefreshTokenService } from './refresh-token.service';

jest.mock('../../infrastructure/observability/sentry', () => ({
  ...jest.requireActual('../../infrastructure/observability/sentry'),
  captureError: jest.fn(),
}));

function fakeEnv(): EnvService {
  const v: Record<string, unknown> = {
    OTP_TTL_SECONDS: 300,
    OTP_MAX_ATTEMPTS: 3,
    OTP_RATE_LIMIT_MAX: 3,
    OTP_RATE_LIMIT_WINDOW_SECONDS: 3600,
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    OTP_PHONE_DAILY_LIMIT: 10,
    OTP_GLOBAL_DAILY_LIMIT: 300,
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

const openVerdict = () => ({
  waits: { cooldown: null, hourly: null, daily: null, global: null },
  globalCount: 0,
});

function create() {
  const repo = {
    evaluateOtpIssuance: jest.fn().mockImplementation(async () => openVerdict()),
    issueOtp: jest.fn().mockResolvedValue({ kind: 'issued', insertedId: 11, globalCount: 0 }),
    refundOtpIssuance: jest.fn().mockResolvedValue(true),
    findLiveOtp: jest.fn(),
    reserveOtpAttempt: jest.fn(),
    readOtpReservationState: jest.fn(),
    consumeOtp: jest.fn().mockResolvedValue(true),
    getUserByPhone: jest.fn(),
    getUserByEmail: jest.fn(),
    getUser: jest.fn(),
    createPassengerAutoRegister: jest.fn(),
    getDriverByNationalId: jest.fn(),
    getDriverCompany: jest.fn(),
    registerDriverFailure: jest.fn(),
    resetDriverAttempts: jest.fn(),
    registerAdminFailure: jest.fn(),
    resetAdminAttempts: jest.fn(),
    getCompanyIdentity: jest.fn(),
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
  (hasher.hash as jest.Mock).mockClear();
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
function companyIdentityFixture(companyId: number, companyName = 'Cootrayal') {
  return { companyId, companyName, municipalityId: 77, municipalityName: 'Yarumal' };
}
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function codeSent(sms: { send: jest.Mock }, call = 0): string {
  const message = String(sms.send.mock.calls[call]?.[1]);
  const match = /(\d+)$/.exec(message);
  if (!match?.[1]) throw new Error('No code in the SMS body');
  return match[1];
}

describe('AuthService.requestOtp (ADR-035 section 3.1)', () => {
  it('happy: issues the OTP, sends the code by SMS and returns cooldown and TTL', async () => {
    const { service, repo, sms, hasher } = create();

    const r = await service.requestOtp({ phone: '3001112233' });

    expect(r).toEqual({ sent: true, resend_in_sec: 30, expires_in_sec: 300 });
    expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);
    const input = (repo as RepoMock).issueOtp.mock.calls[0]?.[0] as {
      phone: string;
      codeHash: string;
      policy: Record<string, number>;
    };
    expect(input.phone).toBe('3001112233');
    expect(input.codeHash).toBe(`hashed:${codeSent(sms)}`);
    expect(input.policy).toEqual({
      ttlSec: 300,
      cooldownSec: 30,
      hourlyLimit: 3,
      hourlyWindowSec: 3600,
      dailyLimit: 10,
      dailyWindowSec: 86400,
      globalLimit: 300,
    });
    expect(hasher.hash).toHaveBeenCalledTimes(1);
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(sms.send).toHaveBeenCalledWith('3001112233', `Tu código VoyYa es ${codeSent(sms)}`, 'otp');
  });

  it('normalizes the phone for the repository and sends the SMS to the number as typed', async () => {
    const { service, repo, sms } = create();

    await service.requestOtp({ phone: '+57 300 111 2233' });

    expect((repo as RepoMock).evaluateOtpIssuance.mock.calls[0]?.[0]).toBe('3001112233');
    expect(((repo as RepoMock).issueOtp.mock.calls[0]?.[0] as { phone: string }).phone).toBe('3001112233');
    expect(sms.send.mock.calls[0]?.[0]).toBe('+57 300 111 2233');
  });

  it('the code has exactly OTP_LENGTH digits from the contract, also with leading zeros (1000 samples)', async () => {
    const { service, sms } = create();
    const codes: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      await service.requestOtp({ phone: `30011${String(10000 + i)}` });
      codes.push(codeSent(sms, i));
    }

    expect(OTP_LENGTH).toBe(6);
    expect(codes.every((c) => new RegExp(`^\\d{${OTP_LENGTH}}$`).test(c))).toBe(true);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
  });

  it('never reads an account: no repository method that touches auth.user is called (D-S01-1)', async () => {
    const { service, repo } = create();

    await service.requestOtp({ phone: '3009900011' });

    expect((repo as RepoMock).getUserByPhone).not.toHaveBeenCalled();
    expect((repo as RepoMock).getUserByEmail).not.toHaveBeenCalled();
    expect((repo as RepoMock).getUser).not.toHaveBeenCalled();
    expect((repo as RepoMock).getDriverByNationalId).not.toHaveBeenCalled();
    expect((repo as RepoMock).createPassengerAutoRegister).not.toHaveBeenCalled();
  });

  it('keeps the order: pre-check, hash, issuing transaction, SMS (P-5)', async () => {
    const { service, repo, hasher, sms } = create();

    await service.requestOtp({ phone: '3001112233' });

    const order = [
      (repo as RepoMock).evaluateOtpIssuance.mock.invocationCallOrder[0],
      (hasher.hash as jest.Mock).mock.invocationCallOrder[0],
      (repo as RepoMock).issueOtp.mock.invocationCallOrder[0],
      sms.send.mock.invocationCallOrder[0],
    ] as number[];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  describe('a cap exhausted at the pre-check costs no hash and opens no transaction (P-5)', () => {
    it.each([
      ['cooldown', { cooldown: 12, hourly: null, daily: null, global: null }, 12],
      ['hourly', { cooldown: null, hourly: 600, daily: null, global: null }, 600],
      ['daily', { cooldown: null, hourly: null, daily: 3600, global: null }, 3600],
      ['global', { cooldown: null, hourly: null, daily: null, global: 80_000 }, 80_000],
    ])('%s', async (_cap, waits, retry) => {
      const { service, repo, hasher, sms } = create();
      (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({ waits, globalCount: 300 });

      const e = await capture(service.requestOtp({ phone: '3001112233' }));

      expect(e.getStatus()).toBe(429);
      expect(e.getResponse()).toEqual({
        code: 'OTP_RATE_LIMIT',
        message: 'Demasiadas solicitudes de código, intenta más tarde',
        retry_in_sec: retry,
      });
      expect(hasher.hash).not.toHaveBeenCalled();
      expect((repo as RepoMock).issueOtp).not.toHaveBeenCalled();
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('answers the largest of several exhausted waits', async () => {
      const { service, repo } = create();
      (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({
        waits: { cooldown: 10, hourly: 600, daily: 7200, global: null },
        globalCount: 0,
      });

      const e = await capture(service.requestOtp({ phone: '3001112233' }));

      expect((e.getResponse() as { retry_in_sec: number }).retry_in_sec).toBe(7200);
    });

    it('all the refusals have the same body shape and code, only the number changes', async () => {
      const bodies = new Set<string>();
      for (const waits of [
        { cooldown: 5, hourly: null, daily: null, global: null },
        { cooldown: null, hourly: 900, daily: null, global: null },
        { cooldown: null, hourly: null, daily: 5000, global: null },
        { cooldown: null, hourly: null, daily: null, global: 70_000 },
      ]) {
        const { service, repo } = create();
        (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({ waits, globalCount: 0 });
        const e = await capture(service.requestOtp({ phone: '3001112233' }));
        bodies.add(JSON.stringify({ ...(e.getResponse() as object), retry_in_sec: 0 }));
      }
      expect(bodies.size).toBe(1);
    });
  });

  describe('the in-process gate (ADR-035 3.2)', () => {
    it('refuses a second request for a phone that is already being issued, with no hash', async () => {
      const { service, repo, hasher } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValueOnce(hold.promise);

      const first = service.requestOtp({ phone: '3001112233' });
      await settle();
      const second = await capture(service.requestOtp({ phone: '3001112233' }));

      expect(second.getStatus()).toBe(429);
      expect(second.getResponse()).toMatchObject({ code: 'OTP_RATE_LIMIT', retry_in_sec: 30 });
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);

      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      await first;
    });

    it('lets a request for another phone through while one phone is being issued', async () => {
      const { service, repo } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValueOnce(hold.promise);

      const first = service.requestOtp({ phone: '3001112233' });
      await settle();
      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      await first;
      const other = await service.requestOtp({ phone: '3001112244' });

      expect(other.sent).toBe(true);
    });

    it('checks and registers the phone synchronously: simultaneous requests in one tick hash once', async () => {
      const { service, repo, hasher } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValue(hold.promise);

      const burst = Array.from({ length: 10 }, () =>
        service.requestOtp({ phone: '3001112233' }).then(
          () => 'ok',
          (e: HttpException) => e.getStatus(),
        ),
      );
      await settle();
      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      const outcomes = await Promise.all(burst);

      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 429)).toHaveLength(9);
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);
    });

    it('releases the gate right after the transaction, before the SMS: a slow provider does not keep the phone busy', async () => {
      const { service, repo, sms } = create();
      const smsHold = deferred();
      sms.send.mockReturnValueOnce(smsHold.promise);

      const first = service.requestOtp({ phone: '3001112233' });
      await settle();
      expect(sms.send).toHaveBeenCalledTimes(1);
      (repo as RepoMock).issueOtp.mockResolvedValueOnce({ kind: 'busy' });
      const second = await capture(service.requestOtp({ phone: '3001112233' }));

      expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(2);
      expect(second.getStatus()).toBe(429);
      smsHold.resolve();
      await first;
    });

    describe('is released on every error path, and the next attempt prospers (P-6)', () => {
      const phone = '3001112233';

      async function nextAttemptWorks(service: AuthService): Promise<void> {
        await expect(service.requestOtp({ phone })).resolves.toMatchObject({ sent: true });
      }

      it('the hash fails', async () => {
        const { service, hasher } = create();
        (hasher.hash as jest.Mock).mockRejectedValueOnce(new Error('hash failed'));

        await expect(service.requestOtp({ phone })).rejects.toThrow('hash failed');

        await nextAttemptWorks(service);
      });

      it('the pre-check fails', async () => {
        const { service, repo } = create();
        (repo as RepoMock).evaluateOtpIssuance.mockRejectedValueOnce(new Error('db down'));

        await expect(service.requestOtp({ phone })).rejects.toThrow('db down');

        await nextAttemptWorks(service);
      });

      it('the issuing transaction throws (P2028 or any error)', async () => {
        const { service, repo } = create();
        (repo as RepoMock).issueOtp.mockRejectedValueOnce(
          Object.assign(new Error('Transaction API error'), { code: 'P2028' }),
        );

        await expect(service.requestOtp({ phone })).rejects.toThrow('Transaction API error');

        await nextAttemptWorks(service);
      });

      it('the transaction answers busy', async () => {
        const { service, repo } = create();
        (repo as RepoMock).issueOtp.mockResolvedValueOnce({ kind: 'busy' });

        const e = await capture(service.requestOtp({ phone }));
        expect(e.getStatus()).toBe(429);

        await nextAttemptWorks(service);
      });

      it('the transaction refuses by a cap', async () => {
        const { service, repo } = create();
        (repo as RepoMock).issueOtp.mockResolvedValueOnce({
          kind: 'refused',
          verdict: { waits: { cooldown: 7, hourly: null, daily: null, global: null }, globalCount: 0 },
        });

        const e = await capture(service.requestOtp({ phone }));
        expect(e.getResponse()).toMatchObject({ retry_in_sec: 7 });

        await nextAttemptWorks(service);
      });

      it('the SMS fails (the quota is returned and the phone is free)', async () => {
        const { service, sms } = create();
        sms.send.mockRejectedValueOnce(new ServiceUnavailableException({ code: 'SMS_SEND_FAILED' }));

        await expect(service.requestOtp({ phone })).rejects.toBeInstanceOf(ServiceUnavailableException);

        await nextAttemptWorks(service);
      });

      it('the limiter saturates', async () => {
        const { service, repo } = create();
        const hold = deferred<unknown>();
        (repo as RepoMock).issueOtp.mockReturnValue(hold.promise);
        const running = Array.from({ length: 6 }, (_, i) =>
          service.requestOtp({ phone: `30011220${i}0` }).catch(() => undefined),
        );
        await settle();
        const e = await capture(service.requestOtp({ phone }));
        expect(e.getStatus()).toBe(429);
        expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);

        hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
        await Promise.all(running);
        await nextAttemptWorks(service);
      });
    });
  });

  describe('the in-process limiter of issuing transactions (ADR-035 3.5)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('opens one transaction at a time and refuses the seventh simultaneous phone with 429 and a 5 s wait, without a transaction', async () => {
      const { service, repo, hasher } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValue(hold.promise);

      const burst = Array.from({ length: 7 }, (_, i) =>
        service.requestOtp({ phone: `30011330${i}0` }).then(
          () => 'ok' as const,
          (e: HttpException) => e,
        ),
      );
      await settle();

      expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);
      expect(hasher.hash).toHaveBeenCalledTimes(7);
      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      const outcomes = await Promise.all(burst);
      const refused = outcomes.filter((o): o is HttpException => o !== 'ok');
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(6);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.getStatus()).toBe(429);
      expect(refused[0]?.getResponse()).toEqual({
        code: 'OTP_RATE_LIMIT',
        message: 'Demasiadas solicitudes de código, intenta más tarde',
        retry_in_sec: 5,
      });
    });

    it('refuses with a 5 s wait a request whose turn does not come in 3 s, and opens no transaction for it', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const { service, repo } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValueOnce(hold.promise);

      const first = service.requestOtp({ phone: '3001114401' });
      await settle();
      const waiting = service.requestOtp({ phone: '3001114402' }).then(
        () => 'ok' as const,
        (e: HttpException) => e,
      );
      await settle();
      await jest.advanceTimersByTimeAsync(3_001);
      const outcome = await waiting;

      expect(outcome).toBeInstanceOf(HttpException);
      expect((outcome as HttpException).getResponse()).toMatchObject({ code: 'OTP_RATE_LIMIT', retry_in_sec: 5 });
      expect((repo as RepoMock).issueOtp).toHaveBeenCalledTimes(1);

      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      await first;
    });

    it('is not a 5xx on purpose, so a burst does not flood Sentry', async () => {
      const { service, repo } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValue(hold.promise);
      const burst = Array.from({ length: 8 }, (_, i) =>
        service.requestOtp({ phone: `30011550${i}0` }).catch((e: HttpException) => e.getStatus()),
      );
      await settle();
      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      const outcomes = await Promise.all(burst);

      expect(outcomes.filter((o) => typeof o === 'number')).toEqual([429, 429]);
    });
  });

  describe('the quota is returned when the SMS fails (ADR-035 3.7)', () => {
    it('deletes the inserted row and answers the provider error', async () => {
      const { service, repo, sms } = create();
      (repo as RepoMock).issueOtp.mockResolvedValue({ kind: 'issued', insertedId: 42, globalCount: 5 });
      const failure = new ServiceUnavailableException({ code: 'SMS_SEND_FAILED', message: 'No se pudo enviar el SMS' });
      sms.send.mockRejectedValueOnce(failure);

      const e = await capture(service.requestOtp({ phone: '3001112233' }));

      expect(e).toBe(failure);
      expect(e.getStatus()).toBe(503);
      expect((repo as RepoMock).refundOtpIssuance).toHaveBeenCalledTimes(1);
      expect((repo as RepoMock).refundOtpIssuance).toHaveBeenCalledWith(42);
    });

    it('refunds after the transaction and never before the SMS attempt', async () => {
      const { service, repo, sms } = create();
      sms.send.mockRejectedValueOnce(new Error('network'));

      await expect(service.requestOtp({ phone: '3001112233' })).rejects.toThrow('network');

      const issued = (repo as RepoMock).issueOtp.mock.invocationCallOrder[0] as number;
      const sent = sms.send.mock.invocationCallOrder[0] as number;
      const refunded = (repo as RepoMock).refundOtpIssuance.mock.invocationCallOrder[0] as number;
      expect(issued).toBeLessThan(sent);
      expect(sent).toBeLessThan(refunded);
    });

    it('does not refund when the SMS goes out', async () => {
      const { service, repo } = create();

      await service.requestOtp({ phone: '3001112233' });

      expect((repo as RepoMock).refundOtpIssuance).not.toHaveBeenCalled();
    });

    it('still answers the provider error when the refund itself fails, and logs it without PII', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, repo, sms } = create();
      const failure = new ServiceUnavailableException({ code: 'SMS_SEND_FAILED' });
      sms.send.mockRejectedValueOnce(failure);
      (repo as RepoMock).refundOtpIssuance.mockRejectedValueOnce(new Error('db down'));

      const e = await capture(service.requestOtp({ phone: '3001112233' }));

      expect(e).toBe(failure);
      expect(warn).toHaveBeenCalledWith({ msg: 'otp_refund_failed' });
      warn.mockRestore();
    });
  });

  describe('logs and the Sentry alert carry no phone and no code (P-11)', () => {
    let warn: jest.SpyInstance;
    let log: jest.SpyInstance;
    let error: jest.SpyInstance;
    const PHONE = '3001112233';

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      (captureError as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function everythingLogged(): string {
      return JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]);
    }

    it.each([
      ['cooldown', { cooldown: 12, hourly: null, daily: null, global: null }],
      ['hourly', { cooldown: null, hourly: 600, daily: null, global: null }],
      ['daily', { cooldown: null, hourly: null, daily: 3600, global: null }],
      ['global', { cooldown: null, hourly: null, daily: null, global: 900 }],
    ])('logs otp_issuance_refused with cap %s at the pre-check', async (cap, waits) => {
      const { service, repo, sms } = create();
      (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({ waits, globalCount: 300 });

      await capture(service.requestOtp({ phone: PHONE }));

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_issuance_refused', cap });
      expect(everythingLogged()).not.toContain(PHONE);
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('logs otp_issuance_refused with cap hourly when the transaction refuses', async () => {
      const { service, repo } = create();
      (repo as RepoMock).issueOtp.mockResolvedValue({
        kind: 'refused',
        verdict: { waits: { cooldown: null, hourly: 55, daily: null, global: null }, globalCount: 0 },
      });

      await capture(service.requestOtp({ phone: PHONE }));

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_issuance_refused', cap: 'hourly' });
    });

    it('logs the cap busy when the gate or the lock refuse', async () => {
      const { service, repo } = create();
      (repo as RepoMock).issueOtp.mockResolvedValue({ kind: 'busy' });

      await capture(service.requestOtp({ phone: PHONE }));

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_issuance_refused', cap: 'busy' });
    });

    it('logs the cap saturated when the limiter refuses', async () => {
      const { service, repo } = create();
      const hold = deferred<unknown>();
      (repo as RepoMock).issueOtp.mockReturnValue(hold.promise);
      const running = Array.from({ length: 6 }, (_, i) =>
        service.requestOtp({ phone: `30011660${i}0` }).catch(() => undefined),
      );
      await settle();

      await capture(service.requestOtp({ phone: PHONE }));

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_issuance_refused', cap: 'saturated' });
      hold.resolve({ kind: 'issued', insertedId: 1, globalCount: 0 });
      await Promise.all(running);
    });

    it('warns at 80%: the emission that makes the count reach 240 of 300', async () => {
      const { service, repo } = create();
      (repo as RepoMock).issueOtp.mockResolvedValue({ kind: 'issued', insertedId: 1, globalCount: 239 });

      await service.requestOtp({ phone: PHONE });

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_global_daily_cap_warning', count: 240, limit: 300 });
      expect(captureError).not.toHaveBeenCalled();
      expect(everythingLogged()).not.toContain(PHONE);
    });

    it('does not warn before 80% nor after it', async () => {
      const { service, repo } = create();
      for (const globalCount of [10, 238, 240, 270]) {
        (repo as RepoMock).issueOtp.mockResolvedValueOnce({ kind: 'issued', insertedId: 1, globalCount });
        await service.requestOtp({ phone: `30011770${String(globalCount).slice(-2)}` });
      }

      expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ msg: 'otp_global_daily_cap_warning' }));
    });

    it('at 100% logs otp_global_daily_cap_reached and raises one Sentry event that is a plain Error', async () => {
      const { service, repo } = create();
      (repo as RepoMock).issueOtp.mockResolvedValue({ kind: 'issued', insertedId: 1, globalCount: 299 });

      await service.requestOtp({ phone: PHONE });

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_global_daily_cap_reached', count: 300, limit: 300 });
      expect(captureError).toHaveBeenCalledTimes(1);
      const raised = (captureError as jest.Mock).mock.calls[0]?.[0];
      expect(raised).toBeInstanceOf(OtpGlobalDailyCapReachedError);
      expect(raised).toBeInstanceOf(Error);
      expect(raised).not.toBeInstanceOf(HttpException);
      expect(String((raised as Error).message)).toBe('OTP global daily cap reached: count=300 limit=300');
      expect(String((raised as Error).message)).not.toContain(PHONE);
    });

    it('when the global cap refuses, logs it as reached and raises the event', async () => {
      const { service, repo } = create();
      (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({
        waits: { cooldown: null, hourly: null, daily: null, global: 700 },
        globalCount: 300,
      });

      await capture(service.requestOtp({ phone: PHONE }));

      expect(warn).toHaveBeenCalledWith({ msg: 'otp_global_daily_cap_reached', count: 300, limit: 300 });
      expect(captureError).toHaveBeenCalledTimes(1);
    });

    it('raises at most one Sentry event per hour per process, and again once the hour passes', async () => {
      const { service, repo } = create();
      const start = Date.now();
      const now = jest.spyOn(Date, 'now').mockReturnValue(start);
      (repo as RepoMock).evaluateOtpIssuance.mockResolvedValue({
        waits: { cooldown: null, hourly: null, daily: null, global: 700 },
        globalCount: 300,
      });

      for (let i = 0; i < 20; i += 1) await capture(service.requestOtp({ phone: `30011880${String(i).padStart(2, '0')}` }));
      expect(captureError).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 59 * 60_000);
      await capture(service.requestOtp({ phone: '3001188099' }));
      expect(captureError).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 61 * 60_000);
      await capture(service.requestOtp({ phone: '3001188098' }));
      expect(captureError).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.filter(([m]) => (m as { msg?: string }).msg === 'otp_global_daily_cap_reached').length).toBe(22);
    });

    it('never puts the code in any log, in the happy path or in the refund path', async () => {
      const { service, sms } = create();

      await service.requestOtp({ phone: PHONE });

      const code = codeSent(sms);
      expect(everythingLogged()).not.toContain(code);
      expect(everythingLogged()).not.toContain(PHONE);
    });
  });
});

describe('AuthService.verifyOtp (ADR-035 section 1: reserve the attempt before comparing)', () => {
  it('passenger auto-register + single use (consumed) + tokens', async () => {
    const { service, repo } = create();
    liveOtpFor(repo, '123456');
    (repo as RepoMock).getUserByPhone.mockResolvedValue(null);
    (repo as RepoMock).createPassengerAutoRegister.mockResolvedValue(newPassengerUser);

    const r = await service.verifyOtp({ phone: '3001112233', code: '123456' });

    expect((repo as RepoMock).consumeOtp).toHaveBeenCalledWith(9);
    expect((repo as RepoMock).createPassengerAutoRegister).toHaveBeenCalledTimes(1);
    expect(r.user.role).toBe('passenger');
    expect(r.user.tenant).toBeNull();
    expect(r.user.profile_complete).toBe(false);
    expect(r.tokens.access_token).toBe('access-jwt');
    expect(r.tokens.refresh_token).toBe('refresh-1');
  });

  it('reserves the attempt before comparing, compares against the hash that came out of the reservation, and consumes after', async () => {
    const { service, repo, hasher } = create();
    liveOtpFor(repo, '123456');
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole('passenger'));

    await service.verifyOtp({ phone: '3001112233', code: '123456' });

    expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledWith(9, 3);
    expect(hasher.compare).toHaveBeenCalledWith('123456', 'hashed:123456');
    const order = [
      (repo as RepoMock).findLiveOtp.mock.invocationCallOrder[0],
      (repo as RepoMock).reserveOtpAttempt.mock.invocationCallOrder[0],
      (hasher.compare as jest.Mock).mock.invocationCallOrder[0],
      (repo as RepoMock).consumeOtp.mock.invocationCallOrder[0],
      (repo as RepoMock).getUserByPhone.mock.invocationCallOrder[0],
    ] as number[];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('no live OTP -> 410 OTP_EXPIRED, nothing is reserved or compared', async () => {
    const { service, repo, hasher } = create();
    (repo as RepoMock).findLiveOtp.mockResolvedValue(null);

    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '123456' }));

    expect(e).toBeInstanceOf(GoneException);
    expect(e.getResponse()).toEqual({ code: 'OTP_EXPIRED', message: 'El código venció, solicita otro' });
    expect((repo as RepoMock).reserveOtpAttempt).not.toHaveBeenCalled();
    expect(hasher.compare).not.toHaveBeenCalled();
  });

  it('wrong code -> the attempt was already reserved and 401 OTP_INVALID', async () => {
    const { service, repo } = create();
    liveOtpFor(repo, '999999');

    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '123456' }));

    expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledWith(9, 3);
    expect((repo as RepoMock).consumeOtp).not.toHaveBeenCalled();
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(code(e)).toBe('OTP_INVALID');
  });

  it('the repository has no separate increment: the reservation is the only counter', () => {
    const { repo } = create();

    expect(repo).not.toHaveProperty('incrementOtpAttempts');
  });

  it('atomic consume lost (count!==1) -> 401 "Código ya utilizado" (no double session)', async () => {
    const { service, repo } = create();
    liveOtpFor(repo, '123456');
    (repo as RepoMock).consumeOtp.mockResolvedValue(false);

    const e = await capture(service.verifyOtp({ phone: '3001112233', code: '123456' }));

    expect(e.getResponse()).toEqual({ code: 'OTP_INVALID', message: 'Código ya utilizado' });
    expect((repo as RepoMock).getUserByPhone).not.toHaveBeenCalled();
  });

  it('a comparison that throws leaves the attempt spent: nothing is given back', async () => {
    const { service, repo, hasher } = create();
    liveOtpFor(repo, '123456');
    (hasher.compare as jest.Mock).mockRejectedValueOnce(new Error('bcrypt exploded'));

    await expect(service.verifyOtp({ phone: '3001112233', code: '123456' })).rejects.toThrow('bcrypt exploded');

    expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledTimes(1);
    expect((repo as RepoMock).consumeOtp).not.toHaveBeenCalled();
  });

  describe('an empty reservation never compares and never answers 401 (RN-EO-03)', () => {
    const live = { consumed: false, alive: true, exhausted: false };

    it.each([
      ['the row no longer exists', null, 410, 'OTP_EXPIRED'],
      ['the row was consumed meanwhile', { ...live, consumed: true }, 410, 'OTP_EXPIRED'],
      ['the row expired meanwhile', { ...live, alive: false }, 410, 'OTP_EXPIRED'],
      ['the row was consumed and also exhausted', { ...live, consumed: true, exhausted: true }, 410, 'OTP_EXPIRED'],
      ['the row expired and also exhausted', { ...live, alive: false, exhausted: true }, 410, 'OTP_EXPIRED'],
      ['the row is alive, unconsumed and exhausted', { ...live, exhausted: true }, 429, 'OTP_MAX_ATTEMPTS'],
      ['the row is alive, unconsumed and still has free attempts (should not happen)', live, 410, 'OTP_EXPIRED'],
    ])('%s', async (_case, state, status, expectedCode) => {
      const { service, repo, hasher } = create();
      (repo as RepoMock).findLiveOtp.mockResolvedValue(9);
      (repo as RepoMock).reserveOtpAttempt.mockResolvedValue(null);
      (repo as RepoMock).readOtpReservationState.mockResolvedValue(state);

      const e = await capture(service.verifyOtp({ phone: '3001112233', code: '123456' }));

      expect(e.getStatus()).toBe(status);
      expect(code(e)).toBe(expectedCode);
      expect(hasher.compare).not.toHaveBeenCalled();
      expect((repo as RepoMock).consumeOtp).not.toHaveBeenCalled();
      expect((repo as RepoMock).getUserByPhone).not.toHaveBeenCalled();
      expect((repo as RepoMock).readOtpReservationState).toHaveBeenCalledWith(9, 3);
    });

    it('the 429 keeps its text', async () => {
      const { service, repo } = create();
      (repo as RepoMock).findLiveOtp.mockResolvedValue(9);
      (repo as RepoMock).reserveOtpAttempt.mockResolvedValue(null);
      (repo as RepoMock).readOtpReservationState.mockResolvedValue({ consumed: false, alive: true, exhausted: true });

      const e = await capture(service.verifyOtp({ phone: '3001112233', code: '123456' }));

      expect(e.getResponse()).toEqual({
        code: 'OTP_MAX_ATTEMPTS',
        message: 'Demasiados intentos, solicita otro código',
      });
    });
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
  it('happy: tokens with driver role and tenant identity matching fleet.driver.company_id; resets attempts', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...driverBase });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));
    const r = await service.driverLogin({ national_id: '71000001', pin: '1234' });
    expect((repo as RepoMock).resetDriverAttempts).toHaveBeenCalledWith(5, 2);
    expect((repo as RepoMock).getCompanyIdentity).toHaveBeenCalledWith(2);
    expect(r.user.role).toBe('driver');
    expect(r.user.tenant?.company_id).toBe(2);
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

describe('AuthService.driverLogin — temporary PIN (ADR-028)', () => {
  const pending = {
    ...driverBase,
    pinMustChange: true,
    temporaryPinExpiresAt: new Date(Date.now() + 3_600_000),
  };

  it('pending change -> JWT and session user carry pin_change_required', async () => {
    const { service, repo, jwt } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({ ...pending });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));
    const r = await service.driverLogin({ national_id: '71000001', pin: '1234' });
    expect(r.user.pin_change_required).toBe(true);
    expect((jwt.sign as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ pin_change_required: true });
  });

  it('personal PIN -> no claim in the JWT and pin_change_required=false', async () => {
    const { service, repo, jwt } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...driverBase,
      pinMustChange: false,
      temporaryPinExpiresAt: null,
    });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));
    const r = await service.driverLogin({ national_id: '71000001', pin: '1234' });
    expect(r.user.pin_change_required).toBe(false);
    expect((jwt.sign as jest.Mock).mock.calls[0]?.[0]).not.toHaveProperty('pin_change_required');
  });

  it('inherited temporary PIN without expiry still logs in with the claim', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...driverBase,
      pinMustChange: true,
      temporaryPinExpiresAt: null,
    });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));
    const r = await service.driverLogin({ national_id: '71000001', pin: '1234' });
    expect(r.user.pin_change_required).toBe(true);
  });

  it('expired temporary PIN with the right PIN -> 401 TEMPORARY_PIN_EXPIRED, not counted as a failure', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...pending,
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '1234' }));
    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(code(e)).toBe('TEMPORARY_PIN_EXPIRED');
    expect((repo as RepoMock).registerDriverFailure).not.toHaveBeenCalled();
  });

  it('expired temporary PIN with a wrong PIN -> 401 INVALID_CREDENTIALS and counts', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...pending,
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '0000' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
    expect((repo as RepoMock).registerDriverFailure).toHaveBeenCalledTimes(1);
  });

  it('PIN not delivered is checked before the expiry', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getDriverByNationalId.mockResolvedValue({
      ...pending,
      pinDeliveredAt: null,
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });
    const e = await capture(service.driverLogin({ national_id: '71000001', pin: '1234' }));
    expect(code(e)).toBe('PIN_NOT_DELIVERED');
  });

  it('refresh while pending re-emits the claim', async () => {
    const { service, repo, refreshTokens, jwt } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 5, refreshToken: 'new' });
    (repo as RepoMock).getUser.mockResolvedValue({
      ...driverBase,
      userId: 5,
      role: 'driver',
      accountStatus: 'active',
    });
    (repo as RepoMock).getDriverCompany.mockResolvedValue({
      companyId: 2,
      status: 'available',
      pinMustChange: true,
    });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));
    const r = await service.refresh({ refresh_token: 'old' });
    expect(r.user.pin_change_required).toBe(true);
    expect((jwt.sign as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ pin_change_required: true });
  });

  it('credentials reset event -> revokes all the driver sessions', async () => {
    const { service, refreshTokens } = create();
    (refreshTokens as RefreshMock).revokeAllForUser.mockResolvedValue(3);
    await service.onDriverCredentialsReset({
      driver_id: 5,
      company_id: 2,
      occurred_at: new Date().toISOString(),
    });
    expect((refreshTokens as RefreshMock).revokeAllForUser).toHaveBeenCalledWith(5);
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
    companyStatus: 'active',
    failedAttempts: 0,
    blockedUntil: null,
  };

  it('happy: tokens with admin role and full tenant identity; resets attempts; JWT carries no names', async () => {
    const { service, repo, jwt } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(1));
    const r = await service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' });
    expect(r.user.role).toBe('admin');
    expect(r.user.tenant).toEqual({
      company_id: 1,
      company_name: 'Cootrayal',
      municipality_id: 77,
      municipality_name: 'Yarumal',
    });
    expect((repo as RepoMock).resetAdminAttempts).toHaveBeenCalledWith(1);

    const payload = (jwt.sign as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['company_id', 'role', 'sub', 'type']);
  });

  it('wrong password (below cap) -> 401 INVALID_CREDENTIALS and records failure', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'wrong1234' }));
    expect(code(e)).toBe('INVALID_CREDENTIALS');
    expect((repo as RepoMock).registerAdminFailure).toHaveBeenCalledWith(1, null);
  });

  it('wrong password reaching the cap -> 429 ACCOUNT_TEMPORARILY_BLOCKED', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin, failedAttempts: 2 });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'wrong1234' }));
    expect(code(e)).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
    expect((repo as RepoMock).registerAdminFailure).toHaveBeenCalledWith(1, expect.any(Date));
  });

  it('already blocked -> 429 without comparing the password', async () => {
    const { service, repo, hasher } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({
      ...admin,
      blockedUntil: new Date(Date.now() + 60_000),
    });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' }));
    expect(code(e)).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
    expect(hasher.compare).not.toHaveBeenCalled();
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

  it('admin of a pending/suspended company -> 403 COMPANY_NOT_ACTIVE', async () => {
    const { service, repo } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({ ...admin, companyStatus: 'suspended' });
    const e = await capture(service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect(code(e)).toBe('COMPANY_NOT_ACTIVE');
  });

  it('platform_admin logs in with tenant=null and a JWT without company_id', async () => {
    const { service, repo, jwt } = create();
    (repo as RepoMock).getUserByEmail.mockResolvedValue({
      ...admin,
      role: 'platform_admin',
      companyId: null,
      companyStatus: null,
    });
    const r = await service.adminLogin({ email: 'admin@voyya.co', password: 'Secret12' });
    expect(r.user.role).toBe('platform_admin');
    expect(r.user.tenant).toBeNull();
    expect((repo as RepoMock).resetAdminAttempts).toHaveBeenCalledWith(1);

    const payload = (jwt.sign as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.company_id).toBeUndefined();
  });
});

describe('AuthService.refresh / logout / revocation', () => {
  it('refresh: uses the rotated token, issues a new access and returns the user', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 5, refreshToken: 'new-refresh' });
    (repo as RepoMock).getUser.mockResolvedValue({
      ...driverBase,
      userId: 5,
      role: 'driver',
      accountStatus: 'active',
    });
    (repo as RepoMock).getDriverCompany.mockResolvedValue({ companyId: 2, status: 'available' });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(2));

    const r = await service.refresh({ refresh_token: 'old' });
    expect(r.refresh_token).toBe('new-refresh');
    expect(r.access_token).toBe('access-jwt');
    expect(r.expires_in).toBe(900);
    expect(r.user.role).toBe('driver');
    expect(r.user.tenant?.company_id).toBe(2);
  });

  it('refresh of a passenger returns user.tenant === null', async () => {
    const { service, repo, refreshTokens } = create();
    (refreshTokens as RefreshMock).rotate.mockResolvedValue({ userId: 10, refreshToken: 'new' });
    (repo as RepoMock).getUser.mockResolvedValue({
      userId: 10,
      firstName: 'Ana',
      lastName: 'P',
      email: null,
      passwordHash: null,
      role: 'passenger',
      accountStatus: 'active',
      companyId: null,
    });

    const r = await service.refresh({ refresh_token: 'x' });
    expect(r.user.role).toBe('passenger');
    expect(r.user.tenant).toBeNull();
    expect((repo as RepoMock).getCompanyIdentity).not.toHaveBeenCalled();
  });

  it('refresh of an admin returns user; renaming the company between login and refresh surfaces the NEW name', async () => {
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
      companyId: 1,
      companyStatus: 'active',
    });
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(
      companyIdentityFixture(1, 'Cootrayal Renamed'),
    );

    const r = await service.refresh({ refresh_token: 'old' });
    expect(r.user.role).toBe('admin');
    expect(r.user.tenant?.company_name).toBe('Cootrayal Renamed');
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

const OTP_PHONE = '3009900011';
const OTP_CODE = '482193';
const STAFF_ROLES = ['driver', 'admin', 'operator', 'platform_admin', 'company'] as const;
const INVALID_OTP_RESPONSE = { code: 'OTP_INVALID', message: 'Código incorrecto' };

function liveOtpFor(repo: object, otpCode = OTP_CODE, id = 9) {
  (repo as RepoMock).findLiveOtp.mockResolvedValue(id);
  (repo as RepoMock).reserveOtpAttempt.mockResolvedValue(`hashed:${otpCode}`);
}

function accountWithRole(role: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: 42,
    firstName: 'Ana',
    lastName: 'Pérez',
    email: null,
    passwordHash: null,
    role,
    accountStatus: 'active',
    companyId: null,
    companyStatus: null,
    failedAttempts: 0,
    blockedUntil: null,
    ...overrides,
  };
}

async function wrongCodeRejection(): Promise<HttpException> {
  const { service, repo } = create();
  liveOtpFor(repo);
  return capture(service.verifyOtp({ phone: OTP_PHONE, code: '000000' }));
}

describe('AuthService.verifyOtp: the OTP only opens passenger sessions (S-01)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('existing passenger gets the session without regression', async () => {
    const { service, repo, refreshTokens, emitter } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole('passenger'));

    const r = await service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE });

    expect(r.user.role).toBe('passenger');
    expect(r.user.tenant).toBeNull();
    expect(r.tokens.refresh_token).toBe('refresh-1');
    expect((refreshTokens as RefreshMock).issue).toHaveBeenCalledTimes(1);
    expect((emitter as { emit: jest.Mock }).emit).toHaveBeenCalledTimes(1);
    expect((repo as RepoMock).createPassengerAutoRegister).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(STAFF_ROLES)(
    '%s with the right code -> 401 OTP_INVALID, no session, no refresh token, no event',
    async (role) => {
      const { service, repo, refreshTokens, jwt, emitter } = create();
      liveOtpFor(repo);
      (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role, { companyId: 3 }));

      const e = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.getStatus()).toBe(401);
      expect(code(e)).toBe('OTP_INVALID');
      expect((refreshTokens as RefreshMock).issue).not.toHaveBeenCalled();
      expect((jwt as { sign: jest.Mock }).sign).not.toHaveBeenCalled();
      expect((emitter as { emit: jest.Mock }).emit).not.toHaveBeenCalled();
      expect((repo as RepoMock).getCompanyIdentity).not.toHaveBeenCalled();
    },
  );

  it.each(STAFF_ROLES)(
    '%s rejection is the exact response of a wrong code (same status, same body, same key order)',
    async (role) => {
      const wrong = await wrongCodeRejection();
      const { service, repo } = create();
      liveOtpFor(repo);
      (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role));

      const byRole = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

      expect(byRole.getStatus()).toBe(wrong.getStatus());
      expect(JSON.stringify(byRole.getResponse())).toBe(JSON.stringify(wrong.getResponse()));
      expect(byRole.getResponse()).toEqual(INVALID_OTP_RESPONSE);
    },
  );

  it.each(STAFF_ROLES)(
    '%s rejection consumes the OTP, the compared attempt was reserved first (the right code also counts) and the account is untouched',
    async (role) => {
      const { service, repo } = create();
      liveOtpFor(repo);
      (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role));

      await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

      expect((repo as RepoMock).consumeOtp).toHaveBeenCalledWith(9);
      expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledTimes(1);
      expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledWith(9, 3);
      expect((repo as RepoMock).registerAdminFailure).not.toHaveBeenCalled();
      expect((repo as RepoMock).registerDriverFailure).not.toHaveBeenCalled();
      expect((repo as RepoMock).resetAdminAttempts).not.toHaveBeenCalled();
      expect((repo as RepoMock).createPassengerAutoRegister).not.toHaveBeenCalled();
    },
  );

  it.each(['ghost', '', 'PASSENGER', 'passenger '])(
    'role outside the enum (%j) -> 401 OTP_INVALID, never an internal error (allow list)',
    async (role) => {
      const { service, repo, refreshTokens } = create();
      liveOtpFor(repo);
      (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role));

      const e = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.getResponse()).toEqual(INVALID_OTP_RESPONSE);
      expect((refreshTokens as RefreshMock).issue).not.toHaveBeenCalled();
    },
  );

  it('the role rejection never uses the "Código ya utilizado" text', async () => {
    const { service, repo } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole('driver'));

    const e = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

    expect(JSON.stringify(e.getResponse())).not.toContain('utilizado');
  });

  it('wrong code never reads the user nor consumes the OTP (order: code, consume, role)', async () => {
    const { service, repo } = create();
    liveOtpFor(repo);

    await capture(service.verifyOtp({ phone: OTP_PHONE, code: '000000' }));

    expect((repo as RepoMock).getUserByPhone).not.toHaveBeenCalled();
    expect((repo as RepoMock).createPassengerAutoRegister).not.toHaveBeenCalled();
    expect((repo as RepoMock).consumeOtp).not.toHaveBeenCalled();
    expect((repo as RepoMock).reserveOtpAttempt).toHaveBeenCalledWith(9, 3);
  });

  it('the OTP is consumed before the user is read', async () => {
    const { service, repo } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole('driver'));

    await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

    const consumedAt = (repo as RepoMock).consumeOtp.mock.invocationCallOrder[0] ?? Infinity;
    const readAt = (repo as RepoMock).getUserByPhone.mock.invocationCallOrder[0] ?? -Infinity;
    expect(consumedAt).toBeLessThan(readAt);
  });

  it.each([
    ['a wrong code', '000000', 'passenger'],
    ['the right code of a staff account', OTP_CODE, 'driver'],
  ])('the same cryptographic work for %s: one compare, no hash', async (_case, submitted, role) => {
    const { service, repo, hasher } = create();
    (hasher.hash as jest.Mock).mockClear();
    (hasher.compare as jest.Mock).mockClear();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role));

    await capture(service.verifyOtp({ phone: OTP_PHONE, code: submitted }));

    expect(hasher.compare).toHaveBeenCalledTimes(1);
    expect(hasher.hash).not.toHaveBeenCalled();
  });

  it.each(STAFF_ROLES)('%s rejection logs user_id and role, never the phone nor the code', async (role) => {
    const { service, repo } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(accountWithRole(role, { userId: 77 }));

    await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('user_id=77');
    expect(line).toContain(`role=${role}`);
    expect(line).not.toContain(OTP_PHONE);
    expect(line).not.toContain(OTP_CODE);
  });

  it('suspended passenger -> 403 ACCOUNT_SUSPENDED (as before)', async () => {
    const { service, repo, refreshTokens } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(
      accountWithRole('passenger', { accountStatus: 'suspended' }),
    );

    const e = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

    expect(e).toBeInstanceOf(ForbiddenException);
    expect(code(e)).toBe('ACCOUNT_SUSPENDED');
    expect((refreshTokens as RefreshMock).issue).not.toHaveBeenCalled();
  });

  it.each(['driver', 'admin', 'operator', 'platform_admin'])(
    'suspended %s -> 401 OTP_INVALID: the role is evaluated before the suspension',
    async (role) => {
      const { service, repo } = create();
      liveOtpFor(repo);
      (repo as RepoMock).getUserByPhone.mockResolvedValue(
        accountWithRole(role, { accountStatus: 'suspended' }),
      );

      const e = await capture(service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));

      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.getResponse()).toEqual(INVALID_OTP_RESPONSE);
    },
  );

  it('new phone is still auto-registered as a passenger and gets a session', async () => {
    const { service, repo } = create();
    liveOtpFor(repo);
    (repo as RepoMock).getUserByPhone.mockResolvedValue(null);
    (repo as RepoMock).createPassengerAutoRegister.mockResolvedValue(newPassengerUser);

    const r = await service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE });

    expect((repo as RepoMock).createPassengerAutoRegister).toHaveBeenCalledWith(OTP_PHONE);
    expect(r.user.role).toBe('passenger');
  });

  it('keeps the OTP error ladder: expired 410, attempts cap 429, consume lost 401 "Código ya utilizado"', async () => {
    const expired = create();
    (expired.repo as RepoMock).findLiveOtp.mockResolvedValue(null);
    const expiredError = await capture(expired.service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));
    expect(expiredError.getStatus()).toBe(410);

    const capped = create();
    (capped.repo as RepoMock).findLiveOtp.mockResolvedValue(9);
    (capped.repo as RepoMock).reserveOtpAttempt.mockResolvedValue(null);
    (capped.repo as RepoMock).readOtpReservationState.mockResolvedValue({
      consumed: false,
      alive: true,
      exhausted: true,
    });
    const cappedError = await capture(capped.service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));
    expect(cappedError.getStatus()).toBe(429);
    expect(capped.hasher.compare).not.toHaveBeenCalled();

    const lost = create();
    liveOtpFor(lost.repo);
    (lost.repo as RepoMock).consumeOtp.mockResolvedValue(false);
    const lostError = await capture(lost.service.verifyOtp({ phone: OTP_PHONE, code: OTP_CODE }));
    expect(lostError.getResponse()).toEqual({ code: 'OTP_INVALID', message: 'Código ya utilizado' });
  });
});

describe('AuthService.issueSession: company roles need a company (S-01, defense in depth)', () => {
  const profile = (role: string) => ({ userId: 42, firstName: 'Ana', lastName: 'P', role });

  it.each(['driver', 'admin', 'operator', 'company'])(
    '%s without a company -> 500, no JWT, no refresh token, no event',
    async (role) => {
      const { service, refreshTokens, jwt, emitter } = create();

      const e = await capture(service.issueSession(profile(role), null));

      expect(e).toBeInstanceOf(InternalServerErrorException);
      expect(e.getStatus()).toBe(500);
      expect((jwt as { sign: jest.Mock }).sign).not.toHaveBeenCalled();
      expect((refreshTokens as RefreshMock).issue).not.toHaveBeenCalled();
      expect((emitter as { emit: jest.Mock }).emit).not.toHaveBeenCalled();
    },
  );

  it.each(['passenger', 'platform_admin'])('%s without a company still gets the session', async (role) => {
    const { service, refreshTokens, emitter } = create();

    const r = await service.issueSession(profile(role), null);

    expect(r.user.role).toBe(role);
    expect(r.user.tenant).toBeNull();
    expect((refreshTokens as RefreshMock).issue).toHaveBeenCalledTimes(1);
    expect((emitter as { emit: jest.Mock }).emit).toHaveBeenCalledTimes(1);
  });

  it.each(['driver', 'admin', 'operator'])('%s with a company gets the session with its tenant', async (role) => {
    const { service, repo } = create();
    (repo as RepoMock).getCompanyIdentity.mockResolvedValue(companyIdentityFixture(7));

    const r = await service.issueSession(profile(role), 7);

    expect(r.user.role).toBe(role);
    expect(r.user.tenant?.company_id).toBe(7);
  });
});
