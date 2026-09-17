import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const ADMIN_EMAIL = '_lockout-admin@voyya-e2e.test';
const ADMIN_PASSWORD = 'CorrectHorse1!';

suite('Admin login — per-account lockout (B-03 item 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminUserId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOGIN_MAX_ATTEMPTS = '2';
    process.env.LOGIN_BLOCK_MINUTES = '15';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9171 },
      update: {},
      create: {
        municipalityId: 9171,
        name: '_LockoutMuni',
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
      where: { taxId: '_lockout-co' },
      update: { status: 'active' },
      create: {
        legalName: '_LockoutCo',
        taxId: '_lockout-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 4);
    const admin = await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: {
        passwordHash,
        role: 'admin',
        accountStatus: 'active',
        companyId: company.companyId,
        failedAttempts: 0,
        blockedUntil: null,
      },
      create: {
        firstName: '_Lockout',
        lastName: 'Admin',
        email: ADMIN_EMAIL,
        phone: '_lockout-admin-phone',
        passwordHash,
        role: 'admin',
        companyId: company.companyId,
      },
    });
    adminUserId = admin.userId;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function login(password: string) {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: ADMIN_EMAIL, password });
  }

  it('wrong password below the cap -> 401 INVALID_CREDENTIALS', async () => {
    const res = await login('wrong-pw-1');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('wrong password reaching LOGIN_MAX_ATTEMPTS -> 429 ACCOUNT_TEMPORARILY_BLOCKED', async () => {
    const res = await login('wrong-pw-2');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_BLOCKED' });

    const row = await prisma.user.findUnique({ where: { userId: adminUserId } });
    expect(row?.blockedUntil).not.toBeNull();
  });

  it('the correct password while blocked -> still 429, not 200 (no password timing oracle)', async () => {
    const res = await login(ADMIN_PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_BLOCKED' });
  });

  it('once the block window has elapsed, the correct password succeeds and attempts reset', async () => {
    await prisma.user.update({
      where: { userId: adminUserId },
      data: { blockedUntil: new Date(Date.now() - 1000) },
    });

    const res = await login(ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');

    const row = await prisma.user.findUnique({ where: { userId: adminUserId } });
    expect(row?.failedAttempts).toBe(0);
    expect(row?.blockedUntil).toBeNull();
  });
});
