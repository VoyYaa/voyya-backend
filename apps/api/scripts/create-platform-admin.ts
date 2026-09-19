import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export interface CreatePlatformAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface CreatedPlatformAdmin {
  userId: number;
  email: string;
}

export async function createPlatformAdmin(
  prisma: PrismaClient,
  input: CreatePlatformAdminInput,
): Promise<CreatedPlatformAdmin> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email.toLowerCase(),
      phone: input.phone,
      passwordHash,
      role: 'platform_admin',
      companyId: null,
    },
  });
  return { userId: user.userId, email: user.email as string };
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(
      `Usage: create-platform-admin.ts --first-name <x> --last-name <x> --email <x> --phone <x> --password <x>`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const input: CreatePlatformAdminInput = {
    firstName: flag('first-name'),
    lastName: flag('last-name'),
    email: flag('email'),
    phone: flag('phone'),
    password: flag('password'),
  };

  const prisma = new PrismaClient();
  try {
    const result = await createPlatformAdmin(prisma, input);
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
