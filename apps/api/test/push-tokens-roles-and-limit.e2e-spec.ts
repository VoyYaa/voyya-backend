import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  type World,
  adminAuth,
  bootWorld,
  createAdminUser,
  createCoveredMunicipality,
  createDriver,
  createOperatingCompany,
  driverAuth,
  passengerAuth,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { pendingToken } from './support/pin-app';
import { createPlatformAdmin, tokenFor } from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_PushTok';
const CENTER = { lat: 12.55, lng: -69.25 };
const PER_USER_LIMIT = 10;

jest.setTimeout(120_000);

interface Actor {
  userId: number;
  authorization: string;
}

suite('POST /push-tokens and /push-tokens/revoke on the full guard stack: per-user limit and roles (ADR-034 section 4.4, T-13)', () => {
  let world: World;
  let http: ReturnType<typeof request>;
  let companyId: number;
  let adminActor: Actor;
  let operatorActor: Actor;
  let platformActor: Actor;

  const newToken = (tag: string): string => `ExponentPushToken[${tag}-${randomUUID()}]`;

  const newPassenger = async (): Promise<Actor> => {
    const userId = await createFreshPassenger(world.prisma);
    return { userId, authorization: passengerAuth(world.jwt, userId) };
  };

  const newDriver = async (): Promise<Actor> => {
    const { driverId } = await createDriver(world.prisma, companyId, CENTER);
    return { userId: driverId, authorization: driverAuth(world.jwt, driverId, companyId) };
  };

  const register = (actor: Actor, token = newToken('reg'), extraHeaders: Record<string, string> = {}) =>
    http
      .post('/push-tokens')
      .set('Authorization', actor.authorization)
      .set(extraHeaders)
      .send({ token, platform: 'android' });

  const revoke = (actor: Actor, token: string, extraHeaders: Record<string, string> = {}) =>
    http.post('/push-tokens/revoke').set('Authorization', actor.authorization).set(extraHeaders).send({ token });

  const tokensOf = async (userId: number): Promise<string[]> =>
    (await world.prisma.pushToken.findMany({ where: { userId } })).map((row) => row.token);

  const times = async (count: number, call: () => Promise<{ status: number }>): Promise<number[]> => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < count; attempt += 1) statuses.push((await call()).status);
    return statuses;
  };

  beforeAll(async () => {
    world = await bootWorld();
    http = request(world.app.getHttpServer());
    const municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyId = await createOperatingCompany(world.prisma, municipalityId, { commissionPct: 8 });
    const adminId = await createAdminUser(world.prisma, companyId);
    adminActor = { userId: adminId, authorization: adminAuth(world.jwt, adminId, companyId) };
    const operator = await world.prisma.user.create({
      data: { firstName: '_Fx', lastName: 'Operator', phone: `_fxo-${randomUUID()}`, role: 'operator', companyId },
    });
    operatorActor = {
      userId: operator.userId,
      authorization: tokenFor(world.jwt, 'operator', companyId, operator.userId),
    };
    const platform = await createPlatformAdmin(world.prisma, world.jwt, 'push-tokens');
    platformActor = { userId: platform.userId, authorization: platform.auth };
  });

  afterAll(async () => {
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  describe('roles: only the audiences of the two apps may keep a token', () => {
    it.each(['admin', 'operator', 'platform_admin'] as const)(
      '%s gets 403 on register and on revoke and no row is written',
      async (role) => {
        const actor = { admin: adminActor, operator: operatorActor, platform_admin: platformActor }[role];
        const token = newToken('forbidden');

        const registered = await register(actor, token);
        const revoked = await revoke(actor, token);

        expect(registered.status).toBe(403);
        expect(revoked.status).toBe(403);
        expect(await world.prisma.pushToken.findUnique({ where: { token } })).toBeNull();
        expect(await tokensOf(actor.userId)).toEqual([]);
      },
    );

    it('a passenger and a driver can register and revoke their own token, and the answer never carries the token', async () => {
      for (const actor of [await newPassenger(), await newDriver()]) {
        const token = newToken('ok');

        const registered = await register(actor, token);
        expect(registered.status).toBe(204);
        expect(registered.text).toBe('');
        expect(JSON.stringify(registered.headers)).not.toContain(token);
        expect(await tokensOf(actor.userId)).toContain(token);

        const revoked = await revoke(actor, token);
        expect(revoked.status).toBe(204);
        expect(await tokensOf(actor.userId)).not.toContain(token);
      }
    });

    it('without a session the answer is 401, and a native FCM token is a 400 that stores nothing', async () => {
      const passenger = await newPassenger();

      const anonymous = await http.post('/push-tokens').send({ token: newToken('anon'), platform: 'android' });
      const native = await register(passenger, 'fcm:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx');

      expect(anonymous.status).toBe(401);
      expect(native.status).toBe(400);
      expect(await tokensOf(passenger.userId)).toEqual([]);
    });
  });

  describe('a driver whose PIN change is pending can revoke but not register (PP-03)', () => {
    const newPendingDriver = async (): Promise<{ pending: Actor; personal: Actor }> => {
      const { driverId } = await createDriver(world.prisma, companyId, CENTER);
      return {
        personal: { userId: driverId, authorization: driverAuth(world.jwt, driverId, companyId) },
        pending: {
          userId: driverId,
          authorization: `Bearer ${pendingToken({ jwt: world.jwt, companyId }, driverId)}`,
        },
      };
    };

    it('the pending claim really blocks the driver routes, so the next answers are not an accident', async () => {
      const { pending } = await newPendingDriver();

      const blocked = await http.get('/driver/me').set('Authorization', pending.authorization);

      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ code: 'PIN_CHANGE_REQUIRED' });
    });

    it('revoke answers 204 and deletes the row of the driver, so logging out before creating the PIN leaves no token behind', async () => {
      const { personal, pending } = await newPendingDriver();
      const token = newToken('pending-revoke');
      expect((await register(personal, token)).status).toBe(204);

      const revoked = await revoke(pending, token);

      expect(revoked.status).toBe(204);
      expect(revoked.text).toBe('');
      expect(await tokensOf(pending.userId)).not.toContain(token);
    });

    it('register answers 403 PIN_CHANGE_REQUIRED and stores nothing', async () => {
      const { pending } = await newPendingDriver();
      const token = newToken('pending-register');

      const registered = await register(pending, token);

      expect(registered.status).toBe(403);
      expect(registered.body).toMatchObject({ code: 'PIN_CHANGE_REQUIRED' });
      expect(await world.prisma.pushToken.findUnique({ where: { token } })).toBeNull();
    });

    it("the exemption is still scoped to the owner: revoking another user's token is a silent no-op", async () => {
      const { pending } = await newPendingDriver();
      const owner = await newPassenger();
      const token = newToken('pending-foreign');
      expect((await register(owner, token)).status).toBe(204);

      const foreign = await revoke(pending, token);

      expect(foreign.status).toBe(204);
      expect(await tokensOf(owner.userId)).toContain(token);
    });

    it('revoke by a pending driver still spends its own ten a minute', async () => {
      const { pending } = await newPendingDriver();
      await times(PER_USER_LIMIT, () => revoke(pending, newToken('pending-limit')));

      expect((await revoke(pending, newToken('pending-limit'))).status).toBe(429);
    });
  });

  describe('limit: ten a minute per user, not per address', () => {
    it('two users behind the same address register ten times each; the eleventh of one is a 429 with Retry-After and the other is untouched until its own eleventh', async () => {
      const first = await newPassenger();
      const second = await newPassenger();
      const bystander = await newDriver();

      const interleaved: Array<[number, number]> = [];
      for (let attempt = 0; attempt < PER_USER_LIMIT; attempt += 1) {
        interleaved.push([(await register(first)).status, (await register(second)).status]);
      }

      expect(interleaved).toEqual(Array(PER_USER_LIMIT).fill([204, 204]));

      const eleventh = await register(first);
      expect(eleventh.status).toBe(429);
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
      expect((await register(second)).status).toBe(429);
      expect((await register(bystander)).status).toBe(204);
    });

    it('a spoofed forwarding header neither buys a user more registrations nor spends the budget of another', async () => {
      const exhausted = await newPassenger();
      const innocent = await newPassenger();
      await times(PER_USER_LIMIT, () => register(exhausted));

      const spoofed = await register(exhausted, newToken('spoof'), { 'X-Forwarded-For': '203.0.113.77' });
      const stillFine = await register(innocent, newToken('innocent'), { 'X-Forwarded-For': '203.0.113.77' });

      expect(spoofed.status).toBe(429);
      expect(stillFine.status).toBe(204);
    });

    it('revoke has its own ten a minute per user, apart from register', async () => {
      const driver = await newDriver();
      await times(PER_USER_LIMIT, () => register(driver));

      const revocations = await times(PER_USER_LIMIT, () => revoke(driver, newToken('rv')));

      expect(revocations).toEqual(Array(PER_USER_LIMIT).fill(204));
      expect((await revoke(driver, newToken('rv'))).status).toBe(429);
      expect((await register(driver)).status).toBe(429);
    });

    it('a 429 spends nothing: the rejected token is not stored', async () => {
      const passenger = await newPassenger();
      await times(PER_USER_LIMIT, () => register(passenger));
      const rejected = newToken('limited');

      const limited = await register(passenger, rejected);

      expect(limited.status).toBe(429);
      expect(await world.prisma.pushToken.findUnique({ where: { token: rejected } })).toBeNull();
    });
  });

  describe('ownership', () => {
    it("revoking another user's token is a silent no-op that leaves it with its owner", async () => {
      const owner = await newPassenger();
      const intruder = await newDriver();
      const token = newToken('own');
      expect((await register(owner, token)).status).toBe(204);

      const foreign = await revoke(intruder, token);

      expect(foreign.status).toBe(204);
      expect(await tokensOf(owner.userId)).toContain(token);
    });

    it('the sixth token of a user pushes out the oldest, and the same token registered by a second user moves to them alone', async () => {
      const first = await newPassenger();
      const second = await newPassenger();
      const shared = newToken('shared');
      const registered: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const token = newToken(`cap${index}`);
        registered.push(token);
        expect((await register(first, token)).status).toBe(204);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      expect((await register(first, shared)).status).toBe(204);
      expect(await tokensOf(first.userId)).toHaveLength(5);
      expect(await tokensOf(first.userId)).not.toContain(registered[0]);

      expect((await register(second, shared)).status).toBe(204);
      expect(await tokensOf(second.userId)).toEqual([shared]);
      expect(await tokensOf(first.userId)).not.toContain(shared);
    });
  });
});
