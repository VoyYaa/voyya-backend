// =============================================================================
// Utilidades de fecha/hora en zona horaria de Colombia (R-01).
// El recargo nocturno/festivo NO puede depender de la hora del proceso (el server
// puede correr en UTC). Se evalúa SIEMPRE en `America/Bogota` (UTC-5, sin DST).
// KISS: Intl (ICU completo en Node 18+), sin dependencias pesadas.
// =============================================================================

export const ZONA_BOGOTA = 'America/Bogota';

/** Hora del día (0–23) del instante `fecha` en Bogotá. */
export function horaEnBogota(fecha: Date): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_BOGOTA,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(fecha);
  const h = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  return h === 24 ? 0 : h; // algunos ICU emiten '24' para medianoche
}

/** Fecha calendario en Bogotá como `YYYY-MM-DD` (locale en-CA da ese formato). */
export function fechaBogotaISO(fecha: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_BOGOTA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha);
}

/** ¿El instante `fecha` cae en domingo según el calendario de Bogotá? */
export function esDomingoEnBogota(fecha: Date): boolean {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_BOGOTA,
    weekday: 'short',
  }).format(fecha);
  return wd === 'Sun';
}
