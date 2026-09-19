import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { REQUIRED_COMPANY_DOCUMENT_TYPES } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { stagingKey } from '../src/modules/affiliation/document-key';
import { FILE_STORAGE, type FileStorageProvider } from '../src/modules/affiliation/ports/file-storage.port';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PDF_BYTES = Buffer.from('%PDF-1.4\n%E2E resubmit test document\n');

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

function randomTaxId(): string {
  return `9${randomInt(10_000_000, 99_999_999)}`;
}

async function stageCompanyDocuments(
  storage: FileStorageProvider,
): Promise<Array<{ type: (typeof REQUIRED_COMPANY_DOCUMENT_TYPES)[number]; storage_key: string }>> {
  const documents = [];
  for (const type of REQUIRED_COMPANY_DOCUMENT_TYPES) {
    const key = stagingKey('application/pdf');
    await storage.put({ key, body: PDF_BYTES, contentType: 'application/pdf' });
    documents.push({ type, storage_key: key });
  }
  return documents;
}

suite('Reintento tras rechazo — misma fila, historial acumulado (ADR-021 §3.4)', () => {
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAdminAuth: string;

  let app: INestApplication;
  let storage: FileStorageProvider;

  async function freshMunicipality(): Promise<number> {
    const suffix = uniqueSuffix();
    const municipality = await prisma.municipality.create({
      data: {
        name: `_ResubmitMuni-${suffix}`,
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
    return municipality.municipalityId;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const bootstrapRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = bootstrapRef.get(PrismaService);
    jwt = bootstrapRef.get(JwtService, { strict: false });

    const suffix = uniqueSuffix();
    const platformAdmin = await prisma.user.create({
      data: {
        firstName: '_Platform',
        lastName: 'Admin',
        phone: `_platadm-resubmit-${suffix}`,
        role: 'platform_admin',
        companyId: null,
      },
    });
    const token = jwt.sign({ sub: platformAdmin.userId, role: 'platform_admin', type: 'access' });
    platformAdminAuth = `Bearer ${token}`;
  }, 20_000);

  beforeEach(async () => {
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    storage = moduleRef.get(FILE_STORAGE);
  }, 20_000);

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rechazada -> reenviada con el mismo NIT -> reutiliza la fila y aprueba; el historial conserva ambas decisiones', async () => {
    const suffix = uniqueSuffix();
    const taxId = randomTaxId();
    const municipalityId = await freshMunicipality();

    const firstSubmission = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_ResubmitCo (v1)',
        tax_id: taxId,
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 5,
        contact_first_name: '_Contact',
        contact_last_name: 'One',
        contact_email: `resubmit-${suffix}@voyya-e2e.test`,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(firstSubmission.status).toBe(201);
    expect(firstSubmission.body.status).toBe('pending');
    const companyId = firstSubmission.body.company_id as number;

    const rejection = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/reject`)
      .set('Authorization', platformAdminAuth)
      .send({ note: 'faltan documentos legibles, vuelve a intentarlo' });
    expect(rejection.status).toBe(200);
    expect(rejection.body.status).toBe('rejected');

    const afterRejection = await prisma.company.findUnique({ where: { companyId } });
    expect(afterRejection?.status).toBe('rejected');

    const secondSubmission = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_ResubmitCo (v2, corregida)',
        tax_id: taxId,
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 6,
        contact_first_name: '_Contact',
        contact_last_name: 'Two',
        contact_email: `resubmit-${suffix}@voyya-e2e.test`,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(secondSubmission.status).toBe(201);
    expect(secondSubmission.body.status).toBe('pending');
    expect(secondSubmission.body.company_id).toBe(companyId);
    expect(secondSubmission.body.legal_name).toBe('_ResubmitCo (v2, corregida)');

    const companyCountForTaxId = await prisma.company.count({ where: { taxId } });
    expect(companyCountForTaxId).toBe(1);

    const approval = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 9000 } });
    expect(approval.status).toBe(200);

    const reviews = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.companyReview.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    });
    expect(reviews.map((r) => r.decision)).toEqual(['rejected', 'approved']);

    const finalCompany = await prisma.company.findUnique({ where: { companyId } });
    expect(finalCompany?.status).toBe('active');
    expect(finalCompany?.legalName).toBe('_ResubmitCo (v2, corregida)');
  }, 30_000);

  it('mientras está pending, reenviar el mismo NIT -> 409 APPLICATION_IN_REVIEW', async () => {
    const suffix = uniqueSuffix();
    const taxId = randomTaxId();
    const municipalityId = await freshMunicipality();
    const commonFields = {
      legal_name: '_PendingRetryCo',
      tax_id: taxId,
      legal_form: 'cooperative' as const,
      municipality_id: municipalityId,
      vehicle_count: 3,
      contact_first_name: '_Contact',
      contact_last_name: 'Pending',
      contact_email: `resubmit-pending-${suffix}@voyya-e2e.test`,
    };

    const first = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        ...commonFields,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        ...commonFields,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'APPLICATION_IN_REVIEW' });
  }, 30_000);

  it('empresa activa: reenviar el mismo NIT -> 409 TAX_ID_TAKEN', async () => {
    const suffix = uniqueSuffix();
    const taxId = randomTaxId();
    const municipalityId = await freshMunicipality();
    const commonFields = {
      legal_name: '_ActiveRetryCo',
      tax_id: taxId,
      legal_form: 'cooperative' as const,
      municipality_id: municipalityId,
      vehicle_count: 3,
      contact_first_name: '_Contact',
      contact_last_name: 'Active',
      contact_email: `resubmit-active-${suffix}@voyya-e2e.test`,
    };

    const first = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        ...commonFields,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(first.status).toBe(201);

    const approval = await request(app.getHttpServer())
      .post(`/platform/companies/${first.body.company_id}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 9000 } });
    expect(approval.status).toBe(200);

    const second = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        ...commonFields,
        contact_email: `resubmit-active-again-${suffix}@voyya-e2e.test`,
        contact_phone: `3${randomInt(100_000_000, 999_999_999)}`,
        documents: await stageCompanyDocuments(storage),
      });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'TAX_ID_TAKEN' });
  }, 30_000);
});
