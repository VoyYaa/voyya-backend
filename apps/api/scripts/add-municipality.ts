import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';

export interface AddMunicipalityInput {
  name: string;
  department: string;
  coveragePolygon: Prisma.InputJsonValue;
}

export interface AddedMunicipality {
  municipalityId: number;
}

export async function addMunicipality(
  prisma: PrismaClient,
  input: AddMunicipalityInput,
): Promise<AddedMunicipality> {
  const created = await prisma.municipality.create({
    data: {
      name: input.name,
      department: input.department,
      coveragePolygon: input.coveragePolygon,
      status: 'active',
    },
  });
  return { municipalityId: created.municipalityId };
}

async function main(): Promise<void> {
  const configFlagIndex = process.argv.indexOf('--config');
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : undefined;
  if (!configPath) {
    throw new Error('Usage: add-municipality.ts --config <file>.json');
  }

  const input = JSON.parse(readFileSync(configPath, 'utf-8')) as AddMunicipalityInput;
  const prisma = new PrismaClient();
  try {
    const result = await addMunicipality(prisma, input);
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
