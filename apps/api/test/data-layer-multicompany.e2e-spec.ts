import type { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabasePreflightService } from '../src/infrastructure/prisma/database-preflight.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import type { EnvService } from '../src/config/env.service';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const HOOK_TIMEOUT_MS = 60_000;
const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = url ? describe : describe.skip;
const ownerIt = ownerUrl ? it : it.skip;

const PREFIX = '_MultiB1';
const DANE_PREFIX = '009';
const CONFIG_TABLES = [
  { table: 'trips.municipality_fare', keyColumns: ['municipality_id', 'service_type'] },
  { table: 'admin.municipality_operational_params', keyColumns: ['municipality_id', 'service_type'] },
  { table: 'tenancy.company_commission', keyColumns: ['company_id'] },
] as const;

const polygon = {
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

function withConnectionLimit(raw: string, limit: number): string {
  const parsed = new URL(raw);
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

suite('ADR-032 data layer against real Postgres as app_voyya (B1)', () => {
  let prisma: PrismaClient;
  let single: PrismaClient;
  let owner: PrismaClient | null = null;
  const run = randomUUID().slice(0, 8);

  let municipalityMainId: number;
  let municipalitySingleId: number;
  let companyAId: number;
  let companyBId: number;
  let companySuspendedId: number;
  let companyComfortId: number;
  let companySingleId: number;
  let driverA: { driverId: number; vehicleId: number };
  let driverB: { driverId: number; vehicleId: number };
  const createdUserIds: number[] = [];

  async function freshPassenger(): Promise<number> {
    const passengerId = await createFreshPassenger(prisma);
    createdUserIds.push(passengerId);
    return passengerId;
  }

  async function asCompany<T>(
    companyId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    client: PrismaClient = prisma,
  ): Promise<T> {
    return client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  async function asPlatform<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_session', 'on', true)`;
      return fn(tx);
    });
  }

  async function nextDaneCode(): Promise<string> {
    const used = await prisma.municipality.findMany({
      where: { daneCode: { startsWith: DANE_PREFIX } },
      select: { daneCode: true },
    });
    const taken = new Set(used.map((row) => row.daneCode));
    for (let n = 0; n < 100; n += 1) {
      const code = `${DANE_PREFIX}${String(n).padStart(2, '0')}`;
      if (!taken.has(code)) return code;
    }
    throw new Error('No free reserved DANE code left for fixtures');
  }

  async function createMunicipality(suffix: string): Promise<number> {
    const created = await prisma.municipality.create({
      data: {
        name: `${PREFIX} ${suffix} ${run}`,
        department: `${PREFIX} Dept`,
        daneCode: await nextDaneCode(),
        daneType: 'municipality',
        referenceLat: 0.5,
        referenceLng: 0.5,
        coveragePolygon: polygon,
        status: 'active',
      },
    });
    return created.municipalityId;
  }

  async function createCompany(
    municipalityId: number,
    label: string,
    options: { status?: 'active' | 'suspended'; serviceTypes?: Array<'taxi' | 'comfort'> } = {},
  ): Promise<number> {
    const company = await prisma.company.create({
      data: {
        legalName: `${PREFIX} ${label} ${run}`,
        taxId: `${PREFIX}-${label}-${run}`,
        type: 'cooperative',
        municipalityId,
        status: options.status ?? 'active',
        serviceTypes: options.serviceTypes ?? ['taxi'],
      },
    });
    await asPlatform((tx) =>
      tx.companyCommission.create({
        data: { companyId: company.companyId, commissionPct: 8, origin: 'platform_edit' },
      }),
    );
    return company.companyId;
  }

  async function createDriver(companyId: number, label: string) {
    const user = await prisma.user.create({
      data: {
        firstName: `${PREFIX}${label}`,
        lastName: run,
        phone: `${PREFIX}-${label}-${run}`,
        role: 'driver',
      },
    });
    createdUserIds.push(user.userId);
    const vehicle = await asCompany(companyId, (tx) =>
      tx.vehicle.create({ data: { companyId, plate: `${label}${run}`.slice(0, 10), status: 'active' } }),
    );
    await asCompany(companyId, (tx) =>
      tx.driver.create({
        data: {
          driverId: user.userId,
          companyId,
          nationalId: `${PREFIX}-${label}-${run}`,
          pin: 'x',
          status: 'available',
          currentVehicleId: vehicle.vehicleId,
        },
      }),
    );
    return { driverId: user.userId, vehicleId: vehicle.vehicleId };
  }

  interface TripOptions {
    municipalityId?: number;
    requestedCompanyId?: number | null;
    status?: 'pending_assignment' | 'assigned' | 'completed' | 'no_driver';
    companyId?: number | null;
  }

  async function createTrip(options: TripOptions = {}) {
    const passengerId = await freshPassenger();
    return prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId: options.municipalityId ?? municipalityMainId,
        requestedCompanyId: options.requestedCompanyId ?? null,
        companyId: options.companyId ?? null,
        status: options.status ?? 'pending_assignment',
        pickupAddress: 'Calle 1',
        dropoffAddress: 'Calle 2',
        pickupLat: 0.5,
        pickupLng: 0.5,
        dropoffLat: 0.51,
        dropoffLng: 0.51,
        fare: 8000,
        commission: 0,
      },
    });
  }

  async function createAssignment(
    tripRequestId: number,
    companyId: number,
    driver: { driverId: number; vehicleId: number },
    status: 'notified' | 'accepted' | 'rejected',
    expiresInMinutes: number | null,
  ): Promise<number> {
    const row = await asCompany(companyId, (tx) =>
      tx.assignment.create({
        data: {
          tripRequestId,
          companyId,
          driverId: driver.driverId,
          vehicleId: driver.vehicleId,
          status,
          expiresAt: expiresInMinutes === null ? null : new Date(Date.now() + expiresInMinutes * 60_000),
        },
      }),
    );
    return row.assignmentId;
  }

  async function visibleTripIds(companyId: number, ids: number[]): Promise<number[]> {
    const rows = await asCompany(companyId, (tx) =>
      tx.$queryRaw<Array<{ trip_request_id: number }>>`
        SELECT trip_request_id FROM trips.trip_request WHERE trip_request_id = ANY(${ids}::int[]) ORDER BY 1`,
    );
    return rows.map((row) => row.trip_request_id);
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    single = new Client({ datasources: { db: { url: withConnectionLimit(url as string, 1) } } });
    await prisma.$connect();
    await single.$connect();
    if (ownerUrl) {
      owner = new Client({ datasources: { db: { url: ownerUrl } } });
      await owner.$connect();
    }

    municipalityMainId = await createMunicipality('Main');
    municipalitySingleId = await createMunicipality('Single');
    companyAId = await createCompany(municipalityMainId, 'A');
    companyBId = await createCompany(municipalityMainId, 'B');
    companySuspendedId = await createCompany(municipalityMainId, 'S', { status: 'suspended' });
    companyComfortId = await createCompany(municipalityMainId, 'C', { serviceTypes: ['comfort'] });
    companySingleId = await createCompany(municipalitySingleId, 'D');
    driverA = await createDriver(companyAId, 'DA');
    driverB = await createDriver(companyBId, 'DB');
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (single) await single.$disconnect();
    if (prisma) {
      await purgeMunicipalitiesByNamePrefix(prisma, PREFIX, { daneCodePrefix: DANE_PREFIX });
      if (owner && createdUserIds.length > 0) {
        await owner.$executeRawUnsafe(
          `DELETE FROM auth."user" WHERE user_id IN (${createdUserIds.join(', ')})`,
        );
      }
      await prisma.$disconnect();
    }
    if (owner) await owner.$disconnect();
  }, HOOK_TIMEOUT_MS);

  describe('the test role', () => {
    it('is not a superuser and does not bypass RLS', async () => {
      const rows = await prisma.$queryRaw<Array<{ super: boolean; bypass: boolean }>>`
        SELECT current_setting('is_superuser') = 'on' AS super,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
      expect(rows[0]).toEqual({ super: false, bypass: false });
    });
  });

  describe('preflight against the real database (section 12.3)', () => {
    function preflight(client: unknown): DatabasePreflightService {
      const env = { get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined) } as unknown as EnvService;
      return new DatabasePreflightService(client as PrismaService, env);
    }

    it('every flag is true, including the three new ones and 14 forced tables', async () => {
      const service = preflight(prisma);

      await service.onApplicationBootstrap();

      expect(service.getLastResult()).toEqual({
        isSuperuser: false,
        bypassesRls: false,
        hasPostgis: true,
        hasGeoColumns: true,
        hasSingleTakeIndex: true,
        hasForcedRls: true,
        hasSafeTripProbe: true,
        hasMunicipalityCatalog: true,
        hasServiceConfig: true,
        hasTripCompanyScope: true,
      });
      expect(service.isHealthy()).toBe(true);
    });

    ownerIt('hasServiceConfig is false when the app can UPDATE a config table, true again once restored', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe('GRANT UPDATE ON trips.municipality_fare TO app_voyya');
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasServiceConfig).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasServiceConfig is false when the app lost the right to close versions (REVOKE without GRANT)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe('REVOKE UPDATE (valid_to) ON tenancy.company_commission FROM app_voyya');
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasServiceConfig).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasTripCompanyScope is false when app_voyya cannot execute company_has_live_assignment', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'REVOKE EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) FROM app_voyya',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasTripCompanyScope is false when PUBLIC can execute the function again (MD-20)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'GRANT EXECUTE ON FUNCTION assignment.company_has_live_assignment(integer, boolean) TO PUBLIC',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasTripCompanyScope is false when the function is SECURITY DEFINER (MD-12)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER FUNCTION trips.trip_request_company_preference() SECURITY DEFINER',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasTripCompanyScope is false when the trigger is gone', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'DROP TRIGGER trip_request_company_preference ON trips.trip_request',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasTripCompanyScope is false when the app owns trips.trip_request (MD-12)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE trips.trip_request OWNER TO app_voyya');
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasForcedRls is false when a new table loses FORCE (14 tables)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe('ALTER TABLE trips.trip_request NO FORCE ROW LEVEL SECURITY');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasForcedRls).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('hasMunicipalityCatalog is false without the coverage constraint', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE tenancy.municipality DROP CONSTRAINT municipality_coverage_matches_status',
          );
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasMunicipalityCatalog).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });

    ownerIt('the residual GUC probe fails the flag when the policy casts without nullif (MD-01)', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`
            ALTER POLICY company_scope_trip_request ON trips.trip_request
              USING (company_id = current_setting('app.current_company', true)::int
                     OR current_setting('app.current_company', true) IS NULL)`);
          await tx.$executeRawUnsafe('SET LOCAL ROLE app_voyya');
          const service = preflight(tx);
          await service.onApplicationBootstrap();
          expect(service.getLastResult()?.hasTripCompanyScope).toBe(false);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });
  });

  describe('MD-01: the residual GUC \'\' does not break trips.trip_request', () => {
    it('after a committed runInTenant on the SAME connection, trip_request answers (EXPLAIN, count, by id, UPDATE) and assignment still fails visibly', async () => {
      const trip = await createTrip();
      await asCompany(companyAId, (tx) => tx.$queryRaw`SELECT 1`, single);
      const residual = await single.$queryRaw<Array<{ residual: boolean }>>`
        SELECT current_setting('app.current_company', true) = '' AS residual`;
      expect(residual[0]?.residual).toBe(true);

      await expect(
        single.$queryRawUnsafe(
          `EXPLAIN SELECT count(*) FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId}`,
        ),
      ).resolves.toBeDefined();
      const byId = await single.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(*) AS total FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId}`;
      expect(Number(byId[0]?.total)).toBe(1);
      const all = await single.$queryRaw<Array<{ total: bigint }>>`SELECT count(*) AS total FROM trips.trip_request`;
      expect(Number(all[0]?.total)).toBeGreaterThanOrEqual(1);
      await expect(
        single.$transaction(async (tx) => {
          const updated = await tx.$executeRaw`
            UPDATE trips.trip_request SET updated_at = updated_at WHERE trip_request_id = ${trip.tripRequestId}`;
          expect(updated).toBe(1);
        }),
      ).resolves.toBeUndefined();
      await expect(
        single.tripRequest.findUnique({ where: { tripRequestId: trip.tripRequestId } }),
      ).resolves.toMatchObject({ tripRequestId: trip.tripRequestId });

      const control = await rejection(single.$queryRaw`SELECT count(*) FROM assignment.assignment`);
      expect(control).toMatch(/invalid input syntax for type integer/);
    });
  });

  describe('MD-20: EXECUTE on the policy function', () => {
    it('app_voyya can execute it and PUBLIC cannot', async () => {
      const rows = await prisma.$queryRaw<Array<{ app: boolean; pub: boolean }>>`
        SELECT has_function_privilege(current_user, 'assignment.company_has_live_assignment(integer, boolean)', 'EXECUTE') AS app,
               has_function_privilege('public', 'assignment.company_has_live_assignment(integer, boolean)', 'EXECUTE') AS pub`;
      expect(rows[0]).toEqual({ app: true, pub: false });
    });

    ownerIt('a role without EXECUTE cannot read trip_request: the policy initializes the function permission', async () => {
      class RolledBack extends Error {}
      await expect(
        (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe('CREATE ROLE _b1_noexec NOLOGIN NOSUPERUSER NOBYPASSRLS');
          await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA trips, assignment TO _b1_noexec');
          await tx.$executeRawUnsafe('GRANT SELECT ON trips.trip_request TO _b1_noexec');
          await tx.$executeRawUnsafe('SET LOCAL ROLE _b1_noexec');
          const message = await rejection(tx.$queryRawUnsafe('SELECT count(*) FROM trips.trip_request'));
          expect(message).toMatch(/permission denied for function company_has_live_assignment/);
          throw new RolledBack('rollback');
        }),
      ).rejects.toThrow(RolledBack);
    });
  });

  describe('RLS of trip_request (section 15.3)', () => {
    it('tenant A does not read a trip of B, and a trip of another municipality is invisible', async () => {
      const toB = await createTrip({ requestedCompanyId: companyBId });
      const other = await createTrip({ municipalityId: municipalitySingleId });

      expect(await visibleTripIds(companyAId, [toB.tripRequestId, other.tripRequestId])).toEqual([]);
      expect(await visibleTripIds(companyBId, [toB.tripRequestId])).toEqual([toB.tripRequestId]);
    });

    it('a "Cualquiera" trip with two active companies and no acceptance is visible to nobody', async () => {
      const trip = await createTrip();

      expect(trip.addressedCompanyId).toBeNull();
      expect(await visibleTripIds(companyAId, [trip.tripRequestId])).toEqual([]);
      expect(await visibleTripIds(companyBId, [trip.tripRequestId])).toEqual([]);
    });

    it('a "Cualquiera" trip with a single company is visible to it (the pilot, RT-3)', async () => {
      const trip = await createTrip({ municipalityId: municipalitySingleId });

      expect(trip.addressedCompanyId).toBe(companySingleId);
      expect(await visibleTripIds(companySingleId, [trip.tripRequestId])).toEqual([trip.tripRequestId]);
    });

    it('offered to A (live offer) A sees it; rejected and taken by B, A does not and B does', async () => {
      const trip = await createTrip();
      const offerId = await createAssignment(trip.tripRequestId, companyAId, driverA, 'notified', 5);
      expect(await visibleTripIds(companyAId, [trip.tripRequestId])).toEqual([trip.tripRequestId]);

      await asCompany(companyAId, (tx) =>
        tx.assignment.update({ where: { assignmentId: offerId }, data: { status: 'rejected' } }),
      );
      await createAssignment(trip.tripRequestId, companyBId, driverB, 'accepted', 5);
      await asCompany(companyBId, (tx) =>
        tx.tripRequest.update({
          where: { tripRequestId: trip.tripRequestId },
          data: { status: 'assigned', companyId: companyBId },
        }),
      );

      expect(await visibleTripIds(companyAId, [trip.tripRequestId])).toEqual([]);
      expect(await visibleTripIds(companyBId, [trip.tripRequestId])).toEqual([trip.tripRequestId]);
    });

    it('an expired offer that nobody marked timeout does not show the trip (MD-03)', async () => {
      const trip = await createTrip();
      await createAssignment(trip.tripRequestId, companyAId, driverA, 'notified', -60);

      expect(await visibleTripIds(companyAId, [trip.tripRequestId])).toEqual([]);
    });

    it('the losing company does not see the trip while its offer is still notified once the trip left pending_assignment (MD-03)', async () => {
      const trip = await createTrip();
      await createAssignment(trip.tripRequestId, companyBId, driverB, 'notified', 5);
      await createAssignment(trip.tripRequestId, companyAId, driverA, 'accepted', 5);
      await asCompany(companyAId, (tx) =>
        tx.tripRequest.update({
          where: { tripRequestId: trip.tripRequestId },
          data: { status: 'assigned', companyId: companyAId },
        }),
      );

      expect(await visibleTripIds(companyBId, [trip.tripRequestId])).toEqual([]);
      expect(await visibleTripIds(companyAId, [trip.tripRequestId])).toEqual([trip.tripRequestId]);
    });

    it('a tenant cannot assign a trip to another company (WITH CHECK)', async () => {
      const trip = await createTrip({ requestedCompanyId: companyAId });

      const message = await rejection(
        asCompany(companyAId, (tx) =>
          tx.tripRequest.update({ where: { tripRequestId: trip.tripRequestId }, data: { companyId: companyBId } }),
        ),
      );

      expect(message).toMatch(/row-level security|violates/i);
    });

    it('MD-18: reopening the trip BEFORE closing the assignment works; the reverse order fails with an RLS violation', async () => {
      const reopenable = async (): Promise<number> => {
        const trip = await createTrip();
        const assignmentId = await createAssignment(trip.tripRequestId, companyAId, driverA, 'accepted', 5);
        await asCompany(companyAId, (tx) =>
          tx.tripRequest.update({
            where: { tripRequestId: trip.tripRequestId },
            data: { status: 'assigned', companyId: companyAId },
          }),
        );
        return assignmentId * 0 + trip.tripRequestId;
      };

      const good = await reopenable();
      await asCompany(companyAId, async (tx) => {
        await tx.$executeRaw`
          UPDATE trips.trip_request SET status = 'pending_assignment', company_id = NULL, commission = 0 WHERE trip_request_id = ${good}`;
        await tx.$executeRaw`
          UPDATE assignment.assignment SET status = 'cancelled' WHERE trip_request_id = ${good} AND status = 'accepted'`;
      });
      expect(
        (await prisma.tripRequest.findUniqueOrThrow({ where: { tripRequestId: good } })).status,
      ).toBe('pending_assignment');

      const bad = await reopenable();
      const message = await rejection(
        asCompany(companyAId, async (tx) => {
          await tx.$executeRaw`
            UPDATE assignment.assignment SET status = 'cancelled' WHERE trip_request_id = ${bad} AND status = 'accepted'`;
          await tx.$executeRaw`
            UPDATE trips.trip_request SET status = 'pending_assignment', company_id = NULL, commission = 0 WHERE trip_request_id = ${bad}`;
        }),
      );
      expect(message).toMatch(/row-level security policy/i);
    });
  });

  describe('trigger trip_request_company_preference (section 15.4)', () => {
    it('a directed trip becomes addressed to the requested company', async () => {
      const trip = await createTrip({ requestedCompanyId: companyAId });

      expect(trip.addressedCompanyId).toBe(companyAId);
    });

    it('"Cualquiera" with two active companies -> NULL; with one -> that company', async () => {
      const two = await createTrip();
      const one = await createTrip({ municipalityId: municipalitySingleId });

      expect(two.addressedCompanyId).toBeNull();
      expect(one.addressedCompanyId).toBe(companySingleId);
    });

    it('the value the application sends in addressed_company_id is ignored', async () => {
      const passengerId = await freshPassenger();
      const trip = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId: municipalityMainId,
          addressedCompanyId: companyBId,
          pickupAddress: 'Calle 1',
          dropoffAddress: 'Calle 2',
          pickupLat: 0.5,
          pickupLng: 0.5,
          dropoffLat: 0.5,
          dropoffLng: 0.5,
          fare: 8000,
          commission: 0,
        },
      });

      expect(trip.addressedCompanyId).toBeNull();
    });

    it('an UPDATE of requested_company_id or addressed_company_id fails with 23514', async () => {
      const trip = await createTrip({ requestedCompanyId: companyAId });

      const message = await rejection(
        prisma.$executeRaw`UPDATE trips.trip_request SET requested_company_id = ${companyBId} WHERE trip_request_id = ${trip.tripRequestId}`,
      );
      expect(message).toMatch(/23514/);
      const message2 = await rejection(
        prisma.$executeRaw`UPDATE trips.trip_request SET addressed_company_id = NULL WHERE trip_request_id = ${trip.tripRequestId}`,
      );
      expect(message2).toMatch(/23514/);
    });

    it.each([
      ['a company of another municipality', () => companySingleId],
      ['a suspended company', () => companySuspendedId],
      ['a company that does not offer the service', () => companyComfortId],
    ])('a trip directed to %s fails with 23514 and the named constraint (MD-12)', async (_label, company) => {
      const message = await rejection(createTrip({ requestedCompanyId: company() }));

      expect(message).toMatch(/23514/);
      expect(message).toMatch(/trip_request_requested_company_available|is not available for this trip/);
    });

    it('app_voyya cannot disable the trigger or change session_replication_role', async () => {
      const disable = await rejection(
        prisma.$executeRawUnsafe('ALTER TABLE trips.trip_request DISABLE TRIGGER trip_request_company_preference'),
      );
      expect(disable).toMatch(/must be owner of table trip_request/);
      const replica = await rejection(prisma.$executeRawUnsafe("SET session_replication_role = 'replica'"));
      expect(replica).toMatch(/permission denied to set parameter/);
    });
  });

  describe('append-only configuration tables (sections 4.4 and 15.6)', () => {
    async function insertVersion(
      tx: Prisma.TransactionClient,
      table: (typeof CONFIG_TABLES)[number]['table'],
      keyId: { municipalityId: number; companyId: number },
    ): Promise<number> {
      if (table === 'trips.municipality_fare') {
        const row = await tx.municipalityFare.create({
          data: {
            municipalityId: keyId.municipalityId,
            serviceType: 'comfort',
            baseFare: 9000,
            nightSurchargePct: 20,
            holidaySurchargePct: 15,
            origin: 'platform_edit',
          },
        });
        return row.municipalityFareId;
      }
      if (table === 'admin.municipality_operational_params') {
        const row = await tx.municipalityOperationalParams.create({
          data: { municipalityId: keyId.municipalityId, serviceType: 'comfort', origin: 'platform_edit' },
        });
        return row.operationalParamsId;
      }
      const row = await tx.companyCommission.create({
        data: { companyId: keyId.companyId, commissionPct: 5, origin: 'platform_edit' },
      });
      return row.companyCommissionId;
    }

    const idColumn = {
      'trips.municipality_fare': 'municipality_fare_id',
      'admin.municipality_operational_params': 'operational_params_id',
      'tenancy.company_commission': 'company_commission_id',
    } as const;

    async function freshKeys(): Promise<{ municipalityId: number; companyId: number }> {
      const municipalityId = await createMunicipality(`Cfg${Math.random()}`);
      const companyId = await createCompany(municipalityId, `K${Math.random().toString(36).slice(2, 8)}`);
      await asPlatform((tx) =>
        tx.$executeRaw`UPDATE tenancy.company_commission SET valid_to = GREATEST(valid_from, now() AT TIME ZONE 'UTC') WHERE company_id = ${companyId} AND valid_to IS NULL`,
      );
      return { municipalityId, companyId };
    }

    it.each(CONFIG_TABLES.map((entry) => [entry.table]))('%s: an INSERT without app.platform_session is rejected by RLS', async (table) => {
      const keys = await freshKeys();

      const message = await rejection(prisma.$transaction((tx) => insertVersion(tx, table, keys)));

      expect(message).toMatch(/row-level security|violates/i);
    });

    it.each(CONFIG_TABLES.map((entry) => [entry.table]))('%s: DELETE and UPDATE of any column other than valid_to are denied', async (table) => {
      const keys = await freshKeys();
      const id = await asPlatform((tx) => insertVersion(tx, table, keys));
      const column = idColumn[table];

      const del = await rejection(prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${column} = ${id}`));
      const upd = await rejection(prisma.$executeRawUnsafe(`UPDATE ${table} SET origin = 'migrated' WHERE ${column} = ${id}`));

      expect(del).toMatch(/permission denied/);
      expect(upd).toMatch(/permission denied/);
    });

    it.each(CONFIG_TABLES.map((entry) => [entry.table]))('%s: close once and now; reopen, re-close, antedate and postdate are rejected (MD-07)', async (table) => {
      const keys = await freshKeys();
      const id = await asPlatform((tx) => insertVersion(tx, table, keys));
      const column = idColumn[table];
      const run = (sql: string) =>
        asPlatform((tx) => tx.$executeRawUnsafe(sql));

      const antedated = await rejection(
        run(`UPDATE ${table} SET valid_to = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE ${column} = ${id}`),
      );
      const postdated = await rejection(
        run(`UPDATE ${table} SET valid_to = (now() AT TIME ZONE 'UTC') + interval '1 hour' WHERE ${column} = ${id}`),
      );
      expect(antedated).toMatch(/row-level security|violates/i);
      expect(postdated).toMatch(/row-level security|violates/i);

      const closed = await run(
        `UPDATE ${table} SET valid_to = GREATEST(valid_from, now() AT TIME ZONE 'UTC') WHERE ${column} = ${id}`,
      );
      expect(closed).toBe(1);

      const reopened = await run(`UPDATE ${table} SET valid_to = NULL WHERE ${column} = ${id}`);
      const reclosed = await run(`UPDATE ${table} SET valid_to = (now() AT TIME ZONE 'UTC') WHERE ${column} = ${id}`);
      expect(reopened).toBe(0);
      expect(reclosed).toBe(0);
      const state = await asPlatform((tx) =>
        tx.$queryRawUnsafe<Array<{ open: boolean }>>(
          `SELECT valid_to IS NULL AS open FROM ${table} WHERE ${column} = ${id}`,
        ),
      );
      expect(state[0]?.open).toBe(false);
    });

    it.each(CONFIG_TABLES.map((entry) => [entry.table]))('%s: a second open version for the same key violates the unique index', async (table) => {
      const keys = await freshKeys();
      await asPlatform((tx) => insertVersion(tx, table, keys));

      const message = await rejection(asPlatform((tx) => insertVersion(tx, table, keys)));

      expect(message).toMatch(/23505|unique/i);
    });

    it('company_commission rejects 50.01 and a valid_to before valid_from (MD-07)', async () => {
      const keys = await freshKeys();

      const range = await rejection(
        asPlatform((tx) =>
          tx.companyCommission.create({ data: { companyId: keys.companyId, commissionPct: 50.01, origin: 'platform_edit' } }),
        ),
      );
      const validity = await rejection(
        asPlatform((tx) =>
          tx.companyCommission.create({
            data: {
              companyId: keys.companyId,
              commissionPct: 5,
              origin: 'platform_edit',
              validFrom: new Date('2026-01-02T00:00:00Z'),
              validTo: new Date('2026-01-01T00:00:00Z'),
            },
          }),
        ),
      );

      expect(range).toMatch(/company_commission_pct_range|23514|check/i);
      expect(validity).toMatch(/company_commission_validity|23514|check/i);
    });

    it('a tenant reads only its own commission; the platform reads all; a session with neither reads none', async () => {
      const own = await asCompany(companyAId, (tx) => tx.companyCommission.findMany());
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((row) => row.companyId === companyAId)).toBe(true);

      const platform = await asPlatform((tx) => tx.companyCommission.findMany());
      expect(new Set(platform.map((row) => row.companyId)).size).toBeGreaterThan(1);

      expect(await prisma.companyCommission.findMany()).toEqual([]);
    });

    it('fares and parameters are readable by everyone, as the passenger quotes without a tenant', async () => {
      await expect(prisma.municipalityFare.findMany({ take: 1 })).resolves.toBeDefined();
      await expect(prisma.municipalityOperationalParams.findMany({ take: 1 })).resolves.toBeDefined();
    });
  });

  describe('motorcycle is impossible (section 4.6)', () => {
    it('company.service_types cannot contain motorcycle', async () => {
      const message = await rejection(
        prisma.$executeRawUnsafe(
          `UPDATE tenancy.company SET service_types = ARRAY['taxi','motorcycle']::trips."ServiceType"[] WHERE company_id = ${companyAId}`,
        ),
      );
      expect(message).toMatch(/company_service_types_no_motorcycle|23514/);
    });

    it('municipality_fare, municipality_operational_params and trip_request reject motorcycle', async () => {
      const fare = await rejection(
        asPlatform((tx) =>
          tx.municipalityFare.create({
            data: {
              municipalityId: municipalityMainId,
              serviceType: 'motorcycle',
              baseFare: 5000,
              nightSurchargePct: 0,
              holidaySurchargePct: 0,
              origin: 'platform_edit',
            },
          }),
        ),
      );
      const params = await rejection(
        asPlatform((tx) =>
          tx.municipalityOperationalParams.create({
            data: { municipalityId: municipalityMainId, serviceType: 'motorcycle', origin: 'platform_edit' },
          }),
        ),
      );
      const passengerId = await freshPassenger();
      const trip = await rejection(
        prisma.tripRequest.create({
          data: {
            passengerId,
            municipalityId: municipalityMainId,
            serviceType: 'motorcycle',
            pickupAddress: 'a',
            dropoffAddress: 'b',
            pickupLat: 0.5,
            pickupLng: 0.5,
            dropoffLat: 0.5,
            dropoffLng: 0.5,
            fare: 1,
            commission: 0,
          },
        }),
      );

      expect(fare).toMatch(/municipality_fare_no_motorcycle|23514/);
      expect(params).toMatch(/municipality_operational_params_no_motorcycle|23514/);
      expect(trip).toMatch(/trip_request_no_motorcycle|23514/);
    });

    it('there are exactly four *_no_motorcycle constraints', async () => {
      const rows = await prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(*) AS total FROM pg_constraint WHERE conname ~ '_no_motorcycle$'`;
      expect(Number(rows[0]?.total)).toBe(4);
    });
  });

  describe('PrismaService.runAsPlatform (MD-11)', () => {
    it('sets the platform session inside the transaction and leaves \'\' behind on the same connection', async () => {
      const previous = process.env.DATABASE_URL;
      process.env.DATABASE_URL = withConnectionLimit(url as string, 1);
      const env = { get: (key: string) => (key === 'DATABASE_URL' ? process.env.DATABASE_URL : undefined) } as unknown as EnvService;
      const service = new PrismaService(env);
      try {
        await service.$connect();
        const inside = await service.runAsPlatform((tx) =>
          tx.$queryRaw<Array<{ value: string }>>`SELECT current_setting('app.platform_session', true) AS value`,
        );
        const after = await service.$queryRaw<Array<{ value: string | null }>>`
          SELECT current_setting('app.platform_session', true) AS value`;

        expect(inside[0]?.value).toBe('on');
        expect(after[0]?.value).toBe('');
      } finally {
        await service.$disconnect();
        process.env.DATABASE_URL = previous;
      }
    });
  });
});
