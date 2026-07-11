import type { PrismaClient } from '@prisma/client';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('ATOMIC SINGLE-TAKE against real Postgres', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS _single_take_test (id int PRIMARY KEY, status text NOT NULL)
    `);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _single_take_test');
      await prisma.$disconnect();
    }
  });

  it('N concurrent transactions -> exactly 1 wins the conditional UPDATE', async () => {
    const N = 50;
    await prisma.$executeRawUnsafe('TRUNCATE _single_take_test');
    await prisma.$executeRawUnsafe(`INSERT INTO _single_take_test (id, status) VALUES (1, 'available')`);

    const attempts = Array.from({ length: N }, () =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: number }>>(
          `UPDATE _single_take_test SET status='on_trip'
             WHERE id=1 AND status='available' RETURNING id`,
        );
        return rows.length;
      }),
    );

    const results = await Promise.all(attempts);
    const winners = results.filter((n) => n === 1);
    expect(winners).toHaveLength(1);
  });
});
