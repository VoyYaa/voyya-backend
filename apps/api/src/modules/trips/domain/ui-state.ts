import type { EstadoSolicitud, EstadoUIPasajero } from '@voyya/shared';

/**
 * Deriva el estado de UI del pasajero (borde de pantalla) desde el estado del viaje.
 * `estado` (en la respuesta) es la fuente precisa; `ui` es una pista gruesa de pantalla.
 * El enum de UI no cubre estados terminales, así que se mapean al más cercano.
 */
export function estadoUIPasajero(estado: EstadoSolicitud): EstadoUIPasajero {
  switch (estado) {
    case 'pendiente_de_asignacion':
      return 'buscando';
    case 'asignada':
    case 'conductor_en_camino':
    case 'en_curso':
    case 'completada':
      return 'conductor_asignado';
    case 'sin_conductor':
    case 'cancelada_cliente':
    case 'cancelada_conductor':
    case 'no_show':
    case 'expirada':
      return 'sin_conductor';
  }
}
