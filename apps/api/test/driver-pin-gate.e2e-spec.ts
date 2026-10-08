import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  bootPinApp,
  createDriver,
  personalToken,
  readDriver,
  type PinApp,
} from './support/pin-app';

const url = process.env.PG_TEST_URL;
const TEST_TIMEOUT_MS = 30_000;
jest.setTimeout(TEST_TIMEOUT_MS);
const suite = url ? describe : describe.skip;

function extractPin(message: string): string {
  const match = /PIN (\d+)/.exec(message);
  if (!match) throw new Error('PIN not found in the SMS body');
  return match[1] as string;
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] as string;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

suite('Driver PIN gate: claim, global guard, refresh, seeded drivers and credentials reset (ADR-028)', () => {
  let ctx: PinApp;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await bootPinApp();
    app = ctx.app;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('a driver created with column defaults (as the seed does)', () => {
    let pendingAccess: string;
    let pendingRefresh: string;
    let driverId: number;

    beforeAll(async () => {
      const driver = await createDriver(ctx);
      driverId = driver.driverId;
      const row = await readDriver(ctx, driverId);
      expect(row.pinMustChange).toBe(true);

      const login = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: driver.nationalId, pin: driver.temporaryPin });
      expect(login.status).toBe(200);
      pendingAccess = login.body.tokens.access_token;
      pendingRefresh = login.body.tokens.refresh_token;
      expect(login.body.user.pin_change_required).toBe(true);
    });

    it('the access token carries the pin_change_required claim', () => {
      expect(decodeClaims(pendingAccess)).toMatchObject({
        sub: driverId,
        role: 'driver',
        pin_change_required: true,
      });
    });

    it.each([
      ['PUT', '/driver/shift'],
      ['POST', '/driver/location'],
      ['GET', '/driver/me'],
      ['GET', '/driver/trips/cash-pending'],
      ['GET', '/assignments/nearby'],
      ['POST', '/assignments/1/accept'],
      ['GET', '/consents'],
    ] as const)('%s %s -> 403 PIN_CHANGE_REQUIRED', async (method, path) => {
      const res = await request(app.getHttpServer())
        [method.toLowerCase() as 'get' | 'post' | 'put'](path)
        .set('Authorization', `Bearer ${pendingAccess}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'PIN_CHANGE_REQUIRED',
        message: 'Crea tu PIN para continuar.',
      });
    });

    it('POST /auth/driver/pin is reachable while pending (a bad body is a 400, not a 403)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/driver/pin')
        .set('Authorization', `Bearer ${pendingAccess}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DATA');
    });

    it('refresh stays public and re-emits the claim while the change is pending', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: pendingRefresh });
      expect(res.status).toBe(200);
      expect(res.body.user.pin_change_required).toBe(true);
      expect(decodeClaims(res.body.access_token)).toMatchObject({ pin_change_required: true });
      pendingRefresh = res.body.refresh_token;
    });

    it('logout stays public while pending', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refresh_token: pendingRefresh });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('the same driver with a token WITHOUT the claim is not gated', async () => {
      const res = await request(app.getHttpServer())
        .get('/driver/me')
        .set('Authorization', `Bearer ${personalToken(ctx, driverId)}`);
      expect(res.status).toBe(200);
    });
  });

  describe('credentials reset by the company admin (resend PIN)', () => {
    it('revokes every session, issues a new temporary PIN with a validity and demands the change again', async () => {
      const driver = await createDriver(ctx, { pinMustChange: false, temporaryPinExpiresAt: null });

      const firstLogin = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: driver.nationalId, pin: driver.temporaryPin });
      expect(firstLogin.status).toBe(200);
      expect(firstLogin.body.user.pin_change_required).toBe(false);
      expect(decodeClaims(firstLogin.body.tokens.access_token)).not.toHaveProperty('pin_change_required');
      const oldRefresh = firstLogin.body.tokens.refresh_token as string;

      ctx.sms.send.mockClear();
      const resend = await request(app.getHttpServer())
        .post(`/admin/drivers/${driver.driverId}/pin/resend`)
        .set('Authorization', ctx.adminAuth)
        .send({});
      expect(resend.status).toBe(200);
      const expiresAt = new Date(resend.body.temporary_pin_expires_at as string).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() + 71 * 3_600_000);
      expect(expiresAt).toBeLessThan(Date.now() + 73 * 3_600_000);

      const revoked = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: oldRefresh });
      expect(revoked.status).toBe(401);
      expect(revoked.body.code).toBe('REFRESH_REVOKED');

      const row = await readDriver(ctx, driver.driverId);
      expect(row.pinMustChange).toBe(true);
      expect(row.temporaryPinExpiresAt).not.toBeNull();

      const newPin = extractPin(ctx.sms.send.mock.calls[0]?.[1] as string);
      const secondLogin = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: driver.nationalId, pin: newPin });
      expect(secondLogin.status).toBe(200);
      expect(secondLogin.body.user.pin_change_required).toBe(true);
      expect(decodeClaims(secondLogin.body.tokens.access_token)).toMatchObject({
        pin_change_required: true,
      });
    });
  });
});
