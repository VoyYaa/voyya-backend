import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { FareBreakdown } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';

export interface QuotePayload {
  municipalityId: number;
  serviceType: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  distanceKm: number;
  fare: FareBreakdown;
  exp: number;
}

export type QuoteVerification =
  | { ok: true; payload: QuotePayload }
  | { ok: false; reason: 'invalid' | 'expired' };

function base64url(buf: Buffer | string): string {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64url');
}
function fromBase64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

@Injectable()
export class QuoteTokenService {
  constructor(private readonly env: EnvService) {}

  sign(payload: Omit<QuotePayload, 'exp'>): string {
    const exp = Math.floor(Date.now() / 1000) + this.env.get('QUOTE_TOKEN_TTL_SECONDS');
    const body = base64url(JSON.stringify({ ...payload, exp } satisfies QuotePayload));
    return `${body}.${this.signBody(body)}`;
  }

  verify(token: string): QuoteVerification {
    const parts = token.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'invalid' };
    const [body, signature] = parts as [string, string];
    if (!safeEqual(signature, this.signBody(body))) return { ok: false, reason: 'invalid' };

    let payload: QuotePayload;
    try {
      payload = JSON.parse(fromBase64url(body)) as QuotePayload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload };
  }

  private signBody(body: string): string {
    return base64url(
      createHmac('sha256', this.env.get('QUOTE_TOKEN_SECRET')).update(body).digest(),
    );
  }
}
