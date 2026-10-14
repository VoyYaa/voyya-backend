import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AuthCleanupService } from '../src/modules/auth/auth-cleanup.service';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import { BcryptHasher } from '../src/modules/auth/hasher.service';
import type { OtpIssuancePolicy } from '../src/modules/auth/otp-policy';
import { type DelayProxy, startDelayProxy, targetOf, urlThrough } from './support/delay-proxy';
import { createOtpHttp, type OtpHttp } from './support/otp-http';
import { bootPinApp, createDriver, type PinApp } from './support/pin-app';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const TEST_TIMEOUT_MS = 90_000;
const BURST = 40;
jest.setTimeout(TEST_TIMEOUT_MS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const POLICY: OtpIssuancePolicy = {
  ttlSec: 300,
  cooldownSec: 30,
  hourlyLimit: 5,
  hourlyWindowSec: 3_600,
  dailyLimit: 10,
  dailyWindowSec: 86_400,
  globalLimit: 1_000_000,
};

function near(value: unknown, expected: number, tolerance = 2): boolean {
  return typeof value === 'number' && Math.abs(value - expected) <= tolerance;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const VOLATILE_HEADERS = new Set(['date', 'x-request-id', 'content-length', 'etag']);
const isVolatileHeader = (name: string) => VOLATILE_HEADERS.has(name) || name.startsWith('x-ratelimit');

function fingerprintOf(res: HttpResult): string {
  const headers = Object.fromEntries(
    Object.entries(res.headers)
      .filter(([name]) => !isVolatileHeader(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ status: res.status, body: { ...res.body, retry_in_sec: res.body.retry_in_sec === undefined ? undefined : 0 }, headers });
}

suite('ADR-035 3 and 4: serialized issuance, exact caps per phone and retention (real Postgres as app_voyya)', () => {
  let ctx: PinApp;
  let http: OtpHttp;
  let repo: AuthRepository;

  beforeAll(async () => {
    process.env.SMS_PROVIDER = 'noop';
    process.env.EMAIL_PROVIDER = 'noop';
    process.env.PUSH_PROVIDER = 'noop';
    process.env.BCRYPT_ROUNDS = '10';
    process.env.OTP_PHONE_DAILY_LIMIT = '10';
    process.env.OTP_RATE_LIMIT_MAX = '5';
    process.env.OTP_GLOBAL_DAILY_LIMIT = '1000000';
    ctx = await bootPinApp();
    ctx.app.getHttpAdapter().getInstance().set('trust proxy', 1);
    http = createOtpHttp(ctx, 31);
    repo = ctx.app.get(AuthRepository, { strict: false });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('V-EO-2: simultaneous requests for one phone through the API (the in-process gate)', () => {
    it(`${BURST} simultaneous requests: one 200, ${BURST - 1} answers 429 with a wait between 1 and 30 s, one row and one SMS`, async () => {
      const phone = http.randomPhone();
      ctx.sms.send.mockClear();

      const burst = await Promise.all(Array.from({ length: BURST }, () => http.post('/auth/otp/request', { phone })));

      const accepted = burst.filter((r) => r.status === 200);
      const limited = burst.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.body).toEqual({ sent: true, resend_in_sec: 30, expires_in_sec: 300 });
      expect(limited).toHaveLength(BURST - 1);
      for (const res of limited) {
        expect(res.body.code).toBe('OTP_RATE_LIMIT');
        expect(res.body.retry_in_sec).toBeGreaterThanOrEqual(1);
        expect(res.body.retry_in_sec).toBeLessThanOrEqual(30);
      }
      expect(await http.rowsOf(phone)).toHaveLength(1);
      expect(ctx.sms.send.mock.calls.filter(([to]) => to === phone)).toHaveLength(1);
    });

    it('a burst of distinct phones is served one transaction at a time and only answers 200 or 429 OTP_RATE_LIMIT', async () => {
      const phones = Array.from({ length: 15 }, () => http.randomPhone());

      const burst = await Promise.all(phones.map((phone) => http.post('/auth/otp/request', { phone })));

      expect(burst.every((r) => r.status === 200 || (r.status === 429 && r.body.code === 'OTP_RATE_LIMIT'))).toBe(true);
      const issued = burst.filter((r) => r.status === 200).length;
      expect(issued).toBeGreaterThanOrEqual(1);
      let rows = 0;
      for (const phone of phones) rows += (await http.rowsOf(phone)).length;
      expect(rows).toBe(issued);
      const saturated = burst.filter((r) => r.status === 429);
      for (const res of saturated) expect(res.body.retry_in_sec).toBe(5);
    });
  });

  describe('P-1: the advisory lock of the database is the authority, without the gate nor the limiter', () => {
    it(`${BURST} parallel issuing transactions for one phone leave one row`, async () => {
      const phone = http.randomPhone();

      const results = await Promise.all(
        Array.from({ length: BURST }, () => repo.issueOtp({ phone, codeHash: 'repository-level-hash', policy: POLICY })),
      );

      expect(results.filter((r) => r.kind === 'issued')).toHaveLength(1);
      expect(results.every((r) => r.kind === 'issued' || r.kind === 'busy' || r.kind === 'refused')).toBe(true);
      expect(await http.rowsOf(phone)).toHaveLength(1);
    });

    it('a refused issuance carries the exact wait of the cooldown and writes nothing', async () => {
      const phone = http.randomPhone();
      await repo.issueOtp({ phone, codeHash: 'first', policy: POLICY });

      const second = await repo.issueOtp({ phone, codeHash: 'second', policy: POLICY });

      expect(second.kind).toBe('refused');
      if (second.kind === 'refused') {
        expect(second.verdict.waits.cooldown).toBeGreaterThanOrEqual(29);
        expect(second.verdict.waits.cooldown).toBeLessThanOrEqual(30);
        expect(second.verdict.waits.hourly).toBeNull();
        expect(second.verdict.waits.daily).toBeNull();
        expect(second.verdict.waits.global).toBeNull();
      }
      expect(await http.rowsOf(phone)).toHaveLength(1);
    });

    it('writes created_at and expires_at in UTC from the clock of the database, with the TTL of the policy', async () => {
      const phone = http.randomPhone();

      await repo.issueOtp({ phone, codeHash: 'utc', policy: { ...POLICY, ttlSec: 120 } });

      const [row] = await http.rowsOf(phone);
      expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(120_000);
    });

    describe('with 25 ms of network latency in each direction, so the window between the lock and the write is wide', () => {
      const PARALLEL = 20;
      let proxy: DelayProxy;
      let slowPrisma: PrismaClient;
      let slowRepo: AuthRepository;

      beforeAll(async () => {
        proxy = await startDelayProxy(targetOf(String(url)), 25);
        slowPrisma = new PrismaClient({ datasourceUrl: urlThrough(String(url), proxy.port) });
        slowRepo = new AuthRepository(slowPrisma as unknown as PrismaService);
      }, TEST_TIMEOUT_MS);

      afterAll(async () => {
        if (slowPrisma) await slowPrisma.$disconnect();
        if (proxy) await proxy.close();
      });

      it(`${PARALLEL} parallel issuing transactions for one phone leave one row: the lock of the database decides`, async () => {
        const phone = http.randomPhone();

        const settled = await Promise.allSettled(
          Array.from({ length: PARALLEL }, () =>
            slowRepo.issueOtp({ phone, codeHash: 'repository-level-hash', policy: POLICY }),
          ),
        );

        expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(0);
        const outcomes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value.kind] : []));
        expect(outcomes.filter((kind) => kind === 'issued')).toHaveLength(1);
        expect(outcomes.filter((kind) => kind === 'busy').length).toBeGreaterThan(0);
        expect(await http.rowsOf(phone)).toHaveLength(1);
      });
    });
  });

  describe('P-2: two instances of the API against the same database, with 25 ms of network latency in each direction', () => {
    let proxy: DelayProxy;
    let first: PinApp;
    let second: PinApp;
    let firstHttp: OtpHttp;
    let secondHttp: OtpHttp;

    beforeAll(async () => {
      proxy = await startDelayProxy(targetOf(String(url)), 25);
      const throughProxy = urlThrough(String(url), proxy.port);
      first = await bootPinApp({ databaseUrl: throughProxy });
      second = await bootPinApp({ databaseUrl: throughProxy });
      first.app.getHttpAdapter().getInstance().set('trust proxy', 1);
      second.app.getHttpAdapter().getInstance().set('trust proxy', 1);
      firstHttp = createOtpHttp(first, 32);
      secondHttp = createOtpHttp(second, 34);
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (first) await first.app.close();
      if (second) await second.app.close();
      if (proxy) await proxy.close();
    });

    it('a burst for one phone split between the two instances leaves one row and one SMS', async () => {
      const phone = http.randomPhone();
      first.sms.send.mockClear();
      second.sms.send.mockClear();

      const burst = await Promise.all(
        Array.from({ length: BURST }, (_, index) =>
          (index % 2 === 0 ? firstHttp : secondHttp).post('/auth/otp/request', { phone }),
        ),
      );

      expect(burst.filter((r) => r.status === 200)).toHaveLength(1);
      const unexpected = burst.filter(
        (r) => r.status !== 200 && r.status !== 500 && !(r.status === 429 && r.body.code === 'OTP_RATE_LIMIT'),
      );
      expect(unexpected).toHaveLength(0);
      expect(await http.rowsOf(phone)).toHaveLength(1);
      const smsCount = [first.sms, second.sms].reduce(
        (total, sms) => total + sms.send.mock.calls.filter(([to]) => to === phone).length,
        0,
      );
      expect(smsCount).toBe(1);
    });
  });

  describe('V-EO-4: exact waits with seeded rows', () => {
    it('hourly cap: the wait is the time until the oldest row of the hour leaves the window, not the whole window', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [50, 40, 30, 20, 10]) await http.seedOtp({ phone, minutesOld });

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RATE_LIMIT');
      expect(near(res.body.retry_in_sec, 600)).toBe(true);
      expect(res.headers).not.toHaveProperty('retry-after');
    });

    it('daily cap: ten emissions in 24 h, the oldest from 23 h ago, wait of one hour', async () => {
      const phone = http.randomPhone();
      for (const hours of [23, 21, 19, 17, 15, 13, 11, 9, 7, 5]) await http.seedOtp({ phone, minutesOld: hours * 60 });

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RATE_LIMIT');
      expect(near(res.body.retry_in_sec, 3_600)).toBe(true);
    });

    it('nine emissions seeded in a day: the tenth is still allowed and the eleventh is not', async () => {
      const phone = http.randomPhone();
      for (const hours of [23, 21, 19, 17, 15, 13, 11, 9, 7]) await http.seedOtp({ phone, minutesOld: hours * 60 });

      const tenth = await http.post('/auth/otp/request', { phone });
      await http.ageOtps(phone, 60);
      const eleventh = await http.post('/auth/otp/request', { phone });

      expect(tenth.status).toBe(200);
      expect(eleventh.status).toBe(429);
    });

    it('when the hourly and the daily caps are both exhausted the largest wait is answered', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [50, 40, 30, 20, 10]) await http.seedOtp({ phone, minutesOld });
      for (const hours of [3, 6, 9, 12, 22]) await http.seedOtp({ phone, minutesOld: hours * 60 });

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(near(res.body.retry_in_sec, 7_200)).toBe(true);
    });

    it('cooldown: 20 s after the last code, 10 s remain', async () => {
      const phone = http.randomPhone();
      await http.seedOtp({ phone, secondsOld: 20 });

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(near(res.body.retry_in_sec, 10, 1)).toBe(true);
    });

    it('the hourly window is a true moving window: a row just beyond one hour no longer counts', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [61, 50, 40, 30, 20]) await http.seedOtp({ phone, minutesOld });

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(200);
    });

    it('the rejection by a cap costs no row and no SMS', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [50, 40, 30, 20, 10]) await http.seedOtp({ phone, minutesOld });
      ctx.sms.send.mockClear();

      await http.post('/auth/otp/request', { phone });

      expect(await http.rowsOf(phone)).toHaveLength(5);
      expect(ctx.sms.send).not.toHaveBeenCalled();
    });
  });

  describe('P-8: retention by age, with the daily cap still seeing what it needs', () => {
    async function cleanup(): Promise<void> {
      await ctx.app.get(AuthCleanupService, { strict: false }).cleanup();
    }

    it('keeps the consumed and the expired rows of two hours, deletes the ones beyond 24 hours', async () => {
      const consumed = http.randomPhone();
      const expired = http.randomPhone();
      const justUnder = http.randomPhone();
      const justOver = http.randomPhone();
      const old = http.randomPhone();
      await http.seedOtp({ phone: consumed, minutesOld: 120, consumed: true });
      await http.seedOtp({ phone: expired, minutesOld: 120 });
      await http.seedOtp({ phone: justUnder, minutesOld: 23 * 60 + 59 });
      await http.seedOtp({ phone: justOver, minutesOld: 24 * 60 + 1 });
      await http.seedOtp({ phone: old, minutesOld: 25 * 60 });

      await cleanup();

      expect(await http.rowsOf(consumed)).toHaveLength(1);
      expect(await http.rowsOf(expired)).toHaveLength(1);
      expect(await http.rowsOf(justUnder)).toHaveLength(1);
      expect(await http.rowsOf(justOver)).toHaveLength(0);
      expect(await http.rowsOf(old)).toHaveLength(0);
    });

    it('the hourly cap survives the cleanup: the sixth request of the hour is still refused with the exact wait', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [50, 40, 30, 20, 10]) await http.seedOtp({ phone, minutesOld });
      const before = await http.post('/auth/otp/request', { phone });

      await cleanup();
      const after = await http.post('/auth/otp/request', { phone });

      expect(before.status).toBe(429);
      expect(after.status).toBe(429);
      expect(near(after.body.retry_in_sec, 600)).toBe(true);
      expect(await http.rowsOf(phone)).toHaveLength(5);
    });

    it('the daily cap still sees the row of 23 h 59 min after the cleanup', async () => {
      const phone = http.randomPhone();
      for (const hours of [2, 4, 6, 8, 10, 12, 14, 16, 18]) await http.seedOtp({ phone, minutesOld: hours * 60 });
      await http.seedOtp({ phone, minutesOld: 23 * 60 + 59 });

      await cleanup();
      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(res.body.retry_in_sec).toBeGreaterThanOrEqual(1);
      expect(res.body.retry_in_sec).toBeLessThanOrEqual(62);
      expect(await http.rowsOf(phone)).toHaveLength(10);
    });
  });

  describe('P-6 and P-7: failures leave no state behind', () => {
    it('a hash that fails answers 5xx, leaves no row and the next attempt for the phone prospers', async () => {
      const phone = http.randomPhone();
      const failing = jest.spyOn(BcryptHasher.prototype, 'hash').mockRejectedValueOnce(new Error('hash failed'));

      const failed = await http.post('/auth/otp/request', { phone });
      failing.mockRestore();
      const next = await http.post('/auth/otp/request', { phone });

      expect(failed.status).toBe(500);
      expect(await http.rowsOf(phone)).toHaveLength(1);
      expect(next.status).toBe(200);
    });

    it('an exception inside the issuing transaction answers 5xx, leaves no row and the gate stays free', async () => {
      const phone = http.randomPhone();
      const failing = jest.spyOn(repo, 'issueOtp').mockRejectedValueOnce(new Error('transaction failed'));

      const failed = await http.post('/auth/otp/request', { phone });
      failing.mockRestore();
      const next = await http.post('/auth/otp/request', { phone });

      expect(failed.status).toBe(500);
      expect(next.status).toBe(200);
      expect(await http.rowsOf(phone)).toHaveLength(1);
    });

    it('P-7: when the SMS fails the quota is returned: 503 SMS_SEND_FAILED, the new row is deleted, the previous OTP stays expired and the next request is not in cooldown', async () => {
      const phone = http.randomPhone();
      await http.requestCode(phone);
      await http.ageOtps(phone, 60);
      ctx.sms.send.mockRejectedValueOnce(
        new ServiceUnavailableException({ code: 'SMS_SEND_FAILED', message: 'No se pudo enviar el SMS' }),
      );

      const failed = await http.post('/auth/otp/request', { phone });

      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({ code: 'SMS_SEND_FAILED', message: 'No se pudo enviar el SMS' });
      const rows = await http.rowsOf(phone);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attempts: 0, consumed: false });
      expect(rows[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      const next = await http.post('/auth/otp/request', { phone });
      expect(next.status).toBe(200);
      expect(await http.rowsOf(phone)).toHaveLength(2);
    });

    it('P-7: a refunded issuance does not count for the hourly cap', async () => {
      const phone = http.randomPhone();
      for (const minutesOld of [50, 40, 30, 20]) await http.seedOtp({ phone, minutesOld });
      ctx.sms.send.mockRejectedValueOnce(new ServiceUnavailableException({ code: 'SMS_SEND_FAILED' }));
      const failed = await http.post('/auth/otp/request', { phone });
      expect(failed.status).toBe(503);

      const retried = await http.post('/auth/otp/request', { phone });

      expect(retried.status).toBe(200);
    });

    it('P-7: an issuance that someone already tried to verify is not deleted by the refund', async () => {
      const phone = http.randomPhone();
      const issued = await repo.issueOtp({ phone, codeHash: 'attempted', policy: POLICY });
      if (issued.kind !== 'issued') throw new Error('expected an issuance');
      await ctx.prisma.$executeRaw`UPDATE auth.otp_code SET attempts = 1 WHERE id = ${issued.insertedId}`;

      await expect(repo.refundOtpIssuance(issued.insertedId)).resolves.toBe(false);

      expect(await http.rowsOf(phone)).toHaveLength(1);
    });

    it('P-7: a consumed issuance is not deleted by the refund either, and an untouched one is', async () => {
      const consumed = http.randomPhone();
      const untouched = http.randomPhone();
      const first = await repo.issueOtp({ phone: consumed, codeHash: 'consumed', policy: POLICY });
      const second = await repo.issueOtp({ phone: untouched, codeHash: 'untouched', policy: POLICY });
      if (first.kind !== 'issued' || second.kind !== 'issued') throw new Error('expected issuances');
      await repo.consumeOtp(first.insertedId);

      await expect(repo.refundOtpIssuance(first.insertedId)).resolves.toBe(false);
      await expect(repo.refundOtpIssuance(second.insertedId)).resolves.toBe(true);

      expect(await http.rowsOf(consumed)).toHaveLength(1);
      expect(await http.rowsOf(untouched)).toHaveLength(0);
    });

    describe('P-7: the pool is exhausted (connection_limit = 1)', () => {
      let tight: PinApp;
      let tightHttp: OtpHttp;
      let tightRepo: AuthRepository;

      beforeAll(async () => {
        const withLimit = `${url}${String(url).includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=10`;
        tight = await bootPinApp({ databaseUrl: withLimit });
        tight.app.getHttpAdapter().getInstance().set('trust proxy', 1);
        tightHttp = createOtpHttp(tight, 33);
        tightRepo = tight.app.get(AuthRepository, { strict: false });
      }, TEST_TIMEOUT_MS);

      afterAll(async () => {
        if (tight) await tight.app.close();
      });

      it('the issuing transaction fails with 5xx after maxWait, without a row and without an SMS, and the gate frees up', async () => {
        const phone = tightHttp.randomPhone();
        const verdict = { waits: { cooldown: null, hourly: null, daily: null, global: null }, globalCount: 0 };
        const precheck = jest.spyOn(tightRepo, 'evaluateOtpIssuance').mockResolvedValue(verdict);
        const holding = tight.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await sleep(4_000);
          },
          { timeout: 15_000 },
        );
        await sleep(300);
        tight.sms.send.mockClear();

        const failed = await tightHttp.post('/auth/otp/request', { phone });
        await holding;
        precheck.mockRestore();
        const next = await tightHttp.post('/auth/otp/request', { phone });

        expect(failed.status).toBe(500);
        expect(next.status).toBe(200);
        expect(await tightHttp.rowsOf(phone)).toHaveLength(1);
        expect(tight.sms.send.mock.calls.filter(([to]) => to === phone)).toHaveLength(1);
      });
    });
  });

  describe('P-9: no response of the OTP flow tells the role nor the existence of an account', () => {
    type PhoneClass = 'passenger' | 'driver' | 'platform_admin' | 'unknown';
    const CLASSES: PhoneClass[] = ['passenger', 'driver', 'platform_admin', 'unknown'];

    async function phoneOf(kind: PhoneClass): Promise<string> {
      if (kind === 'unknown') return http.randomPhone();
      if (kind === 'driver') return (await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null })).phone;
      const phone = http.randomPhone();
      await ctx.prisma.user.create({
        data: {
          firstName: '_EO',
          lastName: kind,
          phone,
          role: kind,
          accountStatus: 'active',
          email: `eo.${kind}.${randomUUID()}@voyya-e2e.test`,
        },
      });
      return phone;
    }

    const SITUATIONS: Array<[string, (phone: string) => Promise<HttpResult>]> = [
      ['a request that is accepted', async (phone) => await http.post('/auth/otp/request', { phone })],
      [
        'a request inside the cooldown',
        async (phone) => {
          await http.post('/auth/otp/request', { phone });
          return http.post('/auth/otp/request', { phone });
        },
      ],
      [
        'a request with the hourly cap exhausted',
        async (phone) => {
          for (const minutesOld of [50, 40, 30, 20, 10]) await http.seedOtp({ phone, minutesOld });
          return http.post('/auth/otp/request', { phone });
        },
      ],
      [
        'a request with the daily cap exhausted',
        async (phone) => {
          for (const hours of [23, 21, 19, 17, 15, 13, 11, 9, 7, 5]) await http.seedOtp({ phone, minutesOld: hours * 60 });
          return http.post('/auth/otp/request', { phone });
        },
      ],
      [
        'a verification with a wrong code',
        async (phone) => {
          const code = await http.requestCode(phone);
          return http.verify(phone, http.wrongCodeFor(code));
        },
      ],
      [
        'a verification with the attempts of the OTP exhausted',
        async (phone) => {
          const code = await http.requestCode(phone);
          for (let i = 0; i < 5; i += 1) await http.verify(phone, http.wrongCodeFor(code));
          return http.verify(phone, http.wrongCodeFor(code));
        },
      ],
      ['a verification without a live OTP', async (phone) => await http.verify(phone, '000000')],
    ];

    it.each(SITUATIONS)('%s: the four kinds of phone get the same status, body and headers', async (_name, run) => {
      const fingerprints: string[] = [];
      const waits: number[] = [];
      for (const kind of CLASSES) {
        const res = await run(await phoneOf(kind));
        fingerprints.push(fingerprintOf(res));
        if (typeof res.body.retry_in_sec === 'number') waits.push(res.body.retry_in_sec);
        expect(res.headers).not.toHaveProperty('retry-after');
      }

      expect(new Set(fingerprints).size).toBe(1);
      if (waits.length > 0) expect(Math.max(...waits) - Math.min(...waits)).toBeLessThanOrEqual(2);
    });
  });
});
