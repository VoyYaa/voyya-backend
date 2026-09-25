import type { PrismaClient } from '@prisma/client';
import { PushTokenPurgeService } from '../src/modules/assignment/push-token-purge.service';
import { PushTokenRepository } from '../src/modules/assignment/push-token.repository';
import type { EnvService } from '../src/config/env.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function fakeEnv(ttlDays: number): EnvService {
  return { get: (k: string) => (k === 'PUSH_TOKEN_TTL_DAYS' ? ttlDays : undefined) } as unknown as EnvService;
}

suite('PushTokenPurgeService against real Postgres, connected as app_voyya (ADR-022 §1.5, §10.5 item 10)', () => {
  let raw: PrismaClient;
  let prismaService: PrismaService;
  let repo: PushTokenRepository;
  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  let userSeq = 0;

  async function makeUser(): Promise<number> {
    userSeq += 1;
    const phone = `_push-purge-${runId}-${userSeq}`;
    const user = await raw.user.upsert({
      where: { phone },
      update: {},
      create: { firstName: '_PushPurge', lastName: `U${userSeq}`, phone, role: 'driver' },
    });
    return user.userId;
  }

  async function makeToken(userId: number, token: string, lastSeenAt: Date): Promise<void> {
    await raw.pushToken.create({
      data: { userId, token, platform: 'android', lastSeenAt },
    });
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
    prismaService = raw as unknown as PrismaService;
    repo = new PushTokenRepository(prismaService);
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  it('PUSH_TOKEN_TTL_DAYS = 0 disables the job entirely: a very stale token is left untouched', async () => {
    const userId = await makeUser();
    const token = `ExponentPushToken[purge-disabled-${runId}]`;
    await makeToken(userId, token, new Date(Date.now() - 200 * 24 * 60 * 60 * 1000));
    const service = new PushTokenPurgeService(prismaService, repo, fakeEnv(0));

    await service.purge();

    const row = await raw.pushToken.findUnique({ where: { token } });
    expect(row).not.toBeNull();
  });

  it('purges a token older than the TTL and leaves a recent one intact', async () => {
    const userId = await makeUser();
    const staleToken = `ExponentPushToken[purge-stale-${runId}]`;
    const freshToken = `ExponentPushToken[purge-fresh-${runId}]`;
    await makeToken(userId, staleToken, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    await makeToken(userId, freshToken, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    const service = new PushTokenPurgeService(prismaService, repo, fakeEnv(60));

    await service.purge();

    const stale = await raw.pushToken.findUnique({ where: { token: staleToken } });
    const fresh = await raw.pushToken.findUnique({ where: { token: freshToken } });
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();
  });

  it('a second concurrent purge() call in the same instant is blocked by the advisory lock', async () => {
    const userId = await makeUser();
    await makeToken(userId, `ExponentPushToken[purge-lock-${runId}]`, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    const service = new PushTokenPurgeService(prismaService, repo, fakeEnv(60));

    await expect(Promise.all([service.purge(), service.purge()])).resolves.toBeDefined();
  });
});
