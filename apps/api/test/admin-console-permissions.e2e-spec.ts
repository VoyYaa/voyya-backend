import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('Admin console — permission matrix per controller (ADR-012 §4/§8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let companyId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9101 },
      update: {},
      create: {
        municipalityId: 9101,
        name: '_PermMuni',
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

    const company = await prisma.company.upsert({
      where: { taxId: '_perm-matrix-co' },
      update: { status: 'active' },
      create: {
        legalName: '_PermCo',
        taxId: '_perm-matrix-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function bearer(payload: { sub: number; role: string; companyId?: number }): string {
    const token = jwt.sign({
      sub: payload.sub,
      role: payload.role,
      type: 'access',
      ...(payload.companyId !== undefined ? { company_id: payload.companyId } : {}),
    });
    return `Bearer ${token}`;
  }

  const operatorAuth = () => bearer({ sub: 900001, role: 'operator', companyId });
  const driverAuth = () => bearer({ sub: 900002, role: 'driver', companyId });

  describe('operator (read-only role)', () => {
    it('POST /admin/drivers -> 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', operatorAuth())
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('PUT /admin/settings -> 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .put('/admin/settings')
        .set('Authorization', operatorAuth())
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('GET /admin/settings -> 403 FORBIDDEN (whole controller is admin-only)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', operatorAuth());
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('GET /ops/trip-requests -> 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/trip-requests')
        .set('Authorization', operatorAuth());
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      expect(res.body.server_time).toEqual(expect.any(String));
    });

    it('GET /ops/drivers -> 200', async () => {
      const res = await request(app.getHttpServer())
        .get('/ops/drivers')
        .set('Authorization', operatorAuth());
      expect(res.status).toBe(200);
    });
  });

  describe('driver (not staff) hitting all eight console routes', () => {
    it.each([
      ['post', '/admin/drivers'],
      ['post', '/admin/drivers/1/pin/resend'],
      ['get', '/admin/settings'],
      ['put', '/admin/settings'],
      ['get', '/ops/trip-requests'],
      ['get', '/ops/trip-requests/1'],
      ['get', '/ops/drivers'],
      ['get', '/ops/drivers/1'],
    ] as const)('%s %s -> 403 FORBIDDEN', async (method, path) => {
      const res = await request(app.getHttpServer())
        [method](path)
        .set('Authorization', driverAuth())
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('no token at all', () => {
    it('GET /ops/trip-requests without Authorization -> 401 SESSION_REQUIRED', async () => {
      const res = await request(app.getHttpServer()).get('/ops/trip-requests');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    });
  });
});
