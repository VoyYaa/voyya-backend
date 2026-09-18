import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export interface ProvisionCompanyInput {
  municipality:
    | { municipalityId: number }
    | {
        name: string;
        department: string;
        coveragePolygon: Prisma.InputJsonValue;
      };
  company: { legalName: string; taxId: string; type: string };
  initialFare: {
    baseFare: number;
    nightSurchargePct?: number;
    holidaySurchargePct?: number;
    commissionPct?: number;
  };
  initialParams: {
    searchRadiusKm: number;
    expansionRadiusKm: number;
    acceptanceTimeoutSec: number;
  };
  admin: { firstName: string; lastName: string; email: string; phone: string; password: string };
}

export interface ProvisionedCompany {
  companyId: number;
  municipalityId: number;
  fareConfigId: number;
  adminUserId: number;
}

export async function provisionCompany(
  prisma: PrismaClient,
  input: ProvisionCompanyInput,
): Promise<ProvisionedCompany> {
  return prisma.$transaction(async (tx) => {
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

    await tx.$executeRaw`SELECT set_config('app.current_company', ${String(company.companyId)}, true)`;

    const fareConfig = await tx.fareConfig.create({
      data: {
        companyId: company.companyId,
        serviceType: 'taxi',
        baseFare: input.initialFare.baseFare,
        nightSurchargePct: input.initialFare.nightSurchargePct,
        holidaySurchargePct: input.initialFare.holidaySurchargePct,
        commissionPct: input.initialFare.commissionPct,
        validFrom: new Date(),
        validTo: null,
        createdBy: null,
      },
    });

    const parameters: Array<[string, string]> = [
      ['search_radius_km', String(input.initialParams.searchRadiusKm)],
      ['acceptance_timeout_sec', String(input.initialParams.acceptanceTimeoutSec)],
      ['expansion_radius_km', String(input.initialParams.expansionRadiusKm)],
    ];
    for (const [key, value] of parameters) {
      await tx.systemParameter.create({
        data: { key, value, companyId: company.companyId, updatedBy: null },
      });
    }

    const passwordHash = await bcrypt.hash(input.admin.password, BCRYPT_ROUNDS);
    const admin = await tx.user.create({
      data: {
        firstName: input.admin.firstName,
        lastName: input.admin.lastName,
        email: input.admin.email,
        phone: input.admin.phone,
        passwordHash,
        role: 'admin',
        companyId: company.companyId,
      },
    });

    return {
      companyId: company.companyId,
      municipalityId,
      fareConfigId: fareConfig.fareConfigId,
      adminUserId: admin.userId,
    };
  });
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

async function main(): Promise<void> {
  const configFlagIndex = process.argv.indexOf('--config');
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : undefined;
  if (!configPath) {
    throw new Error('Usage: provision-company.ts --config <file>.json');
  }

  const input = JSON.parse(readFileSync(configPath, 'utf-8')) as ProvisionCompanyInput;
  const prisma = new PrismaClient();
  try {
    const result = await provisionCompany(prisma, input);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  });
}
