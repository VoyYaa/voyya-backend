import { Prisma } from '@prisma/client';

const PRISMA_UNIQUE_CONSTRAINT = 'P2002';
const PRISMA_RAW_QUERY_FAILED = 'P2010';
const POSTGRES_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === PRISMA_UNIQUE_CONSTRAINT) return true;
  return (
    error.code === PRISMA_RAW_QUERY_FAILED &&
    (error.meta as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION
  );
}
