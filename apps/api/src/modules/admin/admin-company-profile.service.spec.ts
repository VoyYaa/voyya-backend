import { InternalServerErrorException } from '@nestjs/common';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminCompanyProfileService } from './admin-company-profile.service';

const COMPANY_ID = 7;

function fakePrisma(company: { companyId: number; taxId: string; status: string } | null): PrismaService {
  return {
    company: { findUnique: jest.fn().mockResolvedValue(company) },
  } as unknown as PrismaService;
}

describe('AdminCompanyProfileService', () => {
  it('returns tax_id and status for the authenticated tenant', async () => {
    const prisma = fakePrisma({ companyId: COMPANY_ID, taxId: '900123456-7', status: 'active' });
    const service = new AdminCompanyProfileService(prisma);

    const result = await service.get(COMPANY_ID);

    expect(result).toEqual({ company_id: COMPANY_ID, tax_id: '900123456-7', status: 'active' });
    expect(prisma.company.findUnique).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID },
      select: { companyId: true, taxId: true, status: true },
    });
  });

  it('throws if the tenant from the token has no matching company row', async () => {
    const prisma = fakePrisma(null);
    const service = new AdminCompanyProfileService(prisma);

    await expect(service.get(COMPANY_ID)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
