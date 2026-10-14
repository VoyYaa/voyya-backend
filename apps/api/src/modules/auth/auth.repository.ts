import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { type OtpIssuanceRow, otpIssuanceQuery, otpVerdictQuery, type OtpVerdictRow } from './otp-issuance-sql';
import {
  OTP_ISSUE_LOCK_NAMESPACE,
  type OtpIssuancePolicy,
  type OtpIssuanceVerdict,
} from './otp-policy';

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
  pinMustChange: boolean;
  temporaryPinExpiresAt: Date | null;
}

export interface DriverSessionState {
  companyId: number;
  status: string;
  pinMustChange: boolean;
}

export interface CompanyIdentity {
  companyId: number;
  companyName: string;
  municipalityId: number;
  municipalityName: string;
}

export interface IssueOtpInput {
  phone: string;
  codeHash: string;
  policy: OtpIssuancePolicy;
}

export type IssueOtpOutcome =
  | { kind: 'busy' }
  | { kind: 'refused'; verdict: OtpIssuanceVerdict }
  | { kind: 'issued'; insertedId: number; globalCount: number };

export interface OtpReservationState {
  consumed: boolean;
  alive: boolean;
  exhausted: boolean;
}

const ISSUE_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 2_000,
  timeout: 5_000,
} as const;

const REQUIRED_ISOLATION = 'read committed';

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
            pinMustChange: true,
            temporaryPinExpiresAt: true,
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
          pinMustChange: d.pinMustChange,
          temporaryPinExpiresAt: d.temporaryPinExpiresAt,
        };
      }
    }
    return null;
  }

  async getDriverCompany(driverId: number): Promise<DriverSessionState | null> {
    for (const companyId of await this.activeCompanyIds()) {
      const d = await this.prisma.runInTenant(companyId, (tx) =>
        tx.driver.findFirst({
          where: { driverId, companyId },
          select: { companyId: true, status: true, pinMustChange: true },
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

  async evaluateOtpIssuance(phone: string, policy: OtpIssuancePolicy): Promise<OtpIssuanceVerdict> {
    const [row] = await this.prisma.$queryRaw<OtpVerdictRow[]>(otpVerdictQuery(phone, policy));
    if (row === undefined) throw new Error('The OTP issuance verdict returned no row');
    return toVerdict(row);
  }

  async issueOtp(input: IssueOtpInput): Promise<IssueOtpOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean; isolation: string }>>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(${OTP_ISSUE_LOCK_NAMESPACE}::int, hashtext(${input.phone}::text)) AS locked,
               current_setting('transaction_isolation') AS isolation`);
      if (lock?.isolation !== REQUIRED_ISOLATION) {
        throw new Error(`OTP issuance requires the ${REQUIRED_ISOLATION} isolation level`);
      }
      if (lock.locked !== true) return { kind: 'busy' } as const;

      const [row] = await tx.$queryRaw<OtpIssuanceRow[]>(
        otpIssuanceQuery(input.phone, input.codeHash, input.policy),
      );
      if (row === undefined) throw new Error('The OTP issuance statement returned no row');
      if (row.inserted_id === null) return { kind: 'refused', verdict: toVerdict(row) } as const;
      return { kind: 'issued', insertedId: row.inserted_id, globalCount: row.global_count } as const;
    }, ISSUE_TRANSACTION_OPTIONS);
  }

  async refundOtpIssuance(id: number): Promise<boolean> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM auth.otp_code
       WHERE id = ${id}
         AND attempts = 0
         AND consumed = false`;
    return deleted === 1;
  }

  async findLiveOtp(phone: string): Promise<number | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id
        FROM auth.otp_code
       WHERE phone = ${phone}
         AND consumed = false
         AND expires_at > timezone('utc', now())
       ORDER BY created_at DESC, id DESC
       LIMIT 1`;
    return row?.id ?? null;
  }

  async reserveOtpAttempt(id: number, maxAttempts: number): Promise<string | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ code_hash: string }>>`
      UPDATE auth.otp_code
         SET attempts = attempts + 1
       WHERE id = ${id}
         AND consumed = false
         AND expires_at > timezone('utc', now())
         AND attempts < ${maxAttempts}::int
      RETURNING code_hash`;
    return row?.code_hash ?? null;
  }

  async readOtpReservationState(id: number, maxAttempts: number): Promise<OtpReservationState | null> {
    const [row] = await this.prisma.$queryRaw<OtpReservationState[]>`
      SELECT consumed,
             expires_at > timezone('utc', now()) AS alive,
             attempts >= ${maxAttempts}::int AS exhausted
        FROM auth.otp_code
       WHERE id = ${id}`;
    return row ?? null;
  }

  async consumeOtp(id: number): Promise<boolean> {
    const r = await this.prisma.otpCode.updateMany({
      where: { id, consumed: false },
      data: { consumed: true },
    });
    return r.count === 1;
  }
}

function toVerdict(row: OtpVerdictRow): OtpIssuanceVerdict {
  return {
    waits: {
      cooldown: row.cooldown_retry_sec,
      hourly: row.hourly_retry_sec,
      daily: row.daily_retry_sec,
      global: row.global_retry_sec,
    },
    globalCount: row.global_count,
  };
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
