import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface AuthUser {
  userId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  passwordHash: string | null;
  role: string;
  accountStatus: string;
  companyId: number | null;
  companyStatus: string | null;
  failedAttempts: number;
  blockedUntil: Date | null;
}

export interface AuthDriver {
  driverId: number;
  companyId: number;
  pin: string;
  status: string;
  failedAttempts: number;
  blockedUntil: Date | null;
  firstName: string;
  lastName: string;
  accountStatus: string;
  pinDeliveredAt: Date | null;
}

export interface CompanyIdentity {
  companyId: number;
  companyName: string;
  municipalityId: number;
  municipalityName: string;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getUserByPhone(phone: string): Promise<AuthUser | null> {
    const row = await this.prisma.user.findUnique({ where: { phone }, select: userSelect });
    return row ? mapUserRow(row) : null;
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    const row = await this.prisma.user.findUnique({ where: { email }, select: userSelect });
    return row ? mapUserRow(row) : null;
  }

  async getUser(userId: number): Promise<AuthUser | null> {
    const row = await this.prisma.user.findUnique({ where: { userId }, select: userSelect });
    return row ? mapUserRow(row) : null;
  }

  async getCompanyIdentity(companyId: number): Promise<CompanyIdentity | null> {
    const company = await this.prisma.company.findUnique({
      where: { companyId },
      select: {
        companyId: true,
        legalName: true,
        municipality: { select: { municipalityId: true, name: true } },
      },
    });
    if (!company) return null;
    return {
      companyId: company.companyId,
      companyName: company.legalName,
      municipalityId: company.municipality.municipalityId,
      municipalityName: company.municipality.name,
    };
  }

  async createPassengerAutoRegister(phone: string): Promise<AuthUser> {
    const u = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { firstName: '', lastName: '', phone, role: 'passenger', accountStatus: 'active' },
        select: userSelect,
      });
      await tx.passenger.create({ data: { passengerId: created.userId } });
      return created;
    });
    return mapUserRow(u);
  }

  async getDriverByNationalId(nationalId: string): Promise<AuthDriver | null> {
    for (const companyId of await this.activeCompanyIds()) {
      const d = await this.prisma.runInTenant(companyId, (tx) =>
        tx.driver.findFirst({
          where: { nationalId, companyId },
          select: {
            driverId: true,
            companyId: true,
            pin: true,
            status: true,
            failedAttempts: true,
            blockedUntil: true,
            pinDeliveredAt: true,
            user: { select: { firstName: true, lastName: true, accountStatus: true } },
          },
        }),
      );
      if (d) {
        return {
          driverId: d.driverId,
          companyId: d.companyId,
          pin: d.pin,
          status: d.status,
          failedAttempts: d.failedAttempts,
          blockedUntil: d.blockedUntil,
          firstName: d.user.firstName,
          lastName: d.user.lastName,
          accountStatus: d.user.accountStatus,
          pinDeliveredAt: d.pinDeliveredAt,
        };
      }
    }
    return null;
  }

  async getDriverCompany(driverId: number): Promise<{ companyId: number; status: string } | null> {
    for (const companyId of await this.activeCompanyIds()) {
      const d = await this.prisma.runInTenant(companyId, (tx) =>
        tx.driver.findFirst({
          where: { driverId, companyId },
          select: { companyId: true, status: true },
        }),
      );
      if (d) return d;
    }
    return null;
  }

  async registerDriverFailure(
    driverId: number,
    companyId: number,
    blockedUntil: Date | null,
  ): Promise<void> {
    await this.prisma.runInTenant(companyId, (tx) =>
      tx.driver.update({
        where: { driverId },
        data: { failedAttempts: { increment: 1 }, blockedUntil },
      }),
    );
  }

  async resetDriverAttempts(driverId: number, companyId: number): Promise<void> {
    await this.prisma.runInTenant(companyId, (tx) =>
      tx.driver.update({
        where: { driverId },
        data: { failedAttempts: 0, blockedUntil: null },
      }),
    );
  }

  async registerAdminFailure(userId: number, blockedUntil: Date | null): Promise<void> {
    await this.prisma.user.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 }, blockedUntil },
    });
  }

  async resetAdminAttempts(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { userId },
      data: { failedAttempts: 0, blockedUntil: null },
    });
  }

  private async activeCompanyIds(): Promise<number[]> {
    const companies = await this.prisma.company.findMany({
      where: { status: 'active' },
      select: { companyId: true },
    });
    return companies.map((c) => c.companyId);
  }

  async countOtpSince(phone: string, since: Date): Promise<number> {
    return this.prisma.otpCode.count({ where: { phone, createdAt: { gte: since } } });
  }

  async lastOtpCreatedAt(phone: string): Promise<Date | null> {
    const row = await this.prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  async createOtp(phone: string, codeHash: string, expires: Date): Promise<void> {
    await this.prisma.otpCode.create({
      data: { phone, codeHash, expiresAt: expires },
    });
  }

  async getActiveOtp(
    phone: string,
  ): Promise<{ id: number; codeHash: string; attempts: number; expiresAt: Date } | null> {
    return this.prisma.otpCode.findFirst({
      where: { phone, consumed: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true, attempts: true, expiresAt: true },
    });
  }

  async incrementOtpAttempts(id: number): Promise<void> {
    await this.prisma.otpCode.update({ where: { id }, data: { attempts: { increment: 1 } } });
  }

  async consumeOtp(id: number): Promise<boolean> {
    const r = await this.prisma.otpCode.updateMany({
      where: { id, consumed: false },
      data: { consumed: true },
    });
    return r.count === 1;
  }
}

const userSelect = {
  userId: true,
  firstName: true,
  lastName: true,
  email: true,
  passwordHash: true,
  role: true,
  accountStatus: true,
  companyId: true,
  failedAttempts: true,
  blockedUntil: true,
  company: { select: { status: true } },
} as const;

function mapUserRow(row: {
  userId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  passwordHash: string | null;
  role: string;
  accountStatus: string;
  companyId: number | null;
  failedAttempts: number;
  blockedUntil: Date | null;
  company: { status: string } | null;
}): AuthUser {
  return {
    userId: row.userId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    passwordHash: row.passwordHash,
    role: row.role,
    accountStatus: row.accountStatus,
    companyId: row.companyId,
    companyStatus: row.company?.status ?? null,
    failedAttempts: row.failedAttempts,
    blockedUntil: row.blockedUntil,
  };
}
