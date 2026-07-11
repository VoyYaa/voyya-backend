import { FestivosColombiaService } from './festivos-colombia.service';

/** Reloj de pared de Bogotá (UTC-5) → Date. */
function bogota(anio: number, mes: number, dia: number, hora: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, hora + 5, 0, 0));
}

describe('FestivosColombiaService', () => {
  const svc = new FestivosColombiaService();

  it('reconoce un festivo fijo de 2026 (20 de julio, Independencia)', () => {
    expect(svc.esFestivo(bogota(2026, 7, 20, 12))).toBe(true);
  });

  it('reconoce un festivo trasladado de 2026 (Reyes → 12 de enero)', () => {
    expect(svc.esFestivo(bogota(2026, 1, 12, 8))).toBe(true);
    expect(svc.esFestivo(bogota(2026, 1, 6, 8))).toBe(false); // el 6 ya no es festivo
  });

  it('reconoce un festivo de 2027 (1 de enero)', () => {
    expect(svc.esFestivo(bogota(2027, 1, 1, 9))).toBe(true);
  });

  it('un día laborable normal no es festivo', () => {
    expect(svc.esFestivo(bogota(2026, 7, 15, 12))).toBe(false);
  });

  it('respeta la frontera de zona horaria (23:00 Bogotá del 20-jul sigue siendo festivo)', () => {
    // 23:00 Bogotá = 04:00 UTC del 21-jul, pero la fecha en Bogotá es 2026-07-20.
    expect(svc.esFestivo(bogota(2026, 7, 20, 23))).toBe(true);
  });
});
