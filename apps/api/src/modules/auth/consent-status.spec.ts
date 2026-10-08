import { buildConsentStatus, type ConsentLedgerEntry } from './consent-status';

const CURRENT = 'location-notice-v2';
const granted = (version: string, at: string): ConsentLedgerEntry => ({
  action: 'granted',
  noticeVersion: version,
  recordedAt: new Date(at),
});
const revoked = (version: string, at: string): ConsentLedgerEntry => ({
  action: 'revoked',
  noticeVersion: version,
  recordedAt: new Date(at),
});

describe('buildConsentStatus', () => {
  it('reports none and requires acceptance when the ledger is empty', () => {
    expect(buildConsentStatus('location', null, null, CURRENT)).toEqual({
      purpose: 'location',
      state: 'none',
      notice_version: null,
      granted_at: null,
      revoked_at: null,
      current_notice_version: CURRENT,
      requires_acceptance: true,
    });
  });

  it('reports granted for the current version without requiring acceptance', () => {
    const entry = granted(CURRENT, '2026-10-08T10:00:00.000Z');
    expect(buildConsentStatus('location', entry, entry, CURRENT)).toMatchObject({
      state: 'granted',
      notice_version: CURRENT,
      granted_at: '2026-10-08T10:00:00.000Z',
      revoked_at: null,
      requires_acceptance: false,
    });
  });

  it('requires acceptance when the granted version is not the current one', () => {
    const entry = granted('location-notice-v1', '2026-09-01T10:00:00.000Z');
    expect(buildConsentStatus('location', entry, entry, CURRENT)).toMatchObject({
      state: 'granted',
      requires_acceptance: true,
    });
  });

  it('reports revoked with both timestamps when the latest entry is a revocation', () => {
    const grant = granted(CURRENT, '2026-10-08T10:00:00.000Z');
    const revocation = revoked(CURRENT, '2026-10-08T11:00:00.000Z');
    expect(buildConsentStatus('location', revocation, grant, CURRENT)).toMatchObject({
      state: 'revoked',
      granted_at: '2026-10-08T10:00:00.000Z',
      revoked_at: '2026-10-08T11:00:00.000Z',
      requires_acceptance: true,
    });
  });
});
