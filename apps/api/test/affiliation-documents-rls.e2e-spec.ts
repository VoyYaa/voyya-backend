import type { Prisma, PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const NONEXISTENT_TENANT = 987_654_321;

const SQUARE = {
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

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

suite(
  'RLS FORCE on company_document / company_review / driver_document (ADR-021 §9.5) against real Postgres',
  () => {
    let prisma: PrismaClient;
    let companyAId: number;
    let companyBId: number;
    let driverAId: number;

    async function asCompany<T>(
      companyId: number,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
        return fn(tx);
      });
    }

    beforeAll(async () => {
      const { PrismaClient: Client } = await import('@prisma/client');
      prisma = new Client({ datasources: { db: { url } } });
      await prisma.$connect();

      const rows = await prisma.$queryRawUnsafe<Array<{ super: boolean }>>(
        `SELECT current_setting('is_superuser') = 'on' AS super`,
      );
      expect(rows[0]?.super).toBe(false);

      const suffix = uniqueSuffix();
      const municipality = await prisma.municipality.create({
        data: {
          name: `_RlsDocsMuni-${suffix}`,
          department: 'Test',
          coveragePolygon: SQUARE,
          status: 'active',
        },
      });

      const companyA = await prisma.company.create({
        data: {
          legalName: `_RlsDocsCoA-${suffix}`,
          taxId: `_rls-docs-a-${suffix}`,
          type: 'cooperative',
          municipalityId: municipality.municipalityId,
          status: 'active',
        },
      });
      companyAId = companyA.companyId;

      const companyB = await prisma.company.create({
        data: {
          legalName: `_RlsDocsCoB-${suffix}`,
          taxId: `_rls-docs-b-${suffix}`,
          type: 'cooperative',
          municipalityId: municipality.municipalityId,
          status: 'active',
        },
      });
      companyBId = companyB.companyId;

      const reviewerA = await prisma.user.create({
        data: {
          firstName: '_Reviewer',
          lastName: 'A',
          phone: `_rls-reviewer-a-${suffix}`,
          role: 'admin',
          companyId: companyAId,
        },
      });
      const reviewerB = await prisma.user.create({
        data: {
          firstName: '_Reviewer',
          lastName: 'B',
          phone: `_rls-reviewer-b-${suffix}`,
          role: 'admin',
          companyId: companyBId,
        },
      });

      await asCompany(companyAId, (tx) =>
        tx.companyDocument.create({
          data: {
            companyId: companyAId,
            type: 'chamber_of_commerce',
            storageKey: `companies/${companyAId}/chamber_of_commerce/a.pdf`,
            fileName: 'a.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
          },
        }),
      );
      await asCompany(companyBId, (tx) =>
        tx.companyDocument.create({
          data: {
            companyId: companyBId,
            type: 'chamber_of_commerce',
            storageKey: `companies/${companyBId}/chamber_of_commerce/b.pdf`,
            fileName: 'b.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
          },
        }),
      );

      await asCompany(companyAId, (tx) =>
        tx.companyReview.create({
          data: {
            companyId: companyAId,
            decision: 'approved',
            reviewedBy: reviewerA.userId,
          },
        }),
      );
      await asCompany(companyBId, (tx) =>
        tx.companyReview.create({
          data: {
            companyId: companyBId,
            decision: 'approved',
            reviewedBy: reviewerB.userId,
          },
        }),
      );

      const driverAUser = await prisma.user.create({
        data: {
          firstName: '_Driver',
          lastName: 'A',
          phone: `_rls-driver-a-${suffix}`,
          role: 'driver',
          companyId: companyAId,
        },
      });
      driverAId = driverAUser.userId;
      await asCompany(companyAId, (tx) =>
        tx.driver.create({
          data: {
            driverId: driverAId,
            companyId: companyAId,
            nationalId: `_rls-natid-a-${suffix}`,
            pin: 'x',
          },
        }),
      );
      await asCompany(companyAId, (tx) =>
        tx.driverDocument.create({
          data: {
            driverId: driverAId,
            companyId: companyAId,
            type: 'license',
            storageKey: `drivers/${companyAId}/${driverAId}/license/a.pdf`,
            fileName: 'a.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
            expiresAt: new Date('2030-01-01'),
          },
        }),
      );

      const driverBUser = await prisma.user.create({
        data: {
          firstName: '_Driver',
          lastName: 'B',
          phone: `_rls-driver-b-${suffix}`,
          role: 'driver',
          companyId: companyBId,
        },
      });
      await asCompany(companyBId, (tx) =>
        tx.driver.create({
          data: {
            driverId: driverBUser.userId,
            companyId: companyBId,
            nationalId: `_rls-natid-b-${suffix}`,
            pin: 'x',
          },
        }),
      );
      await asCompany(companyBId, (tx) =>
        tx.driverDocument.create({
          data: {
            driverId: driverBUser.userId,
            companyId: companyBId,
            type: 'license',
            storageKey: `drivers/${companyBId}/${driverBUser.userId}/license/b.pdf`,
            fileName: 'b.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
            expiresAt: new Date('2030-01-01'),
          },
        }),
      );
    }, 30_000);

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    it('the 3 tables have RLS forced (relforcerowsecurity = true)', async () => {
      const rows = await prisma.$queryRaw<Array<{ nspname: string; relname: string; relforcerowsecurity: boolean }>>`
        SELECT n.nspname, c.relname, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname, c.relname) IN
          (('tenancy','company_document'), ('tenancy','company_review'), ('fleet','driver_document'))
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('a nonexistent tenant session sees ZERO rows on company_document', async () => {
      const rows = await asCompany(NONEXISTENT_TENANT, (tx) =>
        tx.$queryRawUnsafe<unknown[]>('SELECT * FROM tenancy.company_document'),
      );
      expect(rows).toHaveLength(0);
    });

    it('a nonexistent tenant session sees ZERO rows on company_review', async () => {
      const rows = await asCompany(NONEXISTENT_TENANT, (tx) =>
        tx.$queryRawUnsafe<unknown[]>('SELECT * FROM tenancy.company_review'),
      );
      expect(rows).toHaveLength(0);
    });

    it('a nonexistent tenant session sees ZERO rows on driver_document', async () => {
      const rows = await asCompany(NONEXISTENT_TENANT, (tx) =>
        tx.$queryRawUnsafe<unknown[]>('SELECT * FROM fleet.driver_document'),
      );
      expect(rows).toHaveLength(0);
    });

    it('company A only ever sees its own company_document row, never B\'s', async () => {
      const rows = await asCompany(companyAId, (tx) => tx.companyDocument.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.companyId).toBe(companyAId);
    });

    it('company A cannot UPDATE company B\'s document row (0 rows affected)', async () => {
      const affected = await asCompany(companyAId, (tx) =>
        tx.companyDocument.updateMany({
          where: { companyId: companyBId },
          data: { reviewNote: 'hijacked' },
        }),
      );
      expect(affected.count).toBe(0);
    });

    it('company A only ever sees its own driver_document row, never B\'s', async () => {
      const rows = await asCompany(companyAId, (tx) => tx.driverDocument.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.companyId).toBe(companyAId);
      expect(rows[0]?.driverId).toBe(driverAId);
    });
  },
);
