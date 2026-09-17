import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class CompanyMunicipalityResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(companyId: number): Promise<number> {
    const company = await this.prisma.company.findUnique({
      where: { companyId },
      select: { municipalityId: true },
    });
    if (!company) {
      throw new InternalServerErrorException('Company not found for the authenticated tenant');
    }
    return company.municipalityId;
  }
}
