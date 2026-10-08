import { PrismaClient } from '@prisma/client';
import { runWithAdvisoryLock } from '../src/infrastructure/prisma/advisory-lock';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const LOCK_KEY = 91_900;

suite('runWithAdvisoryLock against real Postgres', () => {
  let client: PrismaClient;
  let prisma: PrismaService;

  beforeAll(() => {
    client = new PrismaClient({ datasources: { db: { url } } });
    prisma = client as unknown as PrismaService;
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it('holds the lock for the whole duration of the work, so a concurrent caller is excluded', async () => {
    let releaseWork: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const first = runWithAdvisoryLock(prisma, LOCK_KEY, async () => {
      signalStarted();
      await workGate;
    });
    await started;

    let secondRan = false;
    const second = await runWithAdvisoryLock(prisma, LOCK_KEY, async () => {
      secondRan = true;
    });

    expect(second).toBe(false);
    expect(secondRan).toBe(false);

    releaseWork();
    await expect(first).resolves.toBe(true);
  });

  it('releases the lock once the work finishes', async () => {
    await expect(runWithAdvisoryLock(prisma, LOCK_KEY, async () => undefined)).resolves.toBe(true);
    await expect(runWithAdvisoryLock(prisma, LOCK_KEY, async () => undefined)).resolves.toBe(true);
  });

  it('propagates the error from the work and still releases the lock', async () => {
    await expect(
      runWithAdvisoryLock(prisma, LOCK_KEY, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    await expect(runWithAdvisoryLock(prisma, LOCK_KEY, async () => undefined)).resolves.toBe(true);
  });
});
