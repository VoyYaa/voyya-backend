import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  createCompany,
  createMunicipality,
  createPlatformAdmin,
  openFares,
  seedCommission,
  seedOpenFare,
  tokenFor,
} from './support/platform-fixtures';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_SettingsMuni';

suite('Company console settings are read-only: the platform owns fare, parameters and commission (ADR-032 §7.4, §8.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAuth: string;
  let municipalityId: number;
  let companyAId: number;
  let companyBId: number;
  let adminAAuth: string;
  let operatorAAuth: string;
  let adminBAuth: string;

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
    platformAuth = (await createPlatformAdmin(prisma, jwt, 'settings')).auth;

    municipalityId = await createMunicipality(prisma, PREFIX);
    companyAId = await createCompany(prisma, municipalityId, { status: 'active', publicName: 'Taxis A' });
    companyBId = await createCompany(prisma, municipalityId, { status: 'active' });
    await seedOpenFare(prisma, municipalityId, 'taxi', 8000);
    await seedCommission(prisma, companyAId, 8);
    await seedCommission(prisma, companyBId, 12.5);
    adminAAuth = tokenFor(jwt, 'admin', companyAId);
    operatorAAuth = tokenFor(jwt, 'operator', companyAId);
    adminBAuth = tokenFor(jwt, 'admin', companyBId);
  }, 30_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    if (app) await app.close();
  }, 60_000);

  function settingsOf(auth: string) {
    return request(app.getHttpServer()).get('/admin/settings').set('Authorization', auth);
  }

  it('GET shows the municipality fare, the nine parameters and the own commission, read-only', async () => {
    const res = await settingsOf(adminAAuth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      read_only: true,
      service_type: 'taxi',
      base_fare: 8000,
      night_surcharge_pct: 20,
      holiday_surcharge_pct: 15,
      commission_pct: 8,
      fare_is_official: false,
      fare_official_reference: null,
      search_radius_km: 2,
      expansion_radius_km: 6,
      acceptance_timeout_sec: 15,
      cancellation_window_min: 2,
      no_show_grace_min: 5,
    });
    expect(res.body.version).toMatch(/^mf:\d+\|op:\d+$/);
    expect(res.body.fare_valid_from).toEqual(expect.any(String));
    for (const key of ['max_auto_retries', 'tiebreak_window_hours', 'location_stale_min', 'avg_speed_kmh']) {
      expect(typeof res.body[key]).toBe('number');
    }
  });

  it('the two companies of one municipality see the same fare and each its own commission', async () => {
    const a = await settingsOf(adminAAuth);
    const b = await settingsOf(adminBAuth);

    expect(a.body.base_fare).toBe(b.body.base_fare);
    expect(a.body.version).toBe(b.body.version);
    expect(a.body.commission_pct).toBe(8);
    expect(b.body.commission_pct).toBe(12.5);
  });

  it('PUT answers 403 SETTINGS_MANAGED_BY_PLATFORM to the admin and writes nothing', async () => {
    const before = await settingsOf(adminAAuth);
    const faresBefore = await prisma.municipalityFare.count({ where: { municipalityId } });

    const res = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAAuth)
      .send({
        version: before.body.version,
        base_fare: 1_000_000,
        night_surcharge_pct: 99,
        holiday_surcharge_pct: 99,
        search_radius_km: 3,
        acceptance_timeout_sec: 20,
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'SETTINGS_MANAGED_BY_PLATFORM',
      message: 'La tarifa y los parámetros los administra VoyYa para todo el municipio.',
    });
    expect(await prisma.municipalityFare.count({ where: { municipalityId } })).toBe(faresBefore);
    expect((await settingsOf(adminAAuth)).body).toEqual(before.body);
  });

  it('PUT with an empty or malformed body is still 403, never a validation error', async () => {
    const empty = await request(app.getHttpServer()).put('/admin/settings').set('Authorization', adminAAuth).send({});
    const garbage = await request(app.getHttpServer())
      .put('/admin/settings')
      .set('Authorization', adminAAuth)
      .send({ base_fare: 'free' });
    expect(empty.status).toBe(403);
    expect(garbage.status).toBe(403);
  });

  it('the operator gets 403 FORBIDDEN on GET and on PUT: settings are an admin screen', async () => {
    const read = await settingsOf(operatorAAuth);
    const write = await request(app.getHttpServer()).put('/admin/settings').set('Authorization', operatorAAuth).send({});
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a platform edit shows up on the company screen with a new version and the official mark', async () => {
    const before = await settingsOf(adminAAuth);
    const current = (await openFares(prisma, municipalityId))[0];

    const edit = await request(app.getHttpServer())
      .put(`/platform/municipalities/${municipalityId}/services/taxi/fare`)
      .set('Authorization', platformAuth)
      .send({
        version: current?.municipalityFareId,
        base_fare: 8500,
        night_surcharge_pct: 25,
        holiday_surcharge_pct: 18,
        is_official: true,
        official_reference: 'Decreto 045 de 2026',
      });
    expect(edit.status).toBe(200);

    const after = await settingsOf(adminAAuth);
    expect(after.body).toMatchObject({
      base_fare: 8500,
      night_surcharge_pct: 25,
      holiday_surcharge_pct: 18,
      fare_is_official: true,
      fare_official_reference: 'Decreto 045 de 2026',
    });
    expect(after.body.version).not.toBe(before.body.version);
  });

  it('a company without a municipality fare answers 404 FARE_CONFIG_NOT_FOUND', async () => {
    const emptyMunicipality = await createMunicipality(prisma, PREFIX);
    const lonelyId = await createCompany(prisma, emptyMunicipality, { status: 'active' });

    const res = await settingsOf(tokenFor(jwt, 'admin', lonelyId));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'FARE_CONFIG_NOT_FOUND' });
  });

  it('GET /admin/company-profile shows the display name, the declared services and the coverage state', async () => {
    const withPublicName = await request(app.getHttpServer())
      .get('/admin/company-profile')
      .set('Authorization', adminAAuth);
    const withoutPublicName = await request(app.getHttpServer())
      .get('/admin/company-profile')
      .set('Authorization', operatorAAuth);

    expect(withPublicName.status).toBe(200);
    expect(withPublicName.body).toMatchObject({
      company_id: companyAId,
      display_name: 'Taxis A',
      service_types: ['taxi'],
      municipality_coverage_active: true,
    });
    expect(withoutPublicName.status).toBe(200);

    const catalogMunicipality = await createMunicipality(prisma, PREFIX, { status: 'catalog' });
    const pendingCoverage = await createCompany(prisma, catalogMunicipality, { status: 'active', legalName: '_PendingCoverage' });
    const profile = await request(app.getHttpServer())
      .get('/admin/company-profile')
      .set('Authorization', tokenFor(jwt, 'admin', pendingCoverage));
    expect(profile.body).toMatchObject({ display_name: '_PendingCoverage', municipality_coverage_active: false });
  });
});
