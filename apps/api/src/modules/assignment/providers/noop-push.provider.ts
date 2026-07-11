import { Injectable, Logger } from '@nestjs/common';
import type { NotificacionAsignacion } from '@voyya/shared';
import type { PushProvider } from '../ports/push-provider.port';

/**
 * Stub no-op de PushProvider (MVP en construcción). NO envía PII a los logs:
 * solo ids de asignación/solicitud/conductor (no dirección exacta ni teléfono).
 */
@Injectable()
export class NoopPushProvider implements PushProvider {
  private readonly logger = new Logger(NoopPushProvider.name);

  async enviarAsignacion(
    destino: { idConductor: number },
    notificacion: NotificacionAsignacion,
  ): Promise<void> {
    this.logger.log(
      `[push:noop] conductor=${destino.idConductor} asignacion=${notificacion.id_asignacion} ` +
        `solicitud=${notificacion.id_solicitud} expira_en=${notificacion.expira_en}`,
    );
  }
}
