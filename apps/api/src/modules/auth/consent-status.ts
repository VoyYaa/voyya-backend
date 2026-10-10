import {
  DRIVER_LOCATION_SHARING_NOTICE_VERSIONS,
  type ConsentPurpose,
  type ConsentState,
  type ConsentStatus,
  LOCATION_NOTICE_VERSION,
} from '@voyyaa/shared';

export interface ConsentLedgerEntry {
  action: 'granted' | 'revoked';
  noticeVersion: string;
  recordedAt: Date;
}

export function coversLocationSharing(status: ConsentStatus): boolean {
  return (
    status.state === 'granted' &&
    status.notice_version !== null &&
    (DRIVER_LOCATION_SHARING_NOTICE_VERSIONS as readonly string[]).includes(status.notice_version)
  );
}

export function buildConsentStatus(
  purpose: ConsentPurpose,
  latest: ConsentLedgerEntry | null,
  latestGranted: ConsentLedgerEntry | null,
  currentNoticeVersion: string = LOCATION_NOTICE_VERSION,
): ConsentStatus {
  const state: ConsentState = latest === null ? 'none' : latest.action;
  return {
    purpose,
    state,
    notice_version: latest ? latest.noticeVersion : null,
    granted_at: latestGranted ? latestGranted.recordedAt.toISOString() : null,
    revoked_at: latest && latest.action === 'revoked' ? latest.recordedAt.toISOString() : null,
    current_notice_version: currentNoticeVersion,
    requires_acceptance: state !== 'granted' || latest?.noticeVersion !== currentNoticeVersion,
  };
}
