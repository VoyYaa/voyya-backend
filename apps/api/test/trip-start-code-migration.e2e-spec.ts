import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = ownerUrl ? describe : describe.skip;

const TIMEOUT_MS = 300_000;
const PRISMA_DIR = resolve(__dirname, '..', 'prisma');
const API_DIR = resolve(__dirname, '..');
const THIS_MIGRATION = '20261009130000_trip_start_code';
const PRISMA_CLI = require.resolve('prisma/build/index.js');

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

function stageBeforeThisCycle(): string {
  const staged = mkdtempSync(join(tmpdir(), 'voyya-before-start-code-'));
  const migrations = join(staged, 'migrations');
  mkdirSync(migrations);
  cpSync(join(PRISMA_DIR, 'schema.prisma'), join(staged, 'schema.prisma'));
  cpSync(join(PRISMA_DIR, 'migrations', 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
  for (const name of readdirSync(join(PRISMA_DIR, 'migrations'))) {
    if (/^\d{14}_/.test(name) && name < THIS_MIGRATION) {
      cpSync(join(PRISMA_DIR, 'migrations', name), join(migrations, name), { recursive: true });
    }
  }
  return staged;
}

interface TripState {
  trip_request_id: number;
  status: string;
  start_code: string | null;
  start_code_exempt: boolean;
  start_code_failed_attempts: number;
}

const TRIPS = [
  { id: 7001, passenger: 7101, status: 'assigned' },
  { id: 7002, passenger: 7102, status: 'driver_en_route' },
  { id: 7003, passenger: 7103, status: 'pending_assignment' },
  { id: 7004, passenger: 7104, status: 'in_progress' },
  { id: 7005, passenger: 7105, status: 'completed' },
  { id: 7006, passenger: 7106, status: 'cancelled_by_passenger' },
] as const;

suite('20261009130000_trip_start_code over a database with open trips and explicit ids (REL-004)', () => {
  const scratchName = `start_code_mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: PrismaClient;
  let scratch: PrismaClient;
  let scratchUrl: string;
  let stagedDir: string;
  let rowCountsBefore: Map<string, number>;

  async function rowCounts(): Promise<Map<string, number>> {
    const tables = await scratch.$queryRawUnsafe<Array<{ schema: string; name: string }>>(`
      SELECT schemaname AS schema, tablename AS name FROM pg_tables
       WHERE schemaname IN ('auth', 'tenancy', 'users', 'fleet', 'trips', 'assignment', 'admin')`);
    const counts = new Map<string, number>();
    for (const table of tables) {
      const rows = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${table.schema}"."${table.name}"`,
      );
      counts.set(`${table.schema}.${table.name}`, Number(rows[0]?.n ?? 0));
    }
    return counts;
  }

  async function states(): Promise<TripState[]> {
    return scratch.$queryRawUnsafe<TripState[]>(`
      SELECT trip_request_id, status::text AS status, start_code, start_code_exempt,
             start_code_failed_attempts::int AS start_code_failed_attempts
        FROM trips.trip_request WHERE trip_request_id >= 7001 ORDER BY trip_request_id`);
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: withDatabase(ownerUrl as string, 'postgres') } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE ${scratchName}`);
    scratchUrl = withDatabase(ownerUrl as string, scratchName);
    stagedDir = stageBeforeThisCycle();
    const deploy = prisma(['migrate', 'deploy', '--schema', join(stagedDir, 'schema.prisma')], scratchUrl);
    expect(deploy.status).toBe(0);
    expect(deploy.output).not.toContain(THIS_MIGRATION);

    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
    for (const trip of TRIPS) {
      await scratch.$executeRawUnsafe(`
        INSERT INTO auth."user" (user_id, first_name, last_name, phone, role)
        VALUES (${trip.passenger}, 'Pasajero', '${trip.id}', 'mig-${trip.id}', 'passenger')`);
      await scratch.$executeRawUnsafe(`INSERT INTO users.passenger (passenger_id) VALUES (${trip.passenger})`);
      await scratch.$executeRawUnsafe(`
        INSERT INTO trips.trip_request
          (trip_request_id, passenger_id, municipality_id, fare, commission, status, pickup_address, dropoff_address,
           pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, updated_at)
        VALUES (${trip.id}, ${trip.passenger}, 1, 8500, 0, '${trip.status}', 'Parque', 'Hospital',
                6.96, -75.41, 6.97, -75.42, now())`);
    }
    rowCountsBefore = await rowCounts();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await scratch?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.$disconnect();
    }
    if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
  });

  it('starts from the production shape: open trips with explicit ids and columns that do not exist yet', async () => {
    const columns = await scratch.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'trips' AND table_name = 'trip_request' AND column_name = 'start_code'`,
    );
    const open = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM trips.trip_request WHERE status IN ('assigned', 'driver_en_route')`,
    );

    expect(columns).toHaveLength(0);
    expect(Number(open[0]?.n)).toBe(2);
  });

  it('db:release applies only this migration and succeeds', async () => {
    const deploy = prisma(['migrate', 'deploy', '--schema', join(PRISMA_DIR, 'schema.prisma')], scratchUrl);

    expect(deploy.status).toBe(0);
    expect(deploy.output).toContain(THIS_MIGRATION);
    expect(deploy.output).not.toContain('20261009120000_trip_company_scope');
    expect(deploy.output).not.toContain('20260711000000_init');
    const last = await scratch.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
      `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1`,
    );
    expect(last[0]?.migration_name).toBe(THIS_MIGRATION);
    expect(last[0]?.finished_at).not.toBeNull();
  }, TIMEOUT_MS);

  it('the trips that were open at the time are exempt and carry no code; the rest are not exempt', async () => {
    const trips = await states();

    expect(trips.map((t) => [t.trip_request_id, t.start_code_exempt, t.start_code])).toEqual([
      [7001, true, null],
      [7002, true, null],
      [7003, false, null],
      [7004, false, null],
      [7005, false, null],
      [7006, false, null],
    ]);
    expect(trips.every((t) => t.start_code_failed_attempts === 0)).toBe(true);
  });

  it('inserts no rows into any existing table', async () => {
    const after = await rowCounts();

    for (const [table, before] of rowCountsBefore) expect([table, after.get(table)]).toEqual([table, before]);
  });

  it('an exempt trip that is reopened and taken again asks for a code from then on', async () => {
    await scratch.$executeRawUnsafe(`UPDATE trips.trip_request SET status = 'pending_assignment' WHERE trip_request_id = 7001`);
    await scratch.$executeRawUnsafe(`UPDATE trips.trip_request SET status = 'assigned' WHERE trip_request_id = 7001`);

    const row = (await states()).find((t) => t.trip_request_id === 7001);

    expect(row?.start_code_exempt).toBe(false);
    expect(row?.start_code).toMatch(/^[0-9]{4}$/);
  });

  it('a trip inserted after the migration with the sequence untouched gets its own id and a code', async () => {
    await scratch.$executeRawUnsafe(`
      INSERT INTO trips.trip_request
        (passenger_id, municipality_id, fare, commission, status, pickup_address, dropoff_address,
         pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, updated_at)
      VALUES (7103, 1, 8500, 0, 'assigned', 'Parque', 'Hospital', 6.96, -75.41, 6.97, -75.42, now())`);

    const rows = await scratch.$queryRawUnsafe<Array<{ start_code: string | null; start_code_exempt: boolean }>>(
      `SELECT start_code, start_code_exempt FROM trips.trip_request WHERE passenger_id = 7103 AND status = 'assigned'`,
    );

    expect(rows[0]?.start_code).toMatch(/^[0-9]{4}$/);
    expect(rows[0]?.start_code_exempt).toBe(false);
  });
});
