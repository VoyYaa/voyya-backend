import type { SettlementRemittanceSummary } from '@voyyaa/shared';

export interface LedgerEntry {
  remittanceId: number;
  kind: 'remittance' | 'reversal';
  amount: number;
  reversesRemittanceId: number | null;
  recordedAt: Date;
}

export interface LedgerState {
  remitted: number;
  lastRemittedAt: Date | null;
  lastActiveRemittanceId: number | null;
}

export function summarizeLedger(entries: readonly LedgerEntry[]): LedgerState {
  const reversed = new Set(
    entries.flatMap((e) => (e.reversesRemittanceId === null ? [] : [e.reversesRemittanceId])),
  );
  let remitted = 0;
  let last: LedgerEntry | null = null;
  for (const entry of entries) {
    remitted += entry.kind === 'remittance' ? entry.amount : -entry.amount;
    if (entry.kind === 'remittance' && !reversed.has(entry.remittanceId)) {
      const isLater =
        last === null ||
        entry.recordedAt > last.recordedAt ||
        (entry.recordedAt.getTime() === last.recordedAt.getTime() &&
          entry.remittanceId > last.remittanceId);
      if (isLater) last = entry;
    }
  }
  return {
    remitted,
    lastRemittedAt: last?.recordedAt ?? null,
    lastActiveRemittanceId: last?.remittanceId ?? null,
  };
}

export function toRemittanceSummary(
  state: LedgerState,
  amountToRemit: number,
): SettlementRemittanceSummary {
  return {
    remitted_amount: state.remitted,
    balance: amountToRemit - state.remitted,
    last_remitted_at: state.lastRemittedAt?.toISOString() ?? null,
  };
}
