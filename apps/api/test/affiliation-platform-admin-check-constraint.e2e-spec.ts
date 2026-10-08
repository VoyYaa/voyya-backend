import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniquePhone(): string {
  return `_platadm-${randomInt(100_000_000, 999_999_999)}`;
}

suite('CHECK user_platform_admin_has_no_company (ADR-021 §1.1) against real Postgres', () => {
  let prisma: PrismaClient;
  let existingCompanyId: number;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    prisma = new Client({ datasources: { db: { url } } });
    await prisma.$connect();

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9201 },
      update: {},
      create: {
        municipalityId: 9201,
        name: '_CheckConstraintMuni',
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

    const company = await prisma.company.upsert({
      where: { taxId: '_check-constraint-co' },
      update: { status: 'active' },
      create: {
        legalName: '_CheckConstraintCo',
        taxId: '_check-constraint-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    existingCompanyId = company.companyId;
  });

  afterAll(async () => {
    if (prisma) {
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } });
      }
      await prisma.$disconnect();
    }
  });

  it('INSERT of a platform_admin WITH a company_id is rejected at the database level', async () => {
    const phone = uniquePhone();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "auth"."user" (first_name, last_name, phone, role, company_id)
        VALUES ('_Rogue', 'PlatformAdmin', ${phone}, 'platform_admin', ${existingCompanyId})
      `,
    ).rejects.toThrow(/user_platform_admin_has_no_company/);

    const leaked = await prisma.user.findUnique({ where: { phone } });
    expect(leaked).toBeNull();
  });

  it('INSERT of a platform_admin WITHOUT a company_id succeeds', async () => {
    const phone = uniquePhone();
    const created = await prisma.user.create({
      data: {
        firstName: '_Real',
        lastName: 'PlatformAdmin',
        phone,
        role: 'platform_admin',
        companyId: null,
      },
    });
    createdUserIds.push(created.userId);
    expect(created.companyId).toBeNull();
  });

  it('UPDATE that promotes an existing tenant-scoped admin to platform_admin (keeping company_id) is rejected', async () => {
    const phone = uniquePhone();
    const admin = await prisma.user.create({
      data: {
        firstName: '_Tenant',
        lastName: 'Admin',
        phone,
        role: 'admin',
        companyId: existingCompanyId,
      },
    });
    createdUserIds.push(admin.userId);

    await expect(
      prisma.$executeRaw`
        UPDATE "auth"."user" SET role = 'platform_admin' WHERE user_id = ${admin.userId}
      `,
    ).rejects.toThrow(/user_platform_admin_has_no_company/);

    const reloaded = await prisma.user.findUnique({ where: { userId: admin.userId } });
    expect(reloaded?.role).toBe('admin');
    expect(reloaded?.companyId).toBe(existingCompanyId);
  });

  it('UPDATE that clears company_id while promoting to platform_admin succeeds', async () => {
    const phone = uniquePhone();
    const admin = await prisma.user.create({
      data: {
        firstName: '_ToPromote',
        lastName: 'Admin',
        phone,
        role: 'admin',
        companyId: existingCompanyId,
      },
    });
    createdUserIds.push(admin.userId);

    await prisma.$executeRaw`
      UPDATE "auth"."user" SET role = 'platform_admin', company_id = NULL WHERE user_id = ${admin.userId}
    `;

    const reloaded = await prisma.user.findUnique({ where: { userId: admin.userId } });
    expect(reloaded?.role).toBe('platform_admin');
    expect(reloaded?.companyId).toBeNull();
  });
});
