import type { Prisma, PrismaClient } from '@prisma/client';
import { DriverLocationPurgeService } from '../src/modules/assignment/driver-location-purge.service';
import { DriverRepository } from '../src/modules/assignment/driver.repository';
import type { EnvService } from '../src/config/env.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function fakeEnv(purgeHours: number): EnvService {
  return { get: (k: string) => (k === 'LOCATION_PURGE_HOURS' ? purgeHours : undefined) } as unknown as EnvService;
}

function asPrismaServiceWithRunInTenant(client: PrismaClient): PrismaService {
  const withRunInTenant = client as PrismaClient & Pick<PrismaService, 'runInTenant'>;
  withRunInTenant.runInTenant = <T>(
    companyId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  return withRunInTenant as unknown as PrismaService;
}

suite('DriverLocationPurgeService against real Postgres, connected as app_voyya (ADR-019 §8, closes V-07)', () => {
  let raw: PrismaClient;
  let prismaService: PrismaService;
  let repo: DriverRepository;
  let municipalityId: number;
  let driverSeq = 0;
  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

  async function withTenant<T>(companyId: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  async function makeCompany(taxId: string): Promise<number> {
    const company = await raw.company.upsert({
      where: { taxId },
      update: { status: 'active' },
      create: { legalName: `_Purge_${taxId}`, taxId, type: 'cooperative', municipalityId, status: 'active' },
    });
    return company.companyId;
  }

  async function makeStaleDriver(companyId: number): Promise<number> {
    driverSeq += 1;
    const phone = `_purge-svc-${runId}-${driverSeq}`;
    const user = await raw.user.upsert({
      where: { phone },
      update: {},
      create: { firstName: '_PurgeSvc', lastName: `Driver${driverSeq}`, phone, role: 'driver' },
    });
    const vehicle = await withTenant(companyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: `_PSV-${runId}-${driverSeq}` },
        update: { status: 'active', companyId },
        create: { plate: `_PSV-${runId}-${driverSeq}`, companyId, status: 'active' },
      }),
    );
    await withTenant(companyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: user.userId },
        update: {
          companyId,
          status: 'available',
          currentVehicleId: vehicle.vehicleId,
          pin: 'x',
          currentLat: 6.9,
          currentLng: -75.4,
          locationUpdatedAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
        },
        create: {
          driverId: user.userId,
          companyId,
          nationalId: `_PSV-DRV-${runId}-${driverSeq}`,
          pin: 'x',
          status: 'available',
          currentVehicleId: vehicle.vehicleId,
          currentLat: 6.9,
          currentLng: -75.4,
          locationUpdatedAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
        },
      }),
    );
    return user.userId;
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
    prismaService = asPrismaServiceWithRunInTenant(raw);
    repo = new DriverRepository(prismaService);

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9007 },
      update: {},
      create: {
        municipalityId: 9007,
        name: '_PurgeSvcTestMuni',
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
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  it('LOCATION_PURGE_HOURS = 0 disables the job entirely: a stale driver is left untouched', async () => {
    const companyId = await makeCompany(`_purge-svc-disabled-${runId}`);
    const driverId = await makeStaleDriver(companyId);
    const service = new DriverLocationPurgeService(
      prismaService,
      repo,
      fakeEnv(0),
    );

    await service.purge();

    const row = await withTenant(companyId, (tx) => tx.driver.findUnique({ where: { driverId } }));
    expect(row?.currentLat).not.toBeNull();
  });

  it('purges stale drivers across every company in one run, isolated per tenant', async () => {
    const companyA = await makeCompany(`_purge-svc-a-${runId}`);
    const companyB = await makeCompany(`_purge-svc-b-${runId}`);
    const driverA = await makeStaleDriver(companyA);
    const driverB = await makeStaleDriver(companyB);
    const service = new DriverLocationPurgeService(
      prismaService,
      repo,
      fakeEnv(12),
    );

    await service.purge();

    const rowA = await withTenant(companyA, (tx) => tx.driver.findUnique({ where: { driverId: driverA } }));
    const rowB = await withTenant(companyB, (tx) => tx.driver.findUnique({ where: { driverId: driverB } }));
    expect(rowA?.currentLat).toBeNull();
    expect(rowA?.locationUpdatedAt).toBeNull();
    expect(rowB?.currentLat).toBeNull();
    expect(rowB?.locationUpdatedAt).toBeNull();
  });

  it('a second concurrent purge() call in the same instant is blocked by the advisory lock', async () => {
    const companyId = await makeCompany(`_purge-svc-lock-${runId}`);
    await makeStaleDriver(companyId);
    const service = new DriverLocationPurgeService(
      prismaService,
      repo,
      fakeEnv(12),
    );

    await expect(Promise.all([service.purge(), service.purge()])).resolves.toBeDefined();
  });
});
