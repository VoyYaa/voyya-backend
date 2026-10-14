import 'reflect-metadata';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { buildThrottlers } from '../../shared/throttlers';
import { ALLOW_PENDING_PIN_CHANGE_KEY } from '../auth/decorators/allow-pending-pin-change.decorator';
import { PinChangeGuard } from '../auth/guards/pin-change.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../tenancy/tenant-request';
import { PushTokenController } from './push-token.controller';
import { PushTokenRepository } from './push-token.repository';

class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: AuthenticatedUser;
    }>();
    const userId = req.headers['x-user'];
    const role = req.headers['x-role'];
    const pinPending = req.headers['x-pin-pending'] === 'true';
    if (userId && role) {
      req.user = {
        userId: Number(userId),
        role: role as AuthenticatedUser['role'],
        ...(pinPending ? { pinChangeRequired: true } : {}),
      };
    }
    return true;
  }
}

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const BODY = { token: TOKEN, platform: 'android' };

describe('PushTokenController · roles and per-user limit (ADR-034 section 4.4, C-1, T-13)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const repo = {
    register: jest.fn(async () => undefined),
    revoke: jest.fn(async () => undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlers({ ttlMs: 60_000, limit: 100 }))],
      controllers: [PushTokenController],
      providers: [
        { provide: PushTokenRepository, useValue: repo },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: HeaderAuthGuard },
        { provide: APP_GUARD, useClass: PinChangeGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (role: string, user: number, path: string, body: object = BODY) =>
    http.post(path).set('x-user', String(user)).set('x-role', role).send(body);

  describe('roles', () => {
    it.each(['passenger', 'driver'])('%s registers and revokes: 204 with no body', async (role) => {
      const registered = await as(role, 100, '/push-tokens');
      const revoked = await as(role, 100, '/push-tokens/revoke', { token: TOKEN });

      expect(registered.status).toBe(204);
      expect(registered.body).toEqual({});
      expect(revoked.status).toBe(204);
    });

    it.each(['admin', 'operator', 'platform_admin'])('%s gets 403 on both routes and nothing is stored', async (role) => {
      repo.register.mockClear();
      repo.revoke.mockClear();

      const registered = await as(role, 200, '/push-tokens');
      const revoked = await as(role, 200, '/push-tokens/revoke', { token: TOKEN });

      expect(registered.status).toBe(403);
      expect(revoked.status).toBe(403);
      expect(repo.register).not.toHaveBeenCalled();
      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('without a session it never reaches the repository', async () => {
      repo.register.mockClear();

      const response = await http.post('/push-tokens').send(BODY);

      expect([401, 403]).toContain(response.status);
      expect(repo.register).not.toHaveBeenCalled();
    });
  });

  describe('driver with a pending PIN change (PP-03)', () => {
    const pendingDriver = (path: string, user: number, body: object = BODY) =>
      http.post(path).set('x-user', String(user)).set('x-role', 'driver').set('x-pin-pending', 'true').send(body);

    it('can revoke its token so that logging out does not leave it behind: 204 and the repository is told', async () => {
      repo.revoke.mockClear();

      const response = await pendingDriver('/push-tokens/revoke', 900, { token: TOKEN });

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(repo.revoke).toHaveBeenCalledWith(900, TOKEN);
    });

    it('cannot register a token: 403 PIN_CHANGE_REQUIRED and nothing is stored', async () => {
      repo.register.mockClear();

      const response = await pendingDriver('/push-tokens', 901);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'PIN_CHANGE_REQUIRED' });
      expect(repo.register).not.toHaveBeenCalled();
    });

    it('a driver whose PIN is already personal registers as always', async () => {
      const response = await as('driver', 902, '/push-tokens');

      expect(response.status).toBe(204);
    });

    it('the exemption does not turn the role check off: an admin with the same claim is still a 403 on revoke', async () => {
      const response = await http
        .post('/push-tokens/revoke')
        .set('x-user', '903')
        .set('x-role', 'admin')
        .set('x-pin-pending', 'true')
        .send({ token: TOKEN });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('only revoke carries the exemption: neither register nor the controller as a whole', () => {
      const exempt = (target: object): unknown => Reflect.getMetadata(ALLOW_PENDING_PIN_CHANGE_KEY, target);

      expect(exempt(PushTokenController.prototype.revoke)).toBe(true);
      expect(exempt(PushTokenController.prototype.register)).toBeUndefined();
      expect(exempt(PushTokenController)).toBeUndefined();
    });
  });

  describe('contract', () => {
    it('registers the token of the authenticated user, never one sent in the body', async () => {
      repo.register.mockClear();

      await as('passenger', 300, '/push-tokens', { ...BODY, user_id: 999 });

      expect(repo.register).toHaveBeenCalledWith(300, TOKEN, 'android');
    });

    it('revokes filtering by the authenticated user', async () => {
      repo.revoke.mockClear();

      await as('driver', 301, '/push-tokens/revoke', { token: TOKEN });

      expect(repo.revoke).toHaveBeenCalledWith(301, TOKEN);
    });

    it('a native FCM token is rejected with 400', async () => {
      const response = await as('passenger', 302, '/push-tokens', {
        token: 'fcm:APA91bGnativeTokenOfTheDevice',
        platform: 'android',
      });

      expect(response.status).toBe(400);
    });

    it('the token never comes back in the response', async () => {
      const response = await as('passenger', 303, '/push-tokens');

      expect(response.text).toBe('');
    });
  });

  describe('limit per user, not per IP', () => {
    const statuses = async (path: string, user: number, times: number, role = 'passenger'): Promise<number[]> => {
      const result: number[] = [];
      for (let i = 0; i < times; i += 1) {
        result.push((await as(role, user, path, path === '/push-tokens' ? BODY : { token: TOKEN })).status);
      }
      return result;
    };

    it.each(['/push-tokens', '/push-tokens/revoke'])(
      '%s: two users behind the same IP register 10 times each in a minute without blocking each other',
      async (path) => {
        const first = await statuses(path, 4001, 10);
        const second = await statuses(path, 4002, 10);

        expect(first.every((s) => s === 204)).toBe(true);
        expect(second.every((s) => s === 204)).toBe(true);
      },
    );

    it.each(['/push-tokens', '/push-tokens/revoke'])(
      '%s: the eleventh request of one user is 429 with Retry-After while the other user still passes',
      async (path) => {
        const base = path === '/push-tokens' ? 5000 : 6000;
        await statuses(path, base + 1, 10);

        const blocked = await as(
          'passenger',
          base + 1,
          path,
          path === '/push-tokens' ? BODY : { token: TOKEN },
        );
        const other = await as('passenger', base + 2, path, path === '/push-tokens' ? BODY : { token: TOKEN });

        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(other.status).toBe(204);
      },
    );

    it('forty subscribers of the same carrier IP registering three times each never reach 429', async () => {
      const all: number[] = [];
      for (let user = 7000; user < 7040; user += 1) all.push(...(await statuses('/push-tokens', user, 3)));

      expect(all.filter((s) => s === 429)).toHaveLength(0);
    });

    it('each route keeps its own count for the same user', async () => {
      await statuses('/push-tokens', 8001, 10);

      expect((await as('passenger', 8001, '/push-tokens/revoke', { token: TOKEN })).status).toBe(204);
    });
  });
});
