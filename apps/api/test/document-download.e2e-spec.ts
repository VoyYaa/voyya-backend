import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { DocumentDownloadTokenService } from '../src/modules/affiliation/document-download-token.service';
import { FILE_STORAGE, type FileStorageProvider } from '../src/modules/affiliation/ports/file-storage.port';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

function bufferParser(res: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function tokenFromDownloadUrl(downloadUrl: string): string {
  const parts = downloadUrl.split('/documents/');
  return parts[1] as string;
}

suite('Document download — end to end over HTTP, unauthenticated by design (ADR-021 §5.1.3 / §9.7.17-18)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let storage: FileStorageProvider;
  let downloadTokens: DocumentDownloadTokenService;
  let platformAdminAuth: string;
  let platformAdminUserId: number;

  const MINTED_BY_TEST_ADMIN = 1;

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
    storage = moduleRef.get(FILE_STORAGE);
    downloadTokens = moduleRef.get(DocumentDownloadTokenService);

    const suffix = uniqueSuffix();
    const platformAdmin = await prisma.user.create({
      data: {
        firstName: '_Platform',
        lastName: 'Admin',
        phone: `_platadm-download-${suffix}`,
        role: 'platform_admin',
        companyId: null,
      },
    });
    const token = jwt.sign({ sub: platformAdmin.userId, role: 'platform_admin', type: 'access' });
    platformAdminAuth = `Bearer ${token}`;
    platformAdminUserId = platformAdmin.userId;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function companyFixture(suffix: string): Promise<number> {
    const municipality = await prisma.municipality.create({
      data: {
        name: `_DlMuni-${suffix}`,
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
        legalName: `_DlCo-${suffix}`,
        taxId: `_dl-${suffix}`,
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'pending',
        vehicleCount: 5,
        contactEmail: `contact-${suffix}@voyya-e2e.test`,
        contactFirstName: '_Contact',
        contactLastName: `Last${suffix}`,
        contactPhone: `_dl-contact-${suffix}`,
      },
    });
    return company.companyId;
  }

  async function documentFixture(
    companyId: number,
    body: Buffer,
  ): Promise<{ companyDocumentId: number; storageKey: string }> {
    const storageKey = `companies/${companyId}/chamber_of_commerce/${uniqueSuffix()}.pdf`;
    await storage.put({ key: storageKey, body, contentType: 'application/pdf' });
    const row = await prisma.runInTenant(companyId, (tx) =>
      tx.companyDocument.create({
        data: {
          companyId,
          type: 'chamber_of_commerce',
          storageKey,
          fileName: 'original-upload-name.pdf',
          contentType: 'application/pdf',
          sizeBytes: body.length,
        },
      }),
    );
    return { companyDocumentId: row.companyDocumentId, storageKey };
  }

  it('a platform_admin gets a download_url from the detail endpoint, and an UNAUTHENTICATED GET to it returns the exact bytes and all five headers', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    const body = Buffer.from('%PDF-1.4 real chamber of commerce bytes for e2e test');
    await documentFixture(companyId, body);

    const detail = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.documents).toHaveLength(1);
    const document = detail.body.documents[0];
    expect(typeof document.download_url).toBe('string');

    const token = tokenFromDownloadUrl(document.download_url as string);

    const download = await request(app.getHttpServer())
      .get(`/documents/${token}`)
      .buffer(true)
      .parse(bufferParser);

    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(body)).toBe(true);
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="chamber_of_commerce-${companyId}.pdf"`,
    );
    expect(download.headers['content-disposition']).not.toContain('original-upload-name.pdf');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(download.headers['referrer-policy']).toBe('no-referrer');
    expect(download.headers['cache-control']).toBe('private, no-store');
  }, 20_000);

  it('the download_url token carries mintedBy=the platform_admin who opened the detail view (C-18)', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    await documentFixture(companyId, Buffer.from('%PDF-1.4 traceability fixture'));

    const detail = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    const token = tokenFromDownloadUrl(detail.body.documents[0].download_url as string);

    const verification = downloadTokens.verify(token);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.payload.mintedBy).toBe(platformAdminUserId);
    }
  }, 20_000);

  it('a token with a tampered payload (different companyDocumentId, same old signature) -> 404 DOCUMENT_NOT_FOUND', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    const { companyDocumentId } = await documentFixture(companyId, Buffer.from('legit'));

    const validToken = downloadTokens.sign(companyDocumentId, companyId, MINTED_BY_TEST_ADMIN);
    const [body, signature] = validToken.split('.') as [string, string];
    const tamperedPayload = {
      companyDocumentId: companyDocumentId + 1,
      companyId,
      mintedBy: MINTED_BY_TEST_ADMIN,
      purpose: 'document_download',
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
    expect(tamperedBody).not.toBe(body);

    const res = await request(app.getHttpServer()).get(`/documents/${tamperedBody}.${signature}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  }, 20_000);

  it('an expired token (correctly signed, exp in the past) -> 404 DOCUMENT_NOT_FOUND, never 401', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    const { companyDocumentId } = await documentFixture(companyId, Buffer.from('legit'));

    const expiredTokens = new DocumentDownloadTokenService({
      get: (key: string) => (key === 'DOCUMENT_SIGNED_URL_TTL_SEC' ? -10 : process.env[key]),
    } as unknown as ConstructorParameters<typeof DocumentDownloadTokenService>[0]);
    const expiredToken = expiredTokens.sign(companyDocumentId, companyId, MINTED_BY_TEST_ADMIN);

    const res = await request(app.getHttpServer()).get(`/documents/${expiredToken}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  }, 20_000);

  it('a document deleted between minting the token and using it -> 404 DOCUMENT_NOT_FOUND, never the stale bytes', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    const { companyDocumentId } = await documentFixture(companyId, Buffer.from('about to be deleted'));

    const detail = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    const document = detail.body.documents[0];
    const token = tokenFromDownloadUrl(document.download_url as string);

    await prisma.runInTenant(companyId, (tx) =>
      tx.companyDocument.delete({ where: { companyDocumentId } }),
    );

    const res = await request(app.getHttpServer()).get(`/documents/${token}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  }, 20_000);

  it('cross-tenant: a token whose signed companyId does not match the real owner of that companyDocumentId never leaks company B\'s bytes to a request scoped as company A', async () => {
    const suffixA = uniqueSuffix();
    const suffixB = uniqueSuffix();
    const companyAId = await companyFixture(suffixA);
    const companyBId = await companyFixture(suffixB);
    const secretBBody = Buffer.from('company B secret chamber of commerce bytes');
    const { companyDocumentId: companyBDocumentId } = await documentFixture(companyBId, secretBBody);

    const crossTenantToken = downloadTokens.sign(companyBDocumentId, companyAId, MINTED_BY_TEST_ADMIN);

    const res = await request(app.getHttpServer())
      .get(`/documents/${crossTenantToken}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(404);
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  }, 20_000);

  it('detail() never touches the storage layer: with the document present but the file missing from disk, the detail call still succeeds and only the download fails', async () => {
    const suffix = uniqueSuffix();
    const companyId = await companyFixture(suffix);
    const { companyDocumentId, storageKey } = await documentFixture(companyId, Buffer.from('will vanish'));
    await storage.remove([storageKey]);

    const detail = await request(app.getHttpServer())
      .get(`/platform/companies/${companyId}`)
      .set('Authorization', platformAdminAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.documents[0].company_document_id).toBe(companyDocumentId);
    expect(typeof detail.body.documents[0].download_url).toBe('string');

    const token = tokenFromDownloadUrl(detail.body.documents[0].download_url as string);
    const download = await request(app.getHttpServer()).get(`/documents/${token}`);
    expect(download.status).toBe(404);
    expect(download.body).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  }, 20_000);
});
