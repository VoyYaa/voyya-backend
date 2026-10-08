import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LedgerEntry } from './remittance-ledger';

export interface DriverAggregateRow {
  driverId: number;
  tripCount: number;
  cashCollected: number;
  commission: number;
  pendingCashTripCount: number;
  pendingCashAmount: number;
}

export interface DriverIdentityRow {
  driverId: number;
  name: string;
  nationalId: string;
  plate: string | null;
}

export interface LedgerRow extends LedgerEntry {
  driverId: number;
  weekStart: string;
  recordedBy: { userId: number; name: string };
  reversed: boolean;
}

export interface InsertLedgerData {
  companyId: number;
  driverId: number;
  weekStart: string;
  kind: 'remittance' | 'reversal';
  amount: number;
  reversesRemittanceId: number | null;
  recordedBy: number;
}

export interface InsertExportData {
  companyId: number;
  exportedBy: number;
  from: string;
  to: string;
  driverId: number | null;
  rowCount: number;
}

interface AggregateSqlRow {
  driver_id: number;
  trip_count: number;
  cash_collected: bigint;
  commission: bigint;
  pending_cash_trip_count: number;
  pending_cash_amount: bigint;
}

const LEDGER_INCLUDE = {
  recordedByUser: { select: { userId: true, firstName: true, lastName: true } },
  reversedBy: { select: { remittanceId: true } },
} satisfies Prisma.SettlementRemittanceInclude;

type LedgerRecord = Prisma.SettlementRemittanceGetPayload<{ include: typeof LEDGER_INCLUDE }>;

function toDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function toLedgerRow(record: LedgerRecord): LedgerRow {
  return {
    remittanceId: record.remittanceId,
    driverId: record.driverId,
    weekStart: record.weekStart.toISOString().slice(0, 10),
    kind: record.kind,
    amount: Number(record.amount),
    reversesRemittanceId: record.reversesRemittanceId,
    recordedAt: record.recordedAt,
    recordedBy: {
      userId: record.recordedByUser.userId,
      name: `${record.recordedByUser.firstName} ${record.recordedByUser.lastName}`.trim(),
    },
    reversed: record.reversedBy !== null,
  };
}

@Injectable()
export class SettlementRepository {
  async aggregateByDriver(
    tx: Prisma.TransactionClient,
    companyId: number,
    from: string,
    to: string,
    driverId: number | null,
  ): Promise<DriverAggregateRow[]> {
    const rows = await tx.$queryRaw<AggregateSqlRow[]>(Prisma.sql`
      WITH bounds AS (
        SELECT ((CAST(${from} AS date))::timestamp AT TIME ZONE 'America/Bogota') AT TIME ZONE 'UTC' AS start_utc,
               ((CAST(${to} AS date) + 1)::timestamp AT TIME ZONE 'America/Bogota') AT TIME ZONE 'UTC' AS end_utc
      ),
      closed AS (
        SELECT a.driver_id, t.fare, t.commission, t.cash_collected_at
          FROM assignment.assignment a
          JOIN trips.trip_request t ON t.trip_request_id = a.trip_request_id
          CROSS JOIN bounds b
         WHERE a.company_id = ${companyId}
           AND a.status = 'completed'
           AND t.status = 'completed'
           AND t.finished_at >= b.start_utc
           AND t.finished_at <  b.end_utc
           AND (${driverId}::int IS NULL OR a.driver_id = ${driverId}::int)
      )
      SELECT c.driver_id,
             (COUNT(*) FILTER (WHERE c.cash_collected_at IS NOT NULL))::int AS trip_count,
             ROUND(COALESCE(SUM(c.fare) FILTER (WHERE c.cash_collected_at IS NOT NULL), 0))::bigint AS cash_collected,
             ROUND(COALESCE(SUM(c.commission) FILTER (WHERE c.cash_collected_at IS NOT NULL), 0))::bigint AS commission,
             (COUNT(*) FILTER (WHERE c.cash_collected_at IS NULL))::int AS pending_cash_trip_count,
             ROUND(COALESCE(SUM(c.fare) FILTER (WHERE c.cash_collected_at IS NULL), 0))::bigint AS pending_cash_amount
        FROM closed c
       GROUP BY c.driver_id
       ORDER BY c.driver_id
    `);
    return rows.map((r) => ({
      driverId: r.driver_id,
      tripCount: r.trip_count,
      cashCollected: Number(r.cash_collected),
      commission: Number(r.commission),
      pendingCashTripCount: r.pending_cash_trip_count,
      pendingCashAmount: Number(r.pending_cash_amount),
    }));
  }

  async findDriverIdentities(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverIds: readonly number[],
  ): Promise<DriverIdentityRow[]> {
    const drivers = await tx.driver.findMany({
      where: { companyId, driverId: { in: [...driverIds] } },
      select: {
        driverId: true,
        nationalId: true,
        user: { select: { firstName: true, lastName: true } },
        currentVehicle: { select: { plate: true } },
      },
    });
    return drivers.map((d) => ({
      driverId: d.driverId,
      name: `${d.user.firstName} ${d.user.lastName}`.trim(),
      nationalId: d.nationalId,
      plate: d.currentVehicle?.plate ?? null,
    }));
  }

  async getCompanyName(tx: Prisma.TransactionClient, companyId: number): Promise<string> {
    const company = await tx.company.findUniqueOrThrow({
      where: { companyId },
      select: { legalName: true },
    });
    return company.legalName;
  }

  async lockDriver(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverId: number,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ driver_id: number }>>`
      SELECT driver_id FROM fleet.driver
       WHERE driver_id = ${driverId} AND company_id = ${companyId}
       FOR UPDATE
    `;
    return rows.length === 1;
  }

  async listLedger(
    tx: Prisma.TransactionClient,
    companyId: number,
    weekStart: string,
    driverIds: readonly number[],
  ): Promise<LedgerRow[]> {
    const records = await tx.settlementRemittance.findMany({
      where: { companyId, weekStart: toDateOnly(weekStart), driverId: { in: [...driverIds] } },
      include: LEDGER_INCLUDE,
      orderBy: { remittanceId: 'asc' },
    });
    return records.map(toLedgerRow);
  }

  async listHistory(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverId: number,
    weekStart: string | undefined,
  ): Promise<LedgerRow[]> {
    const records = await tx.settlementRemittance.findMany({
      where: {
        companyId,
        driverId,
        ...(weekStart ? { weekStart: toDateOnly(weekStart) } : {}),
      },
      include: LEDGER_INCLUDE,
      orderBy: [{ recordedAt: 'desc' }, { remittanceId: 'desc' }],
    });
    return records.map(toLedgerRow);
  }

  async findEntry(
    tx: Prisma.TransactionClient,
    companyId: number,
    remittanceId: number,
  ): Promise<LedgerRow | null> {
    const record = await tx.settlementRemittance.findFirst({
      where: { companyId, remittanceId },
      include: LEDGER_INCLUDE,
    });
    return record ? toLedgerRow(record) : null;
  }

  async findReversalOf(
    tx: Prisma.TransactionClient,
    companyId: number,
    remittanceId: number,
  ): Promise<LedgerRow | null> {
    const record = await tx.settlementRemittance.findFirst({
      where: { companyId, reversesRemittanceId: remittanceId },
      include: LEDGER_INCLUDE,
    });
    return record ? toLedgerRow(record) : null;
  }

  async insertEntry(tx: Prisma.TransactionClient, data: InsertLedgerData): Promise<LedgerRow> {
    const record = await tx.settlementRemittance.create({
      data: {
        companyId: data.companyId,
        driverId: data.driverId,
        weekStart: toDateOnly(data.weekStart),
        kind: data.kind,
        amount: data.amount,
        reversesRemittanceId: data.reversesRemittanceId,
        recordedBy: data.recordedBy,
      },
      include: LEDGER_INCLUDE,
    });
    return toLedgerRow(record);
  }

  async insertExport(tx: Prisma.TransactionClient, data: InsertExportData): Promise<void> {
    await tx.settlementExport.create({
      data: {
        companyId: data.companyId,
        exportedBy: data.exportedBy,
        fromDate: toDateOnly(data.from),
        toDate: toDateOnly(data.to),
        driverId: data.driverId,
        rowCount: data.rowCount,
      },
    });
  }
}
