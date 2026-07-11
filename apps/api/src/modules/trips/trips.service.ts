import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  type AsignacionCanceladaConductorEvent,
  type CancelarSolicitudDTO,
  type CotizacionRespuesta,
  type CotizarTarifaDTO,
  type CrearSolicitudDTO,
  type DesgloseTarifa,
  type EstadoSolicitud,
  type EstadoSolicitudViaje,
  EVENTOS_ASSIGNMENT,
  EVENTOS_TRIPS,
  MaquinaEstadosViaje,
  type SolicitudCancelada,
  type SolicitudCanceladaEvent,
  type SolicitudCreada,
  type SolicitudCreadaEvent,
  type SolicitudSinConductorEvent,
} from '@voyya/shared';
import type { SolicitudViaje } from '@prisma/client';
import { EnvService } from '../../config/env.service';
import { AssignmentService } from '../assignment/assignment.service';
import { calcularTarifa } from './domain/fare.calculator';
import { haversineKm } from './domain/geo';
import { estadoUIPasajero } from './domain/ui-state';
import { FESTIVOS_PROVIDER, type FestivosProvider } from './festivos/festivos.provider';
import { QuoteTokenService, type QuotePayload } from './quote-token.service';
import { TripsRepository } from './trips.repository';

const EPS = 1e-6;

/** Estados en los que la solicitud tiene un conductor asignado (para el resumen). */
const ESTADOS_CON_CONDUCTOR: readonly EstadoSolicitud[] = [
  'asignada',
  'conductor_en_camino',
  'en_curso',
];

/**
 * Dominio TRIPS: cotizar (tarifa fija) → crear (cierra tarifa) → cancelar (ventana).
 * Es el ÚNICO escritor de `solicitud_viaje`, salvo la toma única atómica del módulo
 * assignment (excepción mandada por ADR-002: conductor + asignación + solicitud en
 * una sola transacción). El resto de transiciones llegan por eventos.
 */
@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly repo: TripsRepository,
    private readonly quoteToken: QuoteTokenService,
    private readonly env: EnvService,
    private readonly emitter: EventEmitter2,
    @Inject(FESTIVOS_PROVIDER) private readonly festivos: FestivosProvider,
    private readonly assignment: AssignmentService,
  ) {}

  // ---------------------------------------------------------------------------
  // HU-04 · COTIZAR (ver tarifa fija ANTES de confirmar)
  // ---------------------------------------------------------------------------
  async cotizar(dto: CotizarTarifaDTO): Promise<CotizacionRespuesta> {
    await this.asegurarCobertura(dto.id_municipio, dto.origen, dto.destino);

    const config = await this.repo.getTarifaVigente(dto.id_municipio, dto.tipo_servicio);
    if (!config) {
      throw new ConflictException({
        codigo: 'TARIFA_NO_CONFIGURADA',
        mensaje: 'No hay tarifa vigente para este municipio/servicio',
      });
    }

    const distanciaKm = redondear3(haversineKm(dto.origen, dto.destino));
    const tarifa = calcularTarifa(
      {
        tarifaBase: Number(config.tarifa_base),
        recargoNocturnoPct: Number(config.recargo_nocturno_pct),
        recargoFestivoPct: Number(config.recargo_festivo_pct),
        comisionPct: Number(config.comision_pct),
      },
      { fecha: new Date() },
      this.festivos,
    );

    const cotizacion_token = this.quoteToken.firmar({
      id_municipio: dto.id_municipio,
      tipo_servicio: dto.tipo_servicio,
      origen: { lat: dto.origen.lat, lng: dto.origen.lng },
      destino: { lat: dto.destino.lat, lng: dto.destino.lng },
      distancia_km: distanciaKm,
      tarifa,
    });

    return {
      dentro_cobertura: true,
      tipo_servicio: dto.tipo_servicio,
      metodo_pago: 'efectivo',
      tarifa,
      distancia_km: distanciaKm,
      // ETA null en la cotización: aún no hay conductor asignado (ADR-003).
      eta: null,
      cotizacion_token,
    };
  }

  // ---------------------------------------------------------------------------
  // HU-04 · CREAR (cierra la tarifa exactamente como se cotizó)
  // ---------------------------------------------------------------------------
  async crear(dto: CrearSolicitudDTO, idCliente: number): Promise<SolicitudCreada> {
    const verificacion = this.quoteToken.verificar(dto.cotizacion_token);
    if (!verificacion.ok) {
      if (verificacion.razon === 'expirado') {
        throw new GoneException({
          codigo: 'COTIZACION_EXPIRADA',
          mensaje: 'La cotización venció, vuelve a cotizar',
        });
      }
      throw new BadRequestException({
        codigo: 'DATOS_INVALIDOS',
        mensaje: 'cotizacion_token inválido',
      });
    }

    const payload = verificacion.payload;
    if (!this.tokenCoincideConDto(payload, dto)) {
      throw new BadRequestException({
        codigo: 'DATOS_INVALIDOS',
        mensaje: 'La cotización no corresponde a la solicitud enviada',
      });
    }

    // P1.2: revalida cobertura al CREAR (no solo en cotizar) → 409 FUERA_DE_COBERTURA.
    await this.asegurarCobertura(dto.id_municipio, dto.origen, dto.destino);

    // Idempotencia: un pasajero no puede tener dos solicitudes vivas a la vez.
    if (await this.repo.existeSolicitudActiva(idCliente)) {
      throw new ConflictException({
        codigo: 'SOLICITUD_ACTIVA_EXISTENTE',
        mensaje: 'Ya tienes una solicitud en curso',
      });
    }

    const solicitud = await this.repo.crearSolicitud({
      idCliente,
      idMunicipio: dto.id_municipio,
      tipoServicio: dto.tipo_servicio,
      metodoPago: 'efectivo',
      direccionRecogida: dto.origen.direccion,
      direccionDestino: dto.destino.direccion,
      latRecogida: dto.origen.lat,
      lngRecogida: dto.origen.lng,
      latDestino: dto.destino.lat,
      lngDestino: dto.destino.lng,
      distanciaKm: payload.distancia_km,
      // Tarifa CERRADA: se persiste el total y la comisión firmados en la cotización.
      tarifaTotal: payload.tarifa.total,
      comision: payload.tarifa.comision,
    });

    this.emitirSolicitudCreada(solicitud);

    return {
      id_solicitud: solicitud.id_solicitud,
      estado: 'pendiente_de_asignacion',
      tipo_servicio: dto.tipo_servicio,
      metodo_pago: 'efectivo',
      tarifa: payload.tarifa,
      fecha_hora_solicitud: solicitud.fecha_hora_solicitud.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // HU-05 · CANCELAR (pasajero)
  // ---------------------------------------------------------------------------
  async cancelar(
    idSolicitud: number,
    idCliente: number,
    _dto: CancelarSolicitudDTO,
  ): Promise<SolicitudCancelada> {
    const solicitud = await this.repo.getSolicitud(idSolicitud);
    if (!solicitud) {
      throw new NotFoundException({
        codigo: 'SOLICITUD_NO_EXISTE',
        mensaje: 'La solicitud no existe',
      });
    }
    if (solicitud.id_cliente !== idCliente) {
      throw new ForbiddenException({ codigo: 'NO_ES_DUENO', mensaje: 'No eres el dueño' });
    }

    if (!MaquinaEstadosViaje.solicitud.puede(solicitud.estado, 'cancelada_cliente')) {
      throw new ConflictException({
        codigo: 'ESTADO_NO_CANCELABLE',
        mensaje: 'La solicitud ya no se puede cancelar',
      });
    }

    // Ventana gratuita (HU-05): pendiente = siempre gratis; asignada = ≤ ventana min.
    const ventanaMin = this.env.get('VENTANA_CANCELACION_MIN');
    let gratuita = true;
    if (solicitud.estado !== 'pendiente_de_asignacion') {
      // R-03: la ventana gratuita se mide desde la ACEPTACIÓN (asignada_en), no
      // desde el último update. Fallback defensivo a actualizado_en si faltara.
      const referencia = solicitud.asignada_en ?? solicitud.actualizado_en;
      const minutos = minutosDesde(referencia);
      gratuita = minutos <= ventanaMin;
    }
    const penalidad_registrada = !gratuita; // se REGISTRA, no se cobra (efectivo · MVP)

    await this.repo.actualizarEstado(idSolicitud, 'cancelada_cliente');

    // assignment reacciona: libera al conductor / detiene la cadena.
    const evento: SolicitudCanceladaEvent = {
      id_solicitud: idSolicitud,
      cancelada_por: 'pasajero',
      id_conductor_liberado: null,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_TRIPS.SOLICITUD_CANCELADA, evento);

    if (penalidad_registrada) {
      this.logger.warn(
        `Penalidad registrada (no cobrada) por cancelación tardía solicitud=${idSolicitud}`,
      );
    }

    return {
      id_solicitud: idSolicitud,
      estado: 'cancelada_cliente',
      gratuita,
      penalidad_registrada,
      cancelada_en: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // P1.1 · GET /trips/:id — estado del viaje para el pasajero DUEÑO
  // ---------------------------------------------------------------------------
  async obtenerEstado(idSolicitud: number, idCliente: number): Promise<EstadoSolicitudViaje> {
    const s = await this.repo.getSolicitud(idSolicitud);
    if (!s) {
      throw new NotFoundException({
        codigo: 'SOLICITUD_NO_EXISTE',
        mensaje: 'La solicitud no existe',
      });
    }
    if (s.id_cliente !== idCliente) {
      throw new ForbiddenException({ codigo: 'NO_ES_DUENO', mensaje: 'No eres el dueño' });
    }

    const conConductor = ESTADOS_CON_CONDUCTOR.includes(s.estado);
    const conductor = conConductor
      ? await this.assignment.getResumenConductorAsignado(idSolicitud)
      : null;

    return {
      id_solicitud: s.id_solicitud,
      estado: s.estado,
      ui: estadoUIPasajero(s.estado),
      tarifa: await this.reconstruirTarifa(s),
      conductor,
      actualizado_en: s.actualizado_en.toISOString(),
    };
  }

  /**
   * Reconstruye el desglose de tarifa (el modelo persiste total + comisión). El total
   * es SIEMPRE el CERRADO al confirmar; los recargos se recalculan de forma determinista
   * desde la config vigente y la fecha de la solicitud. Si hay drift de config, degrada
   * a una representación plana anclada al total.
   */
  private async reconstruirTarifa(s: SolicitudViaje): Promise<DesgloseTarifa> {
    const total = Number(s.tarifa);
    const comision = Number(s.comision);
    const config = await this.repo.getTarifaVigente(s.id_municipio, s.tipo_servicio);
    if (config) {
      const d = calcularTarifa(
        {
          tarifaBase: Number(config.tarifa_base),
          recargoNocturnoPct: Number(config.recargo_nocturno_pct),
          recargoFestivoPct: Number(config.recargo_festivo_pct),
          comisionPct: Number(config.comision_pct),
        },
        { fecha: s.fecha_hora_solicitud },
        this.festivos,
      );
      if (d.total === total) return { ...d, comision };
    }
    return {
      tarifa_base: total,
      recargo_nocturno: 0,
      recargo_festivo: 0,
      total,
      comision,
      moneda: 'COP',
    };
  }

  // ---------------------------------------------------------------------------
  // Reacciones a eventos del motor (trips = único escritor de solicitud_viaje)
  // ---------------------------------------------------------------------------

  /** Cadena agotada → la solicitud pasa a `sin_conductor`. */
  @OnEvent(EVENTOS_TRIPS.SOLICITUD_SIN_CONDUCTOR)
  async onSinConductor(ev: SolicitudSinConductorEvent): Promise<void> {
    await this.transicionar(ev.id_solicitud, 'sin_conductor');
  }

  /** Conductor canceló tras aceptar (HU-09) → reabrir y relanzar el motor. */
  @OnEvent(EVENTOS_ASSIGNMENT.ASIGNACION_CANCELADA_CONDUCTOR)
  async onCanceladaConductor(ev: AsignacionCanceladaConductorEvent): Promise<void> {
    const solicitud = await this.repo.getSolicitud(ev.id_solicitud);
    if (!solicitud) return;
    if (!MaquinaEstadosViaje.solicitud.puede(solicitud.estado, 'pendiente_de_asignacion')) {
      return;
    }
    await this.repo.actualizarEstado(ev.id_solicitud, 'pendiente_de_asignacion');
    // Reusa el evento canónico de creación para relanzar nearest-first.
    this.emitirSolicitudCreada({ ...solicitud, estado: 'pendiente_de_asignacion' });
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private async transicionar(
    idSolicitud: number,
    hacia: Parameters<typeof MaquinaEstadosViaje.solicitud.assert>[1],
  ): Promise<void> {
    const solicitud = await this.repo.getSolicitud(idSolicitud);
    if (!solicitud) return;
    if (!MaquinaEstadosViaje.solicitud.puede(solicitud.estado, hacia)) {
      this.logger.warn(
        `Transición ignorada solicitud=${idSolicitud}: ${solicitud.estado} → ${hacia}`,
      );
      return;
    }
    await this.repo.actualizarEstado(idSolicitud, hacia);
  }

  private emitirSolicitudCreada(solicitud: SolicitudViaje): void {
    const evento: SolicitudCreadaEvent = {
      id_solicitud: solicitud.id_solicitud,
      id_cliente: solicitud.id_cliente,
      id_municipio: solicitud.id_municipio,
      tipo_servicio: solicitud.tipo_servicio,
      origen: { lat: solicitud.lat_recogida, lng: solicitud.lng_recogida },
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_TRIPS.SOLICITUD_CREADA, evento);
  }

  private async asegurarCobertura(
    idMunicipio: number,
    origen: { lat: number; lng: number },
    destino: { lat: number; lng: number },
  ): Promise<void> {
    const [origenOk, destinoOk] = await Promise.all([
      this.repo.puntoDentroDeCobertura(idMunicipio, origen.lng, origen.lat),
      this.repo.puntoDentroDeCobertura(idMunicipio, destino.lng, destino.lat),
    ]);
    if (!origenOk || !destinoOk) {
      throw new ConflictException({
        codigo: 'FUERA_DE_COBERTURA',
        mensaje: 'El origen o el destino está fuera del área de cobertura',
      });
    }
  }

  private tokenCoincideConDto(payload: QuotePayload, dto: CrearSolicitudDTO): boolean {
    return (
      payload.id_municipio === dto.id_municipio &&
      payload.tipo_servicio === dto.tipo_servicio &&
      casiIgual(payload.origen.lat, dto.origen.lat) &&
      casiIgual(payload.origen.lng, dto.origen.lng) &&
      casiIgual(payload.destino.lat, dto.destino.lat) &&
      casiIgual(payload.destino.lng, dto.destino.lng)
    );
  }
}

function casiIgual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
function redondear3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function minutosDesde(fecha: Date): number {
  return (Date.now() - fecha.getTime()) / 60000;
}
