import type { Prisma, PrismaClient } from '@prisma/client';
import { DriverRepository } from '../src/modules/assignment/driver.repository';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('DriverRepository raw SQL against real Postgres (ADR-009)', () => {
  let raw: PrismaClient;
  let repo: DriverRepository;
  let companyId: number;
  let municipalityId: number;
  let passengerId: number;
  let vehicleId: number;

  async function withTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();

    repo = new DriverRepository(raw as unknown as PrismaService);

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9006 },
      update: {},
      create: {
        municipalityId: 9006,
        name: '_DriverRepoTestMuni',
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

    const company = await raw.company.upsert({
      where: { taxId: '_driver-repo-test' },
      update: { status: 'active' },
      create: {
        legalName: '_DriverRepoTestCo',
        taxId: '_driver-repo-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await raw.user.upsert({
      where: { phone: '_9990000401' },
      update: {},
      create: { firstName: '_DriverRepo', lastName: 'Passenger', phone: '_9990000401', role: 'passenger' },
    });
    await raw.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    const vehicle = await withTenant((tx) =>
      tx.vehicle.upsert({
        where: { plate: '_DRT001' },
        update: { status: 'active', companyId },
        create: { plate: '_DRT001', companyId, status: 'active' },
      }),
    );
    vehicleId = vehicle.vehicleId;
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  let driverSeq = 0;

  async function makeDriver(status: 'off_shift' | 'available' | 'on_trip'): Promise<number> {
    driverSeq += 1;
    const phone = `_drt-${runId}-${driverSeq}`;
    const user = await raw.user.upsert({
      where: { phone },
      update: {},
      create: { firstName: '_DriverRepo', lastName: `Driver${driverSeq}`, phone, role: 'driver' },
    });
    await withTenant((tx) =>
      tx.driver.upsert({
        where: { driverId: user.userId },
        update: { companyId, status, currentVehicleId: vehicleId, pin: 'x' },
        create: {
          driverId: user.userId,
          companyId,
          nationalId: `_DRT-DRV-${runId}-${driverSeq}`,
          pin: 'x',
          status,
          currentVehicleId: vehicleId,
        },
      }),
    );
    return user.userId;
  }

  describe('startShift', () => {
    it('off_shift with a vehicle linked -> becomes available', async () => {
      const driverId = await makeDriver('off_shift');

      const row = await withTenant((tx) => repo.startShift(tx, driverId, companyId, 6.96, -75.42));

      expect(row).toMatchObject({ status: 'available', currentVehicleId: vehicleId });
    });

    it('already on_trip -> returns null (cannot start a new shift)', async () => {
      const driverId = await makeDriver('on_trip');

      const row = await withTenant((tx) => repo.startShift(tx, driverId, companyId, 6.96, -75.42));

      expect(row).toBeNull();
    });

    it('no vehicle linked -> returns null', async () => {
      const driverId = await makeDriver('off_shift');
      await withTenant((tx) =>
        tx.driver.update({ where: { driverId }, data: { currentVehicleId: null } }),
      );

      const row = await withTenant((tx) => repo.startShift(tx, driverId, companyId, 6.96, -75.42));

      expect(row).toBeNull();
    });
  });

  describe('refreshLocationWhileOnTrip', () => {
    it('on_trip -> updates the location and keeps status on_trip', async () => {
      const driverId = await makeDriver('on_trip');

      const row = await withTenant((tx) =>
        repo.refreshLocationWhileOnTrip(tx, driverId, companyId, 6.97, -75.43),
      );

      expect(row).toMatchObject({ status: 'on_trip' });
      expect(row?.locationUpdatedAt).not.toBeNull();
    });

    it('available (not on_trip) -> returns null', async () => {
      const driverId = await makeDriver('available');

      const row = await withTenant((tx) =>
        repo.refreshLocationWhileOnTrip(tx, driverId, companyId, 6.97, -75.43),
      );

      expect(row).toBeNull();
    });
  });

  describe('endShift', () => {
    it('available -> becomes off_shift and clears the location', async () => {
      const driverId = await makeDriver('available');

      const row = await withTenant((tx) => repo.endShift(tx, driverId, companyId));

      expect(row).toMatchObject({ status: 'off_shift' });
      expect(row?.locationUpdatedAt).toBeNull();
    });

    it('on_trip -> returns null (cannot end shift mid-trip)', async () => {
      const driverId = await makeDriver('on_trip');

      const row = await withTenant((tx) => repo.endShift(tx, driverId, companyId));

      expect(row).toBeNull();
    });
  });

  describe('reportLocation', () => {
    it('available -> updates and returns true', async () => {
      const driverId = await makeDriver('available');

      const ok = await withTenant((tx) => repo.reportLocation(tx, driverId, companyId, 6.9, -75.4));

      expect(ok).toBe(true);
    });

    it('off_shift -> no row updated, returns false', async () => {
      const driverId = await makeDriver('off_shift');

      const ok = await withTenant((tx) => repo.reportLocation(tx, driverId, companyId, 6.9, -75.4));

      expect(ok).toBe(false);
    });
  });

  describe('getShiftRow / getCompanyMunicipality', () => {
    it('getShiftRow reflects the persisted status and vehicle', async () => {
      const driverId = await makeDriver('available');

      const row = await withTenant((tx) => repo.getShiftRow(tx, driverId, companyId));

      expect(row).toMatchObject({ status: 'available', currentVehicleId: vehicleId });
    });

    it('getCompanyMunicipality resolves the company municipality', async () => {
      const found = await repo.getCompanyMunicipality(companyId);

      expect(found).toBe(municipalityId);
    });
  });

  describe('getActiveTrip / listPendingCashTrips', () => {
    it('getActiveTrip returns the accepted assignment with passenger and fare data', async () => {
      const driverId = await makeDriver('on_trip');
      const trip = await raw.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'Origen',
          dropoffAddress: 'Destino',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10000,
          commission: 800,
          status: 'in_progress',
        },
      });
      await withTenant((tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId,
            vehicleId,
            companyId,
            status: 'accepted',
            assignedBy: 'system',
          },
        }),
      );

      const active = await withTenant((tx) => repo.getActiveTrip(tx, driverId, companyId));

      expect(active).toMatchObject({
        tripRequestId: trip.tripRequestId,
        status: 'in_progress',
        pickupAddress: 'Origen',
        dropoffAddress: 'Destino',
        fare: 10000,
        commission: 800,
        passengerName: '_DriverRepo Passenger',
      });
    });

    it('getActiveTrip returns null when there is no accepted assignment', async () => {
      const driverId = await makeDriver('available');

      const active = await withTenant((tx) => repo.getActiveTrip(tx, driverId, companyId));

      expect(active).toBeNull();
    });

    it('listPendingCashTrips lists completed trips with cash still uncollected', async () => {
      const driverId = await makeDriver('available');
      const trip = await raw.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'Origen',
          dropoffAddress: 'Parada final',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 12000,
          commission: 900,
          status: 'completed',
          finishedAt: new Date(),
        },
      });
      await withTenant((tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId,
            vehicleId,
            companyId,
            status: 'completed',
            assignedBy: 'system',
          },
        }),
      );

      const pending = await withTenant((tx) => repo.listPendingCashTrips(tx, driverId, companyId));

      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        tripRequestId: trip.tripRequestId,
        fare: 12000,
        dropoffAddress: 'Parada final',
      });
    });

    it('listPendingCashTrips excludes trips whose cash was already collected', async () => {
      const driverId = await makeDriver('available');
      const trip = await raw.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'Origen',
          dropoffAddress: 'Destino cobrado',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 15000,
          commission: 1000,
          status: 'completed',
          finishedAt: new Date(),
          cashCollectedAt: new Date(),
        },
      });
      await withTenant((tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId,
            vehicleId,
            companyId,
            status: 'completed',
            assignedBy: 'system',
          },
        }),
      );

      const pending = await withTenant((tx) => repo.listPendingCashTrips(tx, driverId, companyId));

      expect(pending).toHaveLength(0);
    });
  });
});
