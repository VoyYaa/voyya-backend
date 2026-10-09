import { DRIVER_LOCATION_SHARING_NOTICE_VERSIONS, LOCATION_NOTICE_VERSION } from '@voyyaa/shared';
import { buildConsentStatus, coversLocationSharing, type ConsentLedgerEntry } from './consent-status';

const CURRENT = 'location-notice-v3';
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

describe('coversLocationSharing (ADR-033 section 3.5)', () => {
  const statusOf = (entry: ConsentLedgerEntry | null, latestGranted: ConsentLedgerEntry | null = entry) =>
    buildConsentStatus('location', entry, latestGranted, CURRENT);

  it('the current notice version is one of the versions that cover sharing', () => {
    expect(DRIVER_LOCATION_SHARING_NOTICE_VERSIONS).toContain(LOCATION_NOTICE_VERSION);
    expect(CURRENT).toBe(LOCATION_NOTICE_VERSION);
  });

  it('a grant of the v3 notice covers sharing', () => {
    expect(coversLocationSharing(statusOf(granted(CURRENT, '2026-10-09T10:00:00.000Z')))).toBe(true);
  });

  it.each(['location-notice-v1', 'location-notice-v2'])('a grant of %s does not cover sharing', (version) => {
    expect(coversLocationSharing(statusOf(granted(version, '2026-10-01T10:00:00.000Z')))).toBe(false);
  });

  it('no ledger entry does not cover sharing', () => {
    expect(coversLocationSharing(statusOf(null, null))).toBe(false);
  });

  it('a revocation after a v3 grant does not cover sharing', () => {
    const grant = granted(CURRENT, '2026-10-09T10:00:00.000Z');
    const revocation = revoked(CURRENT, '2026-10-09T11:00:00.000Z');
    expect(coversLocationSharing(statusOf(revocation, grant))).toBe(false);
  });
});
