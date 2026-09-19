import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ],
};

suite('Municipio disputado — revalidación TOCTOU dentro de la transacción (ADR-021 §3.1)', () => {
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

    const suffix = uniqueSuffix();
    const platformAdmin = await prisma.user.create({
      data: {
        firstName: '_Platform',
        lastName: 'Admin',
        phone: `_platadm-disputed-${suffix}`,
        role: 'platform_admin',
        companyId: null,
      },
    });
    const token = jwt.sign({ sub: platformAdmin.userId, role: 'platform_admin', type: 'access' });
    platformAdminAuth = `Bearer ${token}`;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function municipalityFixture(): Promise<number> {
    const suffix = uniqueSuffix();
    const municipality = await prisma.municipality.create({
      data: {
        name: `_DisputedMuni-${suffix}`,
        department: 'Test',
        coveragePolygon: SQUARE,
        status: 'active',
      },
    });
    return municipality.municipalityId;
  }

  async function pendingCompanyFixture(
    municipalityId: number,
    legalName: string,
  ): Promise<number> {
    const suffix = uniqueSuffix();
    const company = await prisma.company.create({
      data: {
        legalName,
        taxId: `_disputed-${suffix}`,
        type: 'cooperative',
        municipalityId,
        status: 'pending',
        vehicleCount: 10,
        contactEmail: `contact-${suffix}@voyya-e2e.test`,
        contactFirstName: '_Contact',
        contactLastName: `First${suffix}`,
        contactPhone: `_disputed-contact-${suffix}`,
      },
    });
    return company.companyId;
  }

  async function activeCompanyFixture(municipalityId: number, legalName: string): Promise<number> {
    const suffix = uniqueSuffix();
    const company = await prisma.company.create({
      data: {
        legalName,
        taxId: `_disputed-active-${suffix}`,
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    return company.companyId;
  }

  function approve(companyId: number, body: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 9000 }, ...body });
  }

  it('sin conflicto (municipio libre) -> aprueba sin necesidad del flag', async () => {
    const municipalityId = await municipalityFixture();
    const companyId = await pendingCompanyFixture(municipalityId, '_FreeMuniCo');

    const res = await approve(companyId);
    expect(res.status).toBe(200);
    expect(res.body.acknowledged_routing_limitation).toBe(false);
  });

  it('con conflicto y SIN el flag -> 409 MUNICIPALITY_ALREADY_COVERED, la empresa sigue pending', async () => {
    const municipalityId = await municipalityFixture();
    await activeCompanyFixture(municipalityId, '_AlreadyThereCo');
    const companyId = await pendingCompanyFixture(municipalityId, '_LateArrivalCo');

    const res = await approve(companyId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MUNICIPALITY_ALREADY_COVERED' });
    expect(res.body.municipality_active_company_name).toBe('_AlreadyThereCo');

    const reloaded = await prisma.company.findUnique({ where: { companyId } });
    expect(reloaded?.status).toBe('pending');

    const fareConfigCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.fareConfig.count({ where: { companyId } });
    });
    expect(fareConfigCount).toBe(0);
  });

  it('con conflicto y CON el flag -> 200, aprueba y audita el reconocimiento y el nombre congelado', async () => {
    const municipalityId = await municipalityFixture();
    const activeId = await activeCompanyFixture(municipalityId, '_IncumbentCo');
    const companyId = await pendingCompanyFixture(municipalityId, '_ForcedApprovalCo');

    const res = await approve(companyId, { acknowledge_routing_limitation: true, note: 'aprobada a sabiendas' });
    expect(res.status).toBe(200);
    expect(res.body.acknowledged_routing_limitation).toBe(true);

    const reloaded = await prisma.company.findUnique({ where: { companyId } });
    expect(reloaded?.status).toBe('active');

    const review = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.companyReview.findFirst({ where: { companyId, decision: 'approved' } });
    });
    expect(review?.acknowledgedRoutingLimitation).toBe(true);
    expect(review?.municipalityActiveCompanyId).toBe(activeId);
    expect(review?.municipalityActiveCompanyName).toBe('_IncumbentCo');
  });

  it('TOCTOU: el municipio se cubre ENTRE que se pinta el detalle y se aprueba -> el 409 salta igual', async () => {
    const municipalityId = await municipalityFixture();
    const companyAId = await pendingCompanyFixture(municipalityId, '_ToctouA');
    const companyBId = await pendingCompanyFixture(municipalityId, '_ToctouB');

    const detailBefore = await request(app.getHttpServer())
      .get(`/platform/companies/${companyAId}`)
      .set('Authorization', platformAdminAuth);
    expect(detailBefore.status).toBe(200);
    expect(detailBefore.body.municipality_active_company_name).toBeNull();

    const approvedB = await approve(companyBId);
    expect(approvedB.status).toBe(200);

    const approvedA = await approve(companyAId);
    expect(approvedA.status).toBe(409);
    expect(approvedA.body).toMatchObject({ code: 'MUNICIPALITY_ALREADY_COVERED' });
    expect(approvedA.body.municipality_active_company_name).toBe('_ToctouB');

    const reloadedA = await prisma.company.findUnique({ where: { companyId: companyAId } });
    expect(reloadedA?.status).toBe('pending');
  });
});
