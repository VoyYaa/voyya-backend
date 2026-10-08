import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AdminLoginDTO, type Role } from '@voyyaa/shared';

const BCRYPT_ROUNDS = 12;
const PASSWORD_BYTES = 18;
const STAFF_ROLES: readonly Role[] = ['admin', 'operator', 'platform_admin'];

export interface RotateStaffPasswordInput {
  email: string;
  apply: boolean;
}

export interface RotateStaffPasswordResult {
  applied: boolean;
  email: string;
  exists: boolean;
  role: string;
  isStaff: boolean;
  activeSessions: number;
  sessionsRevoked: number;
  newPassword: string | null;
}

export function generateStaffPassword(): string {
  const password = randomBytes(PASSWORD_BYTES).toString('base64url');
  if (!AdminLoginDTO.shape.password.safeParse(password).success) {
    throw new Error('Generated password does not meet the staff password policy');
  }
  return password;
}

function isStaffRole(role: string): boolean {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

export async function rotateStaffPassword(
  prisma: PrismaClient,
  input: RotateStaffPasswordInput,
): Promise<RotateStaffPasswordResult> {
  const email = input.email.trim().toLowerCase();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email },
      select: { userId: true, role: true },
    });
    if (!user) throw new Error('No user found for the given --email');
    if (!isStaffRole(user.role)) {
      throw new Error(
        `The account is not a staff account (role: ${user.role}); drivers use a PIN and passengers use OTP`,
      );
    }

    const activeSessions = await tx.refreshToken.count({
      where: { userId: user.userId, revoked: false, expiresAt: { gt: new Date() } },
    });
    const report = { email, exists: true, role: user.role, isStaff: true, activeSessions };
    if (!input.apply) {
      return { applied: false, ...report, sessionsRevoked: 0, newPassword: null };
    }

    const newPassword = generateStaffPassword();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await tx.user.update({
      where: { userId: user.userId },
      data: { passwordHash, failedAttempts: 0, blockedUntil: null },
    });
    const revoked = await tx.refreshToken.updateMany({
      where: { userId: user.userId, revoked: false },
      data: { revoked: true },
    });

    return { applied: true, ...report, sessionsRevoked: revoked.count, newPassword };
  });
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printResult(result: RotateStaffPasswordResult): void {
  const { newPassword, ...report } = result;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  if (newPassword) {
    // eslint-disable-next-line no-console
    console.log(
      `\nNEW PASSWORD (shown only once, save it in a password manager now):\n${newPassword}\n`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('\nDry run: nothing was changed. Re-run with --apply to rotate the password.');
  }
}

async function main(): Promise<void> {
  const email = flag('email');
  if (!email) {
    throw new Error('Usage: rotate-staff-password.ts --email <email> [--apply]');
  }

  const prisma = new PrismaClient();
  try {
    printResult(
      await rotateStaffPassword(prisma, { email, apply: process.argv.includes('--apply') }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : 'rotate-staff-password failed');
    process.exitCode = 1;
  });
}
