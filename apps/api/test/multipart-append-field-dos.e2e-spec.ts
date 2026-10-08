import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const MAX_RESPONSE_MS = 5_000;
const SMALL_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

suite('Multipart append-field DoS (CM-01, GHSA-535w-7cp7-47q4)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a hostile sparse-index multipart body quickly and keeps the app healthy', async () => {
    const startedAt = Date.now();

    const res = await request(app.getHttpServer())
      .post('/affiliation/documents')
      .field('items[4294967294]', 'x')
      .field('items[foo]', 'y');

    expect(Date.now() - startedAt).toBeLessThan(MAX_RESPONSE_MS);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const health = await request(app.getHttpServer()).get('/health/db');
    expect(health.status).toBe(200);
  }, 20_000);

  it('still accepts a legitimate small PDF upload', async () => {
    const res = await request(app.getHttpServer())
      .post('/affiliation/documents')
      .attach('file', SMALL_PDF, { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
  }, 20_000);
});
