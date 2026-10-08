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
  seedCommission,
  seedOpenFare,
} from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_CoveredMuni';

suite('Approval in a municipality that already has an active company (ADR-032 §10.2, HU-MS-11)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAdminAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    platformAdminAuth = (await createPlatformAdmin(prisma, jwt, 'covered')).auth;
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

  it('a free municipality: approves with the initial fare, creates the municipality fare and the commission', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);

    const res = await approve(companyId, { initial_fare: { base_fare: 9000 }, commission_pct: 7.5 });

    expect(res.status).toBe(200);
    expect(res.body.acknowledged_routing_limitation).toBe(false);
    expect(res.body.provisioning.fare_config_id).toBeNull();
    expect(res.body.provisioning.municipality_fares).toEqual([
      expect.objectContaining({ service_type: 'taxi', created: true }),
    ]);
    const [fare] = await openFares(prisma, municipalityId);
    expect(Number(fare?.baseFare)).toBe(9000);
    expect(Number(fare?.nightSurchargePct)).toBe(20);
    expect(Number(fare?.holidaySurchargePct)).toBe(15);
    expect(fare?.origin).toBe('company_approval');
    expect(fare?.isOfficial).toBe(false);
    expect(fare?.originCompanyId).toBe(companyId);
    const [commission] = await commissionsOf(prisma, companyId);
    expect(Number(commission?.commissionPct)).toBe(7.5);
    expect(commission?.origin).toBe('company_approval');
    expect(res.body.provisioning.company_commission_id).toBe(commission?.companyCommissionId);
  });

  it('a covered municipality is not a block: the second company approves with no fare, the existing fare is untouched', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const incumbentId = await createCompany(prisma, municipalityId, { status: 'active', legalName: '_IncumbentCo' });
    await seedCommission(prisma, incumbentId, 8);
    const fareId = await seedOpenFare(prisma, municipalityId, 'taxi', 8800);
    const companyId = await createCompany(prisma, municipalityId, { legalName: '_LateArrivalCo' });

    const res = await approve(companyId, { commission_pct: 6, note: 'segunda empresa' });

    expect(res.status).toBe(200);
    expect(res.body.provisioning.municipality_fares).toEqual([
      { service_type: 'taxi', municipality_fare_id: fareId, created: false },
    ]);
    const fares = await openFares(prisma, municipalityId);
    expect(fares).toHaveLength(1);
    expect(Number(fares[0]?.baseFare)).toBe(8800);
    expect((await prisma.company.findUnique({ where: { companyId } }))?.status).toBe('active');

    const review = await prisma.runInTenant(companyId, (tx) =>
      tx.companyReview.findFirst({ where: { companyId, decision: 'approved' } }),
    );
    expect(review?.acknowledgedRoutingLimitation).toBe(false);
    expect(review?.municipalityActiveCompanyId).toBeNull();
    expect(review?.municipalityActiveCompanyName).toBeNull();
  });

  it('an initial fare sent for a municipality that already has one is ignored and the response says so', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    await createCompany(prisma, municipalityId, { status: 'active' });
    await seedOpenFare(prisma, municipalityId, 'taxi', 8800);
    const companyId = await createCompany(prisma, municipalityId);

    const res = await approve(companyId, { initial_fare: { base_fare: 20000 }, commission_pct: 5 });

    expect(res.status).toBe(200);
    expect(res.body.provisioning.municipality_fares[0].created).toBe(false);
    expect(Number((await openFares(prisma, municipalityId))[0]?.baseFare)).toBe(8800);
  });

  it('no fare in the municipality and no initial fare -> 409 MUNICIPALITY_FARE_REQUIRED and nothing is left behind', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);

    const res = await approve(companyId, { commission_pct: 8 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MUNICIPALITY_FARE_REQUIRED' });
    expect((await prisma.company.findUnique({ where: { companyId } }))?.status).toBe('pending');
    expect(await openFares(prisma, municipalityId)).toHaveLength(0);
    expect(await commissionsOf(prisma, companyId)).toHaveLength(0);
    expect(await prisma.user.count({ where: { companyId, role: 'admin' } })).toBe(0);
  });

  it('the commission is mandatory: without commission_pct -> 400, and out of 0-50 -> 400', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);

    const missing = await approve(companyId, { initial_fare: { base_fare: 9000 } });
    const tooHigh = await approve(companyId, { initial_fare: { base_fare: 9000 }, commission_pct: 50.01 });

    expect(missing.status).toBe(400);
    expect(tooHigh.status).toBe(400);
    expect((await prisma.company.findUnique({ where: { companyId } }))?.status).toBe('pending');
  });

  it('a commission of 0 is allowed (promotions)', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId);

    const res = await approve(companyId, { initial_fare: { base_fare: 9000 }, commission_pct: 0 });

    expect(res.status).toBe(200);
    expect(Number((await commissionsOf(prisma, companyId))[0]?.commissionPct)).toBe(0);
  });

  it('a declared service that is not active -> 409 SERVICE_NOT_AVAILABLE and the company stays pending', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const companyId = await createCompany(prisma, municipalityId, { serviceTypes: ['taxi', 'comfort'] });

    const res = await approve(companyId, { initial_fare: { base_fare: 9000 }, commission_pct: 8 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
    expect((await prisma.company.findUnique({ where: { companyId } }))?.status).toBe('pending');
    expect(await openFares(prisma, municipalityId)).toHaveLength(0);
  });

  it('the detail lists the other active companies, the fares per declared service and the commission', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX);
    const incumbentId = await createCompany(prisma, municipalityId, { status: 'active', legalName: '_DetailIncumbent' });
    await seedOpenFare(prisma, municipalityId, 'taxi', 8800);
    const companyId = await createCompany(prisma, municipalityId, { publicName: 'Taxis Detalle' });

    const before = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    expect(before.status).toBe(200);
    expect(before.body.municipality_active_companies).toEqual([
      { company_id: incumbentId, legal_name: '_DetailIncumbent' },
    ]);
    expect(before.body.municipality_active_company_name).toBe('_DetailIncumbent');
    expect(before.body.municipality_fares).toEqual([
      expect.objectContaining({ service_type: 'taxi', fare: expect.objectContaining({ base_fare: 8800 }) }),
    ]);
    expect(before.body.commission).toBeNull();
    expect(before.body.public_name).toBe('Taxis Detalle');
    expect(before.body.display_name).toBe('Taxis Detalle');
    expect(before.body.service_types).toEqual(['taxi']);

    await approve(companyId, { commission_pct: 4 });
    const after = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    expect(after.body.commission).toMatchObject({ commission_pct: 4, origin: 'company_approval', valid_to: null });
  });

  it('a municipality without active coverage approves with coverage pending and the list says since when', async () => {
    const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
    const daneCode = (await prisma.municipality.findUnique({ where: { municipalityId } }))?.daneCode;
    const companyId = await createCompany(prisma, municipalityId);

    const res = await approve(companyId, { initial_fare: { base_fare: 9000 }, commission_pct: 8 });
    expect(res.status).toBe(200);
    expect(res.body.municipality_coverage_active).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/platform/companies?status=active&municipality_id=${municipalityId}`)
      .set('Authorization', platformAdminAuth);
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0]).toMatchObject({
      company_id: companyId,
      municipality_dane_code: daneCode,
      municipality_coverage_active: false,
      coverage_pending_since: expect.any(String),
    });
  });
});
