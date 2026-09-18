import type { PrismaClient } from '@prisma/client';
import { DatabasePreflightService } from '../src/infrastructure/prisma/database-preflight.service';
import type { EnvService } from '../src/config/env.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('DatabasePreflightService against real Postgres — covers the 5 tenant-owned tables (ADR-018 closes B-05)', () => {
  let raw: PrismaClient;
  let fakeEnv: EnvService;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
    fakeEnv = { get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined) } as unknown as EnvService;
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  it('the real 00_postgis_rls.sql state forces RLS on all 5 tables, including the two ADR-018 added', async () => {
    const service = new DatabasePreflightService(raw as unknown as PrismaService, fakeEnv);

    await service.onApplicationBootstrap();

    expect(service.getLastResult()?.hasForcedRls).toBe(true);
    expect(service.isHealthy()).toBe(true);
  });
});
