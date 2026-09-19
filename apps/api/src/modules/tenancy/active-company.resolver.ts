import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ActiveCompany {
  companyId: number;
}

export interface ResolveActiveCompanyOptions {
  tx?: Prisma.TransactionClient;
  excludeCompanyId?: number;
}

@Injectable()
export class ActiveCompanyResolver {
  private readonly logger = new Logger(ActiveCompanyResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(municipalityId: number, options?: ResolveActiveCompanyOptions): Promise<number | null> {
    const client = options?.tx ?? this.prisma;
    const companies = await client.company.findMany({
      where: {
        municipalityId,
        status: 'active',
        ...(options?.excludeCompanyId !== undefined
          ? { companyId: { not: options.excludeCompanyId } }
          : {}),
      },
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
