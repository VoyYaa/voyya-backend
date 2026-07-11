// =============================================================================
// Toma única atómica contra POSTGRES REAL (ADR-002 · HU-08).
// Se ejecuta SÓLO si PG_TEST_URL está definida (CI con servicio Postgres); si no,
// se omite (no requiere Docker en local). Valida el patrón EXACTO del ADR:
//   UPDATE ... SET estado='en_servicio' WHERE estado='disponible' RETURNING *  →
//   exactamente una de N transacciones concurrentes obtiene la fila.
// =============================================================================

import type { PrismaClient } from '@prisma/client';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('TOMA ÚNICA ATÓMICA contra Postgres real', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();
    // Tabla regular (visible por todas las conexiones del pool), no temporal.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS _toma_unica_test (id int PRIMARY KEY, estado text NOT NULL)
    `);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS _toma_unica_test');
      await prisma.$disconnect();
    }
  });

  it('N transacciones concurrentes → exactamente 1 gana el UPDATE condicional', async () => {
    const N = 50;
    await prisma.$executeRawUnsafe('TRUNCATE _toma_unica_test');
    await prisma.$executeRawUnsafe(`INSERT INTO _toma_unica_test (id, estado) VALUES (1, 'disponible')`);

    const intentos = Array.from({ length: N }, () =>
      prisma.$transaction(async (tx) => {
        const filas = await tx.$queryRawUnsafe<Array<{ id: number }>>(
          `UPDATE _toma_unica_test SET estado='en_servicio'
             WHERE id=1 AND estado='disponible' RETURNING id`,
        );
        return filas.length; // 1 = ganó, 0 = perdió
      }),
    );

    const resultados = await Promise.all(intentos);
    const ganadores = resultados.filter((n) => n === 1);
    expect(ganadores).toHaveLength(1);
  });
});
