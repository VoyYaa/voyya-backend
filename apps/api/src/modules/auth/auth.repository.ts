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
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getUserByPhone(phone: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { phone }, select: userSelect });
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { email }, select: userSelect });
  }

  async getUser(userId: number): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { userId }, select: userSelect });
  }

  async createPassengerAutoRegister(phone: string): Promise<AuthUser> {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { firstName: '', lastName: '', phone, role: 'passenger', accountStatus: 'active' },
        select: userSelect,
      });
      await tx.passenger.create({ data: { passengerId: u.userId } });
      return u;
    });
  }

  async getDriverByNationalId(nationalId: string): Promise<AuthDriver | null> {
    const d = await this.prisma.driver.findUnique({
      where: { nationalId },
      select: {
        driverId: true,
        companyId: true,
        pin: true,
        status: true,
        failedAttempts: true,
        blockedUntil: true,
        user: { select: { firstName: true, lastName: true, accountStatus: true } },
      },
    });
    if (!d) return null;
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
    };
  }

  async getDriverCompany(driverId: number): Promise<{ companyId: number; status: string } | null> {
    return this.prisma.driver.findUnique({
      where: { driverId },
      select: { companyId: true, status: true },
    });
  }

  async registerDriverFailure(driverId: number, blockedUntil: Date | null): Promise<void> {
    await this.prisma.driver.update({
      where: { driverId },
      data: { failedAttempts: { increment: 1 }, blockedUntil },
    });
  }

  async resetDriverAttempts(driverId: number): Promise<void> {
    await this.prisma.driver.update({
      where: { driverId },
      data: { failedAttempts: 0, blockedUntil: null },
    });
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
} as const;
