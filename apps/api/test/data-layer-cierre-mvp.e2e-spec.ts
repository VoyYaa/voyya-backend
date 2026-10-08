import { type Prisma, PrismaClient } from '@prisma/client';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_B1DataMuni';
const MONDAY = '2026-10-05';

const FORCED_RLS_TABLES = [
  'fleet.driver',
  'fleet.vehicle',
  'assignment.assignment',
  'trips.fare_config',
  'admin.system_parameter',
  'tenancy.company_document',
  'tenancy.company_review',
  'fleet.driver_document',
  'admin.settlement_remittance',
  'admin.settlement_export',
];

const BASE_TRIP = {
  serviceType: 'taxi' as const,
  paymentMethod: 'cash' as const,
  pickupAddress: 'A',
  dropoffAddress: 'B',
  pickupLat: 0.1,
  pickupLng: 0.1,
  dropoffLat: 0.2,
  dropoffLng: 0.2,
  fare: 8000,
  commission: 640,
};

suite('Cierre del MVP data layer against real Postgres as app_voyya (ADR-027, 028, 029, 030)', () => {
  let prisma: PrismaClient;
  let companyId: number;
  let otherCompanyId: number;
  let municipalityId: number;
  let adminId: number;
  let driverId: number;

  async function inTenant<T>(
    tenant: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(tenant)}, true)`;
      return fn(tx);
    });
  }

  async function expectRejected(promise: Promise<unknown>, message: RegExp): Promise<void> {
    await expect(promise).rejects.toThrow(message);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);

    const stamp = Date.now();
    const municipality = await prisma.municipality.create({
      data: {
        name: `${PREFIX}-${stamp}`,
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

    const company = await prisma.company.create({
      data: {
        legalName: '_B1Data A',
        taxId: `_b1-a-${stamp}`,
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;
    const other = await prisma.company.create({
      data: {
        legalName: '_B1Data B',
        taxId: `_b1-b-${stamp}`,
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    otherCompanyId = other.companyId;

    const admin = await prisma.user.create({
      data: {
        firstName: '_B1',
        lastName: 'Admin',
        phone: `_b1-admin-${stamp}`,
        role: 'admin',
        companyId,
      },
    });
    adminId = admin.userId;

    const driverUser = await prisma.user.create({
      data: {
        firstName: '_B1',
        lastName: 'Driver',
        phone: `_b1-driver-${stamp}`,
        role: 'driver',
        companyId,
      },
    });
    driverId = driverUser.userId;
    await inTenant(companyId, (tx) =>
      tx.driver.create({ data: { driverId, companyId, nationalId: `_b1-${stamp}`, pin: 'x' } }),
    );
  });

  afterAll(async () => {
    if (prisma) {
      await purgeMunicipalitiesByNamePrefix(prisma, PREFIX);
      await prisma.$disconnect();
    }
  });

  it('forces RLS on all ten tenant tables', async () => {
    const rows = await prisma.$queryRaw<Array<{ tbl: string }>>`
      SELECT n.nspname || '.' || c.relname AS tbl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relforcerowsecurity
    `;
    const forced = rows.map((r) => r.tbl);
    for (const table of FORCED_RLS_TABLES) expect(forced).toContain(table);
  });

  it('a new driver starts with pin_must_change = true and no temporary expiry (ADR-028)', async () => {
    const driver = await inTenant(companyId, (tx) =>
      tx.driver.findUniqueOrThrow({ where: { driverId } }),
    );
    expect(driver.pinMustChange).toBe(true);
    expect(driver.temporaryPinExpiresAt).toBeNull();
    expect(driver.pinChangedAt).toBeNull();
  });

  it('rejects a temporary expiry on a driver that no longer has to change the PIN', async () => {
    await expectRejected(
      inTenant(companyId, (tx) =>
        tx.driver.update({
          where: { driverId },
          data: { pinMustChange: false, temporaryPinExpiresAt: new Date() },
        }),
      ),
      /driver_temporary_pin_requires_change/,
    );
  });

  describe('settlement ledgers (ADR-027)', () => {
    function remit(
      kind: 'remittance' | 'reversal',
      reverses: number | null,
      amount = 27600,
      weekStart = `${MONDAY}T00:00:00Z`,
    ) {
      return inTenant(companyId, (tx) =>
        tx.settlementRemittance.create({
          data: {
            companyId,
            driverId,
            weekStart: new Date(weekStart),
            kind,
            amount,
            reversesRemittanceId: reverses,
            recordedBy: adminId,
          },
        }),
      );
    }

    it('inserts under the own tenant and hides rows from another tenant', async () => {
      const entry = await remit('remittance', null);
      const own = await inTenant(companyId, (tx) => tx.settlementRemittance.count());
      const foreign = await inTenant(otherCompanyId, (tx) => tx.settlementRemittance.count());
      expect(entry.remittanceId).toBeGreaterThan(0);
      expect(own).toBeGreaterThanOrEqual(1);
      expect(foreign).toBe(0);
    });

    it('rejects an insert for another company (WITH CHECK)', async () => {
      await expectRejected(
        inTenant(otherCompanyId, (tx) =>
          tx.settlementRemittance.create({
            data: {
              companyId,
              driverId,
              weekStart: new Date(`${MONDAY}T00:00:00Z`),
              kind: 'remittance',
              amount: 1,
              recordedBy: adminId,
            },
          }),
        ),
        /row-level security/,
      );
    });

    it('app_voyya cannot UPDATE or DELETE the append-only tables', async () => {
      await expectRejected(
        inTenant(companyId, (tx) => tx.$executeRaw`UPDATE admin.settlement_remittance SET amount = 1`),
        /permission denied/,
      );
      await expectRejected(
        inTenant(companyId, (tx) => tx.$executeRaw`DELETE FROM admin.settlement_remittance`),
        /permission denied/,
      );
      await expectRejected(
        inTenant(companyId, (tx) => tx.$executeRaw`UPDATE admin.settlement_export SET row_count = 1`),
        /permission denied/,
      );
      await expectRejected(
        inTenant(companyId, (tx) => tx.$executeRaw`DELETE FROM admin.settlement_export`),
        /permission denied/,
      );
    });

    it('enforces Monday week start, positive amount and reversal shape', async () => {
      await expectRejected(
        remit('remittance', null, 1, '2026-10-06T00:00:00Z'),
        /week_starts_monday/,
      );
      await expectRejected(remit('remittance', null, 0), /amount_positive/);
      await expectRejected(remit('reversal', null), /reversal_shape/);
    });

    it('allows one reversal per remittance only', async () => {
      const original = await remit('remittance', null, 1000);
      await remit('reversal', original.remittanceId, 1000);
      await expectRejected(remit('reversal', original.remittanceId, 1000), /Unique constraint/);
    });

    it('records an export audit row under the own tenant and enforces the date range', async () => {
      const audit = await inTenant(companyId, (tx) =>
        tx.settlementExport.create({
          data: {
            companyId,
            exportedBy: adminId,
            fromDate: new Date('2026-10-05'),
            toDate: new Date('2026-10-11'),
            rowCount: 3,
          },
        }),
      );
      expect(audit.exportId).toBeGreaterThan(0);
      await expectRejected(
        inTenant(companyId, (tx) =>
          tx.settlementExport.create({
            data: {
              companyId,
              exportedBy: adminId,
              fromDate: new Date('2026-10-12'),
              toDate: new Date('2026-10-05'),
              rowCount: 0,
            },
          }),
        ),
        /settlement_export_range/,
      );
    });
  });

  describe('trip request constraints (ADR-029 section 5, ADR-030)', () => {
    it('allows only one active trip per passenger and a new one after it ends', async () => {
      const passengerId = await createFreshPassenger(prisma);
      const first = await prisma.tripRequest.create({
        data: { ...BASE_TRIP, passengerId, municipalityId, status: 'pending_assignment' },
      });
      await expectRejected(
        prisma.tripRequest.create({
          data: { ...BASE_TRIP, passengerId, municipalityId, status: 'assigned' },
        }),
        /Unique constraint/,
      );
      await prisma.tripRequest.update({
        where: { tripRequestId: first.tripRequestId },
        data: { status: 'cancelled_by_passenger' },
      });
      const second = await prisma.tripRequest.create({
        data: { ...BASE_TRIP, passengerId, municipalityId, status: 'pending_assignment' },
      });
      expect(second.tripRequestId).toBeGreaterThan(first.tripRequestId);
    });

    it('keeps the six location columns mandatory until the trip is purged, then all null together', async () => {
      const passengerId = await createFreshPassenger(prisma);
      await expectRejected(
        prisma.tripRequest.create({
          data: { ...BASE_TRIP, passengerId, municipalityId, status: 'completed', pickupAddress: null },
        }),
        /trip_request_location_purge_consistent/,
      );
      await expectRejected(
        prisma.tripRequest.create({
          data: {
            ...BASE_TRIP,
            passengerId,
            municipalityId,
            status: 'completed',
            locationPurgedAt: new Date(),
          },
        }),
        /trip_request_location_purge_consistent/,
      );
      const purged = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          status: 'completed',
          fare: 8000,
          commission: 640,
          pickupAddress: null,
          dropoffAddress: null,
          pickupLat: null,
          pickupLng: null,
          dropoffLat: null,
          dropoffLng: null,
          locationPurgedAt: new Date(),
        },
      });
      expect(purged.pickupLat).toBeNull();
      expect(purged.locationPurgedAt).not.toBeNull();
    });
  });

  describe('consent ledger (ADR-029 section 2)', () => {
    it('keeps several asientos per user, purpose and version', async () => {
      const userId = await createFreshPassenger(prisma);
      const data = { userId, purpose: 'location' as const, noticeVersion: 'location-notice-v2' };
      await prisma.consentRecord.create({ data: { ...data, action: 'granted' } });
      await prisma.consentRecord.create({ data: { ...data, action: 'revoked' } });
      await prisma.consentRecord.create({ data: { ...data, action: 'granted' } });
      const entries = await prisma.consentRecord.findMany({
        where: { userId },
        orderBy: [{ recordedAt: 'desc' }, { consentRecordId: 'desc' }],
      });
      expect(entries.map((e) => e.action)).toEqual(['granted', 'revoked', 'granted']);
    });

    it('rejects an asiento that points to an unregistered notice text', async () => {
      const userId = await createFreshPassenger(prisma);
      await expectRejected(
        prisma.consentRecord.create({
          data: { userId, purpose: 'location', noticeVersion: 'never-registered', audience: 'driver' },
        }),
        /consent_record_purpose_notice_version_audience_fkey|Foreign key/,
      );
    });
  });

  it('keeps the partial and purge indexes of the cycle', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
       WHERE indexname IN (
         'uq_assignment_completed_per_trip_request',
         'uq_trip_request_active_per_passenger',
         'idx_trip_request_coordinates_purge',
         'settlement_remittance_reverses_remittance_id_key'
       )
    `;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'idx_trip_request_coordinates_purge',
      'settlement_remittance_reverses_remittance_id_key',
      'uq_assignment_completed_per_trip_request',
      'uq_trip_request_active_per_passenger',
    ]);
  });
});
