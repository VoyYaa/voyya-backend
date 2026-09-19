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

const PDF_BYTES = Buffer.from('%PDF-1.4\n%E2E contact-collision test document\n');

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

suite('Colisión de cuenta del contacto — dos ventanas temporales (ADR-021 §5 riesgos)', () => {
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAdminAuth: string;

  let app: INestApplication;
  let storage: FileStorageProvider;

  async function freshMunicipality(): Promise<number> {
    const suffix = uniqueSuffix();
    const municipality = await prisma.municipality.create({
      data: {
        name: `_ContactCollisionMuni-${suffix}`,
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
        phone: `_platadm-contact-${suffix}`,
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

  it('al enviar la solicitud: el teléfono de contacto ya pertenece a un usuario -> 409 CONTACT_PHONE_TAKEN', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await freshMunicipality();
    const takenPhone = randomPhone();

    await prisma.user.create({
      data: {
        firstName: '_Existing',
        lastName: 'Passenger',
        phone: takenPhone,
        role: 'passenger',
      },
    });

    const taxId = randomTaxId();
    const res = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_PhoneCollisionCo',
        tax_id: taxId,
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'PhoneTaken',
        contact_email: `contact-phone-${suffix}@voyya-e2e.test`,
        contact_phone: takenPhone,
        documents: await stageCompanyDocuments(storage),
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONTACT_PHONE_TAKEN' });

    const created = await prisma.company.findUnique({ where: { taxId } });
    expect(created).toBeNull();
  });

  it('al enviar la solicitud: el correo de contacto ya pertenece a un usuario -> 409 CONTACT_EMAIL_TAKEN', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await freshMunicipality();
    const takenEmail = `already-registered-${suffix}@voyya-e2e.test`;

    await prisma.user.create({
      data: {
        firstName: '_Existing',
        lastName: 'Passenger',
        phone: randomPhone(),
        email: takenEmail,
        role: 'passenger',
      },
    });

    const taxId = randomTaxId();
    const res = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_EmailCollisionCo',
        tax_id: taxId,
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'EmailTaken',
        contact_email: takenEmail,
        contact_phone: randomPhone(),
        documents: await stageCompanyDocuments(storage),
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONTACT_EMAIL_TAKEN' });

    const created = await prisma.company.findUnique({ where: { taxId } });
    expect(created).toBeNull();
  });

  it('al aprobar: alguien se registró con el teléfono de contacto ENTRE el envío y la aprobación -> 409 CONTACT_ACCOUNT_CONFLICT, sin dejar la empresa a medias', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await freshMunicipality();
    const contactPhone = randomPhone();

    const submission = await request(app.getHttpServer())
      .post('/affiliation/applications')
      .send({
        legal_name: '_LateConflictCo',
        tax_id: randomTaxId(),
        legal_form: 'cooperative',
        municipality_id: municipalityId,
        vehicle_count: 4,
        contact_first_name: '_Contact',
        contact_last_name: 'LateConflict',
        contact_email: `late-conflict-${suffix}@voyya-e2e.test`,
        contact_phone: contactPhone,
        documents: await stageCompanyDocuments(storage),
      });
    expect(submission.status).toBe(201);
    const companyId = submission.body.company_id as number;

    await prisma.user.create({
      data: {
        firstName: '_JustRegistered',
        lastName: 'Passenger',
        phone: contactPhone,
        role: 'passenger',
      },
    });

    const approval = await request(app.getHttpServer())
      .post(`/platform/companies/${companyId}/approve`)
      .set('Authorization', platformAdminAuth)
      .send({ initial_fare: { base_fare: 9000 } });

    expect(approval.status).toBe(409);
    expect(approval.body).toMatchObject({ code: 'CONTACT_ACCOUNT_CONFLICT' });

    const reloaded = await prisma.company.findUnique({ where: { companyId } });
    expect(reloaded?.status).toBe('pending');

    const adminCount = await prisma.user.count({ where: { companyId, role: 'admin' } });
    expect(adminCount).toBe(0);

    const fareConfigCount = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return tx.fareConfig.count({ where: { companyId } });
    });
    expect(fareConfigCount).toBe(0);
  }, 20_000);
});
