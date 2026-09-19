import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  CompanyProvisioningService,
  type ProvisionCompanyInput,
  type ProvisionedCompany,
} from '../src/modules/tenancy/company-provisioning.service';

export type { ProvisionCompanyInput, ProvisionedCompany };

export async function provisionCompany(
  prisma: PrismaClient,
  input: ProvisionCompanyInput,
): Promise<ProvisionedCompany> {
  const service = new CompanyProvisioningService(prisma as unknown as PrismaService);
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
