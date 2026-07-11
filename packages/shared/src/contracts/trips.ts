// =============================================================================
// VoyYa — Contrato compartido · Dominio TRIPS (solicitud de viaje)
// -----------------------------------------------------------------------------
// Fase Diseñar (ASDD) · Agente `arquitectura` · skill `arquitectura-contrato-api`
// Fuente ÚNICA de verdad para backend (NestJS) y frontend (Expo/Vite). Validación
// con Zod en ambos lados. Sin `any`. Los valores de enum COINCIDEN 1:1 con
// prisma/schema.prisma.
//
// Cubre: cotizar tarifa, crear solicitud, cancelar solicitud (pasajero) y los
// eventos in-process (NestJS EventEmitter — NO Kafka/RabbitMQ/Redis en MVP).
// La aceptación/rechazo/cancelación del conductor viven en ./assignment.
//
// Alcance MVP (regla de oro): taxi · efectivo · 1 empresa · 1 municipio.
// Los enums quedan completos para EV1+ sin migración.
// =============================================================================

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Catálogos (enums espejo de Prisma)
// -----------------------------------------------------------------------------

export const TipoServicio = z.enum(['taxi', 'moto', 'confort', 'envio']);
export type TipoServicio = z.infer<typeof TipoServicio>;

export const MetodoPago = z.enum(['efectivo', 'nequi', 'daviplata', 'tarjeta']);
export type MetodoPago = z.infer<typeof MetodoPago>;

// -----------------------------------------------------------------------------
// Máquina de estados de la SOLICITUD (doc 11 §2.3) — fuente de verdad compartida
// -----------------------------------------------------------------------------

export const EstadoSolicitud = z.enum([
  'pendiente_de_asignacion',
  'asignada',
  'conductor_en_camino',
  'en_curso',
  'completada',
  'cancelada_cliente',
  'cancelada_conductor',
  'sin_conductor',
  'no_show',
  'expirada',
]);
export type EstadoSolicitud = z.infer<typeof EstadoSolicitud>;

/// Transiciones válidas. Alcance de ESTE feature: hasta `en_curso`. Los estados
/// terminales del ciclo siguiente se dejan por completitud (fuente de verdad).
export const TRANSICIONES_SOLICITUD = {
  pendiente_de_asignacion: ['asignada', 'sin_conductor', 'cancelada_cliente', 'expirada'],
  asignada: ['conductor_en_camino', 'pendiente_de_asignacion', 'cancelada_cliente', 'cancelada_conductor'],
  conductor_en_camino: ['en_curso', 'cancelada_cliente', 'cancelada_conductor', 'no_show'],
  en_curso: ['completada'],
  completada: [],
  cancelada_cliente: [],
  cancelada_conductor: [],
  sin_conductor: [],
  no_show: [],
  expirada: [],
} as const satisfies Record<EstadoSolicitud, readonly EstadoSolicitud[]>;

export function puedeTransicionarSolicitud(
  desde: EstadoSolicitud,
  hacia: EstadoSolicitud,
): boolean {
  return (TRANSICIONES_SOLICITUD[desde] as readonly EstadoSolicitud[]).includes(hacia);
}

/// Estados de la UI del pasajero (bordes de pantalla — no son estados de DB).
/// Derivados del estado de la solicitud + condiciones del cliente.
export const EstadoUIPasajero = z.enum([
  'calculando_tarifa', // cotizando antes de confirmar
  'buscando',          // pendiente_de_asignacion / retry chain en curso
  'conductor_asignado',
  'sin_conductor',     // cadena agotada
  'fuera_de_cobertura',
  'sin_conexion',
]);
export type EstadoUIPasajero = z.infer<typeof EstadoUIPasajero>;

// -----------------------------------------------------------------------------
// Tipos base reutilizables
// -----------------------------------------------------------------------------

/// Coordenada WGS84. Rango de Colombia acotado para atrapar lat/lng invertidos.
export const Coordenada = z.object({
  lat: z.number().min(-4.5).max(16),
  lng: z.number().min(-82).max(-66),
});
export type Coordenada = z.infer<typeof Coordenada>;

export const Ubicacion = Coordenada.extend({
  direccion: z.string().min(3).max(255),
});
export type Ubicacion = z.infer<typeof Ubicacion>;

/// Montos en COP, pesos ENTEROS (en DB son Decimal; sobre el cable van como number).
const MontoCOP = z.number().int().nonnegative();

/// Desglose de la tarifa fija (transparencia: "sin cargos ocultos", doc 11 §1.3).
export const DesgloseTarifa = z.object({
  tarifa_base: MontoCOP,
  recargo_nocturno: MontoCOP, // 0 si no aplica
  recargo_festivo: MontoCOP,  // 0 si no aplica
  total: MontoCOP,            // lo que ve y paga el pasajero
  comision: MontoCOP,         // registrada, NO cobrada en MVP (informativa)
  moneda: z.literal('COP'),
});
export type DesgloseTarifa = z.infer<typeof DesgloseTarifa>;

/// ETA estático mostrado como RANGO, nunca exacto (ADR-003).
export const EtaEstimado = z.object({
  min_minutos: z.number().int().nonnegative(),
  max_minutos: z.number().int().nonnegative(),
  es_estimado: z.literal(true), // recuerda al front que NO es GPS en vivo
});
export type EtaEstimado = z.infer<typeof EtaEstimado>;

// -----------------------------------------------------------------------------
// Endpoint 1 — COTIZAR tarifa (ver la tarifa fija ANTES de confirmar) · HU-04
// -----------------------------------------------------------------------------
// POST /trips/cotizar
//   rol: pasajero   ·   tenant: N/A (solicitud global; se valida cobertura del municipio)
//   200 Cotizacion   ·   400 datos inválidos   ·   409 FUERA_DE_COBERTURA
// El servidor calcula la tarifa (NUNCA se confía en un precio del cliente).

export const CotizarTarifaDTO = z.object({
  origen: Ubicacion,
  destino: Ubicacion,
  id_municipio: z.number().int().positive(),
  tipo_servicio: TipoServicio.default('taxi'),
});
export type CotizarTarifaDTO = z.infer<typeof CotizarTarifaDTO>;

export const CotizacionRespuesta = z.object({
  dentro_cobertura: z.literal(true),
  tipo_servicio: TipoServicio,
  metodo_pago: z.literal('efectivo'), // MVP
  tarifa: DesgloseTarifa,
  distancia_km: z.number().nonnegative(),
  eta: EtaEstimado.nullable(), // null si aún no hay conductores en turno
  // Token opaco que congela la cotización; se envía al crear para cerrar la
  // tarifa exactamente como se mostró (evita recálculo divergente). TTL corto.
  cotizacion_token: z.string().min(1),
});
export type CotizacionRespuesta = z.infer<typeof CotizacionRespuesta>;

// -----------------------------------------------------------------------------
// Endpoint 2 — CREAR solicitud · HU-04
// -----------------------------------------------------------------------------
// POST /trips
//   rol: pasajero   ·   tenant: N/A (global)
//   201 SolicitudCreada   ·   400 inválido   ·   401 no autenticado
//   409 FUERA_DE_COBERTURA   ·   409 SOLICITUD_ACTIVA_EXISTENTE   ·   410 COTIZACION_EXPIRADA
// Efecto: crea la solicitud en `pendiente_de_asignacion` y dispara el evento
// `solicitud_creada` (lo consume el módulo assignment para arrancar nearest-first).

export const CrearSolicitudDTO = z.object({
  origen: Ubicacion,
  destino: Ubicacion,
  id_municipio: z.number().int().positive(),
  tipo_servicio: TipoServicio.default('taxi'),
  metodo_pago: MetodoPago.default('efectivo'),
  // Reutiliza la cotización mostrada; el back revalida y cierra ese precio.
  cotizacion_token: z.string().min(1),
});
export type CrearSolicitudDTO = z.infer<typeof CrearSolicitudDTO>;

export const SolicitudCreada = z.object({
  id_solicitud: z.number().int().positive(),
  estado: EstadoSolicitud, // esperado: 'pendiente_de_asignacion'
  tipo_servicio: TipoServicio,
  metodo_pago: MetodoPago,
  tarifa: DesgloseTarifa, // precio CERRADO al confirmar (no cambia)
  fecha_hora_solicitud: z.string().datetime(),
});
export type SolicitudCreada = z.infer<typeof SolicitudCreada>;

// -----------------------------------------------------------------------------
// Endpoint 3 — CANCELAR solicitud (pasajero) · HU-05
// -----------------------------------------------------------------------------
// POST /trips/:id_solicitud/cancelar
//   rol: pasajero (dueño de la solicitud)   ·   tenant: N/A
//   200 SolicitudCancelada   ·   403 no es el dueño   ·   404 no existe
//   409 ESTADO_NO_CANCELABLE (ya en_curso/completada)
// Reglas (parámetro ventana_cancelacion_min = 2):
//   - pendiente_de_asignacion  → cancelada_cliente, sin costo.
//   - asignada ≤ 2 min          → gratuita; el conductor vuelve a `disponible`.
//   - asignada > 2 min          → penalidad REGISTRADA (no se cobra en MVP, efectivo).
// Emite `solicitud_cancelada` (assignment libera al conductor / detiene la cadena).

export const CancelarSolicitudDTO = z.object({
  motivo: z.string().max(280).optional(),
});
export type CancelarSolicitudDTO = z.infer<typeof CancelarSolicitudDTO>;

export const SolicitudCancelada = z.object({
  id_solicitud: z.number().int().positive(),
  estado: z.literal('cancelada_cliente'),
  gratuita: z.boolean(),
  penalidad_registrada: z.boolean(), // true si fue fuera de ventana (no cobrada)
  cancelada_en: z.string().datetime(),
});
export type SolicitudCancelada = z.infer<typeof SolicitudCancelada>;

// -----------------------------------------------------------------------------
// Estado en vivo de la solicitud (para el pasajero: polling GET o push por socket)
// -----------------------------------------------------------------------------
// GET /trips/:id_solicitud   ·   rol: pasajero dueño   ·   200 EstadoSolicitudViaje
// El campo `conductor` llega solo cuando estado ∈ {asignada, conductor_en_camino, en_curso}.

export const ConductorAsignadoResumen = z.object({
  nombre: z.string(),
  placa: z.string(),
  modelo: z.string().nullable(),
  telefono_contacto: z.string().nullable(), // botón "Llamar" (número intermediario)
  eta: EtaEstimado.nullable(),
});
export type ConductorAsignadoResumen = z.infer<typeof ConductorAsignadoResumen>;

export const EstadoSolicitudViaje = z.object({
  id_solicitud: z.number().int().positive(),
  estado: EstadoSolicitud,
  ui: EstadoUIPasajero,
  tarifa: DesgloseTarifa,
  conductor: ConductorAsignadoResumen.nullable(),
  actualizado_en: z.string().datetime(),
});
export type EstadoSolicitudViaje = z.infer<typeof EstadoSolicitudViaje>;

// -----------------------------------------------------------------------------
// Errores tipados del dominio (consistentes back↔front)
// -----------------------------------------------------------------------------

export const CodigoErrorTrips = z.enum([
  'FUERA_DE_COBERTURA',        // 409 — origen/destino fuera del polígono
  'COTIZACION_EXPIRADA',       // 410 — cotizacion_token vencido → recotizar
  'SOLICITUD_ACTIVA_EXISTENTE',// 409 — el pasajero ya tiene una solicitud viva
  'ESTADO_NO_CANCELABLE',      // 409 — ya en_curso/completada
  'NO_ES_DUENO',               // 403
  'SOLICITUD_NO_EXISTE',       // 404
  'TARIFA_NO_CONFIGURADA',     // 409 — no hay ConfiguracionTarifa vigente
]);
export type CodigoErrorTrips = z.infer<typeof CodigoErrorTrips>;

export const ErrorTrips = z.object({
  codigo: CodigoErrorTrips,
  mensaje: z.string(),
});
export type ErrorTrips = z.infer<typeof ErrorTrips>;

// -----------------------------------------------------------------------------
// EVENTOS in-process del dominio trips (NestJS EventEmitter — doc 11 §3.5)
// -----------------------------------------------------------------------------
// Nombre estable + payload tipado. `emisor` produce, `consumidores` reaccionan.

export const EVENTOS_TRIPS = {
  /// emisor: trips  ·  consumidores: assignment (arranca nearest-first), notifications
  SOLICITUD_CREADA: 'solicitud.creada',
  /// emisor: trips  ·  consumidores: assignment (libera conductor/para la cadena), notifications
  SOLICITUD_CANCELADA: 'solicitud.cancelada',
  /// emisor: assignment→trips  ·  consumidores: notifications (avisa al pasajero), admin (alerta cola)
  SOLICITUD_SIN_CONDUCTOR: 'solicitud.sin_conductor',
  /// emisor: trips (scheduler)  ·  consumidores: assignment (aborta), notifications
  SOLICITUD_EXPIRADA: 'solicitud.expirada',
} as const;
export type NombreEventoTrips = (typeof EVENTOS_TRIPS)[keyof typeof EVENTOS_TRIPS];

export const SolicitudCreadaEvent = z.object({
  id_solicitud: z.number().int().positive(),
  id_cliente: z.number().int().positive(),
  id_municipio: z.number().int().positive(),
  tipo_servicio: TipoServicio,
  origen: Coordenada,
  ocurrido_en: z.string().datetime(),
});
export type SolicitudCreadaEvent = z.infer<typeof SolicitudCreadaEvent>;

export const SolicitudCanceladaEvent = z.object({
  id_solicitud: z.number().int().positive(),
  cancelada_por: z.literal('pasajero'),
  id_conductor_liberado: z.number().int().positive().nullable(),
  ocurrido_en: z.string().datetime(),
});
export type SolicitudCanceladaEvent = z.infer<typeof SolicitudCanceladaEvent>;

export const SolicitudSinConductorEvent = z.object({
  id_solicitud: z.number().int().positive(),
  intentos_realizados: z.number().int().nonnegative(),
  radio_final_km: z.number().positive(),
  ocurrido_en: z.string().datetime(),
});
export type SolicitudSinConductorEvent = z.infer<typeof SolicitudSinConductorEvent>;

export const SolicitudExpiradaEvent = z.object({
  id_solicitud: z.number().int().positive(),
  ocurrido_en: z.string().datetime(),
});
export type SolicitudExpiradaEvent = z.infer<typeof SolicitudExpiradaEvent>;
