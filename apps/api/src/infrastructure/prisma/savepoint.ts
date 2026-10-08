import type { Prisma } from '@prisma/client';

const SAVEPOINT_NAME = /^[a-z_][a-z0-9_]*$/;

export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!SAVEPOINT_NAME.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}
