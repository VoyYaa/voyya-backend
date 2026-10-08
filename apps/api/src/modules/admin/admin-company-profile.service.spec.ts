import { InternalServerErrorException } from '@nestjs/common';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminCompanyProfileService } from './admin-company-profile.service';

const COMPANY_ID = 7;

interface CompanyRecord {
  companyId: number;
  taxId: string;
  status: string;
  legalName: string;
  publicName: string | null;
  serviceTypes: string[];
  municipality: { status: string };
}

function companyRecord(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    companyId: COMPANY_ID,
    taxId: '900123456-7',
    status: 'active',
    legalName: 'Cootrayal',
    publicName: null,
    serviceTypes: ['taxi'],
    municipality: { status: 'active' },
    ...overrides,
  };
}

function fakePrisma(company: CompanyRecord | null): PrismaService {
  return {
    company: { findUnique: jest.fn().mockResolvedValue(company) },
  } as unknown as PrismaService;
}

describe('AdminCompanyProfileService', () => {
  it('returns the legal name as display name when there is no public name', async () => {
    const service = new AdminCompanyProfileService(fakePrisma(companyRecord()));

    const result = await service.get(COMPANY_ID);

    expect(result).toEqual({
      company_id: COMPANY_ID,
      tax_id: '900123456-7',
      status: 'active',
      display_name: 'Cootrayal',
      service_types: ['taxi'],
      municipality_coverage_active: true,
    });
  });

  it('prefers the public name and reports the declared services', async () => {
    const service = new AdminCompanyProfileService(
      fakePrisma(companyRecord({ publicName: 'Taxis Cootrayal', serviceTypes: ['taxi', 'comfort'] })),
    );

    const result = await service.get(COMPANY_ID);

    expect(result.display_name).toBe('Taxis Cootrayal');
    expect(result.service_types).toEqual(['taxi', 'comfort']);
  });

  it('reports coverage pending when the municipality is only in the catalog', async () => {
    const service = new AdminCompanyProfileService(
      fakePrisma(companyRecord({ municipality: { status: 'catalog' } })),
    );

    expect((await service.get(COMPANY_ID)).municipality_coverage_active).toBe(false);
  });

  it('throws if the tenant from the token has no matching company row', async () => {
    const service = new AdminCompanyProfileService(fakePrisma(null));

    await expect(service.get(COMPANY_ID)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
