import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { provisionCompany, type ProvisionCompanyInput } from '../scripts/provision-company';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PREFIX = '_ProvisionMuni';

const poly = {
  type: 'Polygon',
  coordinates: [
    [
      [-75.45, 6.94],
      [-75.39, 6.94],
      [-75.39, 6.99],
      [-75.45, 6.99],
      [-75.45, 6.94],
    ],
  ],
};

function uniqueSuffix(): string {
  return `${Date.now()}-${randomInt(100_000, 999_999)}`;
}

suite('provisionCompany (ADR-018 §9, ADR-032 §10.2, ADR-031 §1.4) against real Postgres', () => {
  let raw: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
  });

  afterAll(async () => {
    if (raw) {
      await purgeMunicipalitiesByNamePrefix(raw, PREFIX);
      await raw.$disconnect();
    }
  }, 60_000);

  async function municipalityFixture(suffix: string): Promise<number> {
    const municipality = await raw.municipality.create({
      data: { name: `${PREFIX}-${suffix}`, department: 'Test', coveragePolygon: poly, status: 'active' },
    });
    return municipality.municipalityId;
  }

  function baseInput(
    suffix: string,
    municipalityId: number,
    overrides: Partial<ProvisionCompanyInput> = {},
  ): ProvisionCompanyInput {
    return {
      municipality: { municipalityId },
      company: { legalName: '_ProvisionCo', taxId: `_provision-co-${suffix}`, type: 'cooperative' },
      initialFare: { baseFare: 8200 },
      commissionPct: 8,
      admin: {
        firstName: '_Provision',
        lastName: 'Admin',
        email: `_provision-admin-${suffix}@example.com`,
        phone: `_provision-admin-${suffix}`,
        password: 'a-strong-password',
      },
      ...overrides,
    };
  }

  it('provisions company + municipality fare + commission + admin, all in one transaction', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await municipalityFixture(suffix);

    const result = await provisionCompany(raw, baseInput(suffix, municipalityId));

    expect(result.companyId).toEqual(expect.any(Number));
    expect(result.adminUserId).toEqual(expect.any(Number));
    expect(result.municipalityId).toBe(municipalityId);
    expect(result.municipalityFares).toEqual([
      expect.objectContaining({ serviceType: 'taxi', created: true }),
    ]);

    const fares = await raw.municipalityFare.findMany({ where: { municipalityId, validTo: null } });
    expect(fares).toHaveLength(1);
    expect(Number(fares[0]?.baseFare)).toBe(8200);
    expect(Number(fares[0]?.nightSurchargePct)).toBe(20);
    expect(fares[0]?.origin).toBe('company_approval');
    expect(fares[0]?.createdBy).toBeNull();

    const params = await raw.municipalityOperationalParams.findMany({
      where: { municipalityId, validTo: null },
    });
    expect(params).toHaveLength(1);
    expect(params[0]?.searchRadiusKm).toBeNull();

    const commissions = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(result.companyId)}, true)`;
      return tx.companyCommission.findMany({ where: { companyId: result.companyId } });
    });
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0]?.commissionPct)).toBe(8);

    const legacy = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(result.companyId)}, true)`;
      return {
        fareConfigs: await tx.fareConfig.count({ where: { companyId: result.companyId } }),
        parameters: await tx.systemParameter.count({ where: { companyId: result.companyId } }),
      };
    });
    expect(legacy).toEqual({ fareConfigs: 0, parameters: 0 });

    const admin = await raw.user.findUnique({ where: { userId: result.adminUserId } });
    expect(admin?.role).toBe('admin');
    expect(admin?.companyId).toBe(result.companyId);
  });

  it('a second company in the same municipality reuses the fare instead of creating another', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await municipalityFixture(suffix);
    await provisionCompany(raw, baseInput(suffix, municipalityId));

    const secondSuffix = uniqueSuffix();
    const second = await provisionCompany(raw, {
      ...baseInput(secondSuffix, municipalityId),
      initialFare: { baseFare: 99_000 },
      commissionPct: 3,
    });

    expect(second.municipalityFares).toEqual([expect.objectContaining({ created: false })]);
    const fares = await raw.municipalityFare.findMany({ where: { municipalityId, validTo: null } });
    expect(fares).toHaveLength(1);
    expect(Number(fares[0]?.baseFare)).toBe(8200);
  });

  it('resolves the municipality by DANE code and never creates one', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await municipalityFixture(suffix);
    const daneCode = `00${randomInt(994, 999)}`;
    await raw.municipality.update({ where: { municipalityId }, data: { daneCode, daneType: 'municipality' } });
    const before = await raw.municipality.count();

    const result = await provisionCompany(raw, baseInput(suffix, municipalityId, { municipality: { daneCode } }));

    expect(result.municipalityId).toBe(municipalityId);
    expect(await raw.municipality.count()).toBe(before);
  });

  it('a nonexistent municipality aborts the whole transaction, nothing is created', async () => {
    const suffix = uniqueSuffix();
    const input = baseInput(suffix, 999_999_999);

    await expect(provisionCompany(raw, input)).rejects.toThrow();

    const company = await raw.company.findUnique({ where: { taxId: `_provision-co-${suffix}` } });
    expect(company).toBeNull();
  });

  it('an unknown DANE code aborts without creating a municipality', async () => {
    const suffix = uniqueSuffix();
    const before = await raw.municipality.count();

    await expect(
      provisionCompany(raw, baseInput(suffix, 0, { municipality: { daneCode: '00000' } })),
    ).rejects.toThrow();

    expect(await raw.municipality.count()).toBe(before);
  });

  it('a duplicate taxId aborts the whole transaction: no fare, no commission, no admin leftover', async () => {
    const suffix = uniqueSuffix();
    const municipalityId = await municipalityFixture(suffix);
    await provisionCompany(raw, baseInput(suffix, municipalityId));

    const otherSuffix = uniqueSuffix();
    const otherMunicipalityId = await municipalityFixture(otherSuffix);
    const secondAttempt = baseInput(otherSuffix, otherMunicipalityId, {
      company: { legalName: '_ProvisionDuplicateCo', taxId: `_provision-co-${suffix}`, type: 'cooperative' },
    });

    await expect(provisionCompany(raw, secondAttempt)).rejects.toThrow();

    expect(await raw.municipalityFare.count({ where: { municipalityId: otherMunicipalityId } })).toBe(0);
    const leakedAdmin = await raw.user.findUnique({ where: { phone: `_provision-admin-${otherSuffix}` } });
    expect(leakedAdmin).toBeNull();
  });
});
