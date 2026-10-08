import { type LedgerEntry, summarizeLedger, toRemittanceSummary } from './remittance-ledger';

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 12, 10, minute));

function remittance(id: number, amount: number, minute: number): LedgerEntry {
  return { remittanceId: id, kind: 'remittance', amount, reversesRemittanceId: null, recordedAt: at(minute) };
}

function reversal(id: number, reverses: number, amount: number, minute: number): LedgerEntry {
  return { remittanceId: id, kind: 'reversal', amount, reversesRemittanceId: reverses, recordedAt: at(minute) };
}

describe('summarizeLedger', () => {
  it('is empty without entries', () => {
    expect(summarizeLedger([])).toEqual({ remitted: 0, lastRemittedAt: null, lastActiveRemittanceId: null });
  });

  it('adds remittances', () => {
    const state = summarizeLedger([remittance(1, 2400, 1), remittance(2, 800, 5)]);
    expect(state.remitted).toBe(3200);
    expect(state.lastRemittedAt).toEqual(at(5));
    expect(state.lastActiveRemittanceId).toBe(2);
  });

  it('subtracts reversals and ignores reversed remittances for the last date', () => {
    const state = summarizeLedger([remittance(1, 2400, 1), remittance(2, 800, 5), reversal(3, 2, 800, 6)]);
    expect(state.remitted).toBe(2400);
    expect(state.lastActiveRemittanceId).toBe(1);
    expect(state.lastRemittedAt).toEqual(at(1));
  });

  it('has no last date when everything was reversed', () => {
    const state = summarizeLedger([remittance(1, 2400, 1), reversal(2, 1, 2400, 2)]);
    expect(state).toEqual({ remitted: 0, lastRemittedAt: null, lastActiveRemittanceId: null });
  });
});

describe('toRemittanceSummary', () => {
  it('computes the balance against the amount to remit', () => {
    const state = summarizeLedger([remittance(1, 2400, 1)]);
    expect(toRemittanceSummary(state, 3200)).toEqual({
      remitted_amount: 2400,
      balance: 800,
      last_remitted_at: at(1).toISOString(),
    });
  });
});
