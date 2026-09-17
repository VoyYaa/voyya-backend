import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('Admin console — settings: versioned fare + optimistic lock (ADR-014)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let companyId: number;
  let municipalityId: number;
  let adminAuth: string;

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
      where: { municipalityId: 9131 },
      update: {},
      create: {
        municipalityId: 9131,
        name: '_SettingsMuni',
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
    municipalityId = municipality.municipalityId;

    const company = await prisma.company.upsert({
      where: { taxId: '_settings-co' },
      update: { status: 'active' },
      create: {
        legalName: '_SettingsCo',
        taxId: '_settings-co',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    await prisma.fareConfig.create({
      data: {
        municipalityId,
        serviceType: 'taxi',
        baseFare: 8000,
        nightSurchargePct: 20,
        holidaySurchargePct: 15,
        commissionPct: 8,
      },
    });
    await prisma.systemParameter.upsert({
      where: { key_municipalityId: { key: 'search_radius_km', municipalityId } },
      update: { value: '2' },
      create: { key: 'search_radius_km', value: '2', municipalityId },
    });
    await prisma.systemParameter.upsert({
      where: { key_municipalityId: { key: 'acceptance_timeout_sec', municipalityId } },
      update: { value: '15' },
      create: { key: 'acceptance_timeout_sec', value: '15', municipalityId },
    });
    await prisma.systemParameter.upsert({
      where: { key_municipalityId: { key: 'expansion_radius_km', municipalityId } },
      update: { value: '6' },
      create: { key: 'expansion_radius_km', value: '6', municipalityId },
    });

    const adminUser = await prisma.user.upsert({
      where: { phone: '_9990000601' },
      update: { companyId, role: 'admin' },
      create: {
        firstName: '_Settings',
        lastName: 'Admin',
        phone: '_9990000601',
        role: 'admin',
        companyId,
      },
    });

    const token = jwt.sign({
      sub: adminUser.userId,
      role: 'admin',
      type: 'access',
      company_id: companyId,
    });
    adminAuth = `Bearer ${token}`;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function getSettings(): Promise<request.Response> {
    return request(app.getHttpServer()).get('/admin/settings').set('Authorization', adminAuth);
  }

  it('GET returns the seeded fare + parameters with a version string', async () => {
    const res = await getSettings();
    expect(res.status).toBe(200);
    expect(res.body.base_fare).toBe(8000);
    expect(res.body.search_radius_km).toBe(2);
    expect(res.body.expansion_radius_km).toBe(6);
    expect(res.body.version).toEqual(expect.any(String));
  });

  it('saving only the radius does not create a new fare_config version', async () => {
    const before = await getSettings();
    const fareRowsBefore = await prisma.fareConfig.count({ where: { municipalityId } });

    const res = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAuth)
      .send({
        version: before.body.version,
        base_fare: before.body.base_fare,
        night_surcharge_pct: before.body.night_surcharge_pct,
        holiday_surcharge_pct: before.body.holiday_surcharge_pct,
        search_radius_km: 3,
        acceptance_timeout_sec: before.body.acceptance_timeout_sec,
      });

    expect(res.status).toBe(200);
    expect(res.body.search_radius_km).toBe(3);
    const fareRowsAfter = await prisma.fareConfig.count({ where: { municipalityId } });
    expect(fareRowsAfter).toBe(fareRowsBefore);
  });

  it('changing the base fare creates a new version and getActiveFareConfig resolves to it', async () => {
    const before = await getSettings();

    const res = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAuth)
      .send({
        version: before.body.version,
        base_fare: 9500,
        night_surcharge_pct: before.body.night_surcharge_pct,
        holiday_surcharge_pct: before.body.holiday_surcharge_pct,
        search_radius_km: before.body.search_radius_km,
        acceptance_timeout_sec: before.body.acceptance_timeout_sec,
      });

    expect(res.status).toBe(200);
    expect(res.body.base_fare).toBe(9500);

    const active = await prisma.fareConfig.findFirst({
      where: { municipalityId, serviceType: 'taxi', validTo: null },
    });
    expect(Number(active?.baseFare)).toBe(9500);

    const closed = await prisma.fareConfig.count({
      where: { municipalityId, serviceType: 'taxi', validTo: { not: null } },
    });
    expect(closed).toBeGreaterThan(0);
  });

  it('a stale version -> 409 SETTINGS_CONFLICT, zero writes', async () => {
    const current = await getSettings();
    const paramsBefore = await prisma.systemParameter.findMany({ where: { municipalityId } });

    const res = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAuth)
      .send({
        version: 'fc:1|sp:1',
        base_fare: 12345,
        night_surcharge_pct: current.body.night_surcharge_pct,
        holiday_surcharge_pct: current.body.holiday_surcharge_pct,
        search_radius_km: current.body.search_radius_km,
        acceptance_timeout_sec: current.body.acceptance_timeout_sec,
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SETTINGS_CONFLICT' });

    const paramsAfter = await prisma.systemParameter.findMany({ where: { municipalityId } });
    expect(paramsAfter).toEqual(paramsBefore);
    const stillCurrent = await getSettings();
    expect(stillCurrent.body.base_fare).toBe(current.body.base_fare);
  });

  it('search_radius_km above expansion_radius_km -> 422 SETTINGS_OUT_OF_RANGE on that field', async () => {
    const current = await getSettings();

    const res = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAuth)
      .send({
        version: current.body.version,
        base_fare: current.body.base_fare,
        night_surcharge_pct: current.body.night_surcharge_pct,
        holiday_surcharge_pct: current.body.holiday_surcharge_pct,
        search_radius_km: current.body.expansion_radius_km + 1,
        acceptance_timeout_sec: current.body.acceptance_timeout_sec,
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'SETTINGS_OUT_OF_RANGE', field: 'search_radius_km' });
  });
});
