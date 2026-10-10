import { PrismaClient } from '@prisma/client';
import type { EnvService } from '../src/config/env.service';
import { DatabasePreflightService } from '../src/infrastructure/prisma/database-preflight.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = ownerUrl && url ? describe : describe.skip;

class RolledBack extends Error {}

suite('ADR-033 hasTripStartCode against the real database (the invariant is checked, not assumed)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: url });
  });

  afterAll(async () => {
    await owner.$disconnect();
    await app.$disconnect();
  });

  function service(client: unknown): DatabasePreflightService {
    const env = { get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined) } as unknown as EnvService;
    return new DatabasePreflightService(client as PrismaService, env);
  }

  async function flagAfter(statements: readonly string[]): Promise<boolean | undefined> {
    let flag: boolean | undefined;
    try {
      await owner.$transaction(async (tx) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
        const preflight = service(tx);
        await preflight.onApplicationBootstrap();
        flag = preflight.getLastResult()?.hasTripStartCode;
        throw new RolledBack('rollback');
      });
    } catch (error) {
      if (!(error instanceof RolledBack)) throw error;
    }
    return flag;
  }

  it('is true on the migrated database and /health/db style result lists 11 flags', async () => {
    const preflight = service(app);

    await preflight.onApplicationBootstrap();

    expect(preflight.getLastResult()?.hasTripStartCode).toBe(true);
    expect(Object.keys(preflight.getLastResult() ?? {})).toHaveLength(11);
    expect(preflight.isHealthy()).toBe(true);
  });

  const SWAPPED_TRIGGER = (timing: string, level: string): string[] => [
    'DROP TRIGGER trip_request_start_code ON trips.trip_request',
    `CREATE TRIGGER trip_request_start_code ${timing} UPDATE ON trips.trip_request
       FOR EACH ${level} EXECUTE FUNCTION trips.trip_request_start_code_guard()`,
  ];

  it.each([
    ['the trigger is gone', ['DROP TRIGGER trip_request_start_code ON trips.trip_request']],
    ['the trigger is disabled', ['ALTER TABLE trips.trip_request DISABLE TRIGGER trip_request_start_code']],
    ['the trigger is AFTER instead of BEFORE', SWAPPED_TRIGGER('AFTER', 'ROW')],
    ['the trigger is per statement instead of per row', SWAPPED_TRIGGER('BEFORE', 'STATEMENT')],
    [
      'the trigger only covers UPDATE (not INSERT)',
      [
        'DROP TRIGGER trip_request_start_code ON trips.trip_request',
        `CREATE TRIGGER trip_request_start_code BEFORE UPDATE ON trips.trip_request
           FOR EACH ROW EXECUTE FUNCTION trips.trip_request_start_code_guard()`,
      ],
    ],
    [
      'the trigger only covers INSERT (not UPDATE)',
      [
        'DROP TRIGGER trip_request_start_code ON trips.trip_request',
        `CREATE TRIGGER trip_request_start_code BEFORE INSERT ON trips.trip_request
           FOR EACH ROW EXECUTE FUNCTION trips.trip_request_start_code_guard()`,
      ],
    ],
    ['a constraint is missing', ['ALTER TABLE trips.trip_request DROP CONSTRAINT trip_request_start_code_format']],
    [
      'a constraint is not validated',
      [
        'ALTER TABLE trips.trip_request DROP CONSTRAINT trip_request_start_code_attempts',
        `ALTER TABLE trips.trip_request ADD CONSTRAINT trip_request_start_code_attempts
           CHECK (start_code_failed_attempts BETWEEN 0 AND 5) NOT VALID`,
      ],
    ],
    ['the guard function is SECURITY DEFINER', ['ALTER FUNCTION trips.trip_request_start_code_guard() SECURITY DEFINER']],
    ['the generator lost its search_path', ['ALTER FUNCTION trips.new_start_code() RESET search_path']],
    [
      'a column is missing',
      [
        'ALTER TABLE trips.trip_request DROP CONSTRAINT trip_request_start_code_present',
        'ALTER TABLE trips.trip_request DROP COLUMN pickup_distance_at_assignment_m',
      ],
    ],
    [
      'the generator no longer returns four digits (functional probe)',
      [
        `CREATE OR REPLACE FUNCTION trips.new_start_code() RETURNS text
           LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp
           AS $$ SELECT 'abc'::text $$`,
      ],
    ],
    [
      'app_voyya can turn session_replication_role to replica (C-8)',
      ['GRANT SET ON PARAMETER session_replication_role TO app_voyya'],
    ],
  ])('is false when %s', async (_label, statements) => {
    expect(await flagAfter(statements)).toBe(false);
  });

  it('the owner can still switch triggers off, which is why the app must not own the table', async () => {
    const rows = await owner.$queryRaw<Array<{ owner_is_app: boolean }>>`
      SELECT pg_has_role('app_voyya', c.relowner, 'MEMBER') AS owner_is_app
        FROM pg_class c WHERE c.oid = 'trips.trip_request'::regclass`;

    expect(rows[0]?.owner_is_app).toBe(false);
  });

  it('app_voyya cannot activate session_replication_role: the statement is refused', async () => {
    let message = '';
    try {
      await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('permission denied');
  });
});
