import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AdminLoginDTO } from '@voyyaa/shared';
import { BcryptHasher } from '../src/modules/auth/hasher.service';
import type { EnvService } from '../src/config/env.service';
import { generateStaffPassword, rotateStaffPassword } from '../scripts/rotate-staff-password';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const OLD_PASSWORD = 'old-known-password';
const hasher = new BcryptHasher({ get: () => 12 } as unknown as EnvService);

function uniqueSuffix(): string {
  return `${Date.now()}-${randomInt(100_000, 999_999)}`;
}

suite('rotateStaffPassword (G-01) against real Postgres', () => {
  let raw: PrismaClient;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.user.deleteMany({ where: { email: { in: createdEmails } } }).catch(() => undefined);
    await raw.$disconnect();
  });

  async function seedUser(role: string, withLockout = false): Promise<{ userId: number; email: string }> {
    const suffix = uniqueSuffix();
    const email = `_rotate-${role}-${suffix}@example.com`;
    createdEmails.push(email);
    const user = await raw.user.create({
      data: {
        firstName: '_Rotate',
        lastName: role,
        email,
        phone: `_rotate-${suffix}`,
        passwordHash: await hasher.hash(OLD_PASSWORD),
        role,
        companyId: null,
        failedAttempts: withLockout ? 4 : 0,
        blockedUntil: withLockout ? new Date(Date.now() + 600_000) : null,
      },
    });
    return { userId: user.userId, email };
  }

  async function seedTokens(userId: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await raw.refreshToken.create({
        data: {
          userId,
          tokenHash: `_rotate-${uniqueSuffix()}-${i}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
  }

  it('dry run reports the account and changes nothing', async () => {
    const { userId, email } = await seedUser('platform_admin');
    await seedTokens(userId, 2);
    const before = await raw.user.findUniqueOrThrow({ where: { userId } });

    const result = await rotateStaffPassword(raw, { email, apply: false });

    expect(result).toEqual({
      applied: false,
      email,
      exists: true,
      role: 'platform_admin',
      isStaff: true,
      activeSessions: 2,
      sessionsRevoked: 0,
      newPassword: null,
    });
    const after = await raw.user.findUniqueOrThrow({ where: { userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await raw.refreshToken.count({ where: { userId, revoked: false } })).toBe(2);
  });

  it('apply replaces the hash, old password stops working, new one verifies, sessions and lockout cleared', async () => {
    const { userId, email } = await seedUser('admin', true);
    await seedTokens(userId, 3);

    const result = await rotateStaffPassword(raw, { email, apply: true });

    expect(result.applied).toBe(true);
    expect(result.sessionsRevoked).toBe(3);
    const newPassword = result.newPassword as string;
    const row = await raw.user.findUniqueOrThrow({ where: { userId } });
    expect(await hasher.compare(OLD_PASSWORD, row.passwordHash as string)).toBe(false);
    expect(await hasher.compare(newPassword, row.passwordHash as string)).toBe(true);
    expect(row.failedAttempts).toBe(0);
    expect(row.blockedUntil).toBeNull();
    expect(await raw.refreshToken.count({ where: { userId, revoked: false } })).toBe(0);
    expect(AdminLoginDTO.shape.password.safeParse(newPassword).success).toBe(true);
  });

  it('is case-insensitive on the email', async () => {
    const { email } = await seedUser('operator');
    const result = await rotateStaffPassword(raw, { email: email.toUpperCase(), apply: false });
    expect(result.exists).toBe(true);
  });

  it('fails for an unknown email', async () => {
    await expect(
      rotateStaffPassword(raw, { email: `_rotate-missing-${uniqueSuffix()}@example.com`, apply: true }),
    ).rejects.toThrow(/No user found/);
  });

  it.each(['driver', 'passenger', 'company'])('rejects a %s account and writes nothing', async (role) => {
    const { userId, email } = await seedUser(role);
    const before = await raw.user.findUniqueOrThrow({ where: { userId } });

    await expect(rotateStaffPassword(raw, { email, apply: true })).rejects.toThrow(/not a staff account/);

    const after = await raw.user.findUniqueOrThrow({ where: { userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });
});

describe('generateStaffPassword', () => {
  it('meets the staff password policy and is unique per call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const password = generateStaffPassword();
      expect(AdminLoginDTO.shape.password.safeParse(password).success).toBe(true);
      expect(password.length).toBeGreaterThanOrEqual(24);
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });
});
