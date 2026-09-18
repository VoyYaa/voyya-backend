import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { provisionCompany, type ProvisionCompanyInput } from '../scripts/provision-company';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

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

suite('provisionCompany (ADR-018 §9) against real Postgres', () => {
  let raw: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  function baseInput(suffix: string, overrides: Partial<ProvisionCompanyInput> = {}): ProvisionCompanyInput {
    return {
      municipality: {
        name: `_ProvisionMuni-${suffix}`,
        department: 'Test',
        coveragePolygon: poly,
      },
      company: { legalName: '_ProvisionCo', taxId: `_provision-co-${suffix}`, type: 'cooperative' },
      initialFare: { baseFare: 8200 },
      initialParams: { searchRadiusKm: 2, expansionRadiusKm: 6, acceptanceTimeoutSec: 15 },
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

  it('provisions municipality + company + fare_config + system_parameter + admin, all in one transaction', async () => {
    const suffix = uniqueSuffix();
    const result = await provisionCompany(raw, baseInput(suffix));

    expect(result.companyId).toEqual(expect.any(Number));
    expect(result.fareConfigId).toEqual(expect.any(Number));
    expect(result.adminUserId).toEqual(expect.any(Number));

    const fareConfig = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(result.companyId)}, true)`;
      return tx.fareConfig.findFirst({ where: { companyId: result.companyId, serviceType: 'taxi' } });
    });
    expect(fareConfig?.validTo).toBeNull();
    expect(Number(fareConfig?.baseFare)).toBe(8200);
    expect(fareConfig?.createdBy).toBeNull();

    const parameters = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(result.companyId)}, true)`;
      return tx.systemParameter.findMany({ where: { companyId: result.companyId } });
    });
    const keys = parameters.map((p) => p.key).sort();
    expect(keys).toEqual(['acceptance_timeout_sec', 'expansion_radius_km', 'search_radius_km']);

    const admin = await raw.user.findUnique({ where: { userId: result.adminUserId } });
    expect(admin?.role).toBe('admin');
    expect(admin?.companyId).toBe(result.companyId);
  });

  it('an existing municipalityId is reused, not recreated', async () => {
    const suffix = uniqueSuffix();
    const existing = await raw.municipality.upsert({
      where: { municipalityId: 9191 },
      update: { coveragePolygon: poly, status: 'active' },
      create: {
        municipalityId: 9191,
        name: '_ProvisionExistingMuni',
        department: 'Test',
        coveragePolygon: poly,
        status: 'active',
      },
    });

    const result = await provisionCompany(
      raw,
      baseInput(suffix, { municipality: { municipalityId: existing.municipalityId } }),
    );

    expect(result.municipalityId).toBe(existing.municipalityId);
    const municipalityCount = await raw.municipality.count({
      where: { name: '_ProvisionExistingMuni' },
    });
    expect(municipalityCount).toBe(1);
  });

  it('a nonexistent municipalityId aborts the whole transaction, nothing is created', async () => {
    const suffix = uniqueSuffix();
    const input = baseInput(suffix, { municipality: { municipalityId: 999_999_999 } });

    await expect(provisionCompany(raw, input)).rejects.toThrow();

    const company = await raw.company.findUnique({ where: { taxId: `_provision-co-${suffix}` } });
    expect(company).toBeNull();
  });

  it('a duplicate taxId aborts the whole transaction: no municipality, no company, no admin leftover', async () => {
    const suffix = uniqueSuffix();
    await provisionCompany(raw, baseInput(suffix));

    const duplicateSuffix = uniqueSuffix();
    const secondAttempt = baseInput(duplicateSuffix, {
      company: { legalName: '_ProvisionDuplicateCo', taxId: `_provision-co-${suffix}`, type: 'cooperative' },
    });

    await expect(provisionCompany(raw, secondAttempt)).rejects.toThrow();

    const leakedMunicipality = await raw.municipality.count({
      where: { name: `_ProvisionMuni-${duplicateSuffix}` },
    });
    expect(leakedMunicipality).toBe(0);

    const leakedAdmin = await raw.user.findUnique({
      where: { phone: `_provision-admin-${duplicateSuffix}` },
    });
    expect(leakedAdmin).toBeNull();
  });
});
