import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ServiceType } from '@voyyaa/shared';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';
import {
  type InitialMunicipalityFare,
  type ProvisionedMunicipalityFare,
  ServiceConfigProvisioner,
} from '../service-config/service-config-provisioner';

const BCRYPT_ROUNDS = 12;

export type ProvisionCompanyMunicipality = { municipalityId: number } | { daneCode: string };

export interface ProvisionAdmin {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface ProvisionCompanyInput {
  municipality: ProvisionCompanyMunicipality;
  company: {
    legalName: string;
    taxId: string;
    type: string;
    publicName?: string;
    serviceTypes?: ServiceType[];
  };
  initialFare: InitialMunicipalityFare;
  commissionPct: number;
  admin: ProvisionAdmin;
}

export interface ProvisionedCompany {
  companyId: number;
  municipalityId: number;
  municipalityFares: ProvisionedMunicipalityFare[];
  companyCommissionId: number;
  adminUserId: number;
}

export interface FinishedProvisioning {
  adminUserId: number;
  adminEmail: string;
}

@Injectable()
export class CompanyProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serviceConfig: ServiceConfigProvisioner,
  ) {}

  async provisionNew(input: ProvisionCompanyInput): Promise<ProvisionedCompany> {
    return this.prisma.runAsPlatform(async (tx) => {
      const municipalityId = await resolveMunicipality(tx, input.municipality);
      const serviceTypes = input.company.serviceTypes ?? ['taxi'];

      const company = await tx.company.create({
        data: {
          legalName: input.company.legalName,
          taxId: input.company.taxId,
          type: input.company.type,
          publicName: input.company.publicName ?? null,
          serviceTypes,
          municipalityId,
          status: 'active',
        },
      });

      await setTenantSession(tx, company.companyId);

      const config = await this.serviceConfig.ensureForApproval(tx, {
        companyId: company.companyId,
        municipalityId,
        serviceTypes,
        initialFare: input.initialFare,
        commissionPct: input.commissionPct,
        createdBy: null,
      });
      const finished = await this.finishProvisioning(tx, company.companyId, input.admin);

      return {
        companyId: company.companyId,
        municipalityId,
        municipalityFares: config.municipalityFares,
        companyCommissionId: config.companyCommissionId,
        adminUserId: finished.adminUserId,
      };
    });
  }

  async finishProvisioning(
    tx: Prisma.TransactionClient,
    companyId: number,
    admin: ProvisionAdmin,
  ): Promise<FinishedProvisioning> {
    const passwordHash = await bcrypt.hash(admin.password, BCRYPT_ROUNDS);
    const adminUser = await tx.user.create({
      data: {
        firstName: admin.firstName,
        lastName: admin.lastName,
        email: admin.email,
        phone: admin.phone,
        passwordHash,
        role: 'admin',
        companyId,
      },
    });

    return { adminUserId: adminUser.userId, adminEmail: adminUser.email as string };
  }
}

async function resolveMunicipality(
  tx: Prisma.TransactionClient,
  municipality: ProvisionCompanyMunicipality,
): Promise<number> {
  const existing = await tx.municipality.findUnique({
    where: 'municipalityId' in municipality
      ? { municipalityId: municipality.municipalityId }
      : { daneCode: municipality.daneCode },
    select: { municipalityId: true },
  });
  if (!existing) {
    throw new Error(`Municipality ${JSON.stringify(municipality)} does not exist in the catalog`);
  }
  return existing.municipalityId;
}
