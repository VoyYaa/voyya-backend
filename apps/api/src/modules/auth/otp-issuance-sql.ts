import { Prisma } from '@prisma/client';
import type { OtpIssuancePolicy } from './otp-policy';

export interface OtpVerdictRow {
  cooldown_retry_sec: number | null;
  hourly_retry_sec: number | null;
  daily_retry_sec: number | null;
  global_retry_sec: number | null;
  global_count: number;
}

export interface OtpIssuanceRow extends OtpVerdictRow {
  inserted_id: number | null;
}

function verdictCtes(phone: string, policy: OtpIssuancePolicy): Prisma.Sql {
  const cooldown = policy.cooldownSec;
  const hourWindow = policy.hourlyWindowSec;
  const hourOffset = policy.hourlyLimit - 1;
  const dayWindow = policy.dailyWindowSec;
  const dayOffset = policy.dailyLimit - 1;
  const globalOffset = policy.globalLimit - 1;
  return Prisma.sql`
    clock AS (
      SELECT timezone('utc', clock_timestamp()) AS now_utc
    ),
    verdict AS (
      SELECT
        c.now_utc,
        (SELECT max(o.created_at) + make_interval(secs => ${cooldown}::int)
           FROM auth.otp_code o
          WHERE o.phone = ${phone}::text
            AND o.created_at > c.now_utc - make_interval(secs => ${cooldown}::int)) AS cooldown_until,
        (SELECT o.created_at + make_interval(secs => ${hourWindow}::int)
           FROM auth.otp_code o
          WHERE o.phone = ${phone}::text
            AND o.created_at > c.now_utc - make_interval(secs => ${hourWindow}::int)
          ORDER BY o.created_at DESC
         OFFSET ${hourOffset}::int LIMIT 1) AS hourly_until,
        (SELECT o.created_at + make_interval(secs => ${dayWindow}::int)
           FROM auth.otp_code o
          WHERE o.phone = ${phone}::text
            AND o.created_at > c.now_utc - make_interval(secs => ${dayWindow}::int)
          ORDER BY o.created_at DESC
         OFFSET ${dayOffset}::int LIMIT 1) AS daily_until,
        (SELECT o.created_at + make_interval(secs => ${dayWindow}::int)
           FROM auth.otp_code o
          WHERE o.created_at > c.now_utc - make_interval(secs => ${dayWindow}::int)
          ORDER BY o.created_at DESC
         OFFSET ${globalOffset}::int LIMIT 1) AS global_until,
        (SELECT count(*)::int
           FROM auth.otp_code o
          WHERE o.created_at > c.now_utc - make_interval(secs => ${dayWindow}::int)) AS global_count
      FROM clock c
    )`;
}

const VERDICT_COLUMNS = Prisma.sql`
  ceil(extract(epoch FROM v.cooldown_until - v.now_utc))::int AS cooldown_retry_sec,
  ceil(extract(epoch FROM v.hourly_until - v.now_utc))::int AS hourly_retry_sec,
  ceil(extract(epoch FROM v.daily_until - v.now_utc))::int AS daily_retry_sec,
  ceil(extract(epoch FROM v.global_until - v.now_utc))::int AS global_retry_sec,
  v.global_count`;

export function otpVerdictQuery(phone: string, policy: OtpIssuancePolicy): Prisma.Sql {
  return Prisma.sql`
    WITH ${verdictCtes(phone, policy)}
    SELECT ${VERDICT_COLUMNS}
      FROM verdict v`;
}

export function otpIssuanceQuery(phone: string, codeHash: string, policy: OtpIssuancePolicy): Prisma.Sql {
  const ttl = policy.ttlSec;
  return Prisma.sql`
    WITH ${verdictCtes(phone, policy)},
    allowed AS (
      SELECT v.now_utc
        FROM verdict v
       WHERE v.cooldown_until IS NULL
         AND v.hourly_until IS NULL
         AND v.daily_until IS NULL
         AND v.global_until IS NULL
    ),
    expired AS (
      UPDATE auth.otp_code o
         SET expires_at = a.now_utc
        FROM allowed a
       WHERE o.phone = ${phone}::text
         AND o.consumed = false
         AND o.expires_at > a.now_utc
      RETURNING o.id
    ),
    inserted AS (
      INSERT INTO auth.otp_code (phone, code_hash, expires_at, created_at)
      SELECT ${phone}::text, ${codeHash}::text, a.now_utc + make_interval(secs => ${ttl}::int), a.now_utc
        FROM allowed a
      RETURNING id
    )
    SELECT ${VERDICT_COLUMNS},
           (SELECT id FROM inserted) AS inserted_id
      FROM verdict v`;
}
