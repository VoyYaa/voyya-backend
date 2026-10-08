import type { PrismaClient } from '@prisma/client';
import { DatabasePreflightService } from '../src/infrastructure/prisma/database-preflight.service';
import type { EnvService } from '../src/config/env.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const ownerUrl = process.env.PG_TEST_OWNER_URL;
const tableOwnerOnlyIt = ownerUrl ? it : it.skip;

suite('DatabasePreflightService against real Postgres — covers the 5 tenant-owned tables (ADR-018 closes B-05)', () => {
  let raw: PrismaClient;
  let owner: PrismaClient | null;
  let fakeEnv: EnvService;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
    if (ownerUrl) {
      owner = new Client({ datasources: { db: { url: ownerUrl } } });
      await owner.$connect();
    } else {
      owner = null;
    }
    fakeEnv = { get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined) } as unknown as EnvService;
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
    if (owner) await owner.$disconnect();
  });

  it('the real 00_postgis_rls.sql state forces RLS on all 5 tables, including the two ADR-018 added', async () => {
    const service = new DatabasePreflightService(raw as unknown as PrismaService, fakeEnv);

    await service.onApplicationBootstrap();

    expect(service.getLastResult()?.hasForcedRls).toBe(true);
    expect(service.isHealthy()).toBe(true);
  });

  tableOwnerOnlyIt(
    'ADR-027: hasForcedRls is false with only 9 of the 10 tables forced, true again once restored',
    async () => {
      class RolledBack extends Error {}
      const ownerClient = owner as PrismaClient;

      await expect(
        ownerClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE tenancy.company_review NO FORCE ROW LEVEL SECURITY');

          const service = new DatabasePreflightService(tx as unknown as PrismaService, fakeEnv);
          await service.onApplicationBootstrap();

          expect(service.getLastResult()?.hasForcedRls).toBe(false);
          expect(service.isHealthy()).toBe(false);

          throw new RolledBack('rollback-to-restore-rls');
        }),
      ).rejects.toThrow(RolledBack);

      const service = new DatabasePreflightService(raw as unknown as PrismaService, fakeEnv);
      await service.onApplicationBootstrap();
      expect(service.getLastResult()?.hasForcedRls).toBe(true);
      expect(service.isHealthy()).toBe(true);
    },
  );
  it('the real state has the trip probe owned by a role that bypasses RLS with row_security off (CM-14)', async () => {
    const service = new DatabasePreflightService(raw as unknown as PrismaService, fakeEnv);

    await service.onApplicationBootstrap();

    expect(service.getLastResult()?.hasSafeTripProbe).toBe(true);
  });

  it('PUBLIC cannot execute the trip probe (CM-14)', async () => {
    const rows = await raw.$queryRawUnsafe<Array<{ acl: string[] | null }>>(
      "SELECT proacl::text[] AS acl FROM pg_proc WHERE proname = 'trip_has_assignment'",
    );
    expect(rows).toHaveLength(1);
    expect((rows[0]?.acl ?? []).some((entry) => entry.startsWith('='))).toBe(false);
  });

  tableOwnerOnlyIt(
    'a probe owner without BYPASSRLS fails the preflight and the call fails closed instead of leaking (CM-14)',
    async () => {
      class RolledBack extends Error {}
      const ownerClient = owner as PrismaClient;

      await expect(
        ownerClient.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'CREATE ROLE _probe_nobypass NOLOGIN NOSUPERUSER NOBYPASSRLS',
          );
          await tx.$executeRawUnsafe('GRANT CREATE, USAGE ON SCHEMA assignment TO _probe_nobypass');
          await tx.$executeRawUnsafe('GRANT SELECT ON assignment.assignment TO _probe_nobypass');
          await tx.$executeRawUnsafe(
            'ALTER FUNCTION assignment.trip_has_assignment(integer) OWNER TO _probe_nobypass',
          );

          const service = new DatabasePreflightService(tx as unknown as PrismaService, fakeEnv);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasSafeTripProbe).toBe(false);
          expect(service.isHealthy()).toBe(false);

          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          await expect(
            tx.$queryRawUnsafe('SELECT assignment.trip_has_assignment(1)'),
          ).rejects.toThrow(/row-level security|row_security/i);

          throw new RolledBack('rollback-to-restore-owner');
        }),
      ).rejects.toThrow(RolledBack);
    },
  );
});
