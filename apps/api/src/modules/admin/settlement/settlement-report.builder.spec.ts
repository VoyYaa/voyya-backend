import { buildSettlementReport } from './settlement-report.builder';
import type { DriverAggregateRow, DriverIdentityRow, LedgerRow } from './settlement.repository';

const NOW = new Date('2026-10-12T15:00:00Z');

const aggregate = (driverId: number, commission: number, cash: number): DriverAggregateRow => ({
  driverId,
  tripCount: 3,
  cashCollected: cash,
  commission,
  pendingCashTripCount: 1,
  pendingCashAmount: 5000,
});

const identities: DriverIdentityRow[] = [
  { driverId: 1, name: 'Zoila', nationalId: '1', plate: 'AAA111' },
  { driverId: 2, name: 'Ana', nationalId: '2', plate: null },
];

const ledgerEntry: LedgerRow = {
  remittanceId: 1,
  driverId: 1,
  weekStart: '2026-10-05',
  kind: 'remittance',
  amount: 2400,
  reversesRemittanceId: null,
  recordedAt: new Date('2026-10-12T14:00:00Z'),
  recordedBy: { userId: 9, name: 'Admin' },
  reversed: false,
};

describe('buildSettlementReport', () => {
  it('derives net and amount to remit from the recorded values and sums the rows into totals', () => {
    const report = buildSettlementReport({
      query: { from: '2026-10-05', to: '2026-10-11' },
      now: NOW,
      aggregates: [aggregate(1, 2400, 30000), aggregate(2, 800, 10000)],
      identities,
      ledger: [],
    });
    expect(report.rows.map((r) => r.driver_name)).toEqual(['Ana', 'Zoila']);
    expect(report.rows[1]).toMatchObject({ driver_net: 27600, amount_to_remit: 2400 });
    expect(report.totals).toMatchObject({
      trip_count: 6,
      cash_collected: 40000,
      commission: 3200,
      driver_net: 36800,
      amount_to_remit: 3200,
      pending_cash_trip_count: 2,
      pending_cash_amount: 10000,
    });
  });

  it('includes the remittance summary for a Monday-to-Sunday week', () => {
    const report = buildSettlementReport({
      query: { from: '2026-10-05', to: '2026-10-11' },
      now: NOW,
      aggregates: [aggregate(1, 3200, 40000)],
      identities,
      ledger: [ledgerEntry],
    });
    expect(report.week_start).toBe('2026-10-05');
    expect(report.rows[0]?.remittance).toEqual({
      remitted_amount: 2400,
      balance: 800,
      last_remitted_at: '2026-10-12T14:00:00.000Z',
    });
    expect(report.totals).toMatchObject({ remitted_amount: 2400, remittance_balance: 800 });
  });

  it('has no week and no remittance for a custom range', () => {
    const report = buildSettlementReport({
      query: { from: '2026-10-06', to: '2026-10-12' },
      now: NOW,
      aggregates: [aggregate(1, 100, 1000)],
      identities,
      ledger: [],
    });
    expect(report.week_start).toBeNull();
    expect(report.rows[0]?.remittance).toBeNull();
    expect(report.totals).toMatchObject({ remitted_amount: null, remittance_balance: null });
  });

  it('flags a range that includes today in Bogota as in progress', () => {
    const base = { now: NOW, aggregates: [], identities, ledger: [] };
    expect(buildSettlementReport({ ...base, query: { from: '2026-10-12', to: '2026-10-18' } }).in_progress).toBe(true);
    expect(buildSettlementReport({ ...base, query: { from: '2026-10-05', to: '2026-10-11' } }).in_progress).toBe(false);
  });

  it('returns empty rows and zero totals without trips', () => {
    const report = buildSettlementReport({
      query: { from: '2026-10-05', to: '2026-10-11' },
      now: NOW,
      aggregates: [],
      identities,
      ledger: [],
    });
    expect(report.rows).toEqual([]);
    expect(report.totals.amount_to_remit).toBe(0);
  });
});
