import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DriverStatus } from '@voyyaa/shared';

export interface CreateDriverWithVehicleData {
  firstName: string;
  lastName: string;
  nationalId: string;
  phone: string;
  email: string | null;
  license: string | null;
  pinHash: string;
  vehicle: {
    plate: string;
    model: string;
    year: number | null;
  };
}

export interface CreatedDriverDocumentRow {
  driverDocumentId: number;
  type: string;
  fileName: string;
  issuedAt: Date | null;
  expiresAt: Date;
  uploadedAt: Date;
}

export interface CreatedDriverRow {
  driverId: number;
  nationalId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  status: DriverStatus;
  createdAt: Date;
  vehicle: {
    vehicleId: number;
    plate: string;
    model: string;
    year: number | null;
  };
}

export interface DriverDocumentRowInput {
  type: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  issuedAt: Date | null;
  expiresAt: Date;
}

export interface FleetQuotaRow {
  declared: number | null;
  used: number;
}

export interface RotatedPinRow {
  driverId: number;
  nationalId: string;
  phone: string;
}

@Injectable()
export class AdminDriverRepository {
  async lockFleetQuota(tx: Prisma.TransactionClient, companyId: number): Promise<FleetQuotaRow> {
    const rows = await tx.$queryRaw<Array<{ vehicle_count: number | null }>>`
      SELECT vehicle_count FROM tenancy.company WHERE company_id = ${companyId} FOR UPDATE
    `;
    const used = await tx.vehicle.count({ where: { companyId } });
    return { declared: rows[0]?.vehicle_count ?? null, used };
  }

  async readFleetQuota(tx: Prisma.TransactionClient, companyId: number): Promise<FleetQuotaRow> {
    const [company, used] = await Promise.all([
      tx.company.findUnique({ where: { companyId }, select: { vehicleCount: true } }),
      tx.vehicle.count({ where: { companyId } }),
    ]);
    return { declared: company?.vehicleCount ?? null, used };
  }

  async createDriverDocuments(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    documents: readonly DriverDocumentRowInput[],
  ): Promise<CreatedDriverDocumentRow[]> {
    const rows: CreatedDriverDocumentRow[] = [];
    for (const doc of documents) {
      const row = await tx.driverDocument.create({
        data: {
          driverId,
          companyId,
          type: doc.type as never,
          storageKey: doc.storageKey,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
          issuedAt: doc.issuedAt,
          expiresAt: doc.expiresAt,
        },
      });
      rows.push({
        driverDocumentId: row.driverDocumentId,
        type: row.type,
        fileName: row.fileName,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        uploadedAt: row.uploadedAt,
      });
    }
    return rows;
  }

  async createDriverWithVehicle(
    tx: Prisma.TransactionClient,
    companyId: number,
    data: CreateDriverWithVehicleData,
  ): Promise<CreatedDriverRow> {
    const user = await tx.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        role: 'driver',
        accountStatus: 'active',
      },
    });

    const vehicle = await tx.vehicle.create({
      data: {
        companyId,
        plate: data.vehicle.plate,
        model: data.vehicle.model,
        year: data.vehicle.year,
        status: 'active',
      },
    });

    const driver = await tx.driver.create({
      data: {
        driverId: user.userId,
        companyId,
        nationalId: data.nationalId,
        pin: data.pinHash,
        license: data.license,
        status: 'off_shift',
        currentVehicleId: vehicle.vehicleId,
        pinDeliveredAt: null,
      },
    });

    return {
      driverId: driver.driverId,
      nationalId: driver.nationalId,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      status: driver.status,
      createdAt: driver.createdAt,
      vehicle: {
        vehicleId: vehicle.vehicleId,
        plate: vehicle.plate,
        model: data.vehicle.model,
        year: vehicle.year,
      },
    };
  }

  async markPinDelivered(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<Date | null> {
    const rows = await tx.$queryRaw<Array<{ pin_delivered_at: Date }>>`
      UPDATE fleet.driver
         SET pin_delivered_at = (now() AT TIME ZONE 'UTC')
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
      RETURNING pin_delivered_at
    `;
    return rows[0]?.pin_delivered_at ?? null;
  }

  async findIdInTenant(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
  ): Promise<number | null> {
    const driver = await tx.driver.findFirst({
      where: { driverId, companyId },
      select: { driverId: true },
    });
    return driver?.driverId ?? null;
  }

  async rotatePin(
    tx: Prisma.TransactionClient,
    driverId: number,
    companyId: number,
    pinHash: string,
  ): Promise<RotatedPinRow | null> {
    const rows = await tx.$queryRaw<
      Array<{ driver_id: number; national_id: string; phone: string }>
    >`
      UPDATE fleet.driver d
         SET pin = ${pinHash},
             pin_delivered_at = NULL,
             failed_attempts = 0,
             blocked_until = NULL,
             updated_at = (now() AT TIME ZONE 'UTC')
        FROM auth.user u
       WHERE d.driver_id = ${driverId}
         AND d.company_id = ${companyId}
         AND u.user_id = d.driver_id
      RETURNING d.driver_id AS driver_id, d.national_id AS national_id, u.phone AS phone
    `;
    const row = rows[0];
    if (!row) return null;
    return { driverId: row.driver_id, nationalId: row.national_id, phone: row.phone };
  }
}
