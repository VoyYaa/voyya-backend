import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface ActiveFareConfigRow {
  fareConfigId: number;
  baseFare: number;
  nightSurchargePct: number;
  holidaySurchargePct: number;
  commissionPct: number;
  createdAt: Date;
}

export interface FareConfigValues {
  baseFare: number;
  nightSurchargePct: number;
  holidaySurchargePct: number;
  commissionPct: number;
}

export interface SystemParameterRow {
  key: string;
  value: string;
  updatedAt: Date;
}

@Injectable()
export class AdminSettingsRepository {
  async getActiveFareConfig(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<ActiveFareConfigRow | null> {
    const today = new Date();
    const row = await tx.fareConfig.findFirst({
      where: {
        companyId,
        serviceType: 'taxi',
        validFrom: { lte: today },
        OR: [{ validTo: null }, { validTo: { gte: today } }],
      },
      orderBy: [{ validFrom: 'desc' }, { fareConfigId: 'desc' }],
    });
    if (!row) return null;
    return {
      fareConfigId: row.fareConfigId,
      baseFare: Number(row.baseFare),
      nightSurchargePct: Number(row.nightSurchargePct),
      holidaySurchargePct: Number(row.holidaySurchargePct),
      commissionPct: Number(row.commissionPct),
      createdAt: row.createdAt,
    };
  }

  async closeAndInsertFareConfig(
    tx: Prisma.TransactionClient,
    companyId: number,
    expectedFareConfigId: number,
    values: FareConfigValues,
    createdBy: number,
  ): Promise<ActiveFareConfigRow | null> {
    const closed = await tx.$executeRaw`
      UPDATE trips.fare_config
         SET valid_to = CURRENT_DATE
       WHERE company_id = ${companyId}
         AND service_type = 'taxi'::trips."ServiceType"
         AND fare_config_id = ${expectedFareConfigId}
         AND valid_to IS NULL
    `;
    if (closed === 0) {
      return null;
    }

    const rows = await tx.$queryRaw<
      Array<{
        fare_config_id: number;
        base_fare: number;
        night_surcharge_pct: number;
        holiday_surcharge_pct: number;
        commission_pct: number;
        created_at: Date;
      }>
    >`
      INSERT INTO trips.fare_config
        (company_id, service_type, base_fare, night_surcharge_pct, holiday_surcharge_pct, commission_pct, valid_from, valid_to, created_by)
      VALUES
        (${companyId}, 'taxi'::trips."ServiceType", ${values.baseFare}, ${values.nightSurchargePct}, ${values.holidaySurchargePct}, ${values.commissionPct}, CURRENT_DATE, NULL, ${createdBy})
      RETURNING
        fare_config_id,
        base_fare::float8 AS base_fare,
        night_surcharge_pct::float8 AS night_surcharge_pct,
        holiday_surcharge_pct::float8 AS holiday_surcharge_pct,
        commission_pct::float8 AS commission_pct,
        created_at
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('closeAndInsertFareConfig: INSERT returned no row');
    }
    return {
      fareConfigId: row.fare_config_id,
      baseFare: row.base_fare,
      nightSurchargePct: row.night_surcharge_pct,
      holidaySurchargePct: row.holiday_surcharge_pct,
      commissionPct: row.commission_pct,
      createdAt: row.created_at,
    };
  }

  async getParameters(
    tx: Prisma.TransactionClient,
    companyId: number,
    keys: readonly string[],
  ): Promise<SystemParameterRow[]> {
    const rows = await tx.systemParameter.findMany({
      where: { key: { in: [...keys] }, companyId },
    });
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt }));
  }

  async upsertParameters(
    tx: Prisma.TransactionClient,
    companyId: number,
    entries: Array<{ key: string; value: string }>,
    updatedBy: number,
  ): Promise<void> {
    for (const entry of entries) {
      await tx.systemParameter.upsert({
        where: { key_companyId: { key: entry.key, companyId } },
        update: { value: entry.value, updatedBy },
        create: { key: entry.key, value: entry.value, companyId, updatedBy },
      });
    }
  }
}
