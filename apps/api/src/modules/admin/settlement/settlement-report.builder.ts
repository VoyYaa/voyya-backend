import {
  addDays,
  isMonday,
  SETTLEMENT_TIME_ZONE,
  type SettlementReportQuery,
  type SettlementReportResponse,
  type SettlementReportRow,
  type SettlementReportTotals,
  settlementToday,
} from '@voyyaa/shared';
import { summarizeLedger, toRemittanceSummary } from './remittance-ledger';
import type { DriverAggregateRow, DriverIdentityRow, LedgerRow } from './settlement.repository';

export interface ReportInputs {
  query: SettlementReportQuery;
  now: Date;
  aggregates: readonly DriverAggregateRow[];
  identities: readonly DriverIdentityRow[];
  ledger: readonly LedgerRow[];
}

export function weekStartOfRange(query: SettlementReportQuery): string | null {
  return isMonday(query.from) && query.to === addDays(query.from, 6) ? query.from : null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function buildRow(
  aggregate: DriverAggregateRow,
  identity: DriverIdentityRow | undefined,
  ledger: readonly LedgerRow[],
  hasWeek: boolean,
): SettlementReportRow {
  const driverLedger = ledger.filter((entry) => entry.driverId === aggregate.driverId);
  return {
    driver_id: aggregate.driverId,
    driver_name: identity?.name ?? '',
    national_id: identity?.nationalId ?? '',
    plate: identity?.plate ?? null,
    trip_count: aggregate.tripCount,
    cash_collected: aggregate.cashCollected,
    commission: aggregate.commission,
    driver_net: aggregate.cashCollected - aggregate.commission,
    amount_to_remit: aggregate.commission,
    pending_cash_trip_count: aggregate.pendingCashTripCount,
    pending_cash_amount: aggregate.pendingCashAmount,
    remittance: hasWeek ? toRemittanceSummary(summarizeLedger(driverLedger), aggregate.commission) : null,
  };
}

function buildTotals(rows: readonly SettlementReportRow[], hasWeek: boolean): SettlementReportTotals {
  return {
    trip_count: sum(rows.map((r) => r.trip_count)),
    cash_collected: sum(rows.map((r) => r.cash_collected)),
    commission: sum(rows.map((r) => r.commission)),
    driver_net: sum(rows.map((r) => r.driver_net)),
    amount_to_remit: sum(rows.map((r) => r.amount_to_remit)),
    pending_cash_trip_count: sum(rows.map((r) => r.pending_cash_trip_count)),
    pending_cash_amount: sum(rows.map((r) => r.pending_cash_amount)),
    remitted_amount: hasWeek ? sum(rows.map((r) => r.remittance?.remitted_amount ?? 0)) : null,
    remittance_balance: hasWeek ? sum(rows.map((r) => r.remittance?.balance ?? 0)) : null,
  };
}

export function buildSettlementReport(input: ReportInputs): SettlementReportResponse {
  const weekStart = weekStartOfRange(input.query);
  const hasWeek = weekStart !== null;
  const rows = input.aggregates
    .map((aggregate) =>
      buildRow(
        aggregate,
        input.identities.find((i) => i.driverId === aggregate.driverId),
        input.ledger,
        hasWeek,
      ),
    )
    .sort((a, b) => a.driver_name.localeCompare(b.driver_name, 'es') || a.driver_id - b.driver_id);
  return {
    from: input.query.from,
    to: input.query.to,
    time_zone: SETTLEMENT_TIME_ZONE,
    week_start: weekStart,
    in_progress: input.query.to >= settlementToday(input.now),
    generated_at: input.now.toISOString(),
    rows,
    totals: buildTotals(rows, hasWeek),
  };
}
