import type { Prisma } from '@prisma/client';
import { withSavepoint } from './savepoint';

function fakeTx() {
  const statements: string[] = [];
  const tx = {
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      statements.push(sql);
      return 0;
    }),
  } as unknown as Prisma.TransactionClient;
  return { tx, statements };
}

describe('withSavepoint', () => {
  it('opens and releases the savepoint around successful work and returns its result', async () => {
    const { tx, statements } = fakeTx();
    const result = await withSavepoint(tx, 'purge_company_7', async () => 42);
    expect(result).toBe(42);
    expect(statements).toEqual(['SAVEPOINT purge_company_7', 'RELEASE SAVEPOINT purge_company_7']);
  });

  it('rolls back to the savepoint and rethrows when the work fails', async () => {
    const { tx, statements } = fakeTx();
    await expect(
      withSavepoint(tx, 'purge_company_7', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(statements).toEqual(['SAVEPOINT purge_company_7', 'ROLLBACK TO SAVEPOINT purge_company_7']);
  });

  it.each(['', 'Bad Name', 'x; DROP TABLE y', '1abc'])('rejects the unsafe name %p', async (name) => {
    const { tx, statements } = fakeTx();
    await expect(withSavepoint(tx, name, async () => 1)).rejects.toThrow('Invalid savepoint name');
    expect(statements).toEqual([]);
  });
});
