import type { DesgloseTarifa } from '@voyya/shared';
import type { FestivosProvider } from '../festivos/festivos.provider';
import { esDomingoEnBogota, horaEnBogota } from './bogota-time';

/**
 * Cálculo de TARIFA FIJA del taxi (HU-04). Función PURA (sin DB, sin Nest) salvo el
 * puerto de festivos que recibe por parámetro (DIP): trivialmente testeable.
 * La tarifa se CIERRA al confirmar.
 *
 * R-01: nocturno/festivo se evalúan en `America/Bogota` (no la hora del proceso).
 * R-02: los festivos de calendario los provee un `FestivosProvider` (puerto).
 *
 * Reglas (doc requisitos §HU-04, schema ConfiguracionTarifa):
 *   total = tarifa_base + recargo_nocturno? + recargo_festivo?
 *   comisión = total * comision_pct  (se REGISTRA, no se cobra en MVP)
 * Montos en COP, pesos ENTEROS.
 */

export interface ParametrosTarifa {
  /** COP entero. */
  tarifaBase: number;
  /** Porcentaje, p.ej. 20 = +20% en horario nocturno. */
  recargoNocturnoPct: number;
  /** Porcentaje, p.ej. 15 = +15% en domingo/festivo. */
  recargoFestivoPct: number;
  /** Porcentaje de comisión de plataforma, p.ej. 8. */
  comisionPct: number;
}

export interface ContextoTarifa {
  /** Instante de la cotización (se interpreta en Bogotá). */
  fecha: Date;
}

/** Nocturno: 21:00–04:59 (inclusive), en hora de Bogotá. */
export const HORA_INICIO_NOCTURNO = 21;
export const HORA_FIN_NOCTURNO = 5;

export function esHorarioNocturno(fecha: Date): boolean {
  const hora = horaEnBogota(fecha);
  return hora >= HORA_INICIO_NOCTURNO || hora < HORA_FIN_NOCTURNO;
}

/** Festivo = domingo (Bogotá) o festivo de calendario provisto por el puerto. */
export function esDiaFestivo(fecha: Date, festivos: FestivosProvider): boolean {
  return esDomingoEnBogota(fecha) || festivos.esFestivo(fecha);
}

const porcentaje = (base: number, pct: number): number => Math.round((base * pct) / 100);

export function calcularTarifa(
  params: ParametrosTarifa,
  ctx: ContextoTarifa,
  festivos: FestivosProvider,
): DesgloseTarifa {
  const tarifaBase = Math.round(params.tarifaBase);

  const recargoNocturno = esHorarioNocturno(ctx.fecha)
    ? porcentaje(tarifaBase, params.recargoNocturnoPct)
    : 0;

  const recargoFestivo = esDiaFestivo(ctx.fecha, festivos)
    ? porcentaje(tarifaBase, params.recargoFestivoPct)
    : 0;

  const total = tarifaBase + recargoNocturno + recargoFestivo;
  const comision = porcentaje(total, params.comisionPct);

  return {
    tarifa_base: tarifaBase,
    recargo_nocturno: recargoNocturno,
    recargo_festivo: recargoFestivo,
    total,
    comision,
    moneda: 'COP',
  };
}
