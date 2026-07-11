import type { NotificacionAsignacion } from '@voyya/shared';

/** Token de inyección del puerto de push (DIP). */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * Puerto de notificaciones push al conductor (HU-07). Abstracción intercambiable
 * (Expo Notifications en piloto). La implementación real vive fuera del motor.
 */
export interface PushProvider {
  enviarAsignacion(
    destino: { idConductor: number },
    notificacion: NotificacionAsignacion,
  ): Promise<void>;
}
