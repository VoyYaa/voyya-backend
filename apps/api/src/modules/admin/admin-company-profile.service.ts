import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { CompanyProfile } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class AdminCompanyProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(companyId: number): Promise<CompanyProfile> {
    const company = await this.prisma.company.findUnique({
      where: { companyId },
      select: { companyId: true, taxId: true, status: true },
    });
    if (!company) {
      throw new InternalServerErrorException('Company not found for the authenticated tenant');
    }
    return {
      company_id: company.companyId,
      tax_id: company.taxId,
      status: company.status as CompanyProfile['status'],
    };
  }
}
