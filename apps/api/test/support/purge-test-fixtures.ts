import type { Prisma, PrismaClient } from '@prisma/client';

interface ReferencingKey {
  child: string;
  childColumns: string[];
  parentColumns: string[];
}

const SAFE_PREFIX = /^[A-Za-z0-9_-]+$/;
const NO_TENANT = '0';

const keysByTable = new Map<string, ReferencingKey[]>();

async function referencingKeys(tx: Prisma.TransactionClient, table: string): Promise<ReferencingKey[]> {
  const cached = keysByTable.get(table);
  if (cached) return cached;
  const rows = await tx.$queryRawUnsafe<
    Array<{ child: string; child_columns: string[]; parent_columns: string[] }>
  >(
    `SELECT c.conrelid::regclass::text AS child,
            (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
            (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.confrelid = $1::regclass
        AND c.confdeltype IN ('a', 'r', 'c')`,
    table,
  );
  const keys = rows.map((row) => ({
    child: row.child,
    childColumns: row.child_columns,
    parentColumns: row.parent_columns,
  }));
  keysByTable.set(table, keys);
  return keys;
}

async function deleteWhere(
  tx: Prisma.TransactionClient,
  table: string,
  where: string,
  path: ReadonlySet<string>,
): Promise<void> {
  const nextPath = new Set([...path, table]);
  for (const key of await referencingKeys(tx, table)) {
    if (nextPath.has(key.child)) continue;
    const childColumns = key.childColumns.join(', ');
    const parentColumns = key.parentColumns.join(', ');
    await deleteWhere(
      tx,
      key.child,
      `(${childColumns}) IN (SELECT ${parentColumns} FROM ${table} WHERE ${where})`,
      nextPath,
    );
  }
  await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`);
}

async function withTenant<T>(
  prisma: PrismaClient,
  companyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_company', ${companyId}, true)`;
    return fn(tx);
  });
}

export async function purgeMunicipalitiesByNamePrefix(
  prisma: PrismaClient,
  namePrefix: string,
): Promise<void> {
  if (!SAFE_PREFIX.test(namePrefix) || !namePrefix.startsWith('_')) {
    throw new Error(`Unsafe fixture prefix: ${namePrefix}`);
  }
  const pattern = `${namePrefix}%`;

  const companies = await prisma.$queryRaw<Array<{ company_id: number }>>`
    SELECT c.company_id
      FROM tenancy.company c
      JOIN tenancy.municipality m ON m.municipality_id = c.municipality_id
     WHERE m.name LIKE ${pattern}
  `;
  for (const { company_id: companyId } of companies) {
    await withTenant(prisma, String(companyId), (tx) =>
      deleteWhere(tx, 'tenancy.company', `company_id = ${Number(companyId)}`, new Set()),
    );
  }

  await withTenant(prisma, NO_TENANT, (tx) =>
    deleteWhere(tx, 'tenancy.municipality', `name LIKE '${pattern}'`, new Set()),
  );
}
