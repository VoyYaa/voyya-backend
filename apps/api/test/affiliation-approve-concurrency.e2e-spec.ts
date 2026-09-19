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

suite('Approve company — doubleclick is an atomic single-take (ADR-021 §2.3)', () => {
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
        phone: `_platadm-concur-${suffix}`,
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

  async function pendingCompanyFixture(): Promise<number> {
    const suffix = uniqueSuffix();
    const municipality = await prisma.municipality.create({
      data: {
        name: `_ConcurApproveMuni-${suffix}`,
        department: 'Test',
        coveragePolygon: {
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
        },
        status: 'active',
      },
    });

    const company = await prisma.company.create({
      data: {
        legalName: `_ConcurApproveCo-${suffix}`,
        taxId: `_concur-approve-${suffix}`,
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'pending',
        vehicleCount: 10,
        contactEmail: `contact-${suffix}@voyya-e2e.test`,
        contactFirstName: '_Contact',
        contactLastName: `First${suffix}`,
        contactPhone: `_concur-contact-${suffix}`,
      },
    });
    return company.companyId;
  }

  it('N=10 concurrent approve requests on the SAME pending company -> exactly one 200, the rest 409', async () => {
    const companyId = await pendingCompanyFixture();
    const N = 10;

    const attempts = Array.from({ length: N }, () =>
      request(app.getHttpServer())
        .post(`/platform/companies/${companyId}/approve`)
        .set('Authorization', platformAdminAuth)
        .send({ initial_fare: { base_fare: 9000 } }),
    );

    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
    for (const c of conflicts) {
      expect(c.body).toMatchObject({ code: 'COMPANY_NOT_PENDING' });
    }

    const company = await prisma.company.findUnique({ where: { companyId } });
    expect(company?.status).toBe('active');

    const fareConfigCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.fareConfig.count({ where: { companyId, validTo: null } });
    });
    expect(fareConfigCount).toBe(1);

    const adminCount = await prisma.user.count({ where: { companyId, role: 'admin' } });
    expect(adminCount).toBe(1);

    const reviewCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.companyReview.count({ where: { companyId, decision: 'approved' } });
    });
    expect(reviewCount).toBe(1);
  }, 30_000);

  it('reintentar después de un 409 sigue siendo seguro: aprobar de nuevo no crea una segunda tarifa', async () => {
    const companyId = await pendingCompanyFixture();

    const first = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 8500 } });
    expect(first.status).toBe(200);

    const retry = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 8500 } });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'COMPANY_NOT_PENDING' });

    const fareConfigCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.fareConfig.count({ where: { companyId } });
    });
    expect(fareConfigCount).toBe(1);
  }, 20_000);
});
