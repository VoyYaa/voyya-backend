import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface DispatchCompaniesOptions {
  serviceType?: ServiceType;
  requestedCompanyId?: number | null;
  excludeCompanyId?: number;
  tx?: Prisma.TransactionClient;
}

@Injectable()
export class DispatchCompaniesResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(municipalityId: number, options?: DispatchCompaniesOptions): Promise<number[]> {
    const client = options?.tx ?? this.prisma;
    const companies = await client.company.findMany({
      where: {
        municipalityId,
        status: 'active',
        ...(options?.serviceType !== undefined ? { serviceTypes: { has: options.serviceType } } : {}),
        AND: [
          ...(options?.requestedCompanyId != null ? [{ companyId: options.requestedCompanyId }] : []),
          ...(options?.excludeCompanyId !== undefined
            ? [{ companyId: { not: options.excludeCompanyId } }]
            : []),
        ],
      },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
    });
    return companies.map((company) => company.companyId);
  }
}
