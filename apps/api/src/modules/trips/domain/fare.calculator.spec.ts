import type { FestivosProvider } from '../festivos/festivos.provider';
import {
  calcularTarifa,
  esDiaFestivo,
  esHorarioNocturno,
  type ParametrosTarifa,
} from './fare.calculator';

const PARAMS: ParametrosTarifa = {
  tarifaBase: 8000,
  recargoNocturnoPct: 20,
  recargoFestivoPct: 15,
  comisionPct: 8,
};

// Proveedores de festivos de doble (DIP): deterministas, sin depender del calendario.
const SIN_FESTIVOS: FestivosProvider = { esFestivo: () => false };
const SIEMPRE_FESTIVO: FestivosProvider = { esFestivo: () => true };

/**
 * Construye un Date cuyo RELOJ DE PARED en Bogotá (UTC-5, sin DST) es la fecha/hora
 * dada. Así los tests son deterministas sin importar la zona del proceso (R-01).
 */
function bogota(anio: number, mes: number, dia: number, hora: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, hora + 5, 0, 0));
}
// 2026-01-05 es LUNES; 2026-01-04 es DOMINGO (referencias fijas en Bogotá).
const lunes = (h: number): Date => bogota(2026, 1, 5, h);
const domingo = (h: number): Date => bogota(2026, 1, 4, h);

describe('esHorarioNocturno (hora de Bogotá)', () => {
  it.each([
    [22, true],
    [21, true], // inicio inclusive
    [3, true],
    [4, true],
    [5, false], // fin exclusivo
    [12, false],
    [20, false],
  ])('Bogotá %ih → nocturno=%s', (hora, esperado) => {
    expect(esHorarioNocturno(lunes(hora))).toBe(esperado);
  });
});

describe('esDiaFestivo (Bogotá + puerto de festivos)', () => {
  it('domingo es festivo (aunque el puerto diga que no)', () => {
    expect(esDiaFestivo(domingo(12), SIN_FESTIVOS)).toBe(true);
  });
  it('día laborable sin festivo de calendario no es festivo', () => {
    expect(esDiaFestivo(lunes(12), SIN_FESTIVOS)).toBe(false);
  });
  it('festivo de calendario aunque sea laborable', () => {
    expect(esDiaFestivo(lunes(12), SIEMPRE_FESTIVO)).toBe(true);
  });
});

describe('calcularTarifa', () => {
  it('DÍA laborable: sólo tarifa base', () => {
    const t = calcularTarifa(PARAMS, { fecha: lunes(12) }, SIN_FESTIVOS);
    expect(t).toEqual({
      tarifa_base: 8000,
      recargo_nocturno: 0,
      recargo_festivo: 0,
      total: 8000,
      comision: 640, // 8000 * 8%
      moneda: 'COP',
    });
  });

  it('NOCHE laborable: +20% nocturno', () => {
    const t = calcularTarifa(PARAMS, { fecha: lunes(22) }, SIN_FESTIVOS);
    expect(t.recargo_nocturno).toBe(1600);
    expect(t.recargo_festivo).toBe(0);
    expect(t.total).toBe(9600);
    expect(t.comision).toBe(768); // 9600 * 8%
  });

  it('FESTIVO (domingo) diurno: +15% festivo', () => {
    const t = calcularTarifa(PARAMS, { fecha: domingo(12) }, SIN_FESTIVOS);
    expect(t.recargo_nocturno).toBe(0);
    expect(t.recargo_festivo).toBe(1200);
    expect(t.total).toBe(9200);
  });

  it('FESTIVO de calendario (laborable) diurno: +15% por el puerto', () => {
    const t = calcularTarifa(PARAMS, { fecha: lunes(12) }, SIEMPRE_FESTIVO);
    expect(t.recargo_festivo).toBe(1200);
    expect(t.total).toBe(9200);
  });

  it('FESTIVO + NOCHE (domingo 22h): ambos recargos', () => {
    const t = calcularTarifa(PARAMS, { fecha: domingo(22) }, SIN_FESTIVOS);
    expect(t.recargo_nocturno).toBe(1600);
    expect(t.recargo_festivo).toBe(1200);
    expect(t.total).toBe(10800);
    expect(t.comision).toBe(864); // 10800 * 8%
  });

  it('la comisión se registra sobre el total (no se suma al total que paga el pasajero)', () => {
    const t = calcularTarifa(PARAMS, { fecha: lunes(12) }, SIN_FESTIVOS);
    expect(t.total).toBe(t.tarifa_base + t.recargo_nocturno + t.recargo_festivo);
    expect(t.comision).toBeLessThan(t.total);
  });
});
