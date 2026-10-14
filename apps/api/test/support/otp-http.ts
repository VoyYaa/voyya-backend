import { randomInt } from 'node:crypto';
import request from 'supertest';
import type { PinApp } from './pin-app';

export interface OtpRow {
  id: number;
  phone: string;
  attempts: number;
  consumed: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface SeededOtp {
  phone: string;
  secondsOld?: number;
  minutesOld?: number;
  consumed?: boolean;
  attempts?: number;
  liveForSeconds?: number;
}

export function createOtpHttp(ctx: PinApp, ipBase = 10) {
  let hop = 0;

  function clientIp(): string {
    hop += 1;
    return `10.${ipBase}.${Math.floor(hop / 250)}.${(hop % 250) + 1}`;
  }

  function post(path: string, body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer()).post(path).set('X-Forwarded-For', clientIp()).send(body);
  }

  function get(path: string, token: string) {
    return request(ctx.app.getHttpServer())
      .get(path)
      .set('X-Forwarded-For', clientIp())
      .set('Authorization', `Bearer ${token}`);
  }

  function randomPhone(): string {
    return `3${randomInt(100_000_000, 999_999_999)}`;
  }

  function codeSentTo(phone: string): string {
    const sent = ctx.sms.send.mock.calls.filter(([to]) => to === phone).pop();
    const match = /(\d+)$/.exec(String(sent?.[1]));
    if (!match?.[1]) throw new Error('The OTP SMS was not sent');
    return match[1];
  }

  async function requestCode(phone: string): Promise<string> {
    const res = await post('/auth/otp/request', { phone });
    if (res.status !== 200) throw new Error(`otp request answered ${res.status} ${JSON.stringify(res.body)}`);
    return codeSentTo(phone);
  }

  function verify(phone: string, code: string) {
    return post('/auth/otp/verify', { phone, code });
  }

  function wrongCodeFor(code: string): string {
    return String((Number(code) + 1) % 10 ** code.length).padStart(code.length, '0');
  }

  async function rowsOf(phone: string): Promise<OtpRow[]> {
    return ctx.prisma.$queryRaw<OtpRow[]>`
      SELECT id, phone, attempts, consumed, created_at AS "createdAt", expires_at AS "expiresAt"
        FROM auth.otp_code WHERE phone = ${phone} ORDER BY id
    `;
  }

  async function ageOtps(phone: string, seconds: number): Promise<void> {
    await ctx.prisma.$executeRaw`
      UPDATE auth.otp_code SET created_at = created_at - make_interval(secs => ${seconds}::int)
       WHERE phone = ${phone}
    `;
  }

  async function seedOtp(seed: SeededOtp): Promise<void> {
    const ageSeconds = seed.secondsOld ?? (seed.minutesOld ?? 0) * 60;
    const liveSeconds = seed.liveForSeconds ?? 300;
    await ctx.prisma.$executeRaw`
      INSERT INTO auth.otp_code (phone, code_hash, expires_at, created_at, consumed, attempts)
      VALUES (
        ${seed.phone},
        'seeded-not-a-real-hash',
        timezone('utc', now()) - make_interval(secs => ${ageSeconds}::int) + make_interval(secs => ${liveSeconds}::int),
        timezone('utc', now()) - make_interval(secs => ${ageSeconds}::int),
        ${seed.consumed ?? false},
        ${seed.attempts ?? 0}
      )
    `;
  }

  return { post, get, randomPhone, requestCode, codeSentTo, verify, wrongCodeFor, rowsOf, ageOtps, seedOtp };
}

export type OtpHttp = ReturnType<typeof createOtpHttp>;
