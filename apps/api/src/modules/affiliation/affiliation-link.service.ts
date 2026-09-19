import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EnvService } from '../../config/env.service';

export interface AffiliationLinkPayload {
  companyId: number;
  purpose: 'document_upload';
  exp: number;
}

export type AffiliationLinkVerification =
  | { ok: true; payload: AffiliationLinkPayload }
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
export class AffiliationLinkService {
  constructor(private readonly env: EnvService) {}

  sign(companyId: number): string {
    const ttlSeconds = this.env.get('AFFILIATION_TOKEN_TTL_DAYS') * 24 * 60 * 60;
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload: AffiliationLinkPayload = { companyId, purpose: 'document_upload', exp };
    const body = base64url(JSON.stringify(payload));
    return `${body}.${this.signBody(body)}`;
  }

  buildUrl(companyId: number): string {
    const portal = this.env.get('AFFILIATION_PORTAL_URL').replace(/\/+$/, '');
    return `${portal}/afiliacion/documentos?token=${this.sign(companyId)}`;
  }

  verify(token: string): AffiliationLinkVerification {
    const parts = token.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'invalid' };
    const [body, signature] = parts as [string, string];
    if (!safeEqual(signature, this.signBody(body))) return { ok: false, reason: 'invalid' };

    let payload: AffiliationLinkPayload;
    try {
      payload = JSON.parse(fromBase64url(body)) as AffiliationLinkPayload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.purpose !== 'document_upload') return { ok: false, reason: 'invalid' };
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload };
  }

  private signBody(body: string): string {
    return base64url(
      createHmac('sha256', this.env.get('AFFILIATION_TOKEN_SECRET')).update(body).digest(),
    );
  }
}
