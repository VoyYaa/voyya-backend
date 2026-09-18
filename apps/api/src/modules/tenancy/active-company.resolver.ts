import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ActiveCompany {
  companyId: number;
}

@Injectable()
export class ActiveCompanyResolver {
  private readonly logger = new Logger(ActiveCompanyResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(municipalityId: number): Promise<number | null> {
    const companies = await this.prisma.company.findMany({
      where: { municipalityId, status: 'active' },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
      take: 2,
    });
    if (companies.length > 1) {
      this.logger.error(
        `Multiple active companies in municipality=${municipalityId}: ` +
          companies.map((c) => c.companyId).join(','),
      );
    }
    return companies[0]?.companyId ?? null;
  }
}
