import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { RefreshResponse, SessionResponse } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PASSWORD = 'CorrectHorse1!';
const ADMIN_A_EMAIL = '_tenant-identity-admin-a@voyya-e2e.test';
const ADMIN_B_EMAIL = '_tenant-identity-admin-b@voyya-e2e.test';

const poly = {
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

suite('Auth session — tenant identity travels with the session (ADR-012 §2 bis / §8.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let municipalityId: number;
  let municipalityName: string;
  let companyAId: number;
  let companyALegalName: string;
  let companyBId: number;
  let companyBLegalName: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9165 },
      update: {},
      create: {
        municipalityId: 9165,
        name: '_TenantIdentityMuni',
        department: 'Test',
        coveragePolygon: poly,
        status: 'active',
      },
    });
    municipalityId = municipality.municipalityId;
    municipalityName = municipality.name;

    const companyA = await prisma.company.upsert({
      where: { taxId: '_tenant-identity-co-a' },
      update: { status: 'active', legalName: '_TenantIdentityCoA' },
      create: {
        legalName: '_TenantIdentityCoA',
        taxId: '_tenant-identity-co-a',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyAId = companyA.companyId;
    companyALegalName = companyA.legalName;

    const companyB = await prisma.company.upsert({
      where: { taxId: '_tenant-identity-co-b' },
      update: { status: 'active', legalName: '_TenantIdentityCoB' },
      create: {
        legalName: '_TenantIdentityCoB',
        taxId: '_tenant-identity-co-b',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyBId = companyB.companyId;
    companyBLegalName = companyB.legalName;

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    await prisma.user.upsert({
      where: { email: ADMIN_A_EMAIL },
      update: {
        passwordHash,
        role: 'admin',
        accountStatus: 'active',
        companyId: companyAId,
        failedAttempts: 0,
        blockedUntil: null,
      },
      create: {
        firstName: '_TenantIdentity',
        lastName: 'AdminA',
        email: ADMIN_A_EMAIL,
        phone: '_tenant-identity-admin-a-phone',
        passwordHash,
        role: 'admin',
        companyId: companyAId,
      },
    });
    await prisma.user.upsert({
      where: { email: ADMIN_B_EMAIL },
      update: {
        passwordHash,
        role: 'admin',
        accountStatus: 'active',
        companyId: companyBId,
        failedAttempts: 0,
        blockedUntil: null,
      },
      create: {
        firstName: '_TenantIdentity',
        lastName: 'AdminB',
        email: ADMIN_B_EMAIL,
        phone: '_tenant-identity-admin-b-phone',
        passwordHash,
        role: 'admin',
        companyId: companyBId,
      },
    });
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function login(email: string) {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: PASSWORD });
  }

  describe('contract conformance', () => {
    it('POST /auth/admin/login response satisfies SessionResponse', async () => {
      const res = await login(ADMIN_A_EMAIL);
      expect(res.status).toBe(200);
      expect(() => SessionResponse.parse(res.body)).not.toThrow();
    });

    it('POST /auth/refresh response satisfies RefreshResponse', async () => {
      const loginRes = await login(ADMIN_A_EMAIL);
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refresh_token: loginRes.body.tokens.refresh_token });

      expect(res.status).toBe(200);
      expect(() => RefreshResponse.parse(res.body)).not.toThrow();
    });
  });

  describe('two companies in the same municipality never cross tenant identity', () => {
    it("admin A's session carries company A's legal_name and admin B's carries B's — compared against what was seeded, never a hardcoded string", async () => {
      const resA = await login(ADMIN_A_EMAIL);
      const resB = await login(ADMIN_B_EMAIL);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resA.body.user.tenant).toEqual({
        company_id: companyAId,
        company_name: companyALegalName,
        municipality_id: municipalityId,
        municipality_name: municipalityName,
      });
      expect(resB.body.user.tenant).toEqual({
        company_id: companyBId,
        company_name: companyBLegalName,
        municipality_id: municipalityId,
        municipality_name: municipalityName,
      });
      expect(resA.body.user.tenant.company_name).not.toBe(resB.body.user.tenant.company_name);
    });
  });
});
