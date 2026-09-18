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

  describe('purgeStaleLocations / listCompanyIds (ADR-019 §8, closes V-07)', () => {
    async function withCompanyTenant<T>(
      forCompanyId: number,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company', ${String(forCompanyId)}, true)`;
        return fn(tx);
      });
    }

    async function makeDriverWithLocation(
      status: 'off_shift' | 'available' | 'on_trip',
      locationUpdatedAt: Date | null,
      forCompanyId: number = companyId,
      forVehicleId: number = vehicleId,
    ): Promise<number> {
      driverSeq += 1;
      const phone = `_drt-purge-${runId}-${driverSeq}`;
      const user = await raw.user.upsert({
        where: { phone },
        update: {},
        create: { firstName: '_DriverRepo', lastName: `Purge${driverSeq}`, phone, role: 'driver' },
      });
      await withCompanyTenant(forCompanyId, (tx) =>
        tx.driver.upsert({
          where: { driverId: user.userId },
          update: {
            companyId: forCompanyId,
            status,
            currentVehicleId: forVehicleId,
            pin: 'x',
            currentLat: 6.9,
            currentLng: -75.4,
            locationUpdatedAt,
          },
          create: {
            driverId: user.userId,
            companyId: forCompanyId,
            nationalId: `_DRT-PRG-${runId}-${driverSeq}`,
            pin: 'x',
            status,
            currentVehicleId: forVehicleId,
            currentLat: 6.9,
            currentLng: -75.4,
            locationUpdatedAt,
          },
        }),
      );
      return user.userId;
    }

    async function readDriver(driverId: number, forCompanyId: number = companyId) {
      return withCompanyTenant(forCompanyId, (tx) => tx.driver.findUnique({ where: { driverId } }));
    }

    function hoursAgo(hours: number): Date {
      return new Date(Date.now() - hours * 60 * 60 * 1000);
    }

    it('without a tenant session (a dedicated, never-tenanted connection), the FORCE RLS policy blocks the UPDATE and 0 rows are purged — the exact trap of guardarraíl 7', async () => {
      const driverId = await makeDriverWithLocation('off_shift', hoursAgo(20));

      const { PrismaClient: Client } = await import('@prisma/client');
      const untenanted = new Client({ datasources: { db: { url } } });
      await untenanted.$connect();
      try {
        const purged = await untenanted.$transaction((tx) =>
          repo.purgeStaleLocations(tx, companyId, 12),
        );

        expect(purged).toBe(0);
      } finally {
        await untenanted.$disconnect();
      }

      const row = await readDriver(driverId);
      expect(row?.currentLat).not.toBeNull();

      await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));
    });

    it('connected as app_voyya, inside runInTenant, purges a driver stale beyond the threshold — real rows change, not just "no exception"', async () => {
      const driverId = await makeDriverWithLocation('available', hoursAgo(20));

      const purged = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));

      expect(purged).toBe(1);
      const row = await readDriver(driverId);
      expect(row?.currentLat).toBeNull();
      expect(row?.currentLng).toBeNull();
      expect(row?.locationUpdatedAt).toBeNull();
    });

    it('does not purge an active driver whose location is fresh', async () => {
      const driverId = await makeDriverWithLocation('available', hoursAgo(0.03));

      const purged = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));

      expect(purged).toBe(0);
      const row = await readDriver(driverId);
      expect(row?.currentLat).not.toBeNull();
    });

    it('purges off_shift residue even with a recent timestamp', async () => {
      const driverId = await makeDriverWithLocation('off_shift', hoursAgo(0.03));

      const purged = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));

      expect(purged).toBe(1);
      const row = await readDriver(driverId);
      expect(row?.currentLat).toBeNull();
    });

    it('purges coordinates that have no location_updated_at at all (orphan guard)', async () => {
      const driverId = await makeDriverWithLocation('available', null);

      const purged = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));

      expect(purged).toBe(1);
      const row = await readDriver(driverId);
      expect(row?.currentLat).toBeNull();
    });

    it('never touches status, trip, assignment or cash_collected_at of an on_trip driver — only the location', async () => {
      const driverId = await makeDriverWithLocation('on_trip', hoursAgo(20));
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
      const assignment = await withTenant((tx) =>
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

      const purged = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));

      expect(purged).toBe(1);
      const driverRow = await readDriver(driverId);
      expect(driverRow?.status).toBe('on_trip');
      expect(driverRow?.currentLat).toBeNull();
      const tripRow = await raw.tripRequest.findUnique({ where: { tripRequestId: trip.tripRequestId } });
      expect(tripRow?.status).toBe('in_progress');
      expect(tripRow?.cashCollectedAt).toBeNull();
      const assignmentRow = await withTenant((tx) =>
        tx.assignment.findUnique({ where: { assignmentId: assignment.assignmentId } }),
      );
      expect(assignmentRow?.status).toBe('accepted');
    });

    it('listCompanyIds includes every company, active or not', async () => {
      const suspended = await raw.company.upsert({
        where: { taxId: '_driver-repo-purge-suspended' },
        update: { status: 'suspended' },
        create: {
          legalName: '_DriverRepoPurgeSuspended',
          taxId: '_driver-repo-purge-suspended',
          type: 'cooperative',
          municipalityId,
          status: 'suspended',
        },
      });

      const ids = await repo.listCompanyIds();

      expect(ids).toEqual(expect.arrayContaining([companyId, suspended.companyId]));
    });

    it('two companies with a stale driver each: the loop purges both, no cross-tenant leak', async () => {
      const otherCompany = await raw.company.upsert({
        where: { taxId: '_driver-repo-purge-other' },
        update: { status: 'active' },
        create: {
          legalName: '_DriverRepoPurgeOther',
          taxId: '_driver-repo-purge-other',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      const otherVehicle = await withCompanyTenant(otherCompany.companyId, (tx) =>
        tx.vehicle.upsert({
          where: { plate: '_DRT-PRG-OTHER' },
          update: { status: 'active', companyId: otherCompany.companyId },
          create: { plate: '_DRT-PRG-OTHER', companyId: otherCompany.companyId, status: 'active' },
        }),
      );

      const otherDriverId = await makeDriverWithLocation(
        'available',
        hoursAgo(20),
        otherCompany.companyId,
        otherVehicle.vehicleId,
      );
      const driverId = await makeDriverWithLocation('available', hoursAgo(20));

      const purgedHere = await withTenant((tx) => repo.purgeStaleLocations(tx, companyId, 12));
      const purgedOther = await withCompanyTenant(otherCompany.companyId, (tx) =>
        repo.purgeStaleLocations(tx, otherCompany.companyId, 12),
      );

      expect(purgedHere).toBe(1);
      expect(purgedOther).toBe(1);
      const hereRow = await readDriver(driverId);
      const otherRow = await readDriver(otherDriverId, otherCompany.companyId);
      expect(hereRow?.currentLat).toBeNull();
      expect(otherRow?.currentLat).toBeNull();
    });
  });
});
