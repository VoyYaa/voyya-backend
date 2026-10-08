import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const ORIGIN = 'https://admin.voyya.test';

suite('CORS exposes Content-Disposition to the console (reconciliation CSV filename)', () => {
  let app: NestExpressApplication;
  let adminAuth: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.CORS_ORIGINS = ORIGIN;
    process.env.LOCATION_PURGE_HOURS = '0';
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/main');
    const { EnvService } = await import('../src/config/env.service');
    const { requestContext } = await import('../src/infrastructure/observability/request-context.service');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, app.get(EnvService), requestContext);
    await app.init();

    const prisma = moduleRef.get(PrismaService);
    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9161 },
      update: {},
      create: {
        municipalityId: 9161,
        name: '_CorsMuni',
        department: 'Test',
        coveragePolygon: {
          type: 'Polygon',
          coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
        status: 'active',
      },
    });
    const company = await prisma.company.upsert({
      where: { taxId: '_cors-co' },
      update: { status: 'active' },
      create: {
        legalName: '_CorsCo',
        taxId: '_cors-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    const admin = await prisma.user.upsert({
      where: { phone: '_cors-admin' },
      update: {},
      create: {
        firstName: '_Cors',
        lastName: 'Admin',
        phone: '_cors-admin',
        role: 'admin',
        companyId: company.companyId,
      },
    });
    const jwt = moduleRef.get(JwtService, { strict: false });
    adminAuth = `Bearer ${jwt.sign({ sub: admin.userId, role: 'admin', type: 'access', company_id: company.companyId })}`;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  }, 20_000);

  it('lists Content-Disposition in Access-Control-Expose-Headers and sends the filename', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/reports/settlement/export')
      .query({ from: '2026-10-05', to: '2026-10-11' })
      .set('Origin', ORIGIN)
      .set('Authorization', adminAuth)
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.csv"$/);
  });
});
