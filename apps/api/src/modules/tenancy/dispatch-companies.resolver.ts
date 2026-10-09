import { Injectable } from '@nestjs/common';
import type { ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WITH_OPEN_COMMISSION } from './open-commission.filter';

export interface DispatchCompaniesOptions {
  serviceType?: ServiceType;
  requestedCompanyId?: number | null;
  excludeCompanyId?: number;
}

@Injectable()
export class DispatchCompaniesResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(municipalityId: number, options?: DispatchCompaniesOptions): Promise<number[]> {
    const companies = await this.prisma.runAsPlatform((tx) =>
      tx.company.findMany({
        where: {
          municipalityId,
          status: 'active',
          ...WITH_OPEN_COMMISSION,
          ...(options?.serviceType !== undefined
            ? { serviceTypes: { has: options.serviceType } }
            : {}),
          AND: [
            ...(options?.requestedCompanyId != null
              ? [{ companyId: options.requestedCompanyId }]
              : []),
            ...(options?.excludeCompanyId !== undefined
              ? [{ companyId: { not: options.excludeCompanyId } }]
              : []),
          ],
        },
        orderBy: { companyId: 'asc' },
        select: { companyId: true },
      }),
    );
    return companies.map((company) => company.companyId);
  }
}
