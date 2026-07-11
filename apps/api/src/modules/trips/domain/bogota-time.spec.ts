import { esDomingoEnBogota, fechaBogotaISO, horaEnBogota } from './bogota-time';

/** Reloj de pared de Bogotá (UTC-5) → Date. */
function bogota(anio: number, mes: number, dia: number, hora: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, hora + 5, 0, 0));
}

describe('horaEnBogota', () => {
  it('convierte a hora de Bogotá (UTC-5) sin importar la zona del proceso', () => {
    expect(horaEnBogota(bogota(2026, 1, 5, 22))).toBe(22);
    expect(horaEnBogota(bogota(2026, 1, 5, 0))).toBe(0);
    expect(horaEnBogota(bogota(2026, 1, 5, 5))).toBe(5);
  });
});

describe('fechaBogotaISO', () => {
  it('devuelve YYYY-MM-DD en Bogotá respetando la frontera de día', () => {
    // 23:00 Bogotá del 20-jul = 04:00 UTC del 21-jul; la fecha Bogotá es 20-jul.
    expect(fechaBogotaISO(bogota(2026, 7, 20, 23))).toBe('2026-07-20');
    expect(fechaBogotaISO(bogota(2026, 7, 20, 12))).toBe('2026-07-20');
  });
});

describe('esDomingoEnBogota', () => {
  it('detecta domingo en Bogotá', () => {
    expect(esDomingoEnBogota(bogota(2026, 1, 4, 12))).toBe(true); // 2026-01-04 domingo
    expect(esDomingoEnBogota(bogota(2026, 1, 5, 12))).toBe(false); // 2026-01-05 lunes
  });
});
