import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { CompanyCommissionRepository } from '../src/modules/service-config/company-commission.repository';
import { MunicipalityFareRepository } from '../src/modules/service-config/municipality-fare.repository';
import { OperationalParamsRepository } from '../src/modules/service-config/operational-params.repository';
import { ServiceConfigProvisioner } from '../src/modules/service-config/service-config-provisioner';
import {
  CompanyProvisioningService,
  type ProvisionCompanyInput,
  type ProvisionedCompany,
} from '../src/modules/tenancy/company-provisioning.service';

export type { ProvisionCompanyInput, ProvisionedCompany };

function platformRunnerFor(prisma: PrismaClient): PrismaService {
  return {
    runAsPlatform: (fn: Parameters<PrismaService['runAsPlatform']>[0]) =>
      PrismaService.prototype.runAsPlatform.call(prisma, fn),
  } as unknown as PrismaService;
}

export async function provisionCompany(
  prisma: PrismaClient,
  input: ProvisionCompanyInput,
): Promise<ProvisionedCompany> {
  const serviceConfig = new ServiceConfigProvisioner(
    new MunicipalityFareRepository(),
    new OperationalParamsRepository(),
    new CompanyCommissionRepository(),
  );
  const service = new CompanyProvisioningService(platformRunnerFor(prisma), serviceConfig);
  return service.provisionNew(input);
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
