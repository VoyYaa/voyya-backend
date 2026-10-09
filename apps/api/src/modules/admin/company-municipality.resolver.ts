import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface CompanyServiceScope {
  municipalityId: number;
  serviceType: ServiceType;
}

@Injectable()
export class CompanyMunicipalityResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(companyId: number): Promise<CompanyServiceScope> {
    const company = await this.prisma.company.findUnique({
      where: { companyId },
      select: { municipalityId: true, serviceTypes: true },
    });
    if (!company) {
      throw new InternalServerErrorException('Company not found for the authenticated tenant');
    }
    return { municipalityId: company.municipalityId, serviceType: company.serviceTypes[0] ?? 'taxi' };
  }
}
