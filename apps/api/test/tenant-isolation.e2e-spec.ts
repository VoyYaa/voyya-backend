import type { Prisma, PrismaClient } from '@prisma/client';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('Cross-tenant isolation (RLS FORCE) against real Postgres', () => {
  let prisma: PrismaClient;
  let isSuperuser = false;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();

    const rows = await prisma.$queryRawUnsafe<Array<{ super: boolean }>>(
      `SELECT current_setting('is_superuser') = 'on' AS super`,
    );
    isSuperuser = rows[0]?.super === true;

    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _rls_iso_test');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE _rls_iso_test (id int PRIMARY KEY, company_id int NOT NULL, data text NOT NULL)',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO _rls_iso_test (id, company_id, data) VALUES (1, 1, 'A'), (2, 2, 'B')`,
    );
    await prisma.$executeRawUnsafe('ALTER TABLE _rls_iso_test ENABLE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe('ALTER TABLE _rls_iso_test FORCE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe(
      `CREATE POLICY iso ON _rls_iso_test
         USING (company_id = current_setting('app.current_company', true)::int)
         WITH CHECK (company_id = current_setting('app.current_company', true)::int)`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _rls_iso_test');
      await prisma.$disconnect();
    }
  });

  async function asCompany<T>(
    companyId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  function skipIfSuper(): boolean {
    if (isSuperuser) {
      // eslint-disable-next-line no-console
      console.warn('PG_TEST_URL is superuser: RLS is bypassed. Use a non-owner role.');
    }
    return isSuperuser;
  }

  it('company A only sees ITS rows (not B)', async () => {
    if (skipIfSuper()) return;
    const rows = await asCompany(1, (tx) =>
      tx.$queryRawUnsafe<Array<{ company_id: number }>>('SELECT company_id FROM _rls_iso_test'),
    );
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.company_id === 1)).toBe(true);
  });

  it('company A CANNOT modify B rows (0 rows affected)', async () => {
    if (skipIfSuper()) return;
    const affected = await asCompany(1, (tx) =>
      tx.$executeRawUnsafe(`UPDATE _rls_iso_test SET data = 'x' WHERE company_id = 2`),
    );
    expect(affected).toBe(0);
  });

  it('symmetric: company B only sees ITS rows', async () => {
    if (skipIfSuper()) return;
    const rows = await asCompany(2, (tx) =>
      tx.$queryRawUnsafe<Array<{ company_id: number }>>('SELECT company_id FROM _rls_iso_test'),
    );
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.company_id === 2)).toBe(true);
  });
});
