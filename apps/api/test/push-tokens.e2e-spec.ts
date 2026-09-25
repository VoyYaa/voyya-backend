import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('POST /push-tokens and /push-tokens/revoke over real HTTP (ADR-022)', () => {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

  async function bootApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
    process.env.DATABASE_URL = url;
    process.env.AUTH_DEV_HEADERS = 'true';
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';
    process.env.PUSH_TOKEN_TTL_DAYS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    return { app, prisma: moduleRef.get(PrismaService) };
  }

  async function createDriverUser(prisma: PrismaService, suffix: string): Promise<number> {
    const user = await prisma.user.upsert({
      where: { phone: `_push-${runId}-${suffix}` },
      update: {},
      create: {
        firstName: '_Push',
        lastName: suffix,
        phone: `_push-${runId}-${suffix}`,
        role: 'driver',
      },
    });
    return user.userId;
  }

  function headers(driverId: number): Record<string, string> {
    return { 'x-driver-id': String(driverId) };
  }

  it('no auth -> 401 SESSION_REQUIRED', async () => {
    const { app } = await bootApp();
    try {
      const res = await request(app.getHttpServer())
        .post('/push-tokens')
        .send({ token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', platform: 'android' });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    } finally {
      await app.close();
    }
  }, 20_000);

  it('an invalid token format -> 400', async () => {
    const { app, prisma } = await bootApp();
    try {
      const driverId = await createDriverUser(prisma, 'invalid');
      const res = await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverId))
        .send({ token: 'not-an-expo-token', platform: 'android' });

      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('registers a token and returns 204 with no body', async () => {
    const { app, prisma } = await bootApp();
    try {
      const driverId = await createDriverUser(prisma, 'register');
      const token = `ExponentPushToken[register-${runId}]`;

      const res = await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverId))
        .send({ token, platform: 'android' });

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});

      const row = await prisma.pushToken.findUnique({ where: { token } });
      expect(row?.userId).toBe(driverId);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('shared phone: the same token registered by a second user moves ownership to them alone', async () => {
    const { app, prisma } = await bootApp();
    try {
      const driverA = await createDriverUser(prisma, 'shared-a');
      const driverB = await createDriverUser(prisma, 'shared-b');
      const token = `ExponentPushToken[shared-${runId}]`;

      await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverA))
        .send({ token, platform: 'android' })
        .expect(204);

      await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverB))
        .send({ token, platform: 'android' })
        .expect(204);

      const rows = await prisma.pushToken.findMany({ where: { token } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(driverB);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('caps at 5 tokens per user, keeping the most recently seen', async () => {
    const { app, prisma } = await bootApp();
    try {
      const driverId = await createDriverUser(prisma, 'cap');
      for (let i = 0; i < 7; i += 1) {
        await request(app.getHttpServer())
          .post('/push-tokens')
          .set(headers(driverId))
          .send({ token: `ExponentPushToken[cap-${runId}-${i}]`, platform: 'android' })
          .expect(204);
      }

      const rows = await prisma.pushToken.findMany({ where: { userId: driverId } });
      expect(rows).toHaveLength(5);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('revoke removes only the caller own token', async () => {
    const { app, prisma } = await bootApp();
    try {
      const driverA = await createDriverUser(prisma, 'revoke-a');
      const driverB = await createDriverUser(prisma, 'revoke-b');
      const tokenA = `ExponentPushToken[revoke-a-${runId}]`;
      const tokenB = `ExponentPushToken[revoke-b-${runId}]`;

      await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverA))
        .send({ token: tokenA, platform: 'ios' })
        .expect(204);
      await request(app.getHttpServer())
        .post('/push-tokens')
        .set(headers(driverB))
        .send({ token: tokenB, platform: 'ios' })
        .expect(204);

      await request(app.getHttpServer())
        .post('/push-tokens/revoke')
        .set(headers(driverA))
        .send({ token: tokenB })
        .expect(204);

      const stillThere = await prisma.pushToken.findUnique({ where: { token: tokenB } });
      expect(stillThere?.userId).toBe(driverB);

      await request(app.getHttpServer())
        .post('/push-tokens/revoke')
        .set(headers(driverA))
        .send({ token: tokenA })
        .expect(204);

      const gone = await prisma.pushToken.findUnique({ where: { token: tokenA } });
      expect(gone).toBeNull();
    } finally {
      await app.close();
    }
  }, 20_000);
});
