import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';
import type { SmsProvider } from '../ports/sms-provider.port';

/**
 * Stub de SmsProvider para desarrollo. A-02: en NO producción loguea el contenido
 * (incluye el OTP) para poder probar sin SMS real; en producción NUNCA loguea el
 * código (además está PROHIBIDO por `crearSmsProvider` — fail-fast).
 */
@Injectable()
export class NoopSmsProvider implements SmsProvider {
  private readonly logger = new Logger(NoopSmsProvider.name);

  constructor(private readonly env: EnvService) {}

  async enviar(telefono: string, mensaje: string): Promise<void> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(`[sms:dev] destino=${enmascarar(telefono)} mensaje="${mensaje}"`);
    }
  }
}

function enmascarar(telefono: string): string {
  if (telefono.length <= 4) return '****';
  return `${'*'.repeat(telefono.length - 4)}${telefono.slice(-4)}`;
}
