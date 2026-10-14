import { OTP_DAILY_WINDOW_SECONDS } from '../../config/otp-limits';
import type { EnvService } from '../../config/env.service';

export const OTP_ISSUE_LOCK_NAMESPACE = 91_101;
export const OTP_ISSUE_CONCURRENCY = 1;
export const OTP_ISSUE_QUEUE_MAX = 5;
export const OTP_ISSUE_QUEUE_TIMEOUT_MS = 3_000;
export const OTP_ISSUE_SATURATED_RETRY_SEC = 5;
export const OTP_GLOBAL_CAP_ALERT_INTERVAL_MS = 3_600_000;

const GLOBAL_WARNING_NUMERATOR = 8;
const GLOBAL_WARNING_DENOMINATOR = 10;

export type OtpRefusalCap = 'cooldown' | 'hourly' | 'daily' | 'global' | 'busy' | 'saturated';

export interface OtpIssuancePolicy {
  ttlSec: number;
  cooldownSec: number;
  hourlyLimit: number;
  hourlyWindowSec: number;
  dailyLimit: number;
  dailyWindowSec: number;
  globalLimit: number;
}

export interface OtpIssuanceWaits {
  cooldown: number | null;
  hourly: number | null;
  daily: number | null;
  global: number | null;
}

export interface OtpIssuanceVerdict {
  waits: OtpIssuanceWaits;
  globalCount: number;
}

export interface OtpRefusal {
  cap: OtpRefusalCap;
  retryInSec: number;
  globalCapReached: boolean;
}

const CAP_PRECEDENCE = ['global', 'daily', 'hourly', 'cooldown'] as const;

export function readOtpIssuancePolicy(env: Pick<EnvService, 'get'>): OtpIssuancePolicy {
  return {
    ttlSec: env.get('OTP_TTL_SECONDS'),
    cooldownSec: env.get('OTP_RESEND_COOLDOWN_SECONDS'),
    hourlyLimit: env.get('OTP_RATE_LIMIT_MAX'),
    hourlyWindowSec: env.get('OTP_RATE_LIMIT_WINDOW_SECONDS'),
    dailyLimit: env.get('OTP_PHONE_DAILY_LIMIT'),
    dailyWindowSec: OTP_DAILY_WINDOW_SECONDS,
    globalLimit: env.get('OTP_GLOBAL_DAILY_LIMIT'),
  };
}

export function otpRetentionSeconds(): number {
  return OTP_DAILY_WINDOW_SECONDS;
}

export function decideRefusal(waits: OtpIssuanceWaits): OtpRefusal | null {
  let chosen: { cap: (typeof CAP_PRECEDENCE)[number]; retryInSec: number } | null = null;
  for (const cap of CAP_PRECEDENCE) {
    const wait = waits[cap];
    if (wait !== null && (chosen === null || wait > chosen.retryInSec)) {
      chosen = { cap, retryInSec: wait };
    }
  }
  if (chosen === null) return null;
  return {
    cap: chosen.cap,
    retryInSec: Math.max(chosen.retryInSec, 1),
    globalCapReached: waits.global !== null,
  };
}

export function crossesGlobalWarning(globalCountBefore: number, limit: number): boolean {
  const threshold = Math.ceil((limit * GLOBAL_WARNING_NUMERATOR) / GLOBAL_WARNING_DENOMINATOR);
  return globalCountBefore < threshold && threshold <= globalCountBefore + 1;
}

export function reachesGlobalLimit(globalCountBefore: number, limit: number): boolean {
  return globalCountBefore + 1 >= limit;
}
