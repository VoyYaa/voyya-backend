import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';

const BCRYPT_ROUNDS = 12;

export interface ProvisionCompanyMunicipality {
  municipalityId: number;
}

export interface ProvisionCompanyMunicipalityToCreate {
  name: string;
  department: string;
  coveragePolygon: Prisma.InputJsonValue;
}

export interface ProvisionInitialFare {
  baseFare: number;
  nightSurchargePct?: number;
  holidaySurchargePct?: number;
  commissionPct?: number;
}

export interface ProvisionInitialParams {
  searchRadiusKm: number;
  expansionRadiusKm: number;
  acceptanceTimeoutSec: number;
}

export interface ProvisionAdmin {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface ProvisionCompanyInput {
  municipality: ProvisionCompanyMunicipality | ProvisionCompanyMunicipalityToCreate;
  company: { legalName: string; taxId: string; type: string };
  initialFare: ProvisionInitialFare;
  initialParams: ProvisionInitialParams;
  admin: ProvisionAdmin;
}

export interface ProvisionedCompany {
  companyId: number;
  municipalityId: number;
  fareConfigId: number;
  adminUserId: number;
}

export interface FinishedProvisioning {
  fareConfigId: number;
  adminUserId: number;
  adminEmail: string;
}

@Injectable()
export class CompanyProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provisionNew(input: ProvisionCompanyInput): Promise<ProvisionedCompany> {
    return this.prisma.$transaction(async (tx) => {
      const municipalityId = await resolveMunicipality(tx, input.municipality);

      const company = await tx.company.create({
        data: {
          legalName: input.company.legalName,
          taxId: input.company.taxId,
          type: input.company.type,
          municipalityId,
          status: 'active',
        },
      });

      await setTenantSession(tx, company.companyId);

      const finished = await this.finishProvisioning(
        tx,
        company.companyId,
        input.initialFare,
        input.initialParams,
        input.admin,
        null,
      );

      return {
        companyId: company.companyId,
        municipalityId,
        fareConfigId: finished.fareConfigId,
        adminUserId: finished.adminUserId,
      };
    });
  }

  async finishProvisioning(
    tx: Prisma.TransactionClient,
    companyId: number,
    initialFare: ProvisionInitialFare,
    initialParams: ProvisionInitialParams,
    admin: ProvisionAdmin,
    attributedTo: number | null,
  ): Promise<FinishedProvisioning> {
    const fareConfig = await tx.fareConfig.create({
      data: {
        companyId,
        serviceType: 'taxi',
        baseFare: initialFare.baseFare,
        nightSurchargePct: initialFare.nightSurchargePct,
        holidaySurchargePct: initialFare.holidaySurchargePct,
        commissionPct: initialFare.commissionPct,
        validFrom: new Date(),
        validTo: null,
        createdBy: attributedTo,
      },
    });

    const parameters: Array<[string, string]> = [
      ['search_radius_km', String(initialParams.searchRadiusKm)],
      ['expansion_radius_km', String(initialParams.expansionRadiusKm)],
      ['acceptance_timeout_sec', String(initialParams.acceptanceTimeoutSec)],
    ];
    for (const [key, value] of parameters) {
      await tx.systemParameter.create({
        data: { key, value, companyId, updatedBy: attributedTo },
      });
    }

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

    return {
      fareConfigId: fareConfig.fareConfigId,
      adminUserId: adminUser.userId,
      adminEmail: adminUser.email as string,
    };
  }
}

async function resolveMunicipality(
  tx: Prisma.TransactionClient,
  municipality: ProvisionCompanyInput['municipality'],
): Promise<number> {
  if ('municipalityId' in municipality) {
    const existing = await tx.municipality.findUnique({
      where: { municipalityId: municipality.municipalityId },
      select: { municipalityId: true },
    });
    if (!existing) {
      throw new Error(`Municipality ${municipality.municipalityId} does not exist`);
    }
    return existing.municipalityId;
  }
  const created = await tx.municipality.create({
    data: {
      name: municipality.name,
      department: municipality.department,
      coveragePolygon: municipality.coveragePolygon,
      status: 'active',
    },
  });
  return created.municipalityId;
}
