// =============================================================================
// M-1 · Aislamiento cross-tenant (RLS) contra POSTGRES REAL.
// Gated por PG_TEST_URL (como el e2e de concurrencia); se omite sin él (no requiere
// Docker en local). Valida el patrón EXACTO de RLS del proyecto (ENABLE + FORCE +
// policy USING/WITH CHECK con current_setting('app.current_empresa')): la empresa A
// no ve ni modifica filas de la empresa B, y viceversa.
//
// Requisitos del rol de PG_TEST_URL: NO superusuario (si lo es, la RLS se ignora →
// el test lo detecta y se omite con aviso, ver C-2) y con permiso CREATE en public.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('Aislamiento cross-tenant (RLS FORCE) contra Postgres real', () => {
  let prisma: PrismaClient;
  let esSuperusuario = false;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();

    const rows = await prisma.$queryRawUnsafe<Array<{ super: boolean }>>(
      `SELECT current_setting('is_superuser') = 'on' AS super`,
    );
    esSuperusuario = rows[0]?.super === true;

    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _rls_iso_test');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE _rls_iso_test (id int PRIMARY KEY, id_empresa int NOT NULL, dato text NOT NULL)',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO _rls_iso_test (id, id_empresa, dato) VALUES (1, 1, 'A'), (2, 2, 'B')`,
    );
    await prisma.$executeRawUnsafe('ALTER TABLE _rls_iso_test ENABLE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe('ALTER TABLE _rls_iso_test FORCE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe(
      `CREATE POLICY iso ON _rls_iso_test
         USING (id_empresa = current_setting('app.current_empresa', true)::int)
         WITH CHECK (id_empresa = current_setting('app.current_empresa', true)::int)`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _rls_iso_test');
      await prisma.$disconnect();
    }
  });

  /** Ejecuta `fn` con el tenant fijado (mismo patrón que PrismaService.runInTenant). */
  async function comoEmpresa<T>(
    idEmpresa: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_empresa', ${String(idEmpresa)}, true)`;
      return fn(tx);
    });
  }

  function omitirSiSuper(): boolean {
    if (esSuperusuario) {
      // eslint-disable-next-line no-console
      console.warn('PG_TEST_URL es superusuario: la RLS se ignora. Usa un rol no-dueño (C-2).');
    }
    return esSuperusuario;
  }

  it('empresa A solo ve SUS filas (no las de B)', async () => {
    if (omitirSiSuper()) return;
    const filas = await comoEmpresa(1, (tx) =>
      tx.$queryRawUnsafe<Array<{ id_empresa: number }>>('SELECT id_empresa FROM _rls_iso_test'),
    );
    expect(filas).toHaveLength(1);
    expect(filas.every((f) => f.id_empresa === 1)).toBe(true);
  });

  it('empresa A NO puede modificar filas de B (0 filas afectadas)', async () => {
    if (omitirSiSuper()) return;
    const afectadas = await comoEmpresa(1, (tx) =>
      tx.$executeRawUnsafe(`UPDATE _rls_iso_test SET dato = 'x' WHERE id_empresa = 2`),
    );
    expect(afectadas).toBe(0);
  });

  it('simétrico: empresa B solo ve SUS filas', async () => {
    if (omitirSiSuper()) return;
    const filas = await comoEmpresa(2, (tx) =>
      tx.$queryRawUnsafe<Array<{ id_empresa: number }>>('SELECT id_empresa FROM _rls_iso_test'),
    );
    expect(filas).toHaveLength(1);
    expect(filas.every((f) => f.id_empresa === 2)).toBe(true);
  });
});
