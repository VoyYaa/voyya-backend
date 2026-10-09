import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ServiceType } from '@voyyaa/shared';

export interface MunicipalityRef {
  municipalityId: number;
  name: string;
  department: string;
  daneCode: string | null;
  coverageActive: boolean;
}

export interface ActiveCompanyRef {
  companyId: number;
  legalName: string;
  publicName: string | null;
  serviceTypes: ServiceType[];
  municipality: MunicipalityRef;
}

const COMPANY_SELECT = {
  companyId: true,
  legalName: true,
  publicName: true,
  serviceTypes: true,
  municipality: {
    select: { municipalityId: true, name: true, department: true, daneCode: true, status: true },
  },
} as const;

type CompanyRecord = Prisma.CompanyGetPayload<{ select: typeof COMPANY_SELECT }>;

@Injectable()
export class PlatformConfigQueryRepository {
  async municipalityExists(tx: Prisma.TransactionClient, municipalityId: number): Promise<boolean> {
    const found = await tx.municipality.findUnique({
      where: { municipalityId },
      select: { municipalityId: true },
    });
    return found !== null;
  }

  async companyExists(tx: Prisma.TransactionClient, companyId: number): Promise<boolean> {
    const found = await tx.company.findUnique({ where: { companyId }, select: { companyId: true } });
    return found !== null;
  }

  async listActiveCompanies(
    tx: Prisma.TransactionClient,
    municipalityId: number | null,
  ): Promise<ActiveCompanyRef[]> {
    const rows = await tx.company.findMany({
      where: { status: 'active', ...(municipalityId !== null ? { municipalityId } : {}) },
      select: COMPANY_SELECT,
      orderBy: { companyId: 'asc' },
    });
    return rows.map(toCompanyRef);
  }
}

function toCompanyRef(row: CompanyRecord): ActiveCompanyRef {
  return {
    companyId: row.companyId,
    legalName: row.legalName,
    publicName: row.publicName,
    serviceTypes: row.serviceTypes,
    municipality: {
      municipalityId: row.municipality.municipalityId,
      name: row.municipality.name,
      department: row.municipality.department,
      daneCode: row.municipality.daneCode,
      coverageActive: row.municipality.status === 'active',
    },
  };
}
