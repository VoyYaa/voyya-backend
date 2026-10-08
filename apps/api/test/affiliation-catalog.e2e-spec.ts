import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { REQUIRED_COMPANY_DOCUMENT_TYPES } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { stagingKey } from '../src/modules/affiliation/document-key';
import { FILE_STORAGE, type FileStorageProvider } from '../src/modules/affiliation/ports/file-storage.port';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { createCompany, createMunicipality, uniqueSuffix } from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_CatalogMuni';
const PDF_BYTES = Buffer.from('%PDF-1.4\n%E2E affiliation catalog test document\n');

function randomTaxId(): string {
  return `9${randomInt(10_000_000, 99_999_999)}`;
}

function randomPhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
}

async function stageDocuments(storage: FileStorageProvider) {
  const documents = [];
  for (const type of REQUIRED_COMPANY_DOCUMENT_TYPES) {
    const key = stagingKey('application/pdf');
    await storage.put({ key, body: PDF_BYTES, contentType: 'application/pdf' });
    documents.push({ type, storage_key: key });
  }
  return documents;
}

const APPLICATIONS_PER_APP = 3;

suite('Affiliation: DANE catalog, application with service types and public name (ADR-031 §6, ADR-032 §10.1, HU-MS-13, HU-MS-14)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: FileStorageProvider;
  let poster: { app: INestApplication; used: number } | null = null;

  async function bootApp(): Promise<INestApplication> {
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const booted = moduleRef.createNestApplication();
    booted.useGlobalFilters(new AllExceptionsFilter());
    await booted.init();
    return booted;
  }

  async function postApplication(body: Record<string, unknown>) {
    if (!poster || poster.used >= APPLICATIONS_PER_APP) {
      if (poster) await poster.app.close();
      poster = { app: await bootApp(), used: 0 };
    }
    poster.used += 1;
    return request(poster.app.getHttpServer()).post('/affiliation/applications').send(body);
  }

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
    storage = moduleRef.get(FILE_STORAGE);
  }, 30_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX, { daneCodePrefix: '00' });
    if (poster) await poster.app.close();
    if (app) await app.close();
  }, 60_000);

  async function applicationBody(municipalityId: number, overrides: Record<string, unknown> = {}) {
    const suffix = uniqueSuffix();
    return {
      legal_name: `_CatalogCo-${suffix}`,
      tax_id: randomTaxId(),
      legal_form: 'cooperative',
      municipality_id: municipalityId,
      vehicle_count: 5,
      contact_first_name: '_Contact',
      contact_last_name: 'Catalog',
      contact_email: `catalog-${suffix}@voyya-e2e.test`,
      contact_phone: randomPhone(),
      documents: await stageDocuments(storage),
      ...overrides,
    };
  }

  describe('GET /affiliation/municipalities', () => {
    interface CatalogRow {
      municipality_id: number;
      dane_code: string;
      department_code: string;
      name: string;
      department: string;
      has_active_companies: boolean;
      already_covered: boolean;
      coverage_active: boolean;
    }

    it('serves the 1.104 eligible rows of the DANE catalog with real codes, the source and the active services', async () => {
      const res = await request(app.getHttpServer()).get('/affiliation/municipalities');

      expect(res.status).toBe(200);
      const rows = res.body.rows as CatalogRow[];
      expect(rows.filter((row) => !row.dane_code.startsWith('00'))).toHaveLength(1104);
      expect(res.body.source).toEqual({
        name: 'DIVIPOLA — DANE',
        cut_date: '2024-12-30',
        attribution: expect.stringContaining('dane.gov.co'),
        license: expect.stringContaining('CC BY-SA 4.0'),
      });
      expect(res.body.active_service_types).toEqual(['taxi']);
      for (const row of rows) {
        expect(row.dane_code).toMatch(/^\d{5}$/);
        expect(row.department_code).toBe(row.dane_code.slice(0, 2));
        expect(row.dane_code).not.toBe('00000');
      }
    });

    it('never offers a non-municipalized area nor a retired code', async () => {
      const area = await prisma.municipality.create({
        data: { name: `${PREFIX}-area-${uniqueSuffix()}`, department: 'Test', status: 'catalog', daneCode: '00991', daneType: 'non_municipalized_area' },
      });
      const retired = await prisma.municipality.create({
        data: { name: `${PREFIX}-retired-${uniqueSuffix()}`, department: 'Test', status: 'retired', daneCode: '00992', daneType: 'municipality' },
      });

      const res = await request(app.getHttpServer()).get('/affiliation/municipalities');
      const ids = (res.body.rows as CatalogRow[]).map((row) => row.municipality_id);

      expect(ids).not.toContain(area.municipalityId);
      expect(ids).not.toContain(retired.municipalityId);
    });

    it('orders by department and then by name ignoring accents', async () => {
      const res = await request(app.getHttpServer()).get('/affiliation/municipalities');
      const rows = res.body.rows as CatalogRow[];
      const collator = new Intl.Collator('es-CO', { sensitivity: 'base' });

      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1] as CatalogRow;
        const current = rows[index] as CatalogRow;
        const byDepartment = collator.compare(previous.department, current.department);
        expect(byDepartment <= 0).toBe(true);
        if (byDepartment === 0) expect(collator.compare(previous.name, current.name) <= 0).toBe(true);
      }
    });

    it('says only whether the municipality has active companies: a suspended one does not count and nothing names or counts them', async () => {
      const covered = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      await createCompany(prisma, covered, { status: 'active', legalName: '_CatalogSecretCompany' });
      await createCompany(prisma, covered, { status: 'active', legalName: '_CatalogSecretCompanyTwo' });
      const onlySuspended = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      await createCompany(prisma, onlySuspended, { status: 'suspended', legalName: '_CatalogSuspendedCompany' });
      const empty = await createMunicipality(prisma, PREFIX, { status: 'catalog' });

      const res = await request(app.getHttpServer()).get('/affiliation/municipalities');
      const byId = new Map((res.body.rows as CatalogRow[]).map((row) => [row.municipality_id, row]));

      expect(byId.get(covered)).toMatchObject({ has_active_companies: true, already_covered: true, coverage_active: false });
      expect(byId.get(onlySuspended)).toMatchObject({ has_active_companies: false, already_covered: false });
      expect(byId.get(empty)).toMatchObject({ has_active_companies: false });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('_CatalogSecretCompany');
      expect(text).not.toContain('_CatalogSuspendedCompany');
      expect(Object.keys(byId.get(covered) as CatalogRow).sort()).toEqual(
        [
          'already_covered',
          'coverage_active',
          'dane_code',
          'department',
          'department_code',
          'has_active_companies',
          'municipality_id',
          'name',
        ].sort(),
      );
    });

    it('marks a municipality with active coverage and carries Cache-Control for five minutes', async () => {
      const active = await createMunicipality(prisma, PREFIX, { status: 'active', daneCode: '00993' });

      const res = await request(app.getHttpServer()).get('/affiliation/municipalities');
      const row = (res.body.rows as CatalogRow[]).find((r) => r.municipality_id === active);

      expect(row).toMatchObject({ coverage_active: true, dane_code: '00993' });
      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });

    it('has its own throttle of 20 requests per minute: the 21st is a 429', async () => {
      const { AppModule } = await import('../src/app.module');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const fresh = moduleRef.createNestApplication();
      fresh.useGlobalFilters(new AllExceptionsFilter());
      await fresh.init();
      try {
        const statuses: number[] = [];
        for (let index = 0; index < 21; index += 1) {
          statuses.push((await request(fresh.getHttpServer()).get('/affiliation/municipalities')).status);
        }
        expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
        expect(statuses[20]).toBe(429);
      } finally {
        await fresh.close();
      }
    }, 60_000);
  });

  describe('POST /affiliation/applications', () => {
    it('a catalog municipality without coverage accepts the application with the default service and no public name', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });

      const res = await postApplication(await applicationBody(municipalityId));

      expect(res.status).toBe(201);
      const company = await prisma.company.findUnique({ where: { companyId: res.body.company_id } });
      expect(company).toMatchObject({ status: 'pending', serviceTypes: ['taxi'], publicName: null, type: 'cooperative' });
    });

    it('stores the declared service and the public name', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });

      const res = await postApplication(await applicationBody(municipalityId, { service_types: ['taxi'], public_name: 'Taxis del Norte' }));

      expect(res.status).toBe(201);
      const company = await prisma.company.findUnique({ where: { companyId: res.body.company_id } });
      expect(company).toMatchObject({ serviceTypes: ['taxi'], publicName: 'Taxis del Norte' });
    });

    it('a municipality that already has active companies is accepted like any other: no 409, no cover mark', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      await createCompany(prisma, municipalityId, { status: 'active' });

      const res = await postApplication(await applicationBody(municipalityId));

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
    });

    it('two applications for the same municipality at the same time are both accepted', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      const bodies = await Promise.all([applicationBody(municipalityId), applicationBody(municipalityId)]);

      const concurrent = await bootApp();
      try {
        const results = await Promise.all(
          bodies.map((body) => request(concurrent.getHttpServer()).post('/affiliation/applications').send(body)),
        );
        expect(results.map((r) => r.status)).toEqual([201, 201]);
      } finally {
        await concurrent.close();
      }
    });

    it('a pending application of a covered municipality stays pending: nothing rejects it automatically', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      const pendingId = await createCompany(prisma, municipalityId, { status: 'pending' });
      await createCompany(prisma, municipalityId, { status: 'active' });

      expect((await prisma.company.findUnique({ where: { companyId: pendingId } }))?.status).toBe('pending');
    });

    it.each([
      ['a non-municipalized area', { status: 'catalog' as const, daneType: 'non_municipalized_area' }],
      ['a retired code', { status: 'retired' as const, daneType: 'municipality' }],
    ])('%s answers 404 MUNICIPALITY_NOT_FOUND and creates nothing', async (_label, shape) => {
      const suffix = uniqueSuffix();
      const municipality = await prisma.municipality.create({
        data: { name: `${PREFIX}-ineligible-${suffix}`, department: 'Test', daneCode: `00${randomInt(900, 989)}`, ...shape },
      });
      const body = await applicationBody(municipality.municipalityId);

      const res = await postApplication(body);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'MUNICIPALITY_NOT_FOUND' });
      expect(await prisma.company.findUnique({ where: { taxId: body.tax_id } })).toBeNull();
    });

    it('a municipality without a DANE code answers 404', async () => {
      const municipality = await prisma.municipality.create({
        data: { name: `${PREFIX}-nocode-${uniqueSuffix()}`, department: 'Test', status: 'catalog' },
      });

      const res = await postApplication(await applicationBody(municipality.municipalityId));

      expect(res.status).toBe(404);
    });

    it('an inactive service answers 409 SERVICE_NOT_AVAILABLE and creates nothing nor moves any file', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      const body = await applicationBody(municipalityId, { service_types: ['comfort'] });

      const res = await postApplication(body);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
      expect(await prisma.company.findUnique({ where: { taxId: body.tax_id } })).toBeNull();
      for (const document of body.documents) {
        expect(await storage.stat(document.storage_key)).not.toBeNull();
      }
    });

    it.each([
      ['motorcycle', { service_types: ['motorcycle'] }],
      ['an unknown service', { service_types: ['bus'] }],
      ['an empty list', { service_types: [] }],
      ['a repeated service', { service_types: ['taxi', 'taxi'] }],
      ['a public name of one character', { public_name: 'A' }],
      ['a public name over 60 characters', { public_name: 'N'.repeat(61) }],
    ])('%s answers 400 and creates nothing', async (_label, override) => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
      const body = await applicationBody(municipalityId, override);

      const res = await postApplication(body);

      expect(res.status).toBe(400);
      expect(await prisma.company.findUnique({ where: { taxId: body.tax_id } })).toBeNull();
    });

    it('legal_form is kept as the legal form: it does not stand in for the declared service', async () => {
      const municipalityId = await createMunicipality(prisma, PREFIX, { status: 'catalog' });

      const res = await postApplication(await applicationBody(municipalityId, { legal_form: 'corporation' }));

      expect(res.status).toBe(201);
      const company = await prisma.company.findUnique({ where: { companyId: res.body.company_id } });
      expect(company).toMatchObject({ type: 'corporation', serviceTypes: ['taxi'] });
    });
  });
});
