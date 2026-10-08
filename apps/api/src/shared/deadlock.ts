import { Prisma } from '@prisma/client';

const POSTGRES_DEADLOCK = '40P01';
const PRISMA_TRANSACTION_CONFLICT = 'P2034';
const PRISMA_RAW_QUERY_FAILED = 'P2010';

export function isDeadlock(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === PRISMA_TRANSACTION_CONFLICT) return true;
  return (
    error.code === PRISMA_RAW_QUERY_FAILED &&
    (error.meta as { code?: string } | undefined)?.code === POSTGRES_DEADLOCK
  );
}

export async function retryOnDeadlock<T>(operation: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0 && isDeadlock(error)) return retryOnDeadlock(operation, retries - 1);
    throw error;
  }
}
