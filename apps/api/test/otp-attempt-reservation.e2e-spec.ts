import * as bcrypt from 'bcryptjs';
import { OTP_LENGTH } from '@voyyaa/shared';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import { BcryptHasher, type Hasher } from '../src/modules/auth/hasher.service';
import { createOtpHttp, type OtpHttp } from './support/otp-http';
import { bootPinApp, createDriver, type PinApp } from './support/pin-app';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const TEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 5;
const BURST = 40;
jest.setTimeout(TEST_TIMEOUT_MS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilAttemptReserved(http: OtpHttp, phone: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await http.rowsOf(phone);
    if (row?.attempts === 1) return;
    await sleep(25);
  }
  throw new Error('The attempt was not reserved in time');
}

function slowHasher(compareDelayMs: number): Hasher {
  return {
    hash: (plain) => bcrypt.hash(plain, 4),
    compare: async (plain, hash) => {
      await sleep(compareDelayMs);
      return bcrypt.compare(plain, hash);
    },
  };
}

suite('ADR-035 1 and 2: reserve the attempt before comparing, one live OTP per phone (real Postgres as app_voyya)', () => {
  let ctx: PinApp;
  let http: OtpHttp;
  let repo: AuthRepository;
  let compareSpy: jest.SpyInstance;

  beforeAll(async () => {
    process.env.SMS_PROVIDER = 'noop';
    process.env.EMAIL_PROVIDER = 'noop';
    process.env.PUSH_PROVIDER = 'noop';
    process.env.BCRYPT_ROUNDS = '10';
    process.env.OTP_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
    ctx = await bootPinApp();
    ctx.app.getHttpAdapter().getInstance().set('trust proxy', 1);
    http = createOtpHttp(ctx, 21);
    repo = ctx.app.get(AuthRepository, { strict: false });
    compareSpy = jest.spyOn(BcryptHasher.prototype, 'compare');
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('V-EO-1: the cap of attempts per code holds under concurrency', () => {
    it(`${BURST} simultaneous wrong codes: exactly ${MAX_ATTEMPTS} are compared (401) and the rest answer 429, attempts = ${MAX_ATTEMPTS}`, async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);
      compareSpy.mockClear();

      const burst = await Promise.all(Array.from({ length: BURST }, () => http.verify(phone, http.wrongCodeFor(code))));

      const invalid = burst.filter((r) => r.status === 401 && r.body.code === 'OTP_INVALID');
      const exhausted = burst.filter((r) => r.status === 429 && r.body.code === 'OTP_MAX_ATTEMPTS');
      expect(invalid).toHaveLength(MAX_ATTEMPTS);
      expect(exhausted).toHaveLength(BURST - MAX_ATTEMPTS);
      expect(compareSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      const [row] = await http.rowsOf(phone);
      expect(row).toMatchObject({ attempts: MAX_ATTEMPTS, consumed: false });
    });

    it('the right code hidden among the wrong ones: at most one session, at most five comparisons, attempts never beyond the cap', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);
      compareSpy.mockClear();

      const burst = await Promise.all(
        Array.from({ length: BURST }, (_, index) => http.verify(phone, index === 17 ? code : http.wrongCodeFor(code))),
      );

      expect(burst.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(compareSpy.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
      const [row] = await http.rowsOf(phone);
      expect(row?.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
      expect(burst.every((r) => [200, 401, 429].includes(r.status))).toBe(true);
    });

    it('two simultaneous verifications with the right code: one session, the other answers "Código ya utilizado"', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);

      const pair = await Promise.all([http.verify(phone, code), http.verify(phone, code)]);

      expect(pair.filter((r) => r.status === 200)).toHaveLength(1);
      const loser = pair.find((r) => r.status !== 200);
      expect(loser?.status).toBe(401);
      expect(loser?.body).toEqual({ code: 'OTP_INVALID', message: 'Código ya utilizado' });
    });

    it('sequentially, as before: five wrong codes answer 401 and the sixth, even the right one, answers 429', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        const rejected = await http.verify(phone, http.wrongCodeFor(code));
        expect(rejected.status).toBe(401);
      }

      const sixth = await http.verify(phone, code);

      expect(sixth.status).toBe(429);
      expect(sixth.body).toEqual({ code: 'OTP_MAX_ATTEMPTS', message: 'Demasiados intentos, solicita otro código' });
    });

    it('the fifth attempt still counts: four wrong codes and then the right one enters', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);
      for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) await http.verify(phone, http.wrongCodeFor(code));

      const fifth = await http.verify(phone, code);

      expect(fifth.status).toBe(200);
      const [row] = await http.rowsOf(phone);
      expect(row).toMatchObject({ attempts: MAX_ATTEMPTS, consumed: true });
    });

    it('the right code on the first try also counts one reserved attempt', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);

      const res = await http.verify(phone, code);

      expect(res.status).toBe(200);
      const [row] = await http.rowsOf(phone);
      expect(row).toMatchObject({ attempts: 1, consumed: true });
    });
  });

  describe('the reservation at repository level, without the service (the SQL is the arbiter)', () => {
    async function insertOtp(phone: string, hash = 'stored-hash'): Promise<number> {
      await http.seedOtp({ phone });
      await ctx.prisma.$executeRaw`UPDATE auth.otp_code SET code_hash = ${hash} WHERE phone = ${phone}`;
      const id = await repo.findLiveOtp(phone);
      if (id === null) throw new Error('seeded OTP is not live');
      return id;
    }

    it(`${BURST} parallel reservations succeed exactly ${MAX_ATTEMPTS} times and return the stored hash`, async () => {
      const id = await insertOtp(http.randomPhone(), 'the-stored-hash');

      const reservations = await Promise.all(Array.from({ length: BURST }, () => repo.reserveOtpAttempt(id, MAX_ATTEMPTS)));

      expect(reservations.filter((hash) => hash === 'the-stored-hash')).toHaveLength(MAX_ATTEMPTS);
      expect(reservations.filter((hash) => hash === null)).toHaveLength(BURST - MAX_ATTEMPTS);
    });

    it('OTP_MAX_ATTEMPTS = 1 allows a single comparison', async () => {
      const id = await insertOtp(http.randomPhone());

      await expect(repo.reserveOtpAttempt(id, 1)).resolves.toBe('stored-hash');
      await expect(repo.reserveOtpAttempt(id, 1)).resolves.toBeNull();
    });

    it('refuses to reserve a consumed OTP and an expired OTP', async () => {
      const consumed = await insertOtp(http.randomPhone());
      await repo.consumeOtp(consumed);
      const expiredPhone = http.randomPhone();
      const expired = await insertOtp(expiredPhone);
      await ctx.prisma.$executeRaw`UPDATE auth.otp_code SET expires_at = timezone('utc', now()) - interval '1 second' WHERE id = ${expired}`;

      await expect(repo.reserveOtpAttempt(consumed, MAX_ATTEMPTS)).resolves.toBeNull();
      await expect(repo.reserveOtpAttempt(expired, MAX_ATTEMPTS)).resolves.toBeNull();
    });

    it('classifies an unreserved OTP from the confirmed state, with an explicit attempts comparison', async () => {
      const phone = http.randomPhone();
      const id = await insertOtp(phone);
      await expect(repo.readOtpReservationState(id, MAX_ATTEMPTS)).resolves.toEqual({
        consumed: false,
        alive: true,
        exhausted: false,
      });
      await ctx.prisma.$executeRaw`UPDATE auth.otp_code SET attempts = ${MAX_ATTEMPTS} WHERE id = ${id}`;
      await expect(repo.readOtpReservationState(id, MAX_ATTEMPTS)).resolves.toMatchObject({ exhausted: true });
      await expect(repo.readOtpReservationState(-1, MAX_ATTEMPTS)).resolves.toBeNull();
    });
  });

  describe('V-EO-6 (OTP-07): one live OTP per phone', () => {
    it('issuing a new OTP expires the previous one at the instant of the emission, without consuming it nor touching its attempts', async () => {
      const phone = http.randomPhone();
      await http.requestCode(phone);
      await http.ageOtps(phone, 60);
      const before = Date.now();
      await http.requestCode(phone);

      const [first, second] = await http.rowsOf(phone);
      expect(first?.consumed).toBe(false);
      expect(first?.attempts).toBe(0);
      expect(first!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(first!.expiresAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(second!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
    });

    it('consuming the last OTP does not bring the previous one back to life', async () => {
      const phone = http.randomPhone();
      const first = await http.requestCode(phone);
      await http.ageOtps(phone, 60);
      const second = await http.requestCode(phone);

      const withSecond = await http.verify(phone, second);
      const withFirst = await http.verify(phone, first);

      expect(withSecond.status).toBe(200);
      expect(withFirst.status).toBe(410);
      expect(withFirst.body.code).toBe('OTP_EXPIRED');
      expect(withFirst.body).not.toHaveProperty('tokens');
    });

    it('for the legitimate passenger nothing changes: the code of the last SMS enters and the older code is just a wrong code', async () => {
      const phone = http.randomPhone();
      const first = await http.requestCode(phone);
      await http.ageOtps(phone, 60);
      const second = await http.requestCode(phone);

      const stale = await http.verify(phone, first);
      expect(stale.status).toBe(401);
      expect(stale.body.code).toBe('OTP_INVALID');
      const fresh = await http.verify(phone, second);

      expect(fresh.status).toBe(200);
    });

    it('staff with two OTPs: the last right code is rejected like a wrong code and the first one answers 410, not 401', async () => {
      const driver = await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null });
      const first = await http.requestCode(driver.phone);
      await http.ageOtps(driver.phone, 60);
      const second = await http.requestCode(driver.phone);

      const rejected = await http.verify(driver.phone, second);
      const afterwards = await http.verify(driver.phone, first);

      expect(rejected.status).toBe(401);
      expect(rejected.body).toEqual({ code: 'OTP_INVALID', message: 'Código incorrecto' });
      expect(afterwards.status).toBe(410);
      expect(afterwards.body.code).toBe('OTP_EXPIRED');
    });

    it('a used OTP stays single use: repeating the code answers 410', async () => {
      const phone = http.randomPhone();
      const code = await http.requestCode(phone);
      await http.verify(phone, code);

      const replay = await http.verify(phone, code);

      expect(replay.status).toBe(410);
      expect(replay.body.code).toBe('OTP_EXPIRED');
    });
  });

  describe('P-10: the reservation and a new emission race', () => {
    let slow: PinApp;
    let slowHttp: OtpHttp;
    let slowRepo: AuthRepository;
    const COMPARE_DELAY_MS = 1_500;
    const delayedHasher = slowHasher(COMPARE_DELAY_MS);

    beforeAll(async () => {
      slow = await bootPinApp({ hasher: delayedHasher });
      slow.app.getHttpAdapter().getInstance().set('trust proxy', 1);
      slowHttp = createOtpHttp(slow, 22);
      slowRepo = slow.app.get(AuthRepository, { strict: false });
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (slow) await slow.app.close();
    });

    it('the right code already reserved enters even if a new emission expires its OTP while the comparison runs (1.6)', async () => {
      const phone = slowHttp.randomPhone();
      const first = await slowHttp.requestCode(phone);
      await slowHttp.ageOtps(phone, 60);

      const verifying = slowHttp.verify(phone, first).then((res) => res);
      await untilAttemptReserved(slowHttp, phone);
      const issued = await slowHttp.post('/auth/otp/request', { phone });
      const session = await verifying;

      expect(issued.status).toBe(200);
      expect(session.status).toBe(200);
      expect(session.body.user.role).toBe('passenger');
      const [original] = await slowHttp.rowsOf(phone);
      expect(original).toMatchObject({ attempts: 1, consumed: true });
    });

    it('the OTP that expires between the lookup and the reservation answers 410 and is never compared', async () => {
      const phone = slowHttp.randomPhone();
      const first = await slowHttp.requestCode(phone);
      await slowHttp.ageOtps(phone, 60);
      const original = slowRepo.findLiveOtp.bind(slowRepo);
      const lookup = jest.spyOn(slowRepo, 'findLiveOtp').mockImplementationOnce(async (lookedUp) => {
        const id = await original(lookedUp);
        const issued = await slowHttp.post('/auth/otp/request', { phone });
        expect(issued.status).toBe(200);
        return id;
      });
      const compare = jest.spyOn(delayedHasher, 'compare');

      const res = await slowHttp.verify(phone, first);

      expect(lookup).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('OTP_EXPIRED');
      expect(compare).not.toHaveBeenCalled();
      const [expired] = await slowHttp.rowsOf(phone);
      expect(expired).toMatchObject({ attempts: 0, consumed: false });
      lookup.mockRestore();
    });
  });

  describe('P-12: a code of another length is rejected by the contract before touching the OTP', () => {
    it.each(['1234', '12345', '1234567', '12345a', ''])('%j answers 400 INVALID_DATA and the row is untouched', async (bad) => {
      const phone = http.randomPhone();
      await http.requestCode(phone);
      const [before] = await http.rowsOf(phone);
      const lookup = jest.spyOn(repo, 'findLiveOtp');
      const reserve = jest.spyOn(repo, 'reserveOtpAttempt');

      const res = await http.verify(phone, bad);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DATA');
      expect(lookup).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      const [after] = await http.rowsOf(phone);
      expect(after).toEqual(before);
      lookup.mockRestore();
      reserve.mockRestore();
    });

    it('the code that the server generates has exactly OTP_LENGTH digits', async () => {
      const phone = http.randomPhone();

      const code = await http.requestCode(phone);

      expect(OTP_LENGTH).toBe(6);
      expect(code).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
    });
  });
});
