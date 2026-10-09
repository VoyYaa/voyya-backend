import { Prisma } from '@prisma/client';
import { isDeadlock, retryOnDeadlock } from './deadlock';

function prismaError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });
}

describe('isDeadlock (MD-16)', () => {
  it('recognizes the Postgres 40P01 inside a raw query failure', () => {
    expect(isDeadlock(prismaError('P2010', { code: '40P01' }))).toBe(true);
  });

  it('recognizes the Prisma transaction conflict P2034', () => {
    expect(isDeadlock(prismaError('P2034'))).toBe(true);
  });

  it('does not take a unique violation or an unrelated error for a deadlock', () => {
    expect(isDeadlock(prismaError('P2010', { code: '23505' }))).toBe(false);
    expect(isDeadlock(prismaError('P2002'))).toBe(false);
    expect(isDeadlock(new Error('40P01'))).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });
});

describe('retryOnDeadlock', () => {
  it('retries once after a deadlock and returns the second result', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(prismaError('P2010', { code: '40P01' }))
      .mockResolvedValueOnce('ok');

    await expect(retryOnDeadlock(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries and rethrows the deadlock', async () => {
    const deadlock = prismaError('P2034');
    const operation = jest.fn().mockRejectedValue(deadlock);

    await expect(retryOnDeadlock(operation, 1)).rejects.toBe(deadlock);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('never retries another error', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('other'));

    await expect(retryOnDeadlock(operation)).rejects.toThrow('other');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
