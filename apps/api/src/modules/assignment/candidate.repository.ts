import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface CandidatoDb {
  idConductor: number;
  idTaxi: number;
  distanciaM: number;
  viajesUltimas3h: number;
}

export interface BusquedaCandidatos {
  idEmpresa: number;
  lat: number;
  lng: number;
  radioKm: number;
  ventanaDesempateHoras: number;
  limite: number;
  /** Conductores ya intentados en esta cadena (se excluyen). */
  excluir: number[];
}

/**
 * Selección de candidatos nearest-first (ADR-001) con PostGIS.
 * Consulta SIEMPRE tenant-scoped (id_empresa) — debe ejecutarse dentro de
 * `prisma.runInTenant(idEmpresa, tx => ...)` para que aplique la RLS.
 *
 * Orden: distancia ASC; desempate por menos viajes aceptados en la ventana.
 * Sólo conductores `disponible`, con taxi y ubicación, dentro del radio.
 */
@Injectable()
export class CandidateRepository {
  async findCandidates(
    tx: Prisma.TransactionClient,
    q: BusquedaCandidatos,
  ): Promise<CandidatoDb[]> {
    const punto = Prisma.sql`ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography`;
    const radioMetros = q.radioKm * 1000;
    const exclusion = q.excluir.length
      ? Prisma.sql`AND c.id_conductor NOT IN (${Prisma.join(q.excluir)})`
      : Prisma.empty;

    return tx.$queryRaw<CandidatoDb[]>(Prisma.sql`
      SELECT
        c.id_conductor       AS "idConductor",
        c.id_taxi_actual     AS "idTaxi",
        ST_Distance(c.ubicacion_actual, ${punto}) AS "distanciaM",
        (
          SELECT COUNT(*)::int
          FROM assignment.asignacion a
          WHERE a.id_conductor = c.id_conductor
            AND a.estado = 'aceptada'
            AND a.fecha_asignacion > now() - (${q.ventanaDesempateHoras} * interval '1 hour')
        ) AS "viajesUltimas3h"
      FROM fleet.conductor c
      WHERE c.id_empresa = ${q.idEmpresa}
        AND c.estado = 'disponible'
        AND c.id_taxi_actual IS NOT NULL
        AND c.ubicacion_actual IS NOT NULL
        AND ST_DWithin(c.ubicacion_actual, ${punto}, ${radioMetros})
        ${exclusion}
      ORDER BY "distanciaM" ASC, "viajesUltimas3h" ASC
      LIMIT ${q.limite}
    `);
  }
}
