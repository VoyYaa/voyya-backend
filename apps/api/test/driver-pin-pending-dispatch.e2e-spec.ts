import type { Prisma, PrismaClient } from '@prisma/client';
import { AdminDriverRepository } from '../src/modules/admin/admin-driver.repository';
import { CandidateRepository } from '../src/modules/assignment/candidate.repository';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const MUNICIPALITY_ID = 9231;
const MUNICIPALITY_NAME = '_PinPendingDispatchMuni';
const ORIGIN = { lat: 0.5, lng: 0.5 };

suite('Drivers with a pending temporary PIN do not receive offers (CM-09)', () => {
  let raw: PrismaClient;
  let companyId: number;
  let vehicleId: number;
  let seq = 0;
  const candidates = new CandidateRepository();
  const adminDrivers = new AdminDriverRepository();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

  function withTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
    await raw.municipality.upsert({
      where: { municipalityId: MUNICIPALITY_ID },
      update: {},
      create: {
        municipalityId: MUNICIPALITY_ID,
        name: MUNICIPALITY_NAME,
        department: 'Test',
        coveragePolygon: {
          type: 'Polygon',
          coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
        status: 'active',
      },
    });
    const company = await raw.company.upsert({
      where: { taxId: '_pin-pending-dispatch' },
      update: { status: 'active' },
      create: {
        legalName: '_PinPendingDispatchCo',
        taxId: '_pin-pending-dispatch',
        type: 'cooperative',
        municipalityId: MUNICIPALITY_ID,
        status: 'active',
      },
    });
    companyId = company.companyId;
    const vehicle = await withTenant((tx) =>
      tx.vehicle.create({ data: { plate: `_PP${runId.slice(-9)}`, companyId, status: 'active' } }),
    );
    vehicleId = vehicle.vehicleId;
  });

  afterAll(async () => {
    if (raw) {
      await purgeMunicipalitiesByNamePrefix(raw, MUNICIPALITY_NAME);
      await raw.$disconnect();
    }
  });

  async function makeDriver(
    status: 'available' | 'off_shift' | 'on_trip',
    pinMustChange: boolean,
  ): Promise<number> {
    seq += 1;
    const user = await raw.user.create({
      data: { firstName: '_PP', lastName: `Driver${seq}`, phone: `_pp-${runId}-${seq}`, role: 'driver' },
    });
    await withTenant((tx) =>
      tx.driver.create({
        data: {
          driverId: user.userId,
          companyId,
          nationalId: `_PP-${runId}-${seq}`,
          pin: 'x',
          status,
          pinMustChange,
          currentVehicleId: vehicleId,
          currentLat: ORIGIN.lat,
          currentLng: ORIGIN.lng,
          locationUpdatedAt: new Date(),
        },
      }),
    );
    return user.userId;
  }

  function search(): Promise<number[]> {
    return withTenant(async (tx) => {
      const rows = await candidates.findCandidates(tx, {
        companyId,
        lat: ORIGIN.lat,
        lng: ORIGIN.lng,
        radiusKm: 10,
        tiebreakWindowHours: 3,
        locationStaleMin: 0,
        limit: 50,
        exclude: [],
      });
      return rows.map((r) => r.driverId);
    });
  }

  it('excludes an available driver whose PIN must still be changed and keeps the others', async () => {
    const pending = await makeDriver('available', true);
    const ready = await makeDriver('available', false);

    const found = await search();

    expect(found).toContain(ready);
    expect(found).not.toContain(pending);
  });

  it('resending the PIN moves an available driver to off_shift and out of the candidates', async () => {
    const driverId = await makeDriver('available', false);
    expect(await search()).toContain(driverId);

    const rotated = await withTenant((tx) =>
      adminDrivers.rotatePin(tx, driverId, companyId, 'hash', new Date(Date.now() + 3_600_000)),
    );

    expect(rotated).not.toBeNull();
    const after = await withTenant((tx) => tx.driver.findUniqueOrThrow({ where: { driverId } }));
    expect(after).toMatchObject({ status: 'off_shift', pinMustChange: true });
    expect(await search()).not.toContain(driverId);
  });

  it.each(['on_trip', 'off_shift'] as const)('resending the PIN keeps a %s driver in that status', async (status) => {
    const driverId = await makeDriver(status, false);

    await withTenant((tx) =>
      adminDrivers.rotatePin(tx, driverId, companyId, 'hash', new Date(Date.now() + 3_600_000)),
    );

    const after = await withTenant((tx) => tx.driver.findUniqueOrThrow({ where: { driverId } }));
    expect(after.status).toBe(status);
    expect(after.pinMustChange).toBe(true);
  });
});
