import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcryptjs';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AUTH_EVENTS, RefreshResponse, SessionResponse, type SessionStartedEvent } from '@voyyaa/shared';
import { bootPinApp, createDriver, readDriver, type PinApp } from './support/pin-app';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const STAFF_ROLES = ['driver', 'admin', 'operator', 'platform_admin', 'company'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

const INVALID_OTP_BODY = { code: 'OTP_INVALID', message: 'Código incorrecto' };
const PASSWORD = 'CorrectHorse1!';
const TEST_TIMEOUT_MS = 60_000;
jest.setTimeout(TEST_TIMEOUT_MS);

suite('S-01: the OTP login only opens passenger sessions (real Postgres as app_voyya)', () => {
  let ctx: PinApp;
  const startedSessions: SessionStartedEvent[] = [];
  let hop = 0;

  beforeAll(async () => {
    process.env.SMS_PROVIDER = 'noop';
    process.env.EMAIL_PROVIDER = 'noop';
    process.env.PUSH_PROVIDER = 'noop';
    process.env.BCRYPT_ROUNDS = '10';
    ctx = await bootPinApp();
    ctx.app.getHttpAdapter().getInstance().set('trust proxy', 1);
    ctx.app.get(EventEmitter2).on(AUTH_EVENTS.SESSION_STARTED, (event: SessionStartedEvent) => {
      startedSessions.push(event);
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  function clientIp(): string {
    hop += 1;
    return `10.88.${Math.floor(hop / 250)}.${(hop % 250) + 1}`;
  }

  function post(path: string, body: Record<string, unknown>, token?: string) {
    const req = request(ctx.app.getHttpServer()).post(path).set('X-Forwarded-For', clientIp());
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  }

  function get(path: string, token: string) {
    return request(ctx.app.getHttpServer())
      .get(path)
      .set('X-Forwarded-For', clientIp())
      .set('Authorization', `Bearer ${token}`);
  }

  function randomPhone(): string {
    return `3${randomInt(100_000_000, 999_999_999)}`;
  }

  function verify(phone: string, otp: string) {
    return post('/auth/otp/verify', { phone, code: otp });
  }

  function wrongCodeFor(otp: string): string {
    return String((Number(otp) + 1) % 10 ** otp.length).padStart(otp.length, '0');
  }

  async function requestCode(phone: string): Promise<string> {
    const res = await post('/auth/otp/request', { phone });
    expect(res.status).toBe(200);
    const sent = ctx.sms.send.mock.calls.filter(([to]) => to === phone).pop();
    const match = /(\d+)$/.exec(String(sent?.[1]));
    if (!match?.[1]) throw new Error('The OTP SMS was not sent');
    return match[1];
  }

  async function createAccount(
    role: string,
    options: { phone?: string; companyId?: number | null; accountStatus?: string; email?: string } = {},
  ) {
    const phone = options.phone ?? randomPhone();
    const withPassword = options.email ? { email: options.email, passwordHash: await bcrypt.hash(PASSWORD, 4) } : {};
    const user = await ctx.prisma.user.create({
      data: {
        firstName: '_S01',
        lastName: role,
        phone,
        role,
        accountStatus: options.accountStatus ?? 'active',
        companyId: options.companyId === undefined ? null : options.companyId,
        ...withPassword,
      },
    });
    return { userId: user.userId, phone };
  }

  async function createStaff(role: StaffRole, accountStatus = 'active') {
    if (role === 'driver') {
      const driver = await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null });
      if (accountStatus !== 'active') {
        await ctx.prisma.user.update({ where: { userId: driver.driverId }, data: { accountStatus } });
      }
      return { userId: driver.driverId, phone: driver.phone };
    }
    const companyId = role === 'platform_admin' ? null : ctx.companyId;
    return createAccount(role, { companyId, accountStatus });
  }

  async function wrongCodeBaseline() {
    const phone = randomPhone();
    const otp = await requestCode(phone);
    return verify(phone, wrongCodeFor(otp));
  }

  async function accountState(userId: number) {
    return ctx.prisma.user.findUniqueOrThrow({
      where: { userId },
      select: { failedAttempts: true, blockedUntil: true, accountStatus: true, role: true, companyId: true },
    });
  }

  function sessionsOf(userId: number): number {
    return startedSessions.filter((event) => event.user_id === userId).length;
  }

  function refreshTokensOf(userId: number): Promise<number> {
    return ctx.prisma.refreshToken.count({ where: { userId } });
  }

  describe('the five staff roles are rejected with the answer of a wrong code (HU-S01-02, HU-S01-03)', () => {
    it.each(STAFF_ROLES)(
      '%s: the right code -> 401 OTP_INVALID, byte for byte the answer of a wrong code, no session at all',
      async (role) => {
        const account = await createStaff(role);
        const baseline = await wrongCodeBaseline();
        const before = await accountState(account.userId);
        const otp = await requestCode(account.phone);

        const res = await verify(account.phone, otp);

        expect(baseline.status).toBe(401);
        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_OTP_BODY);
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(baseline.body));
        expect(res.headers['content-type']).toBe(baseline.headers['content-type']);
        expect(res.headers['content-length']).toBe(baseline.headers['content-length']);
        expect(res.body).not.toHaveProperty('tokens');
        expect(res.body).not.toHaveProperty('user');
        expect(await refreshTokensOf(account.userId)).toBe(0);
        expect(sessionsOf(account.userId)).toBe(0);
        expect(await accountState(account.userId)).toEqual(before);
      },
    );

    it.each(STAFF_ROLES)('%s: the OTP is consumed and the right code counted one reserved attempt', async (role) => {
      const account = await createStaff(role);
      const otp = await requestCode(account.phone);

      await verify(account.phone, otp);

      const row = await ctx.prisma.otpCode.findFirstOrThrow({
        where: { phone: account.phone },
        orderBy: { id: 'desc' },
      });
      expect(row.consumed).toBe(true);
      expect(row.attempts).toBe(1);
      const again = await verify(account.phone, otp);
      expect(again.status).toBe(410);
      expect(again.body.code).toBe('OTP_EXPIRED');
    });

    it.each(STAFF_ROLES)('%s: a wrong code is the same ordinary rejection and the OTP stays usable', async (role) => {
      const account = await createStaff(role);
      const otp = await requestCode(account.phone);

      const res = await verify(account.phone, wrongCodeFor(otp));

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_OTP_BODY);
      const row = await ctx.prisma.otpCode.findFirstOrThrow({
        where: { phone: account.phone },
        orderBy: { id: 'desc' },
      });
      expect(row).toMatchObject({ consumed: false, attempts: 1 });
      expect(await refreshTokensOf(account.userId)).toBe(0);
    });

    it('the driver counters of the PIN login are not touched by the OTP rejection', async () => {
      const account = await createStaff('driver');
      const otp = await requestCode(account.phone);

      await verify(account.phone, otp);

      const driver = await readDriver(ctx, account.userId);
      expect(driver.failedAttempts).toBe(0);
      expect(driver.blockedUntil).toBeNull();
    });

    it('a role changed after asking for the OTP is read when verifying', async () => {
      const account = await createAccount('passenger');
      const otp = await requestCode(account.phone);
      await ctx.prisma.user.update({
        where: { userId: account.userId },
        data: { role: 'driver', companyId: ctx.companyId },
      });

      const res = await verify(account.phone, otp);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_OTP_BODY);
      expect(await refreshTokensOf(account.userId)).toBe(0);
    });

    it.each(['ghost', 'PASSENGER', ''])('a role outside the enum (%j) -> 401 OTP_INVALID, not a 500', async (role) => {
      const account = await createAccount(role, { companyId: ctx.companyId });
      const otp = await requestCode(account.phone);

      const res = await verify(account.phone, otp);

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_OTP_BODY);
      expect(await refreshTokensOf(account.userId)).toBe(0);
    });

    it('a driver saved with the +57 prefix never matches: the OTP creates a separate passenger and the driver gets nothing', async () => {
      const driver = await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null });
      await ctx.prisma.user.update({
        where: { userId: driver.driverId },
        data: { phone: `+57${driver.phone}` },
      });
      const otp = await requestCode(driver.phone);

      const res = await verify(driver.phone, otp);

      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('passenger');
      expect(res.body.user.user_id).not.toBe(driver.driverId);
      expect(await refreshTokensOf(driver.driverId)).toBe(0);
      expect(sessionsOf(driver.driverId)).toBe(0);
    });
  });

  describe('suspension keeps its answers (HU-S01-05)', () => {
    it('a suspended passenger -> 403 ACCOUNT_SUSPENDED', async () => {
      const account = await createAccount('passenger', { accountStatus: 'suspended' });
      const otp = await requestCode(account.phone);

      const res = await verify(account.phone, otp);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(await refreshTokensOf(account.userId)).toBe(0);
    });

    it.each(['driver', 'admin', 'platform_admin'] as const)(
      'a suspended %s -> 401 OTP_INVALID: neither the role nor the suspension is revealed',
      async (role) => {
        const account = await createStaff(role, 'suspended');
        const otp = await requestCode(account.phone);

        const res = await verify(account.phone, otp);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_OTP_BODY);
      },
    );

    it('the attempts cap still applies to the OTP of a staff phone', async () => {
      const account = await createStaff('admin');
      const otp = await requestCode(account.phone);
      const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);
      for (let i = 0; i < maxAttempts; i += 1) {
        const rejected = await verify(account.phone, wrongCodeFor(otp));
        expect(rejected.status).toBe(401);
      }

      const capped = await verify(account.phone, otp);

      expect(capped.status).toBe(429);
      expect(capped.body.code).toBe('OTP_MAX_ATTEMPTS');
    });
  });

  describe('the passenger keeps its login (HU-S01-01)', () => {
    it('a new phone is auto-registered and gets a full session', async () => {
      const phone = randomPhone();
      const otp = await requestCode(phone);

      const res = await verify(phone, otp);

      expect(res.status).toBe(200);
      expect(SessionResponse.safeParse(res.body).success).toBe(true);
      expect(res.body.user).toMatchObject({ role: 'passenger', tenant: null, profile_complete: false });
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { phone } });
      expect(user.role).toBe('passenger');
      expect(await ctx.prisma.passenger.count({ where: { passengerId: user.userId } })).toBe(1);
      expect(await refreshTokensOf(user.userId)).toBe(1);
      expect(sessionsOf(user.userId)).toBe(1);
      const claims = JSON.parse(
        Buffer.from(String(res.body.tokens.access_token).split('.')[1] as string, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(claims).toMatchObject({ sub: user.userId, role: 'passenger' });
      expect(claims).not.toHaveProperty('company_id');
    });

    it('an existing passenger enters, reads its active trip, refreshes and logs out', async () => {
      const account = await createAccount('passenger');
      await ctx.prisma.passenger.create({ data: { passengerId: account.userId } });
      const otp = await requestCode(account.phone);

      const res = await verify(account.phone, otp);

      expect(res.status).toBe(200);
      expect(res.body.user.user_id).toBe(account.userId);
      const active = await get('/trips/active', res.body.tokens.access_token);
      expect(active.status).toBe(200);

      const refreshed = await post('/auth/refresh', { refresh_token: res.body.tokens.refresh_token });
      expect(refreshed.status).toBe(200);
      expect(RefreshResponse.safeParse(refreshed.body).success).toBe(true);
      expect(refreshed.body.user.role).toBe('passenger');
      expect(refreshed.body.refresh_token).not.toBe(res.body.tokens.refresh_token);

      const loggedOut = await post('/auth/logout', { refresh_token: refreshed.body.refresh_token });
      expect(loggedOut.status).toBe(200);
      const afterLogout = await post('/auth/refresh', { refresh_token: refreshed.body.refresh_token });
      expect(afterLogout.status).toBe(401);
    });

    it('the OTP is single use and a wrong code counts one attempt', async () => {
      const phone = randomPhone();
      const otp = await requestCode(phone);

      const wrong = await verify(phone, wrongCodeFor(otp));
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(INVALID_OTP_BODY);
      const row = await ctx.prisma.otpCode.findFirstOrThrow({ where: { phone }, orderBy: { id: 'desc' } });
      expect(row.attempts).toBe(1);

      const first = await verify(phone, otp);
      expect(first.status).toBe(200);
      const replay = await verify(phone, otp);
      expect(replay.status).toBe(410);
      expect(replay.body.code).toBe('OTP_EXPIRED');
    });

    it('requesting an OTP behaves the same for a staff phone, a passenger and an unknown phone', async () => {
      const driver = await createStaff('driver');
      const passenger = await createAccount('passenger');
      const answers = [];
      for (const phone of [driver.phone, passenger.phone, randomPhone()]) {
        const res = await post('/auth/otp/request', { phone });
        answers.push({ status: res.status, body: res.body });
        const again = await post('/auth/otp/request', { phone });
        expect(again.status).toBe(429);
        expect(again.body.code).toBe('OTP_RATE_LIMIT');
      }
      expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
      expect(ctx.sms.send).toHaveBeenCalledTimes(3);
    });
  });

  describe('the staff access methods are intact (HU-S01-07)', () => {
    it('driver: national id and PIN, temporary PIN change, new session, old session revoked', async () => {
      const driver = await createDriver(ctx, { temporaryPin: '482915' });
      await ctx.prisma.runInTenant(ctx.companyId, (tx) =>
        tx.driver.update({ where: { driverId: driver.driverId }, data: { pinMustChange: true } }),
      );

      const login = await post('/auth/driver/login', { national_id: driver.nationalId, pin: '482915' });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ role: 'driver', pin_change_required: true });
      expect(login.body.user.tenant.company_id).toBe(ctx.companyId);

      const changed = await post(
        '/auth/driver/pin',
        { current_pin: '482915', new_pin: '739204' },
        login.body.tokens.access_token,
      );
      expect(changed.status).toBe(200);
      expect(changed.body.user.pin_change_required).toBe(false);
      const newRefresh = await post('/auth/refresh', { refresh_token: changed.body.tokens.refresh_token });
      expect(newRefresh.status).toBe(200);
      expect(newRefresh.body.user.role).toBe('driver');
      const oldRefresh = await post('/auth/refresh', { refresh_token: login.body.tokens.refresh_token });
      expect(oldRefresh.status).toBe(401);
    });

    it('driver: a wrong PIN counts a failed attempt', async () => {
      const driver = await createDriver(ctx, { temporaryPin: '482915' });

      const res = await post('/auth/driver/login', { national_id: driver.nationalId, pin: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      expect((await readDriver(ctx, driver.driverId)).failedAttempts).toBe(1);
    });

    it.each([
      ['admin', true],
      ['operator', true],
      ['platform_admin', false],
    ] as const)('%s: email and password, then refresh keeps its role and tenant', async (role, hasCompany) => {
      const email = `s01.${role}.${randomUUID()}@voyya-e2e.test`;
      await createAccount(role, { email, companyId: hasCompany ? ctx.companyId : null });

      const login = await post('/auth/admin/login', { email, password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe(role);
      expect(login.body.user.tenant?.company_id ?? null).toBe(hasCompany ? ctx.companyId : null);

      const refreshed = await post('/auth/refresh', { refresh_token: login.body.tokens.refresh_token });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.user.role).toBe(role);
      expect(refreshed.body.user.tenant?.company_id ?? null).toBe(hasCompany ? ctx.companyId : null);
    });

    it('driver: refresh keeps its role and company', async () => {
      const driver = await createDriver(ctx, {
        temporaryPin: '482915',
        pinMustChange: false,
        temporaryPinExpiresAt: null,
      });
      const login = await post('/auth/driver/login', { national_id: driver.nationalId, pin: '482915' });
      expect(login.status).toBe(200);

      const refreshed = await post('/auth/refresh', { refresh_token: login.body.tokens.refresh_token });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.user.role).toBe('driver');
      expect(refreshed.body.user.tenant.company_id).toBe(ctx.companyId);
    });
  });
});
