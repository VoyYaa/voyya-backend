import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DesgloseTarifa } from '@voyya/shared';
import { EnvService } from '../../config/env.service';

/**
 * Cotización firmada (HMAC-SHA256) con TTL corto. Congela la tarifa mostrada en
 * `cotizar` para que `crear` cierre EXACTAMENTE ese precio (evita recálculo
 * divergente) sin guardar estado en servidor. No transporta PII.
 */
export interface QuotePayload {
  id_municipio: number;
  tipo_servicio: string;
  origen: { lat: number; lng: number };
  destino: { lat: number; lng: number };
  distancia_km: number;
  tarifa: DesgloseTarifa;
  /** epoch en segundos. */
  exp: number;
}

export type VerificacionQuote =
  | { ok: true; payload: QuotePayload }
  | { ok: false; razon: 'invalido' | 'expirado' };

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

  firmar(payload: Omit<QuotePayload, 'exp'>): string {
    const exp = Math.floor(Date.now() / 1000) + this.env.get('QUOTE_TOKEN_TTL_SECONDS');
    const cuerpo = base64url(JSON.stringify({ ...payload, exp } satisfies QuotePayload));
    return `${cuerpo}.${this.sign(cuerpo)}`;
  }

  verificar(token: string): VerificacionQuote {
    const partes = token.split('.');
    if (partes.length !== 2) return { ok: false, razon: 'invalido' };
    const [cuerpo, firma] = partes as [string, string];
    if (!safeEqual(firma, this.sign(cuerpo))) return { ok: false, razon: 'invalido' };

    let payload: QuotePayload;
    try {
      payload = JSON.parse(fromBase64url(cuerpo)) as QuotePayload;
    } catch {
      return { ok: false, razon: 'invalido' };
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      return { ok: false, razon: 'expirado' };
    }
    return { ok: true, payload };
  }

  private sign(cuerpo: string): string {
    return base64url(
      createHmac('sha256', this.env.get('QUOTE_TOKEN_SECRET')).update(cuerpo).digest(),
    );
  }
}
