import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  type AceptarAsignacionDTO,
  type AsignacionCanceladaConductorEvent,
  type AsignacionCreadaEvent,
  type AsignacionExpiradaEvent,
  type AsignacionRechazadaEvent,
  type CancelarAsignacionConductorDTO,
  type ConductorAsignadoEvent,
  type ConductorAsignadoResumen,
  EVENTOS_ASSIGNMENT,
  EVENTOS_TRIPS,
  type NotificacionAsignacion,
  type RechazarAsignacionDTO,
  type ResultadoAceptacion,
  type ResultadoCancelacionConductor,
  type SolicitudCanceladaEvent,
  type SolicitudCreadaEvent,
  type SolicitudSinConductorEvent,
} from '@voyya/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AssignmentParamsService,
  type ParametrosAsignacion,
} from './assignment-params.service';
import { AssignmentRepository, type SolicitudInfo } from './assignment.repository';
import { CandidateRepository } from './candidate.repository';
import { PUSH_PROVIDER, type PushProvider } from './ports/push-provider.port';
// Utilidad geográfica pura (sin estado): ETA estático (ADR-003), reutilizada (DRY).
import { calcularEta, haversineKm } from '../trips/domain/geo';

/** Se lanza dentro de la transacción de toma para forzar ROLLBACK (perdió la carrera). */
export class SolicitudYaTomadaError extends Error {
  constructor() {
    super('La solicitud ya fue tomada');
    this.name = 'SolicitudYaTomadaError';
  }
}

interface ContextoCadena {
  idSolicitud: number;
  idEmpresa: number;
  idMunicipio: number;
  origen: { lat: number; lng: number };
  info: SolicitudInfo;
  params: ParametrosAsignacion;
  intentados: Set<number>;
  orden: number;
  expandido: boolean;
  asignacionActual: number | null;
}

/**
 * Motor de asignación (ADR-001 · ADR-002). Orquesta nearest-first + retry chain +
 * TOMA ÚNICA ATÓMICA. In-process (EventEmitter, sin broker). Responsabilidad única:
 * emparejar; NO envía notificaciones (delega en PushProvider) ni calcula tarifa.
 *
 * Estado de cadena/timers en memoria (KISS para instancia única del MVP). EV1 con N
 * instancias: migrar a @nestjs/schedule + advisory lock de PostgreSQL (doc 14 §3).
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);
  private readonly cadenas = new Map<number, ContextoCadena>();
  private readonly timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateRepo: CandidateRepository,
    private readonly repo: AssignmentRepository,
    private readonly paramsService: AssignmentParamsService,
    private readonly emitter: EventEmitter2,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  // ===========================================================================
  // Disparo del motor (evento de trips)
  // ===========================================================================
  @OnEvent(EVENTOS_TRIPS.SOLICITUD_CREADA)
  async onSolicitudCreada(ev: SolicitudCreadaEvent): Promise<void> {
    try {
      await this.iniciar(ev.id_solicitud, ev.id_municipio, ev.origen);
    } catch (e) {
      this.logger.error(`Fallo iniciando asignación solicitud=${ev.id_solicitud}: ${msg(e)}`);
    }
  }

  private async iniciar(
    idSolicitud: number,
    idMunicipio: number,
    origen: { lat: number; lng: number },
  ): Promise<void> {
    const info = await this.repo.getSolicitudInfo(idSolicitud);
    if (!info || info.estado !== 'pendiente_de_asignacion') return;

    const idEmpresa = await this.repo.resolveEmpresaActiva(idMunicipio);
    if (idEmpresa === null) {
      this.logger.warn(`Sin empresa activa en municipio=${idMunicipio}`);
      this.emitirSinConductor(idSolicitud, 0, 0);
      return;
    }

    const params = await this.paramsService.obtener(idMunicipio);
    const ctx: ContextoCadena = {
      idSolicitud,
      idEmpresa,
      idMunicipio,
      origen,
      info,
      params,
      intentados: new Set<number>(),
      orden: 0,
      expandido: false,
      asignacionActual: null,
    };
    this.cadenas.set(idSolicitud, ctx);
    await this.intentarSiguiente(ctx);
  }

  // ===========================================================================
  // Retry chain (nearest-first)
  // ===========================================================================
  private async intentarSiguiente(ctx: ContextoCadena): Promise<void> {
    if (ctx.orden >= ctx.params.maxReintentos) {
      return this.finalizarSinConductor(ctx);
    }

    const radioKm = ctx.expandido ? ctx.params.radioExpansionKm : ctx.params.radioBusquedaKm;
    const candidatos = await this.prisma.runInTenant(ctx.idEmpresa, (tx) =>
      this.candidateRepo.findCandidates(tx, {
        idEmpresa: ctx.idEmpresa,
        lat: ctx.origen.lat,
        lng: ctx.origen.lng,
        radioKm,
        ventanaDesempateHoras: ctx.params.ventanaDesempateHoras,
        limite: 1,
        excluir: [...ctx.intentados],
      }),
    );

    const cand = candidatos[0];
    if (!cand) {
      if (!ctx.expandido) {
        ctx.expandido = true;
        return this.intentarSiguiente(ctx);
      }
      return this.finalizarSinConductor(ctx);
    }

    ctx.orden += 1;
    ctx.intentados.add(cand.idConductor);

    const expiraEn = new Date(Date.now() + ctx.params.timeoutAceptacionSeg * 1000);
    const asignacion = await this.prisma.runInTenant(ctx.idEmpresa, (tx) =>
      this.repo.crearAsignacionNotificada(tx, {
        idSolicitud: ctx.idSolicitud,
        idConductor: cand.idConductor,
        idTaxi: cand.idTaxi,
        idEmpresa: ctx.idEmpresa,
        ordenIntento: ctx.orden,
        expiraEn,
      }),
    );
    ctx.asignacionActual = asignacion.id_asignacion;

    const notificacion: NotificacionAsignacion = {
      id_asignacion: asignacion.id_asignacion,
      id_solicitud: ctx.idSolicitud,
      origen: {
        direccion: ctx.info.direccion_recogida,
        lat: ctx.origen.lat,
        lng: ctx.origen.lng,
      },
      destino_barrio: barrioDe(ctx.info.direccion_destino),
      tarifa_total: Math.round(ctx.info.tarifa),
      distancia_al_origen_m: Math.round(cand.distanciaM),
      expira_en: expiraEn.toISOString(),
      segundos_para_responder: ctx.params.timeoutAceptacionSeg,
    };
    await this.push.enviarAsignacion({ idConductor: cand.idConductor }, notificacion);

    const creado: AsignacionCreadaEvent = {
      id_asignacion: asignacion.id_asignacion,
      id_solicitud: ctx.idSolicitud,
      id_conductor: cand.idConductor,
      id_empresa: ctx.idEmpresa,
      orden_intento: ctx.orden,
      expira_en: expiraEn.toISOString(),
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_ASSIGNMENT.ASIGNACION_CREADA, creado);

    this.armarTimeout(asignacion.id_asignacion, ctx.idSolicitud, ctx.params.timeoutAceptacionSeg);
  }

  private finalizarSinConductor(ctx: ContextoCadena): void {
    this.cadenas.delete(ctx.idSolicitud);
    const radioFinal = ctx.expandido ? ctx.params.radioExpansionKm : ctx.params.radioBusquedaKm;
    this.emitirSinConductor(ctx.idSolicitud, ctx.orden, radioFinal);
  }

  private emitirSinConductor(
    idSolicitud: number,
    intentos: number,
    radioFinalKm: number,
  ): void {
    const ev: SolicitudSinConductorEvent = {
      id_solicitud: idSolicitud,
      intentos_realizados: intentos,
      radio_final_km: radioFinalKm > 0 ? radioFinalKm : 1,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_TRIPS.SOLICITUD_SIN_CONDUCTOR, ev);
  }

  // ===========================================================================
  // Countdown (timeout de aceptación)
  // ===========================================================================
  private armarTimeout(idAsignacion: number, idSolicitud: number, segundos: number): void {
    const t = setTimeout(() => {
      void this.manejarExpiracion(idAsignacion, idSolicitud);
    }, segundos * 1000);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(idAsignacion, t);
  }

  private limpiarTimer(idAsignacion: number): void {
    const t = this.timers.get(idAsignacion);
    if (t) {
      clearTimeout(t);
      this.timers.delete(idAsignacion);
    }
  }

  private async manejarExpiracion(idAsignacion: number, idSolicitud: number): Promise<void> {
    this.limpiarTimer(idAsignacion);
    const ctx = this.cadenas.get(idSolicitud);
    if (!ctx) return;
    try {
      const expiro = await this.prisma.runInTenant(ctx.idEmpresa, (tx) =>
        this.repo.marcarTimeout(tx, idAsignacion, ctx.idEmpresa),
      );
      if (!expiro) return; // ya fue aceptada/rechazada

      const ev: AsignacionExpiradaEvent = {
        id_asignacion: idAsignacion,
        id_solicitud: idSolicitud,
        id_conductor: 0,
        orden_intento: ctx.orden,
        ocurrido_en: new Date().toISOString(),
      };
      this.emitter.emit(EVENTOS_ASSIGNMENT.ASIGNACION_EXPIRADA, ev);
      await this.intentarSiguiente(ctx);
    } catch (e) {
      this.logger.error(`Fallo en expiración asignacion=${idAsignacion}: ${msg(e)}`);
    }
  }

  // ===========================================================================
  // ACEPTAR — TOMA ÚNICA ATÓMICA (HU-08 · ADR-002)  ← el corazón del sistema
  // ===========================================================================
  async aceptar(
    idAsignacion: number,
    idConductor: number,
    idEmpresa: number,
    _dto: AceptarAsignacionDTO,
  ): Promise<ResultadoAceptacion> {
    type R =
      | { tipo: 'no_existe' }
      | { tipo: 'no_conductor' }
      | { tipo: 'expirada' }
      | { tipo: 'ya_tomada' }
      | { tipo: 'aceptada'; idSolicitud: number };

    let resultado: R;
    try {
      resultado = await this.prisma.runInTenant<R>(idEmpresa, async (tx) => {
        const asig = await this.repo.getAsignacion(tx, idAsignacion, idEmpresa);
        if (!asig) return { tipo: 'no_existe' };
        if (asig.id_conductor !== idConductor) return { tipo: 'no_conductor' };

        const expirada = asig.expira_en !== null && asig.expira_en.getTime() < Date.now();
        if (asig.estado === 'timeout' || (expirada && asig.estado === 'notificada')) {
          return { tipo: 'expirada' };
        }
        if (asig.estado !== 'notificada') return { tipo: 'ya_tomada' };

        // BARRERA 1 (recurso escaso = conductor): 0 filas ⇒ perdió la carrera.
        const tomado = await this.repo.tomarConductor(tx, idConductor, idEmpresa);
        if (!tomado) return { tipo: 'ya_tomada' };

        // BARRERA 2 (índice único parcial): una sola asignación 'aceptada' / solicitud.
        const aceptOk = await this.repo.marcarAsignacionAceptada(tx, idAsignacion, idEmpresa);
        if (!aceptOk) throw new SolicitudYaTomadaError();
        const asignada = await this.repo.marcarSolicitudAsignada(tx, asig.id_solicitud);
        if (!asignada) throw new SolicitudYaTomadaError(); // ROLLBACK libera al conductor

        return { tipo: 'aceptada', idSolicitud: asig.id_solicitud };
      });
    } catch (e) {
      if (e instanceof SolicitudYaTomadaError) return this.respYaTomada();
      throw e;
    }

    switch (resultado.tipo) {
      case 'no_existe':
        throw new NotFoundException({
          codigo: 'ASIGNACION_NO_EXISTE',
          mensaje: 'La asignación no existe',
        });
      case 'no_conductor':
        throw new ForbiddenException({
          codigo: 'NO_ES_EL_CONDUCTOR',
          mensaje: 'No eres el conductor notificado',
        });
      case 'expirada':
        return { resultado: 'expirada', mensaje: 'El tiempo para aceptar venció' };
      case 'ya_tomada':
        return this.respYaTomada();
      case 'aceptada':
        return this.finalizarAceptacion(idAsignacion, idConductor, idEmpresa, resultado.idSolicitud);
    }
  }

  private async finalizarAceptacion(
    idAsignacion: number,
    idConductor: number,
    idEmpresa: number,
    idSolicitud: number,
  ): Promise<ResultadoAceptacion> {
    this.limpiarTimer(idAsignacion);
    this.cadenas.delete(idSolicitud);

    const datos = await this.repo.getDatosPasajero(idSolicitud);

    const ev: ConductorAsignadoEvent = {
      id_solicitud: idSolicitud,
      id_asignacion: idAsignacion,
      id_conductor: idConductor,
      id_taxi: 0,
      id_empresa: idEmpresa,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_ASSIGNMENT.CONDUCTOR_ASIGNADO, ev);

    return {
      resultado: 'aceptada',
      id_asignacion: idAsignacion,
      id_solicitud: idSolicitud,
      estado_solicitud: 'asignada',
      pasajero: {
        nombre: datos?.nombre ?? '',
        telefono_contacto: datos?.telefono ?? null,
        direccion_recogida: datos?.direccion_recogida ?? '',
      },
    };
  }

  private respYaTomada(): ResultadoAceptacion {
    return { resultado: 'ya_tomada', mensaje: 'La solicitud ya fue tomada' };
  }

  // ===========================================================================
  // Lectura para el estado del pasajero (P1.1 · GET /trips/:id)
  // ===========================================================================
  /**
   * Resumen del conductor asignado para el DUEÑO de la solicitud (viaje activo).
   * telefono_contacto se expone solo aquí (ADR-004), nunca en logs. ETA estático
   * (ADR-003) desde la última ubicación conocida del conductor.
   */
  async getResumenConductorAsignado(idSolicitud: number): Promise<ConductorAsignadoResumen | null> {
    const info = await this.repo.getSolicitudInfo(idSolicitud);
    if (!info) return null;

    const idEmpresa = await this.repo.resolveEmpresaActiva(info.id_municipio);
    if (idEmpresa === null) return null;

    const row = await this.prisma.runInTenant(idEmpresa, (tx) =>
      this.repo.getConductorAsignado(tx, idSolicitud, idEmpresa),
    );
    if (!row) return null;

    const params = await this.paramsService.obtener(info.id_municipio);
    const eta =
      row.lat !== null && row.lng !== null
        ? calcularEta(
            haversineKm(
              { lat: row.lat, lng: row.lng },
              { lat: info.lat_recogida, lng: info.lng_recogida },
            ),
            params.velocidadPromedioKmh,
          )
        : null;

    return {
      nombre: row.nombre,
      placa: row.placa,
      modelo: row.modelo,
      telefono_contacto: row.telefono,
      eta,
    };
  }

  // ===========================================================================
  // GET /assignments/cercanas — ofertas pendientes del conductor (POLLING · HU-07)
  // ===========================================================================
  /**
   * Ofertas PENDIENTES del conductor autenticado (estado creada/notificada, no
   * expiradas). Es el PUENTE de polling hasta el PUSH real (Expo Notifications, EV1).
   * Lectura pura tenant-scoped: NO toca la máquina de estados. Devuelve el MISMO
   * `NotificacionAsignacion` que consume apps/driver. Datos que no tenemos (p.ej.
   * nombre del pasajero) NO se inventan: el contrato no los incluye aquí.
   * TODO(EV1): complementar/reemplazar por push real.
   */
  async listarCercanas(idConductor: number, idEmpresa: number): Promise<NotificacionAsignacion[]> {
    const { ofertas, ubicacion } = await this.prisma.runInTenant(idEmpresa, async (tx) => ({
      ofertas: await this.repo.getOfertasPendientes(tx, idConductor, idEmpresa),
      ubicacion: await this.repo.getUbicacionConductor(tx, idConductor, idEmpresa),
    }));

    const ahora = Date.now();
    return ofertas.map((o) => ({
      id_asignacion: o.id_asignacion,
      id_solicitud: o.id_solicitud,
      origen: { direccion: o.direccion_recogida, lat: o.lat_recogida, lng: o.lng_recogida },
      destino_barrio: barrioDe(o.direccion_destino),
      tarifa_total: Math.round(o.tarifa),
      distancia_al_origen_m:
        ubicacion?.lat != null && ubicacion.lng != null
          ? Math.round(
              haversineKm(
                { lat: ubicacion.lat, lng: ubicacion.lng },
                { lat: o.lat_recogida, lng: o.lng_recogida },
              ) * 1000,
            )
          : 0,
      expira_en: o.expira_en.toISOString(),
      segundos_para_responder: Math.max(1, Math.ceil((o.expira_en.getTime() - ahora) / 1000)),
    }));
  }

  // ===========================================================================
  // RECHAZAR (antes de aceptar) — HU-09
  // ===========================================================================
  async rechazar(
    idAsignacion: number,
    idConductor: number,
    idEmpresa: number,
    dto: RechazarAsignacionDTO,
  ): Promise<{ ok: true }> {
    const r = await this.prisma.runInTenant(idEmpresa, async (tx) => {
      const asig = await this.repo.getAsignacion(tx, idAsignacion, idEmpresa);
      if (!asig) return { tipo: 'no_existe' as const };
      if (asig.id_conductor !== idConductor) return { tipo: 'no_conductor' as const };
      if (asig.estado !== 'notificada') return { tipo: 'estado_invalido' as const };
      await this.repo.marcarRechazada(tx, idAsignacion, idEmpresa, dto.motivo ?? null);
      return { tipo: 'ok' as const, idSolicitud: asig.id_solicitud, idConductor };
    });

    if (r.tipo === 'no_existe') {
      throw new NotFoundException({ codigo: 'ASIGNACION_NO_EXISTE', mensaje: 'No existe' });
    }
    if (r.tipo === 'no_conductor') {
      throw new ForbiddenException({ codigo: 'NO_ES_EL_CONDUCTOR', mensaje: 'No eres el conductor' });
    }
    if (r.tipo === 'estado_invalido') {
      throw new ConflictException({ codigo: 'ESTADO_INVALIDO', mensaje: 'Ya no está notificada' });
    }

    this.limpiarTimer(idAsignacion);
    const ev: AsignacionRechazadaEvent = {
      id_asignacion: idAsignacion,
      id_solicitud: r.idSolicitud,
      id_conductor: r.idConductor,
      motivo: dto.motivo ?? null,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_ASSIGNMENT.ASIGNACION_RECHAZADA, ev);

    const ctx = this.cadenas.get(r.idSolicitud);
    if (ctx) await this.intentarSiguiente(ctx);
    return { ok: true };
  }

  // ===========================================================================
  // CANCELAR tras aceptar (conductor) — HU-09
  // ===========================================================================
  async cancelarPorConductor(
    idAsignacion: number,
    idConductor: number,
    idEmpresa: number,
    dto: CancelarAsignacionConductorDTO,
  ): Promise<ResultadoCancelacionConductor> {
    const r = await this.prisma.runInTenant(idEmpresa, async (tx) => {
      const asig = await this.repo.getAsignacion(tx, idAsignacion, idEmpresa);
      if (!asig) return { tipo: 'no_existe' as const };
      if (asig.id_conductor !== idConductor) return { tipo: 'no_conductor' as const };
      if (asig.estado !== 'aceptada') return { tipo: 'estado_invalido' as const };
      const ok = await this.repo.marcarCanceladaConductor(tx, idAsignacion, idEmpresa, dto.motivo);
      if (!ok) return { tipo: 'estado_invalido' as const };
      await this.repo.liberarConductor(tx, idConductor, idEmpresa);
      return { tipo: 'ok' as const, idSolicitud: asig.id_solicitud };
    });

    if (r.tipo === 'no_existe') {
      throw new NotFoundException({ codigo: 'ASIGNACION_NO_EXISTE', mensaje: 'No existe' });
    }
    if (r.tipo === 'no_conductor') {
      throw new ForbiddenException({ codigo: 'NO_ES_EL_CONDUCTOR', mensaje: 'No eres el conductor' });
    }
    if (r.tipo === 'estado_invalido') {
      throw new ConflictException({ codigo: 'ESTADO_INVALIDO', mensaje: 'La asignación no está aceptada' });
    }

    this.limpiarTimer(idAsignacion);
    this.cadenas.delete(r.idSolicitud);

    // trips reabre la solicitud y relanza el motor (re-emite solicitud.creada).
    const ev: AsignacionCanceladaConductorEvent = {
      id_asignacion: idAsignacion,
      id_solicitud: r.idSolicitud,
      id_conductor: idConductor,
      motivo: dto.motivo,
      ocurrido_en: new Date().toISOString(),
    };
    this.emitter.emit(EVENTOS_ASSIGNMENT.ASIGNACION_CANCELADA_CONDUCTOR, ev);

    return {
      id_asignacion: idAsignacion,
      id_solicitud: r.idSolicitud,
      estado_solicitud: 'pendiente_de_asignacion',
      rebuscando: true,
    };
  }

  // ===========================================================================
  // Cancelación del pasajero → liberar conductor / detener la cadena
  // ===========================================================================
  @OnEvent(EVENTOS_TRIPS.SOLICITUD_CANCELADA)
  async onSolicitudCancelada(ev: SolicitudCanceladaEvent): Promise<void> {
    try {
      const ctx = this.cadenas.get(ev.id_solicitud);
      if (ctx?.asignacionActual != null) this.limpiarTimer(ctx.asignacionActual);
      this.cadenas.delete(ev.id_solicitud);

      const info = await this.repo.getSolicitudInfo(ev.id_solicitud);
      if (!info) return;
      const idEmpresa =
        ctx?.idEmpresa ?? (await this.repo.resolveEmpresaActiva(info.id_municipio));
      if (idEmpresa === null) return;

      await this.prisma.runInTenant(idEmpresa, async (tx) => {
        const asig = await this.repo.getAsignacionActiva(tx, ev.id_solicitud, idEmpresa);
        if (!asig) return;
        if (asig.estado === 'aceptada') {
          await this.repo.liberarConductor(tx, asig.id_conductor, idEmpresa);
        }
        await this.repo.marcarAsignacionCancelada(tx, asig.id_asignacion, idEmpresa);
      });
    } catch (e) {
      this.logger.error(`Fallo liberando en cancelación solicitud=${ev.id_solicitud}: ${msg(e)}`);
    }
  }
}

function barrioDe(direccion: string): string {
  const primera = direccion.split(',')[0]?.trim();
  return primera && primera.length > 0 ? primera : 'Zona destino';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
