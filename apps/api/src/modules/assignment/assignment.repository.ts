import { Injectable } from '@nestjs/common';
import type { Asignacion, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface SolicitudInfo {
  id_solicitud: number;
  id_cliente: number;
  id_municipio: number;
  direccion_recogida: string;
  direccion_destino: string;
  lat_recogida: number;
  lng_recogida: number;
  tarifa: number;
  estado: string;
}

export interface DatosPasajero {
  nombre: string;
  telefono: string;
  direccion_recogida: string;
}

export interface ConductorAsignadoRow {
  nombre: string;
  telefono: string;
  placa: string;
  modelo: string | null;
  lat: number | null;
  lng: number | null;
}

/** Oferta pendiente para el polling del conductor (GET /assignments/cercanas). */
export interface OfertaPendiente {
  id_asignacion: number;
  id_solicitud: number;
  expira_en: Date;
  direccion_recogida: string;
  direccion_destino: string;
  lat_recogida: number;
  lng_recogida: number;
  tarifa: number;
}

export interface CrearAsignacionData {
  idSolicitud: number;
  idConductor: number;
  idTaxi: number;
  idEmpresa: number;
  ordenIntento: number;
  expiraEn: Date;
}

/**
 * Acceso a datos del motor de asignación.
 *
 * - Operaciones sobre tablas TENANT (fleet.conductor, assignment.asignacion) reciben
 *   `tx` y DEBEN ejecutarse dentro de `prisma.runInTenant(idEmpresa, ...)`.
 * - DEFENSA EN PROFUNDIDAD (C-2): todas filtran `id_empresa` EXPLÍCITO en el WHERE,
 *   no solo por RLS. Si la RLS quedara inactiva (owner-bypass), el tenant sigue aislado.
 * - Lecturas GLOBALES (solicitud_viaje, empresa, pasajero) usan el cliente directo.
 * - `marcarSolicitudAsignada` escribe trips.solicitud_viaje DENTRO de la transacción
 *   de la toma única: excepción MANDADA por ADR-002.
 */
@Injectable()
export class AssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Lecturas GLOBALES (sin tenant) ---------------------------------------

  async resolveEmpresaActiva(idMunicipio: number): Promise<number | null> {
    const empresa = await this.prisma.empresa.findFirst({
      where: { id_municipio: idMunicipio, estado: 'activa' },
      orderBy: { id_empresa: 'asc' },
      select: { id_empresa: true },
    });
    return empresa?.id_empresa ?? null;
  }

  async getSolicitudInfo(idSolicitud: number): Promise<SolicitudInfo | null> {
    const s = await this.prisma.solicitudViaje.findUnique({
      where: { id_solicitud: idSolicitud },
      select: {
        id_solicitud: true,
        id_cliente: true,
        id_municipio: true,
        direccion_recogida: true,
        direccion_destino: true,
        lat_recogida: true,
        lng_recogida: true,
        tarifa: true,
        estado: true,
      },
    });
    if (!s) return null;
    return { ...s, tarifa: Number(s.tarifa) };
  }

  async getDatosPasajero(idSolicitud: number): Promise<DatosPasajero | null> {
    const s = await this.prisma.solicitudViaje.findUnique({
      where: { id_solicitud: idSolicitud },
      select: {
        direccion_recogida: true,
        pasajero: {
          select: { usuario: { select: { nombre: true, apellido: true, telefono: true } } },
        },
      },
    });
    if (!s) return null;
    const u = s.pasajero.usuario;
    return {
      nombre: `${u.nombre} ${u.apellido}`.trim(),
      telefono: u.telefono,
      direccion_recogida: s.direccion_recogida,
    };
  }

  // --- Escrituras/lecturas TENANT (dentro de runInTenant, id_empresa explícito) ---

  async crearAsignacionNotificada(
    tx: Prisma.TransactionClient,
    data: CrearAsignacionData,
  ): Promise<Asignacion> {
    return tx.asignacion.create({
      data: {
        id_solicitud: data.idSolicitud,
        id_conductor: data.idConductor,
        id_taxi: data.idTaxi,
        id_empresa: data.idEmpresa,
        estado: 'notificada',
        asignado_por: 'sistema',
        orden_intento: data.ordenIntento,
        notificada_en: new Date(),
        expira_en: data.expiraEn,
      },
    });
  }

  async getAsignacion(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
  ): Promise<Asignacion | null> {
    return tx.asignacion.findFirst({
      where: { id_asignacion: idAsignacion, id_empresa: idEmpresa },
    });
  }

  async getAsignacionActiva(
    tx: Prisma.TransactionClient,
    idSolicitud: number,
    idEmpresa: number,
  ): Promise<Asignacion | null> {
    return tx.asignacion.findFirst({
      where: {
        id_solicitud: idSolicitud,
        id_empresa: idEmpresa,
        estado: { in: ['notificada', 'aceptada'] },
      },
      orderBy: { id_asignacion: 'desc' },
    });
  }

  /** Datos del conductor asignado (aceptada) para el estado del pasajero (P1.1). */
  async getConductorAsignado(
    tx: Prisma.TransactionClient,
    idSolicitud: number,
    idEmpresa: number,
  ): Promise<ConductorAsignadoRow | null> {
    const asig = await tx.asignacion.findFirst({
      where: { id_solicitud: idSolicitud, id_empresa: idEmpresa, estado: 'aceptada' },
      select: {
        conductor: {
          select: {
            lat_actual: true,
            lng_actual: true,
            usuario: { select: { nombre: true, apellido: true, telefono: true } },
          },
        },
        taxi: { select: { placa: true, modelo: true } },
      },
    });
    if (!asig) return null;
    const u = asig.conductor.usuario;
    return {
      nombre: `${u.nombre} ${u.apellido}`.trim(),
      telefono: u.telefono,
      placa: asig.taxi.placa,
      modelo: asig.taxi.modelo,
      lat: asig.conductor.lat_actual,
      lng: asig.conductor.lng_actual,
    };
  }

  /**
   * Ofertas PENDIENTES del conductor (polling · GET /assignments/cercanas): estado
   * `creada`/`notificada` y no expiradas, del tenant. Lectura pura (no toca estados).
   */
  async getOfertasPendientes(
    tx: Prisma.TransactionClient,
    idConductor: number,
    idEmpresa: number,
  ): Promise<OfertaPendiente[]> {
    const filas = await tx.asignacion.findMany({
      where: {
        id_conductor: idConductor,
        id_empresa: idEmpresa,
        estado: { in: ['creada', 'notificada'] },
        expira_en: { gt: new Date() },
      },
      orderBy: { fecha_asignacion: 'desc' },
      select: {
        id_asignacion: true,
        id_solicitud: true,
        expira_en: true,
        solicitud: {
          select: {
            direccion_recogida: true,
            direccion_destino: true,
            lat_recogida: true,
            lng_recogida: true,
            tarifa: true,
          },
        },
      },
    });
    return filas
      .filter((f): f is typeof f & { expira_en: Date } => f.expira_en !== null)
      .map((f) => ({
        id_asignacion: f.id_asignacion,
        id_solicitud: f.id_solicitud,
        expira_en: f.expira_en,
        direccion_recogida: f.solicitud.direccion_recogida,
        direccion_destino: f.solicitud.direccion_destino,
        lat_recogida: f.solicitud.lat_recogida,
        lng_recogida: f.solicitud.lng_recogida,
        tarifa: Number(f.solicitud.tarifa),
      }));
  }

  /** Última ubicación conocida del conductor (para la distancia al origen). */
  async getUbicacionConductor(
    tx: Prisma.TransactionClient,
    idConductor: number,
    idEmpresa: number,
  ): Promise<{ lat: number | null; lng: number | null } | null> {
    const c = await tx.conductor.findFirst({
      where: { id_conductor: idConductor, id_empresa: idEmpresa },
      select: { lat_actual: true, lng_actual: true },
    });
    if (!c) return null;
    return { lat: c.lat_actual, lng: c.lng_actual };
  }

  /**
   * TOMA ÚNICA ATÓMICA (ADR-002 · HU-08). El recurso escaso es la disponibilidad
   * del conductor. 0 filas ⇒ ya no está 'disponible' ⇒ perdió la carrera.
   */
  async tomarConductor(
    tx: Prisma.TransactionClient,
    idConductor: number,
    idEmpresa: number,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_conductor: number }>>`
      UPDATE fleet.conductor
         SET estado = 'en_servicio', actualizado_en = now()
       WHERE id_conductor = ${idConductor}
         AND estado = 'disponible'
         AND id_empresa = ${idEmpresa}
      RETURNING id_conductor
    `;
    return filas.length === 1;
  }

  /** Libera al conductor (en_servicio → disponible) de forma igualmente atómica. */
  async liberarConductor(
    tx: Prisma.TransactionClient,
    idConductor: number,
    idEmpresa: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE fleet.conductor
         SET estado = 'disponible', actualizado_en = now()
       WHERE id_conductor = ${idConductor}
         AND estado = 'en_servicio'
         AND id_empresa = ${idEmpresa}
    `;
  }

  async marcarAsignacionAceptada(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_asignacion: number }>>`
      UPDATE assignment.asignacion
         SET estado = 'aceptada', respondida_en = now()
       WHERE id_asignacion = ${idAsignacion}
         AND id_empresa = ${idEmpresa}
         AND estado = 'notificada'
      RETURNING id_asignacion
    `;
    return filas.length === 1;
  }

  /**
   * ADR-002: cambia la solicitud a `asignada` en la MISMA transacción de la toma.
   * R-03: fija `asignada_en` = now() como base de la ventana gratuita de cancelación.
   * (solicitud_viaje es GLOBAL, sin RLS por empresa → no lleva id_empresa.)
   */
  async marcarSolicitudAsignada(
    tx: Prisma.TransactionClient,
    idSolicitud: number,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_solicitud: number }>>`
      UPDATE trips.solicitud_viaje
         SET estado = 'asignada', asignada_en = now(), actualizado_en = now()
       WHERE id_solicitud = ${idSolicitud}
         AND estado = 'pendiente_de_asignacion'
      RETURNING id_solicitud
    `;
    return filas.length === 1;
  }

  async marcarTimeout(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_asignacion: number }>>`
      UPDATE assignment.asignacion
         SET estado = 'timeout', respondida_en = now()
       WHERE id_asignacion = ${idAsignacion}
         AND id_empresa = ${idEmpresa}
         AND estado = 'notificada'
      RETURNING id_asignacion
    `;
    return filas.length === 1;
  }

  async marcarRechazada(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
    motivo: string | null,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_asignacion: number }>>`
      UPDATE assignment.asignacion
         SET estado = 'rechazada', respondida_en = now(), motivo_cancelacion = ${motivo}
       WHERE id_asignacion = ${idAsignacion}
         AND id_empresa = ${idEmpresa}
         AND estado = 'notificada'
      RETURNING id_asignacion
    `;
    return filas.length === 1;
  }

  async marcarCanceladaConductor(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
    motivo: string,
  ): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id_asignacion: number }>>`
      UPDATE assignment.asignacion
         SET estado = 'cancelada', respondida_en = now(), motivo_cancelacion = ${motivo}
       WHERE id_asignacion = ${idAsignacion}
         AND id_empresa = ${idEmpresa}
         AND estado = 'aceptada'
      RETURNING id_asignacion
    `;
    return filas.length === 1;
  }

  /** Cancela cualquier asignación viva de una solicitud (cancelación del pasajero). */
  async marcarAsignacionCancelada(
    tx: Prisma.TransactionClient,
    idAsignacion: number,
    idEmpresa: number,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE assignment.asignacion
         SET estado = 'cancelada', respondida_en = now()
       WHERE id_asignacion = ${idAsignacion}
         AND id_empresa = ${idEmpresa}
         AND estado IN ('notificada', 'aceptada')
    `;
  }
}
