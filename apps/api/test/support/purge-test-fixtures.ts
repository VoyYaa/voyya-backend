import { type Prisma, PrismaClient } from '@prisma/client';

interface ReferencingKey {
  child: string;
  childColumns: string[];
  parentColumns: string[];
}

const SAFE_PREFIX = /^[A-Za-z0-9_-]+$/;
const NO_TENANT = '0';
const USER_TABLE = 'auth."user"';
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  'admin.settlement_remittance',
  'admin.settlement_export',
  'auth.consent_record',
  'trips.municipality_fare',
  'admin.municipality_operational_params',
  'tenancy.company_commission',
  USER_TABLE,
]);
const SAFE_DANE_PREFIX = /^00[0-9]*$/;
const PURGE_TRANSACTION_TIMEOUT_MS = 60_000;
const REVERSALS_FIRST = "kind = 'reversal'";

type OwnerDelete = (table: string, where: string) => Promise<void>;

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
  ownerDelete: OwnerDelete,
  keepRoot = false,
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
      ownerDelete,
    );
  }
  if (keepRoot) return;
  if (APPEND_ONLY_TABLES.has(table)) {
    await ownerDelete(table, where);
    return;
  }
  await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`);
}

async function withTenant<T>(
  prisma: PrismaClient,
  companyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${companyId}, true)`;
      return fn(tx);
    },
    { timeout: PURGE_TRANSACTION_TIMEOUT_MS, maxWait: PURGE_TRANSACTION_TIMEOUT_MS },
  );
}

interface OwnerSession {
  delete: OwnerDelete;
  close: () => Promise<void>;
}

function createOwnerSession(): OwnerSession {
  const url = process.env.PG_TEST_OWNER_URL;
  let client: PrismaClient | null = null;
  return {
    delete: async (table, where) => {
      if (!url) return;
      client ??= new PrismaClient({ datasourceUrl: url });
      if (table === 'admin.settlement_remittance') {
        await client.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE ${REVERSALS_FIRST} AND (${where})`,
        );
      }
      await client.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`);
    },
    close: async () => {
      if (client) await client.$disconnect();
    },
  };
}

export interface PurgeOptions {
  daneCodePrefix?: string;
}

export async function purgeMunicipalitiesByNamePrefix(
  prisma: PrismaClient,
  namePrefix: string,
  options: PurgeOptions = {},
): Promise<void> {
  if (!SAFE_PREFIX.test(namePrefix) || !namePrefix.startsWith('_')) {
    throw new Error(`Unsafe fixture prefix: ${namePrefix}`);
  }
  if (options.daneCodePrefix !== undefined && !SAFE_DANE_PREFIX.test(options.daneCodePrefix)) {
    throw new Error(`Unsafe DANE code prefix (it must start with the reserved 00): ${options.daneCodePrefix}`);
  }
  const pattern = `${namePrefix}%`;
  const danePattern = options.daneCodePrefix === undefined ? null : `${options.daneCodePrefix}%`;
  const owner = createOwnerSession();
  try {
    await purgeWith(prisma, pattern, danePattern, owner.delete);
  } finally {
    await owner.close();
  }
}

async function purgeWith(
  prisma: PrismaClient,
  pattern: string,
  danePattern: string | null,
  ownerDelete: OwnerDelete,
): Promise<void> {
  const municipalityScope =
    danePattern === null
      ? `name LIKE '${pattern}'`
      : `name LIKE '${pattern}' OR dane_code LIKE '${danePattern}'`;
  const municipalityIds = `SELECT municipality_id FROM tenancy.municipality WHERE ${municipalityScope}`;
  await ownerDelete(
    'assignment.assignment',
    `trip_request_id IN (SELECT trip_request_id FROM trips.trip_request WHERE municipality_id IN (${municipalityIds}))`,
  );
  await ownerDelete('trips.trip_request', `municipality_id IN (${municipalityIds})`);

  const companies = await prisma.$queryRaw<Array<{ company_id: number }>>`
    SELECT c.company_id
      FROM tenancy.company c
      JOIN tenancy.municipality m ON m.municipality_id = c.municipality_id
     WHERE m.name LIKE ${pattern}
        OR (${danePattern}::text IS NOT NULL AND m.dane_code LIKE ${danePattern})
  `;
  for (const { company_id: companyId } of companies) {
    const userScope = `company_id = ${Number(companyId)}`;
    await withTenant(prisma, String(companyId), (tx) =>
      deleteWhere(tx, USER_TABLE, userScope, new Set(), ownerDelete, true),
    );
    await ownerDelete(USER_TABLE, userScope);
    await withTenant(prisma, String(companyId), (tx) =>
      deleteWhere(tx, 'tenancy.company', userScope, new Set(), ownerDelete),
    );
  }

  await withTenant(prisma, NO_TENANT, (tx) =>
    deleteWhere(tx, 'tenancy.municipality', municipalityScope, new Set(), ownerDelete),
  );
}
