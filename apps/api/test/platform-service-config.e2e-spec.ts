import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  commissionsOf,
  createCompany,
  createMunicipality,
  createPlatformAdmin,
  openFares,
  seedCommission,
  seedOpenFare,
  tokenFor,
} from './support/platform-fixtures';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_PlatCfgMuni';

const FARE_BODY = {
  base_fare: 9500,
  night_surcharge_pct: 22,
  holiday_surcharge_pct: 16,
  is_official: false,
};

const PARAMS_BODY = {
  search_radius_km: 3,
  expansion_radius_km: 8,
  acceptance_timeout_sec: 20,
  max_auto_retries: 4,
  tiebreak_window_hours: 5,
  location_stale_min: 10,
  avg_speed_kmh: 25,
  cancellation_window_min: 3,
  no_show_grace_min: 6,
};

suite('Platform service configuration: fare, operational parameters and commission (HU-MS-10, HU-MS-15, ADR-032 §4, §8.4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let platformAuth: string;
  let platformUserId: number;
  let otherPlatformAuth: string;

  let municipalityId: number;
  let companyAId: number;
  let companyBId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '15';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    const admin = await createPlatformAdmin(prisma, jwt, 'platcfg');
    platformAuth = admin.auth;
    platformUserId = admin.userId;
    otherPlatformAuth = (await createPlatformAdmin(prisma, jwt, 'platcfg2')).auth;

    municipalityId = await createMunicipality(prisma, PREFIX);
    companyAId = await createCompany(prisma, municipalityId, { status: 'active', legalName: '_PlatCfgA', publicName: 'Taxis A' });
    companyBId = await createCompany(prisma, municipalityId, { status: 'active', legalName: '_PlatCfgB' });
    await seedOpenFare(prisma, municipalityId, 'taxi', 8000);
    await seedCommission(prisma, companyAId, 8);
    await seedCommission(prisma, companyBId, 10);
  }, 30_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
    if (app) await app.close();
  }, 60_000);

  const base = () => `/platform/municipalities/${municipalityId}/services/taxi`;

  function asPlatform(method: 'get' | 'put', path: string, auth = platformAuth) {
    return request(app.getHttpServer())[method](path).set('Authorization', auth);
  }

  async function currentFareId(): Promise<number> {
    return (await openFares(prisma, municipalityId))[0]?.municipalityFareId ?? 0;
  }

  describe('who may call it (HU-MS-10, HU-MS-15)', () => {
    const routes: Array<[string, 'get' | 'put', () => string, Record<string, unknown>?]> = [
      ['GET service-configs', 'get', () => '/platform/service-configs'],
      ['GET fare history', 'get', () => `${base()}/fare`],
      ['PUT fare', 'put', () => `${base()}/fare`, { version: 1, ...FARE_BODY }],
      ['GET operational params', 'get', () => `${base()}/operational-params`],
      ['PUT operational params', 'put', () => `${base()}/operational-params`, { version: null, ...PARAMS_BODY }],
      ['GET commissions', 'get', () => '/platform/commissions'],
      ['GET commission history', 'get', () => `/platform/companies/${companyAId}/commission`],
      ['PUT commission', 'put', () => `/platform/companies/${companyAId}/commission`, { version: 1, commission_pct: 1 }],
    ];

    it.each(['admin', 'operator', 'passenger', 'driver'] as const)(
      'a %s gets 403 on every platform configuration route and nothing changes',
      async (role) => {
        const faresBefore = await prisma.municipalityFare.count({ where: { municipalityId } });
        const paramsBefore = await prisma.municipalityOperationalParams.count({ where: { municipalityId } });
        const commissionsBefore = (await commissionsOf(prisma, companyAId)).length;
        const auth = tokenFor(jwt, role as 'admin', role === 'admin' || role === 'operator' ? companyAId : null);

        for (const [label, method, path, body] of routes) {
          const res = await (body
            ? request(app.getHttpServer())[method](path()).set('Authorization', auth).send(body)
            : request(app.getHttpServer())[method](path()).set('Authorization', auth));
          expect([label, res.status]).toEqual([label, 403]);
          expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
        }

        expect(await prisma.municipalityFare.count({ where: { municipalityId } })).toBe(faresBefore);
        expect(await prisma.municipalityOperationalParams.count({ where: { municipalityId } })).toBe(paramsBefore);
        expect((await commissionsOf(prisma, companyAId)).length).toBe(commissionsBefore);
      },
    );

    it('without a session every route answers 401', async () => {
      for (const [, method, path] of routes) {
        const res = await request(app.getHttpServer())[method](path());
        expect(res.status).toBe(401);
      }
    });
  });

  describe('GET /platform/service-configs', () => {
    it('lists the municipality of the active companies with its fare, its parameters in effect and the company count', async () => {
      const res = await asPlatform('get', `/platform/service-configs?municipality_id=${municipalityId}`);

      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({
        municipality_id: municipalityId,
        service_type: 'taxi',
        active_company_count: 2,
        coverage_active: true,
        dane_code: null,
        fare: expect.objectContaining({ base_fare: 8000, is_official: false, valid_to: null }),
      });
      expect(res.body.rows[0].operational_params).toMatchObject({
        operational_params_id: null,
        search_radius_km: 2,
        expansion_radius_km: 6,
        cancellation_window_min: 2,
        origin: null,
      });
      expect(res.body.rows[0].operational_params.platform_default_keys).toHaveLength(9);
    });

    it('omits municipalities without active companies and does not count suspended ones', async () => {
      const idleMunicipality = await createMunicipality(prisma, PREFIX);
      await createCompany(prisma, idleMunicipality, { status: 'suspended' });
      await createCompany(prisma, idleMunicipality, { status: 'pending' });

      const res = await asPlatform('get', `/platform/service-configs?municipality_id=${idleMunicipality}`);

      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
    });

    it('only offers the active services: comfort and motorcycle never appear', async () => {
      const res = await asPlatform('get', '/platform/service-configs');
      const services = new Set((res.body.rows as Array<{ service_type: string }>).map((r) => r.service_type));
      expect([...services]).toEqual(['taxi']);
    });

    it('rejects a malformed municipality filter with 400', async () => {
      const res = await asPlatform('get', '/platform/service-configs?municipality_id=abc');
      expect(res.status).toBe(400);
    });
  });

  describe('fare versions (HU-MS-10)', () => {
    it('saving creates a new open version, closes the previous one without gaps and keeps it in the history', async () => {
      const oldId = await currentFareId();

      const res = await asPlatform('put', `${base()}/fare`).send({ version: oldId, ...FARE_BODY });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        municipality_id: municipalityId,
        service_type: 'taxi',
        base_fare: 9500,
        night_surcharge_pct: 22,
        holiday_surcharge_pct: 16,
        is_official: false,
        official_reference: null,
        origin: 'platform_edit',
        valid_to: null,
        created_by: { user_id: platformUserId },
      });
      expect(res.body.municipality_fare_id).toBeGreaterThan(oldId);
      const closed = await prisma.municipalityFare.findUnique({ where: { municipalityFareId: oldId } });
      expect(closed?.validTo).not.toBeNull();
      expect(closed?.validTo?.toISOString()).toBe(res.body.valid_from);
      expect(Number(closed?.baseFare)).toBe(8000);
      expect(await openFares(prisma, municipalityId)).toHaveLength(1);
    });

    it('the history lists snapshots, newest first, with author and a current version', async () => {
      const res = await asPlatform('get', `${base()}/fare`);

      expect(res.status).toBe(200);
      expect(res.body.server_time).toEqual(expect.any(String));
      expect(res.body.current).toMatchObject({ base_fare: 9500, valid_to: null });
      const versions = res.body.versions as Array<{ municipality_fare_id: number; valid_to: string | null }>;
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions[0]?.municipality_fare_id).toBe(res.body.current.municipality_fare_id);
      const ids = versions.map((v) => v.municipality_fare_id);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
      expect(versions.filter((v) => v.valid_to === null)).toHaveLength(1);
    });

    it('changing only the official mark or the reference also creates a version', async () => {
      const before = await currentFareId();

      const marked = await asPlatform('put', `${base()}/fare`).send({
        version: before,
        ...FARE_BODY,
        is_official: true,
        official_reference: 'Decreto 045 de 2026',
      });
      const renamed = await asPlatform('put', `${base()}/fare`).send({
        version: marked.body.municipality_fare_id,
        ...FARE_BODY,
        is_official: true,
        official_reference: 'Decreto 046 de 2026',
      });
      const unmarked = await asPlatform('put', `${base()}/fare`).send({
        version: renamed.body.municipality_fare_id,
        ...FARE_BODY,
        is_official: false,
      });

      expect(marked.status).toBe(200);
      expect(marked.body).toMatchObject({ is_official: true, official_reference: 'Decreto 045 de 2026' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.official_reference).toBe('Decreto 046 de 2026');
      expect(unmarked.status).toBe(200);
      expect(unmarked.body).toMatchObject({ is_official: false, official_reference: null });
      expect(new Set([before, marked.body.municipality_fare_id, renamed.body.municipality_fare_id, unmarked.body.municipality_fare_id]).size).toBe(4);
    });

    it('ten consecutive edits without any pause never violate the validity of a version', async () => {
      let version = await currentFareId();
      for (let index = 0; index < 10; index += 1) {
        const res = await asPlatform('put', `${base()}/fare`).send({ version, ...FARE_BODY, base_fare: 9600 + index });
        expect(res.status).toBe(200);
        version = res.body.municipality_fare_id;
      }
      const rows = await prisma.municipalityFare.findMany({
        where: { municipalityId },
        orderBy: { municipalityFareId: 'asc' },
      });
      for (const row of rows) {
        if (row.validTo) expect(row.validTo.getTime()).toBeGreaterThanOrEqual(row.validFrom.getTime());
      }
      expect(rows.filter((r) => r.validTo === null)).toHaveLength(1);
    });

    it('the history pages with before and limit', async () => {
      const first = await asPlatform('get', `${base()}/fare?limit=3`);
      expect(first.status).toBe(200);
      expect(first.body.versions).toHaveLength(3);
      expect(first.body.next_before).toBe(first.body.versions[2].municipality_fare_id);

      const second = await asPlatform('get', `${base()}/fare?limit=3&before=${first.body.next_before}`);
      expect(second.body.versions[0].municipality_fare_id).toBeLessThan(first.body.next_before);
      const firstIds = new Set(first.body.versions.map((v: { municipality_fare_id: number }) => v.municipality_fare_id));
      for (const version of second.body.versions) {
        expect(firstIds.has(version.municipality_fare_id)).toBe(false);
      }
    });

    it('two concurrent saves with the same version: one 200, one 409 SETTINGS_CONFLICT naming the winner, one open version', async () => {
      const version = await currentFareId();

      const [first, second] = await Promise.all([
        asPlatform('put', `${base()}/fare`).send({ version, ...FARE_BODY, base_fare: 12_000 }),
        asPlatform('put', `${base()}/fare`, otherPlatformAuth).send({ version, ...FARE_BODY, base_fare: 13_000 }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const winner = first.status === 200 ? first : second;
      const loser = first.status === 409 ? first : second;
      expect(loser.body).toMatchObject({
        code: 'SETTINGS_CONFLICT',
        current_version: winner.body.municipality_fare_id,
        current_author_name: expect.stringContaining('_Platform'),
      });
      expect(await openFares(prisma, municipalityId)).toHaveLength(1);
    });

    it('a stale version answers 409 SETTINGS_CONFLICT with the current version and does not write', async () => {
      const count = await prisma.municipalityFare.count({ where: { municipalityId } });
      const current = await currentFareId();

      const res = await asPlatform('put', `${base()}/fare`).send({ version: current - 1, ...FARE_BODY });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SETTINGS_CONFLICT', current_version: current });
      expect(await prisma.municipalityFare.count({ where: { municipalityId } })).toBe(count);
    });

    it.each([
      ['a base fare under 1.000', { base_fare: 999 }],
      ['a base fare over 1.000.000', { base_fare: 1_000_001 }],
      ['a fractional base fare', { base_fare: 9000.5 }],
      ['a night surcharge over 100', { night_surcharge_pct: 100.5 }],
      ['a negative holiday surcharge', { holiday_surcharge_pct: -1 }],
      ['a reference longer than 120 characters', { is_official: true, official_reference: 'x'.repeat(121) }],
      ['a reference shorter than 3 characters', { is_official: true, official_reference: 'ab' }],
      ['a missing version', { version: undefined }],
    ])('%s is rejected with 400 and nothing is saved', async (_label, override) => {
      const count = await prisma.municipalityFare.count({ where: { municipalityId } });

      const res = await asPlatform('put', `${base()}/fare`).send({ version: await currentFareId(), ...FARE_BODY, ...override });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
      expect(await prisma.municipalityFare.count({ where: { municipalityId } })).toBe(count);
    });

    it('a reference on a fare that is not official is a 422 SETTINGS_OUT_OF_RANGE on that field', async () => {
      const res = await asPlatform('put', `${base()}/fare`).send({
        version: await currentFareId(),
        ...FARE_BODY,
        is_official: false,
        official_reference: 'Decreto 12 de 2026',
      });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'SETTINGS_OUT_OF_RANGE', field: 'official_reference' });
    });

    it('a municipality without a fare answers 404 FARE_NOT_FOUND, and an unknown one 404 MUNICIPALITY_NOT_FOUND', async () => {
      const bareMunicipality = await createMunicipality(prisma, PREFIX);
      const bare = await asPlatform('put', `/platform/municipalities/${bareMunicipality}/services/taxi/fare`).send({
        version: 1,
        ...FARE_BODY,
      });
      const unknown = await asPlatform('put', '/platform/municipalities/999999999/services/taxi/fare').send({
        version: 1,
        ...FARE_BODY,
      });
      const unknownHistory = await asPlatform('get', '/platform/municipalities/999999999/services/taxi/fare');

      expect(bare.status).toBe(404);
      expect(bare.body).toMatchObject({ code: 'FARE_NOT_FOUND' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'MUNICIPALITY_NOT_FOUND' });
      expect(unknownHistory.status).toBe(404);
    });

    it('an inactive service answers 409 SERVICE_NOT_AVAILABLE and motorcycle or an unknown one 400', async () => {
      const comfort = await asPlatform('put', `/platform/municipalities/${municipalityId}/services/comfort/fare`).send({
        version: 1,
        ...FARE_BODY,
      });
      const comfortHistory = await asPlatform('get', `/platform/municipalities/${municipalityId}/services/comfort/fare`);
      const motorcycle = await asPlatform('put', `/platform/municipalities/${municipalityId}/services/motorcycle/fare`).send({
        version: 1,
        ...FARE_BODY,
      });
      const unknown = await asPlatform('get', `/platform/municipalities/${municipalityId}/services/bus/fare`);

      expect(comfort.status).toBe(409);
      expect(comfort.body).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
      expect(comfortHistory.status).toBe(409);
      expect(motorcycle.status).toBe(400);
      expect(unknown.status).toBe(400);
    });

    it('the platform session does not leak: right after a platform write a company request still reads only its own scope', async () => {
      const adminA = tokenFor(jwt, 'admin', companyAId);
      const direct = await request(app.getHttpServer()).get('/admin/settings').set('Authorization', adminA);
      expect(direct.status).toBe(200);
      expect(direct.body.commission_pct).toBe(8);
      const adminB = tokenFor(jwt, 'admin', companyBId);
      expect((await request(app.getHttpServer()).get('/admin/settings').set('Authorization', adminB)).body.commission_pct).toBe(10);
    });
  });

  describe('operational parameters (HU-MS-10, P-12, H-2)', () => {
    const paramsMunicipality = async () => createMunicipality(prisma, PREFIX);

    it('before any save shows the values in force, with the nine keys flagged as platform defaults and the cancellation window from the environment', async () => {
      const bare = await paramsMunicipality();
      await createCompany(prisma, bare, { status: 'active' });

      const res = await asPlatform('get', `/platform/municipalities/${bare}/services/taxi/operational-params`);

      expect(res.status).toBe(200);
      expect(res.body.current).toMatchObject({
        operational_params_id: null,
        municipality_id: bare,
        search_radius_km: 2,
        expansion_radius_km: 6,
        acceptance_timeout_sec: 15,
        cancellation_window_min: 2,
        no_show_grace_min: 5,
        origin: null,
        valid_from: null,
        created_by: null,
      });
      expect(res.body.current.platform_default_keys).toContain('cancellation_window_min');
      expect(res.body.current.platform_default_keys).toHaveLength(9);
      expect(res.body.versions).toEqual([]);
    });

    it('the first save fixes all nine values with version null and a second one with null is a 409', async () => {
      const target = await paramsMunicipality();
      await createCompany(prisma, target, { status: 'active' });
      const path = `/platform/municipalities/${target}/services/taxi/operational-params`;

      const first = await asPlatform('put', path).send({ version: null, ...PARAMS_BODY });
      const again = await asPlatform('put', path).send({ version: null, ...PARAMS_BODY });

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        ...PARAMS_BODY,
        platform_default_keys: [],
        origin: 'platform_edit',
        created_by: { user_id: platformUserId },
      });
      expect(first.body.operational_params_id).toEqual(expect.any(Number));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: 'SETTINGS_CONFLICT',
        current_version: first.body.operational_params_id,
      });
    });

    it('later saves version the whole set, close the previous one and list it in the history', async () => {
      const target = await paramsMunicipality();
      await createCompany(prisma, target, { status: 'active' });
      const path = `/platform/municipalities/${target}/services/taxi/operational-params`;
      const first = await asPlatform('put', path).send({ version: null, ...PARAMS_BODY });

      const second = await asPlatform('put', path).send({
        version: first.body.operational_params_id,
        ...PARAMS_BODY,
        acceptance_timeout_sec: 30,
      });
      const history = await asPlatform('get', path);

      expect(second.status).toBe(200);
      expect(second.body.acceptance_timeout_sec).toBe(30);
      expect(history.body.current.operational_params_id).toBe(second.body.operational_params_id);
      expect(history.body.versions.map((v: { acceptance_timeout_sec: number }) => v.acceptance_timeout_sec)).toEqual([30, 20]);
      const open = await prisma.municipalityOperationalParams.count({ where: { municipalityId: target, validTo: null } });
      expect(open).toBe(1);
    });

    it('a search radius above the expansion radius is a 422 SETTINGS_OUT_OF_RANGE on search_radius_km', async () => {
      const res = await asPlatform('put', `${base()}/operational-params`).send({
        version: null,
        ...PARAMS_BODY,
        search_radius_km: 9,
        expansion_radius_km: 8,
      });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'SETTINGS_OUT_OF_RANGE', field: 'search_radius_km' });
    });

    it.each([
      ['acceptance timeout under 5', { acceptance_timeout_sec: 4 }],
      ['acceptance timeout over 120', { acceptance_timeout_sec: 121 }],
      ['a cancellation window over 30', { cancellation_window_min: 31 }],
      ['a no-show grace of 0', { no_show_grace_min: 0 }],
      ['retries of 0', { max_auto_retries: 0 }],
      ['a tiebreak window over 24', { tiebreak_window_hours: 25 }],
      ['a location staleness over 120', { location_stale_min: 121 }],
      ['an average speed under 5', { avg_speed_kmh: 4 }],
      ['a radius that is not a multiple of 0.1', { search_radius_km: 2.25 }],
      ['a missing parameter', { no_show_grace_min: undefined }],
    ])('%s is a 400 and nothing is saved', async (_label, override) => {
      const target = await paramsMunicipality();
      await createCompany(prisma, target, { status: 'active' });

      const res = await asPlatform('put', `/platform/municipalities/${target}/services/taxi/operational-params`).send({
        version: null,
        ...PARAMS_BODY,
        ...override,
      });

      expect(res.status).toBe(400);
      expect(await prisma.municipalityOperationalParams.count({ where: { municipalityId: target } })).toBe(0);
    });

    it('two concurrent first saves: one 200 and one 409, a single open row', async () => {
      const target = await paramsMunicipality();
      await createCompany(prisma, target, { status: 'active' });
      const path = `/platform/municipalities/${target}/services/taxi/operational-params`;

      const results = await Promise.all([
        asPlatform('put', path).send({ version: null, ...PARAMS_BODY }),
        asPlatform('put', path, otherPlatformAuth).send({ version: null, ...PARAMS_BODY, acceptance_timeout_sec: 40 }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await prisma.municipalityOperationalParams.count({ where: { municipalityId: target, validTo: null } })).toBe(1);
    });

    it('the company sees the parameters in force read-only, and they replace the environment values', async () => {
      const target = await paramsMunicipality();
      const companyId = await createCompany(prisma, target, { status: 'active' });
      await seedOpenFare(prisma, target, 'taxi', 8000);
      await seedCommission(prisma, companyId, 8);
      const adminAuth = tokenFor(jwt, 'admin', companyId);

      const before = await request(app.getHttpServer()).get('/admin/settings').set('Authorization', adminAuth);
      expect(before.body).toMatchObject({ search_radius_km: 2, cancellation_window_min: 2 });

      await asPlatform('put', `/platform/municipalities/${target}/services/taxi/operational-params`).send({
        version: null,
        ...PARAMS_BODY,
      });
      const after = await request(app.getHttpServer()).get('/admin/settings').set('Authorization', adminAuth);

      expect(after.body).toMatchObject({
        search_radius_km: 3,
        expansion_radius_km: 8,
        acceptance_timeout_sec: 20,
        max_auto_retries: 4,
        tiebreak_window_hours: 5,
        location_stale_min: 10,
        avg_speed_kmh: 25,
        cancellation_window_min: 3,
        no_show_grace_min: 6,
      });
      expect(after.body.version).not.toBe(before.body.version);
    });
  });

  describe('company commission (HU-MS-15, P-13)', () => {
    it('lists the active companies with their commission and no pending or suspended ones', async () => {
      const suspended = await createCompany(prisma, municipalityId, { status: 'suspended', legalName: '_PlatCfgSuspended' });

      const res = await asPlatform('get', '/platform/commissions');

      expect(res.status).toBe(200);
      const rows = res.body.rows as Array<{ company_id: number; display_name: string; commission: { commission_pct: number } | null }>;
      const rowA = rows.find((r) => r.company_id === companyAId);
      expect(rowA).toMatchObject({ display_name: 'Taxis A', municipality_id: municipalityId });
      expect(rowA?.commission?.commission_pct).toBe(8);
      expect(rows.find((r) => r.company_id === companyBId)?.display_name).toBe('_PlatCfgB');
      expect(rows.find((r) => r.company_id === suspended)).toBeUndefined();
    });

    it('a save creates a version for the next trips only: a trip already accepted keeps its commission', async () => {
      const passengerId = await createFreshPassenger(prisma, { firstName: 'PaxCommission' });
      const trip = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'CommissionPickup',
          dropoffAddress: 'CommissionDropoff',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10_000,
          commission: 800,
          commissionPct: 8,
          companyId: companyAId,
          status: 'assigned',
        },
      });
      const current = (await commissionsOf(prisma, companyAId)).find((c) => c.validTo === null);

      const res = await asPlatform('put', `/platform/companies/${companyAId}/commission`).send({
        version: current?.companyCommissionId,
        commission_pct: 11.25,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        company_id: companyAId,
        commission_pct: 11.25,
        origin: 'platform_edit',
        valid_to: null,
        created_by: { user_id: platformUserId },
      });
      const stored = await prisma.tripRequest.findUnique({ where: { tripRequestId: trip.tripRequestId } });
      expect(Number(stored?.commission)).toBe(800);
      expect(Number(stored?.commissionPct)).toBe(8);

      const adminA = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', tokenFor(jwt, 'admin', companyAId));
      expect(adminA.body.commission_pct).toBe(11.25);
      const closed = await prisma.runAsPlatform((tx) =>
        tx.companyCommission.findUnique({ where: { companyCommissionId: current?.companyCommissionId ?? 0 } }),
      );
      expect(closed?.validTo).not.toBeNull();
    });

    it('0 and 50 are accepted, 50.01 and negative values are not', async () => {
      const path = `/platform/companies/${companyBId}/commission`;
      let version = (await commissionsOf(prisma, companyBId)).find((c) => c.validTo === null)?.companyCommissionId;

      for (const pct of [0, 50]) {
        const ok = await asPlatform('put', path).send({ version, commission_pct: pct });
        expect(ok.status).toBe(200);
        version = ok.body.company_commission_id;
      }
      for (const pct of [50.01, -1, 8.123]) {
        const bad = await asPlatform('put', path).send({ version, commission_pct: pct });
        expect(bad.status).toBe(400);
      }
      const history = await asPlatform('get', path);
      expect(history.body.current.commission_pct).toBe(50);
    });

    it('a stale version or a duplicate first save is a 409 naming the current version', async () => {
      const path = `/platform/companies/${companyAId}/commission`;
      const current = (await commissionsOf(prisma, companyAId)).find((c) => c.validTo === null);

      const stale = await asPlatform('put', path).send({ version: (current?.companyCommissionId ?? 2) - 1, commission_pct: 5 });
      const duplicateFirst = await asPlatform('put', path).send({ version: null, commission_pct: 5 });

      for (const res of [stale, duplicateFirst]) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SETTINGS_CONFLICT', current_version: current?.companyCommissionId });
      }
    });

    it('a company without a commission can get its first one with version null', async () => {
      const fresh = await createCompany(prisma, municipalityId, { status: 'active' });

      const res = await asPlatform('put', `/platform/companies/${fresh}/commission`).send({
        version: null,
        commission_pct: 7,
      });

      expect(res.status).toBe(200);
      expect(res.body.commission_pct).toBe(7);
    });

    it('an unknown company is a 404 COMPANY_NOT_FOUND on history and on save', async () => {
      const history = await asPlatform('get', '/platform/companies/999999999/commission');
      const save = await asPlatform('put', '/platform/companies/999999999/commission').send({ version: null, commission_pct: 5 });
      expect(history.status).toBe(404);
      expect(history.body).toMatchObject({ code: 'COMPANY_NOT_FOUND' });
      expect(save.status).toBe(404);
    });

    it('the history of a company pages by version and is not visible to another company admin', async () => {
      const history = await asPlatform('get', `/platform/companies/${companyAId}/commission?limit=1`);
      expect(history.status).toBe(200);
      expect(history.body.versions).toHaveLength(1);
      expect(history.body.next_before).toEqual(expect.any(Number));
      const asCompany = await request(app.getHttpServer())
        .get(`/platform/companies/${companyAId}/commission`)
        .set('Authorization', tokenFor(jwt, 'admin', companyBId));
      expect(asCompany.status).toBe(403);
    });

    it('a company reads another company commission through no route: its own tenant sees only its own row', async () => {
      const own = await prisma.runInTenant(companyAId, (tx) => tx.companyCommission.findMany());
      expect(own.every((row) => row.companyId === companyAId)).toBe(true);
      expect(own.length).toBeGreaterThan(0);
    });
  });

  describe('privacy: the platform sees no passenger data (HU-MS-09, MD-14)', () => {
    it('no platform configuration response carries a passenger name, phone or address', async () => {
      const passengerId = await createFreshPassenger(prisma, { firstName: 'PaxPrivacyMarker' });
      await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'PrivacyMarkerPickup',
          dropoffAddress: 'PrivacyMarkerDropoff',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10_000,
          commission: 0,
          status: 'pending_assignment',
        },
      });

      const bodies = await Promise.all([
        asPlatform('get', '/platform/service-configs'),
        asPlatform('get', `${base()}/fare`),
        asPlatform('get', `${base()}/operational-params`),
        asPlatform('get', '/platform/commissions'),
        asPlatform('get', `/platform/companies/${companyAId}/commission`),
        asPlatform('get', `/platform/companies/${companyAId}`),
      ]);

      for (const res of bodies) {
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('PrivacyMarker');
        expect(text).not.toContain('PaxPrivacyMarker');
      }
    });

    it('a platform_admin cannot read trips through the ops console', async () => {
      const res = await asPlatform('get', '/ops/trip-requests');
      expect(res.status).toBe(403);
    });
  });
});
