import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EnvService } from '../../config/env.service';

export interface DocumentDownloadTokenPayload {
  companyDocumentId: number;
  companyId: number;
  mintedBy: number;
  purpose: 'document_download';
  exp: number;
}

export type DocumentDownloadTokenVerification =
  | { ok: true; payload: DocumentDownloadTokenPayload }
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
export class DocumentDownloadTokenService {
  constructor(private readonly env: EnvService) {}

  sign(companyDocumentId: number, companyId: number, mintedBy: number): string {
    const ttlSeconds = this.env.get('DOCUMENT_SIGNED_URL_TTL_SEC');
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload: DocumentDownloadTokenPayload = {
      companyDocumentId,
      companyId,
      mintedBy,
      purpose: 'document_download',
      exp,
    };
    const body = base64url(JSON.stringify(payload));
    return `${body}.${this.signBody(body)}`;
  }

  buildUrl(companyDocumentId: number, companyId: number, mintedBy: number): string {
    const base = this.env.get('API_PUBLIC_URL').replace(/\/+$/, '');
    return `${base}/documents/${this.sign(companyDocumentId, companyId, mintedBy)}`;
  }

  verify(token: string): DocumentDownloadTokenVerification {
    const parts = token.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'invalid' };
    const [body, signature] = parts as [string, string];
    if (!safeEqual(signature, this.signBody(body))) return { ok: false, reason: 'invalid' };

    let payload: DocumentDownloadTokenPayload;
    try {
      payload = JSON.parse(fromBase64url(body)) as DocumentDownloadTokenPayload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.purpose !== 'document_download') return { ok: false, reason: 'invalid' };
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
