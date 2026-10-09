import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  commissionsOf,
  createCompany,
  createMunicipality,
  createPlatformAdmin,
  openFares,
} from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_ConcurApproveMuni';

suite('Approve company: double click and concurrent approvals are atomic (ADR-021 §2.3, ADR-032 §10.2, HU-MS-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAdminAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ACTIVE_SERVICE_TYPES = 'taxi,comfort';
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    platformAdminAuth = (await createPlatformAdmin(prisma, jwt, 'concur')).auth;
  }, 30_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    if (app) await app.close();
  }, 60_000);

  function approve(companyId: number, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send(body);
  }

  const APPROVAL = { initial_fare: { base_fare: 9000 }, commission_pct: 8 };

  it('N=10 concurrent approve requests on the SAME pending company -> exactly one 200, the rest 409', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);
    const N = 10;

    const results = await Promise.all(Array.from({ length: N }, () => approve(companyId, APPROVAL)));
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
    for (const c of conflicts) {
      expect(c.body).toMatchObject({ code: 'COMPANY_NOT_PENDING' });
    }

    const company = await prisma.company.findUnique({ where: { companyId } });
    expect(company?.status).toBe('active');
    expect(await openFares(prisma, municipalityId)).toHaveLength(1);
    expect((await commissionsOf(prisma, companyId)).filter((c) => c.validTo === null)).toHaveLength(1);
    expect(await prisma.user.count({ where: { companyId, role: 'admin' } })).toBe(1);

    const reviewCount = await prisma.runInTenant(companyId, (tx) =>
      tx.companyReview.count({ where: { companyId, decision: 'approved' } }),
    );
    expect(reviewCount).toBe(1);
  }, 30_000);

  it('retrying after a 409 is safe: approving again creates no second fare and no second commission', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);

    const first = await approve(companyId, APPROVAL);
    expect(first.status).toBe(200);
    expect(first.body.provisioning.municipality_fares).toEqual([
      expect.objectContaining({ service_type: 'taxi', created: true }),
    ]);

    const retry = await approve(companyId, APPROVAL);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'COMPANY_NOT_PENDING' });

    expect(await openFares(prisma, municipalityId)).toHaveLength(1);
    expect(await commissionsOf(prisma, companyId)).toHaveLength(1);
  }, 20_000);

  it('HU-MS-11: two different companies of the same municipality approved at once -> two 200 and one single open fare', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const firstId = await createCompany(prisma, municipalityId);
    const secondId = await createCompany(prisma, municipalityId);

    const [first, second] = await Promise.all([
      approve(firstId, { initial_fare: { base_fare: 9000 }, commission_pct: 8 }),
      approve(secondId, { initial_fare: { base_fare: 12000 }, commission_pct: 5 }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const created = [first, second].filter((r) => r.body.provisioning.municipality_fares[0].created);
    expect(created).toHaveLength(1);
    const fares = await openFares(prisma, municipalityId);
    expect(fares).toHaveLength(1);
    expect(first.body.provisioning.municipality_fares[0].municipality_fare_id).toBe(fares[0]?.municipalityFareId);
    expect(second.body.provisioning.municipality_fares[0].municipality_fare_id).toBe(fares[0]?.municipalityFareId);
    expect(Number((await commissionsOf(prisma, firstId))[0]?.commissionPct)).toBe(8);
    expect(Number((await commissionsOf(prisma, secondId))[0]?.commissionPct)).toBe(5);
  }, 30_000);

  it('MD-16: repeated concurrent approvals with services declared in opposite orders never answer 500', async () => {
    for (let round = 0; round < 3; round += 1) {
      const municipalityId = await createMunicipality(prisma, PREFIX);
      const firstId = await createCompany(prisma, municipalityId, { serviceTypes: ['taxi', 'comfort'] });
      const secondId = await createCompany(prisma, municipalityId, { serviceTypes: ['comfort', 'taxi'] });

      const results = await Promise.all([
        approve(firstId, APPROVAL),
        approve(secondId, APPROVAL),
      ]);

      for (const result of results) {
        expect([200, 409]).toContain(result.status);
      }
      expect((await openFares(prisma, municipalityId, 'taxi')).length).toBeLessThanOrEqual(1);
      expect((await openFares(prisma, municipalityId, 'comfort')).length).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
