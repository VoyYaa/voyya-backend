import type { INestApplication } from '@nestjs/common';
import { AuthError } from '@voyyaa/shared';
import request from 'supertest';
import {
  bootPinApp,
  createDriver,
  pendingToken,
  personalToken,
  readDriver,
  type PinApp,
} from './support/pin-app';

const url = process.env.PG_TEST_URL;
const TEST_TIMEOUT_MS = 30_000;
jest.setTimeout(TEST_TIMEOUT_MS);
const suite = url ? describe : describe.skip;

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] as string;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function changePin(app: INestApplication, token: string, body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .post('/auth/driver/pin')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function login(app: INestApplication, nationalId: string, pin: string) {
  return request(app.getHttpServer())
    .post('/auth/driver/login')
    .send({ national_id: nationalId, pin });
}

const NEW_PIN = '739204';

suite('POST /auth/driver/pin: rejections (ADR-028)', () => {
  let ctx: PinApp;

  beforeAll(async () => {
    ctx = await bootPinApp();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('a request without a session -> 401 SESSION_REQUIRED', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/driver/pin')
      .send({ current_pin: '482915', new_pin: NEW_PIN });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REQUIRED');
  });

  it('weak PINs and a PIN equal to the temporary one are rejected by the contract (400) and nothing changes', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '482915' });
    const token = pendingToken(ctx, driver.driverId);

    const sequential = await changePin(ctx.app, token, { current_pin: '482915', new_pin: '123456' });
    expect(sequential.status).toBe(400);
    expect(sequential.body.code).toBe('INVALID_DATA');
    expect(AuthError.safeParse(sequential.body).success).toBe(true);
    expect(sequential.body).toEqual({
      code: 'INVALID_DATA',
      message: 'Solicitud inválida',
      details: [{ field: 'new_pin', error: expect.any(String) }],
    });

    const same = await changePin(ctx.app, token, { current_pin: '482915', new_pin: '482915' });
    expect(same.status).toBe(400);
    expect(AuthError.safeParse(same.body).success).toBe(true);
    expect(same.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'new_pin',
          error: 'El PIN nuevo debe ser distinto del que recibiste',
        }),
      ]),
    );

    const row = await readDriver(ctx, driver.driverId);
    expect(row.pinMustChange).toBe(true);
    expect(row.failedAttempts).toBe(0);
  });

  it('a PIN made of the last 6 digits of the national id or of the phone -> 422 PIN_TOO_WEAK', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '482915' });
    const token = pendingToken(ctx, driver.driverId);

    const fromNationalId = await changePin(ctx.app, token, {
      current_pin: '482915',
      new_pin: driver.nationalId.slice(-6),
    });
    expect(fromNationalId.status).toBe(422);
    expect(fromNationalId.body.code).toBe('PIN_TOO_WEAK');

    const fromPhone = await changePin(ctx.app, token, {
      current_pin: '482915',
      new_pin: driver.phone.slice(-6),
    });
    expect(fromPhone.status).toBe(422);
    expect(fromPhone.body.code).toBe('PIN_TOO_WEAK');

    const row = await readDriver(ctx, driver.driverId);
    expect(row.pinMustChange).toBe(true);
    expect(row.pinChangedAt).toBeNull();
  });
});

suite('POST /auth/driver/pin: the wrong current PIN counts toward the login lockout (ADR-028)', () => {
  let ctx: PinApp;

  beforeAll(async () => {
    ctx = await bootPinApp();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('uses the same counter and threshold as the login: LOGIN_MAX_ATTEMPTS wrong tries block, even the correct PIN at login afterwards', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '482915' });
    const token = pendingToken(ctx, driver.driverId);

    for (const expectedAttempts of [1, 2]) {
      const wrong = await changePin(ctx.app, token, { current_pin: '000111', new_pin: NEW_PIN });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect((await readDriver(ctx, driver.driverId)).failedAttempts).toBe(expectedAttempts);
    }

    const blocking = await changePin(ctx.app, token, { current_pin: '000111', new_pin: NEW_PIN });
    expect(blocking.status).toBe(429);
    expect(blocking.body.code).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
    expect(blocking.body.retry_in_sec).toBe(15 * 60);
    expect((await readDriver(ctx, driver.driverId)).blockedUntil).not.toBeNull();

    expect((await readDriver(ctx, driver.driverId)).pinMustChange).toBe(true);

    const loginWhileBlocked = await login(ctx.app, driver.nationalId, '482915');
    expect(loginWhileBlocked.status).toBe(429);
  });

  it('failures at login and at change add up in the same counter', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '482915' });
    const token = pendingToken(ctx, driver.driverId);

    const wrongLogin = await login(ctx.app, driver.nationalId, '000111');
    expect(wrongLogin.status).toBe(401);
    const wrongChange = await changePin(ctx.app, token, { current_pin: '000111', new_pin: NEW_PIN });
    expect(wrongChange.status).toBe(401);
    expect((await readDriver(ctx, driver.driverId)).failedAttempts).toBe(2);

    const blocking = await changePin(ctx.app, token, { current_pin: '000111', new_pin: NEW_PIN });
    expect(blocking.status).toBe(429);
    expect(blocking.body.code).toBe('ACCOUNT_TEMPORARILY_BLOCKED');
  });
});

suite('Expired temporary PIN (ADR-028)', () => {
  let ctx: PinApp;

  beforeAll(async () => {
    ctx = await bootPinApp();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('with the right PIN: login and change answer 401 TEMPORARY_PIN_EXPIRED and do not count as failures', async () => {
    const driver = await createDriver(ctx, {
      temporaryPin: '482915',
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });

    const loginRes = await login(ctx.app, driver.nationalId, '482915');
    expect(loginRes.status).toBe(401);
    expect(loginRes.body.code).toBe('TEMPORARY_PIN_EXPIRED');

    const changeRes = await changePin(ctx.app, pendingToken(ctx, driver.driverId), {
      current_pin: '482915',
      new_pin: NEW_PIN,
    });
    expect(changeRes.status).toBe(401);
    expect(changeRes.body.code).toBe('TEMPORARY_PIN_EXPIRED');

    const row = await readDriver(ctx, driver.driverId);
    expect(row.failedAttempts).toBe(0);
    expect(row.pinMustChange).toBe(true);
  });

  it('with a wrong PIN it is an ordinary INVALID_CREDENTIALS (the expiry is not an oracle)', async () => {
    const driver = await createDriver(ctx, {
      temporaryPin: '482915',
      temporaryPinExpiresAt: new Date(Date.now() - 1000),
    });
    const loginRes = await login(ctx.app, driver.nationalId, '000111');
    expect(loginRes.status).toBe(401);
    expect(loginRes.body.code).toBe('INVALID_CREDENTIALS');
    const changeRes = await changePin(ctx.app, pendingToken(ctx, driver.driverId), {
      current_pin: '000111',
      new_pin: NEW_PIN,
    });
    expect(changeRes.body.code).toBe('INVALID_CREDENTIALS');
  });
});

suite('POST /auth/driver/pin: success, revocation and idempotency (ADR-028)', () => {
  let ctx: PinApp;

  beforeAll(async () => {
    ctx = await bootPinApp();
  }, 30_000);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('changes the PIN, clears the pending state, revokes older sessions and returns a session without the claim', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '482915' });
    const firstLogin = await login(ctx.app, driver.nationalId, '482915');
    expect(firstLogin.status).toBe(200);
    const pendingAccess = firstLogin.body.tokens.access_token as string;
    const oldRefresh = firstLogin.body.tokens.refresh_token as string;

    const res = await changePin(ctx.app, pendingAccess, { current_pin: '482915', new_pin: NEW_PIN });

    expect(res.status).toBe(200);
    expect(res.body.user.pin_change_required).toBe(false);
    expect(res.body.user.role).toBe('driver');
    expect(res.body.user.tenant.company_id).toBe(ctx.companyId);
    expect(decodeClaims(res.body.tokens.access_token)).not.toHaveProperty('pin_change_required');
    expect(JSON.stringify(res.body)).not.toContain(NEW_PIN);

    const row = await readDriver(ctx, driver.driverId);
    expect(row.pinMustChange).toBe(false);
    expect(row.temporaryPinExpiresAt).toBeNull();
    expect(row.pinChangedAt).not.toBeNull();
    expect(row.failedAttempts).toBe(0);
    expect(row.blockedUntil).toBeNull();
    expect(row.pin).not.toContain(NEW_PIN);

    const staleRefresh = await request(ctx.app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: oldRefresh });
    expect(staleRefresh.status).toBe(401);
    expect(staleRefresh.body.code).toBe('REFRESH_REVOKED');

    const me = await request(ctx.app.getHttpServer())
      .get('/driver/me')
      .set('Authorization', `Bearer ${res.body.tokens.access_token}`);
    expect(me.status).toBe(200);

    const loginNew = await login(ctx.app, driver.nationalId, NEW_PIN);
    expect(loginNew.status).toBe(200);
    expect(loginNew.body.user.pin_change_required).toBe(false);

    const loginOld = await login(ctx.app, driver.nationalId, '482915');
    expect(loginOld.status).toBe(401);
    expect(loginOld.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('submitting the same change twice is idempotent: a second session, no failure counted, same PIN', async () => {
    const driver = await createDriver(ctx, { temporaryPin: '603518' });
    const token = pendingToken(ctx, driver.driverId);
    const body = { current_pin: '603518', new_pin: '817240' };

    const first = await changePin(ctx.app, token, body);
    expect(first.status).toBe(200);
    const hashAfterFirst = (await readDriver(ctx, driver.driverId)).pin;

    const second = await changePin(ctx.app, token, body);
    expect(second.status).toBe(200);
    expect(second.body.user.pin_change_required).toBe(false);
    expect(second.body.tokens.refresh_token).not.toBe(first.body.tokens.refresh_token);

    const row = await readDriver(ctx, driver.driverId);
    expect(row.pin).toBe(hashAfterFirst);
    expect(row.failedAttempts).toBe(0);
  });

  it('a driver with a personal PIN can also change it, and the endpoint rejects non-drivers', async () => {
    const driver = await createDriver(ctx, {
      temporaryPin: '259031',
      pinMustChange: false,
      temporaryPinExpiresAt: null,
    });
    const voluntary = await changePin(ctx.app, personalToken(ctx, driver.driverId), {
      current_pin: '259031',
      new_pin: '684127',
    });
    expect(voluntary.status).toBe(200);

    const passengerToken = ctx.jwt.sign({ sub: 99, role: 'passenger', type: 'access' });
    const asPassenger = await changePin(ctx.app, passengerToken, {
      current_pin: '259031',
      new_pin: '684127',
    });
    expect(asPassenger.status).toBe(403);
    expect(asPassenger.body.code).toBe('FORBIDDEN');
  });
});
