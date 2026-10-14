import { HttpException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { OtpGlobalDailyCapReachedError } from '../src/modules/auth/auth-errors';
import { BcryptHasher } from '../src/modules/auth/hasher.service';
import { captureError } from '../src/infrastructure/observability/sentry';
import { createOtpHttp, type OtpHttp } from './support/otp-http';
import { bootPinApp, createDriver, type PinApp } from './support/pin-app';

jest.mock('../src/infrastructure/observability/sentry', () => ({
  ...jest.requireActual('../src/infrastructure/observability/sentry'),
  captureError: jest.fn(),
}));

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const TEST_TIMEOUT_MS = 90_000;
const HEADROOM = 5;
const WAVE = 3 * HEADROOM;
jest.setTimeout(TEST_TIMEOUT_MS);

async function countRowsOfTheDay(): Promise<number> {
  const probe = new PrismaClient({ datasourceUrl: url });
  try {
    const [row] = await probe.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM auth.otp_code
       WHERE created_at > timezone('utc', now()) - interval '24 hours'
    `;
    return row?.count ?? 0;
  } finally {
    await probe.$disconnect();
  }
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const isVolatileHeader = (name: string) =>
  ['date', 'x-request-id', 'content-length', 'etag'].includes(name) || name.startsWith('x-ratelimit');

function fingerprintOf(res: HttpResult): string {
  const headers = Object.fromEntries(
    Object.entries(res.headers)
      .filter(([name]) => !isVolatileHeader(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ status: res.status, body: { ...res.body, retry_in_sec: 0 }, headers });
}

suite('ADR-035 4: the global daily cap under concurrency (real Postgres as app_voyya)', () => {
  let ctx: PinApp;
  let http: OtpHttp;
  let limit: number;
  let rowsBeforeBoot: number;
  let warn: jest.SpyInstance;
  let wave: HttpResult[];
  let waveIssued: string[];
  let waveCodes: Map<string, string>;
  let waveRows: number;
  let waveWarnings: unknown[][];
  let waveEvents: unknown[];
  let hashSpy: jest.SpyInstance;

  beforeAll(async () => {
    process.env.SMS_PROVIDER = 'noop';
    process.env.EMAIL_PROVIDER = 'noop';
    process.env.PUSH_PROVIDER = 'noop';
    process.env.BCRYPT_ROUNDS = '10';
    process.env.OTP_PHONE_DAILY_LIMIT = '10';
    rowsBeforeBoot = await countRowsOfTheDay();
    limit = rowsBeforeBoot + HEADROOM;
    process.env.OTP_GLOBAL_DAILY_LIMIT = String(limit);
    ctx = await bootPinApp();
    ctx.app.getHttpAdapter().getInstance().set('trust proxy', 1);
    http = createOtpHttp(ctx, 41);
    hashSpy = jest.spyOn(BcryptHasher.prototype, 'hash');
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    (captureError as jest.Mock).mockClear();

    const phones = Array.from({ length: WAVE }, () => http.randomPhone());
    wave = await Promise.all(phones.map((phone) => http.post('/auth/otp/request', { phone })));
    waveIssued = phones.filter((_, index) => wave[index]?.status === 200);
    waveCodes = new Map(waveIssued.map((phone) => [phone, http.codeSentTo(phone)]));
    waveRows = 0;
    for (const phone of phones) waveRows += (await http.rowsOf(phone)).length;
    waveWarnings = [...warn.mock.calls];
    waveEvents = (captureError as jest.Mock).mock.calls.map(([error]) => error);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    warn?.mockRestore();
    if (ctx) await ctx.app.close();
  });

  describe('V-EO-5: the cap holds under a burst of distinct phones', () => {
    it(`a burst of ${WAVE} phones creates at most ${HEADROOM} rows (exact with one instance and the limiter)`, async () => {
      expect(waveRows).toBeLessThanOrEqual(HEADROOM);
      expect(waveRows).toBe(waveIssued.length);
      const total = await countRowsOfTheDay();
      const foreignGrowth = total - rowsBeforeBoot - waveRows;
      if (foreignGrowth === 0) expect(waveRows).toBe(HEADROOM);
      else expect(total).toBeGreaterThanOrEqual(limit);
    });

    it('every answer is 200 or 429 OTP_RATE_LIMIT, never a 5xx', () => {
      expect(wave.every((r) => r.status === 200 || (r.status === 429 && r.body.code === 'OTP_RATE_LIMIT'))).toBe(true);
    });

    it('with the cap reached a new phone is refused with the exact wait, no row, no hash and no SMS', async () => {
      const phone = http.randomPhone();
      ctx.sms.send.mockClear();
      hashSpy.mockClear();

      const res = await http.post('/auth/otp/request', { phone });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RATE_LIMIT');
      const [expected] = await ctx.prisma.$queryRaw<Array<{ wait: number }>>`
        SELECT ceil(extract(epoch FROM (created_at + interval '24 hours') - timezone('utc', clock_timestamp())))::int AS wait
          FROM auth.otp_code
         WHERE created_at > timezone('utc', now()) - interval '24 hours'
         ORDER BY created_at DESC
        OFFSET ${limit - 1} LIMIT 1
      `;
      expect(Math.abs(Number(res.body.retry_in_sec) - Number(expected?.wait))).toBeLessThanOrEqual(2);
      expect(await http.rowsOf(phone)).toHaveLength(0);
      expect(hashSpy).not.toHaveBeenCalled();
      expect(ctx.sms.send).not.toHaveBeenCalled();
    });

    it('with the cap reached whoever already has a code still enters, refreshes and reads the active trip (RN-EO-15)', async () => {
      const phone = waveIssued[0];
      if (!phone) throw new Error('the burst issued nothing');
      const code = waveCodes.get(phone) ?? '';

      const login = await http.verify(phone, code);
      expect(login.status).toBe(200);
      const active = await http.get('/trips/active', login.body.tokens.access_token);
      expect(active.status).toBe(200);
      const refreshed = await http.post('/auth/refresh', { refresh_token: login.body.tokens.refresh_token });
      expect(refreshed.status).toBe(200);
    });
  });

  describe('P-9: with the global cap exhausted the four kinds of phone get the same answer', () => {
    it('the same status, body shape and headers for a passenger, a driver, a platform_admin and an unknown phone', async () => {
      const driver = await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null });
      const passenger = http.randomPhone();
      await ctx.prisma.user.create({
        data: { firstName: '_EO', lastName: 'passenger', phone: passenger, role: 'passenger', accountStatus: 'active' },
      });
      const admin = http.randomPhone();
      await ctx.prisma.user.create({
        data: { firstName: '_EO', lastName: 'admin', phone: admin, role: 'platform_admin', accountStatus: 'active' },
      });
      const unknown = http.randomPhone();

      const answers = [];
      for (const phone of [passenger, driver.phone, admin, unknown]) answers.push(await http.post('/auth/otp/request', { phone }));

      expect(answers.every((r) => r.status === 429)).toBe(true);
      expect(new Set(answers.map(fingerprintOf)).size).toBe(1);
      const waits = answers.map((r) => Number(r.body.retry_in_sec));
      expect(Math.max(...waits) - Math.min(...waits)).toBeLessThanOrEqual(2);
      for (const res of answers) expect(res.headers).not.toHaveProperty('retry-after');
    });
  });

  describe('P-11: logs and the Sentry event carry no phone and no code', () => {
    it('logs the cap reached and the refusals by cap, without personal data', () => {
      const logged = waveWarnings.map(([entry]) => entry as { msg?: string; cap?: string });
      const reached = logged.filter((entry) => entry.msg === 'otp_global_daily_cap_reached');
      const refused = logged.filter((entry) => entry.msg === 'otp_issuance_refused');

      expect(reached.length).toBeGreaterThanOrEqual(1);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      for (const entry of refused) expect(['global', 'saturated']).toContain(entry.cap);
      for (const entry of reached) expect(Object.keys(entry).sort()).toEqual(['count', 'limit', 'msg']);
      const everything = JSON.stringify(waveWarnings);
      for (const phone of waveIssued) expect(everything).not.toContain(phone);
    });

    it('raises one plain Error event for the whole burst and the refusals that followed, never an HttpException', () => {
      const capEvents = waveEvents.filter((error) => error instanceof OtpGlobalDailyCapReachedError);

      expect(capEvents).toHaveLength(1);
      expect(capEvents[0]).toBeInstanceOf(Error);
      expect(capEvents[0]).not.toBeInstanceOf(HttpException);
      expect(String((capEvents[0] as Error).message)).toMatch(/^OTP global daily cap reached: count=\d+ limit=\d+$/);
      for (const phone of waveIssued) expect(String((capEvents[0] as Error).message)).not.toContain(phone);
    });
  });
});
