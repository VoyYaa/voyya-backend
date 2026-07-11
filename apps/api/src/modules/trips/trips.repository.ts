import { Injectable } from '@nestjs/common';
import type { ConfiguracionTarifa, SolicitudViaje } from '@prisma/client';
import { type EstadoSolicitud, ESTADOS_SOLICITUD_ACTIVOS, type TipoServicio } from '@voyya/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface CrearSolicitudData {
  idCliente: number;
  idMunicipio: number;
  tipoServicio: TipoServicio;
  metodoPago: 'efectivo';
  direccionRecogida: string;
  direccionDestino: string;
  latRecogida: number;
  lngRecogida: number;
  latDestino: number;
  lngDestino: number;
  distanciaKm: number;
  tarifaTotal: number;
  comision: number;
}

/**
 * Acceso a datos del dominio TRIPS. SolicitudViaje, ConfiguracionTarifa y Municipio
 * son GLOBALES (sin RLS por empresa), por eso NO se envuelven en runInTenant.
 * La cobertura usa PostGIS (columna generada `cobertura`) vía $queryRaw.
 */
@Injectable()
export class TripsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getTarifaVigente(
    idMunicipio: number,
    tipoServicio: TipoServicio,
  ): Promise<ConfiguracionTarifa | null> {
    const hoy = new Date();
    return this.prisma.configuracionTarifa.findFirst({
      where: {
        id_municipio: idMunicipio,
        tipo_servicio: tipoServicio,
        AND: [
          { OR: [{ fecha_desde: null }, { fecha_desde: { lte: hoy } }] },
          { OR: [{ fecha_hasta: null }, { fecha_hasta: { gte: hoy } }] },
        ],
      },
      orderBy: { fecha_desde: 'desc' },
    });
  }

  /** ST_Covers(polígono_municipio, punto). `true` sólo si el punto está cubierto. */
  async puntoDentroDeCobertura(
    idMunicipio: number,
    lng: number,
    lat: number,
  ): Promise<boolean> {
    const filas = await this.prisma.$queryRaw<Array<{ cubierto: boolean | null }>>`
      SELECT ST_Covers(cobertura, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS cubierto
      FROM tenancy.municipio
      WHERE id_municipio = ${idMunicipio}
    `;
    return filas.length > 0 && filas[0]?.cubierto === true;
  }

  /** Idempotencia HU-04: un pasajero no puede tener dos solicitudes vivas. */
  async existeSolicitudActiva(idCliente: number): Promise<boolean> {
    const n = await this.prisma.solicitudViaje.count({
      where: {
        id_cliente: idCliente,
        estado: { in: [...ESTADOS_SOLICITUD_ACTIVOS] },
      },
    });
    return n > 0;
  }

  async crearSolicitud(data: CrearSolicitudData): Promise<SolicitudViaje> {
    return this.prisma.solicitudViaje.create({
      data: {
        id_cliente: data.idCliente,
        id_municipio: data.idMunicipio,
        tipo_servicio: data.tipoServicio,
        metodo_pago: data.metodoPago,
        direccion_recogida: data.direccionRecogida,
        direccion_destino: data.direccionDestino,
        lat_recogida: data.latRecogida,
        lng_recogida: data.lngRecogida,
        lat_destino: data.latDestino,
        lng_destino: data.lngDestino,
        distancia: data.distanciaKm,
        tarifa: data.tarifaTotal,
        comision: data.comision,
        estado: 'pendiente_de_asignacion',
      },
    });
  }

  async getSolicitud(idSolicitud: number): Promise<SolicitudViaje | null> {
    return this.prisma.solicitudViaje.findUnique({ where: { id_solicitud: idSolicitud } });
  }

  /** Cambia el estado de la solicitud (transición ya validada por el service). */
  async actualizarEstado(
    idSolicitud: number,
    estado: EstadoSolicitud,
  ): Promise<void> {
    await this.prisma.solicitudViaje.update({
      where: { id_solicitud: idSolicitud },
      data: { estado },
    });
  }
}
