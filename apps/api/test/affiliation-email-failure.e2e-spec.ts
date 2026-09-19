import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { REQUIRED_COMPANY_DOCUMENT_TYPES } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { stagingKey } from '../src/modules/affiliation/document-key';
import { FILE_STORAGE, type FileStorageProvider } from '../src/modules/affiliation/ports/file-storage.port';
import { EMAIL_PROVIDER, type EmailProvider } from '../src/modules/affiliation/ports/email-provider.port';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PDF_BYTES = Buffer.from('%PDF-1.4\n%E2E email-failure test document\n');

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

function randomTaxId(): string {
  return `9${randomInt(10_000_000, 99_999_999)}`;
}

function randomPhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
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

suite('El fallo del correo NO deshace la decisión ya persistida (ADR-021 §5.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let storage: FileStorageProvider;
  let email: { send: jest.Mock };
  let platformAdminAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    email = { send: jest.fn() };

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_PROVIDER)
      .useValue(email as unknown as EmailProvider)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    storage = moduleRef.get(FILE_STORAGE);

    const suffix = uniqueSuffix();
    const platformAdmin = await prisma.user.create({
      data: {
        firstName: '_Platform',
        lastName: 'Admin',
        phone: `_platadm-email-${suffix}`,
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

  async function freshMunicipality(): Promise<number> {
    const suffix = uniqueSuffix();
    const municipality = await prisma.municipality.create({
      data: {
        name: `_EmailFailureMuni-${suffix}`,
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

  it('SendGrid caído al aprobar -> la empresa queda active igual, delivery=failed; el reenvío luego entrega sent', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await freshMunicipality();

    const submission = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_EmailFailureCo',
        tax_id: randomTaxId(),
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'EmailFailure',
        contact_email: `email-failure-${suffix}@voyya-e2e.test`,
        contact_phone: randomPhone(),
        documents: await stageCompanyDocuments(storage),
      });
    expect(submission.status).toBe(201);
    const companyId = submission.body.company_id as number;

    email.send.mockRejectedValueOnce(new Error('SendGrid is down'));

    const approval = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 9000 } });

    expect(approval.status).toBe(200);
    expect(approval.body.notification.delivery).toBe('failed');
    expect(email.send).toHaveBeenCalledTimes(1);

    const reloaded = await prisma.company.findUnique({ where: { companyId } });
    expect(reloaded?.status).toBe('active');

    const adminCount = await prisma.user.count({ where: { companyId, role: 'admin' } });
    expect(adminCount).toBe(1);

    const fareConfigCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.fareConfig.count({ where: { companyId, validTo: null } });
    });
    expect(fareConfigCount).toBe(1);

    email.send.mockResolvedValueOnce(undefined);
    const resend = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/notifications/resend`)
      .set('Authorization', platformAdminAuth)
      .send({});

    expect(resend.status).toBe(200);
    expect(resend.body.notification.delivery).toBe('sent');
    expect(resend.body.decision).toBe('credentials_reissued');
    expect(email.send).toHaveBeenCalledTimes(2);

    const reissuedText = email.send.mock.calls[1][0].text as string;
    const reissuedPassword = /Contraseña temporal: (\S+)/.exec(reissuedText)?.[1];
    expect(reissuedPassword).toBeTruthy();

    const login = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: resend.body.notification.to, password: reissuedPassword });
    expect(login.status).toBe(200);

    const reviews = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.companyReview.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    });
    expect(reviews.map((r) => r.decision)).toEqual(['approved', 'credentials_reissued']);
  }, 20_000);

  it('SendGrid caído al pedir documento y al rechazar -> el estado igual se persiste, delivery=failed', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await freshMunicipality();

    const submissionA = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_EmailFailureRequestDocsCo',
        tax_id: randomTaxId(),
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'RequestDocs',
        contact_email: `email-failure-reqdocs-${suffix}@voyya-e2e.test`,
        contact_phone: randomPhone(),
        documents: await stageCompanyDocuments(storage),
      });
    expect(submissionA.status).toBe(201);
    const companyIdA = submissionA.body.company_id as number;

    email.send.mockRejectedValueOnce(new Error('SendGrid is down'));
    const requestDocs = await request(app.getHttpServer())
      .post(`/platform/companies/${companyIdA}/request-documents`)
      .set('Authorization', platformAdminAuth)
      .send({ document_types: ['liability_insurance'], note: 'la póliza venció, súbela de nuevo' });

    expect(requestDocs.status).toBe(200);
    expect(requestDocs.body.notification.delivery).toBe('failed');
    expect(requestDocs.body.status).toBe('pending');

    const reloadedA = await prisma.company.findUnique({ where: { companyId: companyIdA } });
    expect(reloadedA?.status).toBe('pending');

    const submissionB = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_EmailFailureRejectCo',
        tax_id: randomTaxId(),
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'Reject',
        contact_email: `email-failure-reject-${suffix}@voyya-e2e.test`,
        contact_phone: randomPhone(),
        documents: await stageCompanyDocuments(storage),
      });
    expect(submissionB.status).toBe(201);
    const companyIdB = submissionB.body.company_id as number;

    email.send.mockRejectedValueOnce(new Error('SendGrid is down'));
    const rejection = await request(app.getHttpServer())
      .post(`/platform/companies/${companyIdB}/reject`)
      .set('Authorization', platformAdminAuth)
      .send({ note: 'documentación insuficiente para operar' });

    expect(rejection.status).toBe(200);
    expect(rejection.body.notification.delivery).toBe('failed');

    const reloadedB = await prisma.company.findUnique({ where: { companyId: companyIdB } });
    expect(reloadedB?.status).toBe('rejected');
  }, 20_000);
});
