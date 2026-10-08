import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface LockedDriver {
  driverId: number;
  pin: string;
  status: string;
  accountStatus: string;
  failedAttempts: number;
  blockedUntil: Date | null;
  pinMustChange: boolean;
  temporaryPinExpiresAt: Date | null;
  pinChangedAt: Date | null;
  nationalId: string;
  phone: string;
  firstName: string;
  lastName: string;
}

interface LockedDriverRow {
  driver_id: number;
  pin: string;
  status: string;
  account_status: string;
  failed_attempts: number;
  blocked_until: Date | null;
  pin_must_change: boolean;
  temporary_pin_expires_at: Date | null;
  pin_changed_at: Date | null;
  national_id: string;
  phone: string;
  first_name: string;
  last_name: string;
}

@Injectable()
export class DriverPinRepository {
  async lockDriver(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<LockedDriver | null> {
    const rows = await tx.$queryRaw<LockedDriverRow[]>`
      SELECT d.driver_id, d.pin, d.status::text AS status, u.account_status::text AS account_status,
             d.failed_attempts, d.blocked_until, d.pin_must_change, d.temporary_pin_expires_at,
             d.pin_changed_at, d.national_id, u.phone, u.first_name, u.last_name
        FROM fleet.driver d
        JOIN auth."user" u ON u.user_id = d.driver_id
       WHERE d.driver_id = ${driverId}
         AND d.company_id = ${companyId}
         FOR UPDATE OF d
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      driverId: row.driver_id,
      pin: row.pin,
      status: row.status,
      accountStatus: row.account_status,
      failedAttempts: row.failed_attempts,
      blockedUntil: row.blocked_until,
      pinMustChange: row.pin_must_change,
      temporaryPinExpiresAt: row.temporary_pin_expires_at,
      pinChangedAt: row.pin_changed_at,
      nationalId: row.national_id,
      phone: row.phone,
      firstName: row.first_name,
      lastName: row.last_name,
    };
  }

  async registerFailure(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    blockedUntil: Date | null,
  ): Promise<void> {
    await tx.driver.updateMany({
      where: { driverId, companyId },
      data: { failedAttempts: { increment: 1 }, blockedUntil },
    });
  }

  async applyNewPin(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    pinHash: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE fleet.driver
         SET pin = ${pinHash},
             pin_must_change = false,
             temporary_pin_expires_at = NULL,
             pin_changed_at = (now() AT TIME ZONE 'UTC'),
             failed_attempts = 0,
             blocked_until = NULL,
             updated_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId}
         AND company_id = ${companyId}
    `;
  }
}
