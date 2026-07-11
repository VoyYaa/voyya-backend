import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import twilio from 'twilio';
import type { SmsProvider } from '../ports/sms-provider.port';

/** Credenciales de Twilio (las provee la factory desde el entorno, nunca hardcodeadas). */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Proveedor SMS real (Twilio) tras el puerto `SmsProvider` (Fase 0). Sin lock-in:
 * conmutar de proveedor es cambiar esta implementación.
 *
 * SEGURIDAD: NUNCA loguea el `authToken`, el `mensaje` (contiene el OTP) ni el
 * teléfono completo (se enmascara, igual que el stub). El destino se normaliza a
 * E.164; los errores del SDK se envuelven en un error tipado sin filtrar detalles.
 */
@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly cliente: ReturnType<typeof twilio>;
  private readonly from: string;

  constructor(config: TwilioConfig) {
    this.cliente = twilio(config.accountSid, config.authToken);
    this.from = config.fromNumber;
  }

  async enviar(telefono: string, mensaje: string): Promise<void> {
    const to = aE164(telefono);
    try {
      await this.cliente.messages.create({ to, from: this.from, body: mensaje });
      this.logger.log(`[sms:twilio] enviado destino=${enmascarar(to)}`);
    } catch {
      // No se propaga el error del SDK (podría incluir metadatos sensibles); solo
      // el destino enmascarado en el log de servidor.
      this.logger.error(`[sms:twilio] fallo al enviar destino=${enmascarar(to)}`);
      throw new ServiceUnavailableException({
        codigo: 'SMS_ENVIO_FALLIDO',
        mensaje: 'No se pudo enviar el SMS',
      });
    }
  }
}

/** Normaliza a E.164: respeta un `+` ya presente; 10 dígitos colombianos → +57XXXXXXXXXX. */
function aE164(telefono: string): string {
  const t = telefono.trim();
  if (t.startsWith('+')) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `+57${d}`;
  if (d.length === 12 && d.startsWith('57')) return `+${d}`;
  return `+${d}`;
}

function enmascarar(telefono: string): string {
  if (telefono.length <= 4) return '****';
  return `${'*'.repeat(telefono.length - 4)}${telefono.slice(-4)}`;
}
