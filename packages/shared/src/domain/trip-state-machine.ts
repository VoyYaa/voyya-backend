// =============================================================================
// VoyYa — Máquina de estados del viaje (FUENTE ÚNICA DE VERDAD)
// -----------------------------------------------------------------------------
// NO redefine transiciones: REUSA las ya tipadas en los contratos
// (packages/shared/src/contracts/*.ts) y las agrupa en un único objeto para que
// backend y frontend consuman la MISMA lógica (DRY · coding-standards §DRY).
//
// Añade helpers `assert*` (lanzan en transición inválida) que el backend usa para
// proteger cada cambio de estado — sin duplicar la tabla de transiciones.
// =============================================================================

import {
  type EstadoSolicitud,
  TRANSICIONES_SOLICITUD,
  puedeTransicionarSolicitud,
} from '../contracts/trips';
import {
  type EstadoAsignacion,
  TRANSICIONES_ASIGNACION,
  puedeTransicionarAsignacion,
} from '../contracts/assignment';

/** Error de dominio: transición de estado no permitida por la máquina. */
export class TransicionInvalidaError extends Error {
  constructor(
    public readonly maquina: 'solicitud' | 'asignacion',
    public readonly desde: string,
    public readonly hacia: string,
  ) {
    super(`Transición inválida en ${maquina}: ${desde} → ${hacia}`);
    this.name = 'TransicionInvalidaError';
  }
}

/**
 * Máquina de estados del viaje — único punto de verdad para las transiciones de
 * `SolicitudViaje` y `Asignacion`. Reusa los predicados de los contratos.
 */
export const MaquinaEstadosViaje = {
  solicitud: {
    transiciones: TRANSICIONES_SOLICITUD,
    puede: puedeTransicionarSolicitud,
    siguientes: (desde: EstadoSolicitud): readonly EstadoSolicitud[] =>
      TRANSICIONES_SOLICITUD[desde],
    assert: (desde: EstadoSolicitud, hacia: EstadoSolicitud): void => {
      if (!puedeTransicionarSolicitud(desde, hacia)) {
        throw new TransicionInvalidaError('solicitud', desde, hacia);
      }
    },
  },
  asignacion: {
    transiciones: TRANSICIONES_ASIGNACION,
    puede: puedeTransicionarAsignacion,
    siguientes: (desde: EstadoAsignacion): readonly EstadoAsignacion[] =>
      TRANSICIONES_ASIGNACION[desde],
    assert: (desde: EstadoAsignacion, hacia: EstadoAsignacion): void => {
      if (!puedeTransicionarAsignacion(desde, hacia)) {
        throw new TransicionInvalidaError('asignacion', desde, hacia);
      }
    },
  },
} as const;

/** Estados terminales de una solicitud (no admiten más transiciones). */
export const ESTADOS_SOLICITUD_TERMINALES: readonly EstadoSolicitud[] = [
  'completada',
  'cancelada_cliente',
  'cancelada_conductor',
  'sin_conductor',
  'no_show',
  'expirada',
];

/** Estados en los que una solicitud está "viva" (bloquea crear otra — idempotencia HU-04). */
export const ESTADOS_SOLICITUD_ACTIVOS: readonly EstadoSolicitud[] = [
  'pendiente_de_asignacion',
  'asignada',
  'conductor_en_camino',
  'en_curso',
];

export function esEstadoSolicitudTerminal(estado: EstadoSolicitud): boolean {
  return ESTADOS_SOLICITUD_TERMINALES.includes(estado);
}

export function esEstadoSolicitudActivo(estado: EstadoSolicitud): boolean {
  return ESTADOS_SOLICITUD_ACTIVOS.includes(estado);
}
