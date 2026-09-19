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
    'ADR-021: hasForcedRls is false with only 7 of the 8 tables forced, true again once restored',
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
});
