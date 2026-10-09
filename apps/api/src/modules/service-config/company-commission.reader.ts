import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CompanyCommissionRepository } from './company-commission.repository';
import type { CompanyCommissionRow } from './service-config.types';

@Injectable()
export class CompanyCommissionReader {
  constructor(private readonly repo: CompanyCommissionRepository) {}

  getCurrent(tx: Prisma.TransactionClient, companyId: number): Promise<CompanyCommissionRow | null> {
    return this.repo.findCurrent(tx, companyId);
  }
}
