import { Prisma } from '@prisma/client';
import { isUniqueViolation } from './unique-violation';

function prismaError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });
}

describe('isUniqueViolation', () => {
  it('recognizes the Prisma unique constraint error P2002', () => {
    expect(isUniqueViolation(prismaError('P2002'))).toBe(true);
  });

  it('recognizes the Postgres 23505 inside a raw query failure', () => {
    expect(isUniqueViolation(prismaError('P2010', { code: '23505' }))).toBe(true);
  });

  it('does not take a deadlock or an unrelated error for a unique violation', () => {
    expect(isUniqueViolation(prismaError('P2010', { code: '40P01' }))).toBe(false);
    expect(isUniqueViolation(new Error('23505'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
