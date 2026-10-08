import type { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';

const LOCK_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

export async function runWithAdvisoryLock(
  prisma: PrismaService,
  lockKey: number,
  work: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked
      `;
      if (rows[0]?.locked !== true) return false;
      await work(tx);
      return true;
    },
    { timeout: LOCK_TRANSACTION_TIMEOUT_MS },
  );
}
