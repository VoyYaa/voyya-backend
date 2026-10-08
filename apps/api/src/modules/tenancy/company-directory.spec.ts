import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CompanyDirectory } from './company-directory';

interface Row {
  companyId: number;
  publicName: string | null;
  legalName: string;
}

function buildDirectory(rows: Row[]): { directory: CompanyDirectory; findMany: jest.Mock; findUnique: jest.Mock } {
  const findMany = jest.fn(async () => rows);
  const findUnique = jest.fn(async ({ where }: { where: { companyId: number } }) =>
    rows.find((row) => row.companyId === where.companyId) ?? null,
  );
  const prisma = { company: { findMany, findUnique } } as unknown as PrismaService;
  return { directory: new CompanyDirectory(prisma), findMany, findUnique };
}

describe('CompanyDirectory', () => {
  it('lists the active companies that offer the service, named by public name or legal name', async () => {
    const { directory, findMany } = buildDirectory([
      { companyId: 2, publicName: 'Beta Taxis', legalName: 'Beta SAS' },
      { companyId: 1, publicName: null, legalName: 'Cootrayal Ltda' },
    ]);

    const result = await directory.listActive(7, 'taxi');

    expect(result.map((company) => company.display_name)).toEqual(['Beta Taxis', 'Cootrayal Ltda']);
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      municipalityId: 7,
      status: 'active',
      serviceTypes: { has: 'taxi' },
    });
  });

  it('sorts by display name with Spanish collation, ignoring accents and case', async () => {
    const { directory } = buildDirectory([
      { companyId: 1, publicName: 'zeta', legalName: 'z' },
      { companyId: 2, publicName: 'Álamo', legalName: 'a' },
      { companyId: 3, publicName: 'beta', legalName: 'b' },
    ]);

    const result = await directory.listActive(1, 'taxi');

    expect(result.map((company) => company.display_name)).toEqual(['Álamo', 'beta', 'zeta']);
  });

  it('companies with the same name keep a stable order by id', async () => {
    const { directory } = buildDirectory([
      { companyId: 9, publicName: 'Igual', legalName: 'x' },
      { companyId: 3, publicName: 'Igual', legalName: 'y' },
    ]);

    const result = await directory.listActive(1, 'taxi');

    expect(result.map((company) => company.company_id)).toEqual([3, 9]);
  });

  it('getRef names one company and returns null when it does not exist', async () => {
    const { directory } = buildDirectory([{ companyId: 4, publicName: null, legalName: 'Legal SAS' }]);

    await expect(directory.getRef(4)).resolves.toEqual({ company_id: 4, display_name: 'Legal SAS' });
    await expect(directory.getRef(99)).resolves.toBeNull();
  });
});
