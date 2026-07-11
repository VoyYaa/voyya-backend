// =============================================================================
// VoyYa — Contrato compartido · Dominio ASSIGNMENT (motor de asignación)
// -----------------------------------------------------------------------------
// Fase Diseñar (ASDD) · Agente `arquitectura` · skill `arquitectura-contrato-api`
// Fuente ÚNICA de verdad para backend (NestJS) y app del conductor (Expo).
// Validación con Zod. Sin `any`. Enums espejo de prisma/schema.prisma.
//
// Cubre: aceptar / rechazar / cancelar (conductor) una asignación, el resultado
// de la TOMA ÚNICA ATÓMICA (HU-08, ADR-002), la notificación al conductor con
// countdown (HU-07), y los eventos in-process (NestJS EventEmitter — sin broker).
//
// Motor: nearest-first + retry chain (ADR-001). Este contrato es TENANT-scoped:
// toda operación exige `id_empresa` (del JWT del conductor).
// =============================================================================

import { z } from 'zod';
import { EstadoSolicitud } from './trips';

// -----------------------------------------------------------------------------
// Máquina de estados del CONDUCTOR (espejo de Prisma) — relevante para el motor
// -----------------------------------------------------------------------------

export const EstadoConductor = z.enum([
  'disponible',
  'en_servicio',
  'fuera_de_turno',
  'inactivo',
  'suspendido',
  'bloqueado_documentos',
]);
export type EstadoConductor = z.infer<typeof EstadoConductor>;

// -----------------------------------------------------------------------------
// Máquina de estados de la ASIGNACION (doc 11 §2.3) — fuente de verdad compartida
// -----------------------------------------------------------------------------

export const EstadoAsignacion = z.enum([
  'creada',
  'notificada',
  'aceptada',
  'rechazada',
  'timeout',
  'cancelada',
  'finalizada',
]);
export type EstadoAsignacion = z.infer<typeof EstadoAsignacion>;

export const TRANSICIONES_ASIGNACION = {
  creada: ['notificada', 'timeout'],
  notificada: ['aceptada', 'rechazada', 'timeout'],
  aceptada: ['cancelada', 'finalizada'],
  rechazada: [],
  timeout: [],
  cancelada: [],
  finalizada: [],
} as const satisfies Record<EstadoAsignacion, readonly EstadoAsignacion[]>;

export function puedeTransicionarAsignacion(
  desde: EstadoAsignacion,
  hacia: EstadoAsignacion,
): boolean {
  return (TRANSICIONES_ASIGNACION[desde] as readonly EstadoAsignacion[]).includes(hacia);
}

// -----------------------------------------------------------------------------
// Candidato del motor nearest-first (uso interno assignment; no se expone al front)
// -----------------------------------------------------------------------------

export const CandidatoConductor = z.object({
  id_conductor: z.number().int().positive(),
  id_taxi: z.number().int().positive(),
  distancia_m: z.number().nonnegative(),          // orden primario (haversine/PostGIS)
  viajes_ultimas_3h: z.number().int().nonnegative(), // desempate (menos viajes gana)
  orden_intento: z.number().int().positive(),     // posición en la retry chain
});
export type CandidatoConductor = z.infer<typeof CandidatoConductor>;

// -----------------------------------------------------------------------------
// Notificación al conductor (payload del push / socket) · HU-07
// -----------------------------------------------------------------------------

export const NotificacionAsignacion = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  origen: z.object({
    direccion: z.string(),
    lat: z.number(),
    lng: z.number(),
  }),
  destino_barrio: z.string(), // barrio/zona, no dirección exacta hasta aceptar
  tarifa_total: z.number().int().nonnegative(), // COP
  distancia_al_origen_m: z.number().nonnegative(),
  // Countdown de aceptación (parámetro timeout_aceptacion_seg = 15, configurable).
  expira_en: z.string().datetime(),
  segundos_para_responder: z.number().int().positive(),
});
export type NotificacionAsignacion = z.infer<typeof NotificacionAsignacion>;

// -----------------------------------------------------------------------------
// GET /assignments/cercanas — ofertas PENDIENTES del conductor (POLLING · HU-07)
// -----------------------------------------------------------------------------
// rol: conductor · tenant: id_empresa (del JWT). Devuelve las asignaciones del
// conductor autenticado en estado `creada`/`notificada` y NO expiradas, como un
// array del MISMO `NotificacionAsignacion` (DRY, sin redefinir campos). Es el
// PUENTE de polling hasta que exista el PUSH real (Expo Notifications, EV1).
// TODO(EV1): reemplazar/complementar este polling por push real.
export const OfertasCercanasRespuesta = z.array(NotificacionAsignacion);
export type OfertasCercanasRespuesta = z.infer<typeof OfertasCercanasRespuesta>;

// -----------------------------------------------------------------------------
// Endpoint 1 — ACEPTAR asignación (TOMA ÚNICA ATÓMICA) · HU-07 / HU-08
// -----------------------------------------------------------------------------
// POST /assignments/:id_asignacion/aceptar
//   rol: conductor   ·   tenant: id_empresa (del JWT) OBLIGATORIO
//   200 ResultadoAceptacion { resultado:'aceptada' }  — este conductor GANÓ
//   409 ResultadoAceptacion { resultado:'ya_tomada' } — otro ganó la carrera
//   410 { resultado:'expirada' } — venció el countdown → ya pasó al siguiente
//   403 no es el conductor notificado   ·   404 asignación no existe
// Implementación: UPDATE fleet.conductor SET estado='en_servicio'
//   WHERE id_conductor=$1 AND estado='disponible' AND id_empresa=$tenant RETURNING *;
//   0 filas ⇒ 'ya_tomada'. La solicitud pasa a `asignada`.

export const AceptarAsignacionDTO = z.object({
  // Ubicación del conductor al aceptar (refina ETA); opcional.
  lat_actual: z.number().optional(),
  lng_actual: z.number().optional(),
});
export type AceptarAsignacionDTO = z.infer<typeof AceptarAsignacionDTO>;

export const ResultadoAceptacion = z.discriminatedUnion('resultado', [
  z.object({
    resultado: z.literal('aceptada'),
    id_asignacion: z.number().int().positive(),
    id_solicitud: z.number().int().positive(),
    estado_solicitud: EstadoSolicitud, // esperado: 'asignada'
    pasajero: z.object({
      nombre: z.string(),
      telefono_contacto: z.string().nullable(),
      direccion_recogida: z.string(), // dirección completa recién al aceptar
    }),
  }),
  z.object({
    resultado: z.literal('ya_tomada'),
    // Mensaje UX del requisito: "La solicitud ya fue tomada".
    mensaje: z.string(),
  }),
  z.object({
    resultado: z.literal('expirada'),
    mensaje: z.string(),
  }),
]);
export type ResultadoAceptacion = z.infer<typeof ResultadoAceptacion>;

// -----------------------------------------------------------------------------
// Endpoint 2 — RECHAZAR asignación (antes de aceptar) · HU-09
// -----------------------------------------------------------------------------
// POST /assignments/:id_asignacion/rechazar
//   rol: conductor   ·   tenant: id_empresa   ·   200 ok   ·   404 no existe
//   409 ESTADO_INVALIDO (ya no está `notificada`)
// Efecto: asignación → `rechazada`, sin penalidad. Emite `asignacion_rechazada`
// → el motor pasa al siguiente candidato de la cadena (HU-08).

export const RechazarAsignacionDTO = z.object({
  motivo: z.string().max(280).optional(),
});
export type RechazarAsignacionDTO = z.infer<typeof RechazarAsignacionDTO>;

// -----------------------------------------------------------------------------
// Endpoint 3 — CANCELAR asignación (DESPUÉS de aceptar, antes de recoger) · HU-09
// -----------------------------------------------------------------------------
// POST /assignments/:id_asignacion/cancelar
//   rol: conductor   ·   tenant: id_empresa   ·   motivo OBLIGATORIO
//   200 ok   ·   404 no existe   ·   409 ESTADO_INVALIDO (no está `aceptada`)
// Efecto: asignación → `cancelada`; la solicitud VUELVE a buscar conductor
// (pendiente_de_asignacion) o `sin_conductor` si se agota. Registra el evento
// (motivo, conductor, timestamp) y notifica al pasajero.

export const CancelarAsignacionConductorDTO = z.object({
  motivo: z.string().min(3).max(280),
});
export type CancelarAsignacionConductorDTO = z.infer<typeof CancelarAsignacionConductorDTO>;

export const ResultadoCancelacionConductor = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  estado_solicitud: EstadoSolicitud, // 'pendiente_de_asignacion' o 'sin_conductor'
  rebuscando: z.boolean(),
});
export type ResultadoCancelacionConductor = z.infer<typeof ResultadoCancelacionConductor>;

// -----------------------------------------------------------------------------
// Errores tipados del dominio
// -----------------------------------------------------------------------------

export const CodigoErrorAssignment = z.enum([
  'ASIGNACION_NO_EXISTE',   // 404
  'NO_ES_EL_CONDUCTOR',     // 403 — no es el conductor notificado
  'ESTADO_INVALIDO',        // 409 — transición no permitida
  'ASIGNACION_YA_TOMADA',   // 409 — perdió la toma única
  'ASIGNACION_EXPIRADA',    // 410 — venció el countdown
  'FUERA_DE_TENANT',        // 403 — id_empresa no coincide (defensa RLS)
]);
export type CodigoErrorAssignment = z.infer<typeof CodigoErrorAssignment>;

export const ErrorAssignment = z.object({
  codigo: CodigoErrorAssignment,
  mensaje: z.string(),
});
export type ErrorAssignment = z.infer<typeof ErrorAssignment>;

// -----------------------------------------------------------------------------
// EVENTOS in-process del dominio assignment (NestJS EventEmitter — doc 11 §3.5)
// -----------------------------------------------------------------------------

export const EVENTOS_ASSIGNMENT = {
  /// emisor: assignment  ·  consumidores: notifications (push al conductor)
  ASIGNACION_CREADA: 'asignacion.creada',
  /// emisor: notifications→assignment  ·  consumidores: assignment (arma countdown)
  ASIGNACION_NOTIFICADA: 'asignacion.notificada',
  /// emisor: assignment  ·  consumidores: trips (solicitud→asignada), notifications (avisa al pasajero)
  /// Este es el `conductor_asignado` que pide el brief.
  CONDUCTOR_ASIGNADO: 'asignacion.conductor_asignado',
  /// emisor: assignment  ·  consumidores: assignment (siguiente candidato)
  ASIGNACION_RECHAZADA: 'asignacion.rechazada',
  /// emisor: assignment (scheduler del countdown)  ·  consumidores: assignment (siguiente candidato)
  ASIGNACION_EXPIRADA: 'asignacion.expirada',
  /// emisor: assignment  ·  consumidores: trips (re-buscar), notifications (avisa al pasajero)
  ASIGNACION_CANCELADA_CONDUCTOR: 'asignacion.cancelada_conductor',
} as const;
export type NombreEventoAssignment =
  (typeof EVENTOS_ASSIGNMENT)[keyof typeof EVENTOS_ASSIGNMENT];

export const AsignacionCreadaEvent = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  id_conductor: z.number().int().positive(),
  id_empresa: z.number().int().positive(),
  orden_intento: z.number().int().positive(),
  expira_en: z.string().datetime(),
  ocurrido_en: z.string().datetime(),
});
export type AsignacionCreadaEvent = z.infer<typeof AsignacionCreadaEvent>;

/// `conductor_asignado`: un conductor ganó la toma única y aceptó.
export const ConductorAsignadoEvent = z.object({
  id_solicitud: z.number().int().positive(),
  id_asignacion: z.number().int().positive(),
  id_conductor: z.number().int().positive(),
  id_taxi: z.number().int().positive(),
  id_empresa: z.number().int().positive(),
  ocurrido_en: z.string().datetime(),
});
export type ConductorAsignadoEvent = z.infer<typeof ConductorAsignadoEvent>;

export const AsignacionRechazadaEvent = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  id_conductor: z.number().int().positive(),
  motivo: z.string().nullable(),
  ocurrido_en: z.string().datetime(),
});
export type AsignacionRechazadaEvent = z.infer<typeof AsignacionRechazadaEvent>;

/// `asignacion_expirada`: venció el countdown sin respuesta → siguiente candidato.
export const AsignacionExpiradaEvent = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  id_conductor: z.number().int().positive(),
  orden_intento: z.number().int().positive(),
  ocurrido_en: z.string().datetime(),
});
export type AsignacionExpiradaEvent = z.infer<typeof AsignacionExpiradaEvent>;

export const AsignacionCanceladaConductorEvent = z.object({
  id_asignacion: z.number().int().positive(),
  id_solicitud: z.number().int().positive(),
  id_conductor: z.number().int().positive(),
  motivo: z.string(),
  ocurrido_en: z.string().datetime(),
});
export type AsignacionCanceladaConductorEvent = z.infer<
  typeof AsignacionCanceladaConductorEvent
>;
