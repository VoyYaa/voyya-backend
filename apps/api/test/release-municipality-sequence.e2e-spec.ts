import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = ownerUrl ? describe : describe.skip;

const TIMEOUT_MS = 300_000;
const PRISMA_DIR = resolve(__dirname, '..', 'prisma');
const API_DIR = resolve(__dirname, '..');
const FIRST_CATALOG_MIGRATION = '20261009100000_municipality_dane_catalog';
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const CATALOG_ROW_COUNT = 1122;

function withDatabase(raw: string, database: string): string {
  const parsed = new URL(raw);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function prisma(args: string[], databaseUrl: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function applyRlsSql(databaseUrl: string, schemaPath: string): void {
  const result = prisma(
    ['db', 'execute', '--file', join(PRISMA_DIR, 'sql', '00_postgis_rls.sql'), '--schema', schemaPath],
    databaseUrl,
  );
  expect(result.output).toContain('Script executed successfully');
}

function stageMainSchema(): string {
  const staged = mkdtempSync(join(tmpdir(), 'voyya-main-schema-'));
  const migrations = join(staged, 'migrations');
  mkdirSync(migrations);
  cpSync(join(PRISMA_DIR, 'schema.prisma'), join(staged, 'schema.prisma'));
  cpSync(join(PRISMA_DIR, 'migrations', 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
  for (const name of readdirSync(join(PRISMA_DIR, 'migrations'))) {
    if (/^\d{14}_/.test(name) && name < FIRST_CATALOG_MIGRATION) {
      cpSync(join(PRISMA_DIR, 'migrations', name), join(migrations, name), { recursive: true });
    }
  }
  return staged;
}

suite('db:release over a database whose municipality sequence lags behind its rows', () => {
  const scratchName = `release_seq_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: PrismaClient;
  let scratch: PrismaClient;
  let scratchUrl: string;
  let stagedDir: string;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: withDatabase(ownerUrl as string, 'postgres') } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE ${scratchName}`);
    scratchUrl = withDatabase(ownerUrl as string, scratchName);
    stagedDir = stageMainSchema();
    const stagedSchema = join(stagedDir, 'schema.prisma');
    const deploy = prisma(['migrate', 'deploy', '--schema', stagedSchema], scratchUrl);
    expect(deploy.status).toBe(0);
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
    await scratch.$executeRawUnsafe(`
      INSERT INTO tenancy.municipality (municipality_id, name, department, coverage_polygon, status)
      VALUES
        (1, 'Yarumal', 'Antioquia', '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]}'::jsonb, 'active'),
        (2, 'Santa Rosa de Osos', 'Antioquia', '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]}'::jsonb, 'active')
    `);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await scratch?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.$disconnect();
    }
    if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
  });

  it('starts from the production shape: explicit ids 1 and 2 and a sequence that has not advanced', async () => {
    const rows = await scratch.$queryRawUnsafe<{ is_called: boolean; last_value: bigint }[]>(
      `SELECT is_called, last_value FROM tenancy.municipality_municipality_id_seq`,
    );

    expect(rows[0]?.is_called).toBe(false);
    expect(Number(rows[0]?.last_value)).toBe(1);
  });

  it('db:release completes and loads the 1,122-row DANE catalog keeping the existing ids', async () => {
    const schemaPath = join(PRISMA_DIR, 'schema.prisma');
    const deploy = prisma(['migrate', 'deploy', '--schema', schemaPath], scratchUrl);
    expect(deploy.output).not.toContain('23505');
    expect(deploy.status).toBe(0);
    applyRlsSql(scratchUrl, schemaPath);

    const [{ total }] = await scratch.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM tenancy.municipality WHERE dane_code IS NOT NULL`,
    );
    expect(Number(total)).toBe(CATALOG_ROW_COUNT);

    const named = await scratch.$queryRawUnsafe<{ municipality_id: number; dane_code: string; status: string }[]>(
      `SELECT municipality_id, dane_code, status FROM tenancy.municipality
        WHERE municipality_id IN (1, 2) ORDER BY municipality_id`,
    );
    expect(named).toEqual([
      { municipality_id: 1, dane_code: '05887', status: 'active' },
      { municipality_id: 2, dane_code: '05686', status: 'active' },
    ]);
  }, TIMEOUT_MS);
});
