import { Injectable } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Parámetros del motor (ADR-001). NO hardcodeados: DB → env fallback. */
export interface ParametrosAsignacion {
  radioBusquedaKm: number;
  radioExpansionKm: number;
  timeoutAceptacionSeg: number;
  maxReintentos: number;
  ventanaDesempateHoras: number;
  velocidadPromedioKmh: number;
}

/**
 * Resuelve los parámetros del motor. Fuente AUTORITATIVA: tabla `parametros_sistema`
 * (por municipio, con fallback a global). Si una clave no está en DB, cae al valor
 * de entorno (config). Nunca hay "números mágicos" en el código del motor.
 */
@Injectable()
export class AssignmentParamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async obtener(idMunicipio: number): Promise<ParametrosAsignacion> {
    const filas = await this.prisma.parametrosSistema.findMany({
      where: { OR: [{ id_municipio: idMunicipio }, { id_municipio: null }] },
    });

    // Prioriza la clave específica del municipio sobre la global.
    const mapa = new Map<string, string>();
    for (const f of filas) {
      if (f.id_municipio === null && mapa.has(f.clave)) continue;
      mapa.set(f.clave, f.valor);
    }

    const num = (clave: string, fallback: number): number => {
      const v = mapa.get(clave);
      if (v === undefined) return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    return {
      radioBusquedaKm: num('radio_busqueda_km', this.env.get('RADIO_BUSQUEDA_KM')),
      radioExpansionKm: num('radio_expansion_km', this.env.get('RADIO_EXPANSION_KM')),
      timeoutAceptacionSeg: num(
        'timeout_aceptacion_seg',
        this.env.get('TIMEOUT_ACEPTACION_SEG'),
      ),
      maxReintentos: num(
        'max_reintentos_automaticos',
        this.env.get('MAX_REINTENTOS_AUTOMATICOS'),
      ),
      ventanaDesempateHoras: num(
        'ventana_desempate_viajes_horas',
        this.env.get('VENTANA_DESEMPATE_VIAJES_HORAS'),
      ),
      velocidadPromedioKmh: num(
        'velocidad_promedio_kmh',
        this.env.get('VELOCIDAD_PROMEDIO_KMH'),
      ),
    };
  }
}
