import { Injectable } from '@nestjs/common';
import type { CompanyRef, ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WITH_OPEN_COMMISSION } from './open-commission.filter';
import { companyDisplayName } from './company-display-name';

const collator = new Intl.Collator('es-CO', { sensitivity: 'base' });

@Injectable()
export class CompanyDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(municipalityId: number, serviceType: ServiceType): Promise<CompanyRef[]> {
    const rows = await this.prisma.runAsPlatform((tx) =>
      tx.company.findMany({
        where: {
          municipalityId,
          status: 'active',
          serviceTypes: { has: serviceType },
          ...WITH_OPEN_COMMISSION,
        },
        select: { companyId: true, publicName: true, legalName: true },
      }),
    );
    return rows
      .map((row) => ({ company_id: row.companyId, display_name: companyDisplayName(row) }))
      .sort(
        (a, b) => collator.compare(a.display_name, b.display_name) || a.company_id - b.company_id,
      );
  }

  async getRef(companyId: number): Promise<CompanyRef | null> {
    const row = await this.prisma.company.findUnique({
      where: { companyId },
      select: { companyId: true, publicName: true, legalName: true },
    });
    return row ? { company_id: row.companyId, display_name: companyDisplayName(row) } : null;
  }
}
