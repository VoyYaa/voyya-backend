import { Injectable } from '@nestjs/common';
import { fechaBogotaISO } from '../domain/bogota-time';
import type { FestivosProvider } from './festivos.provider';

/**
 * Festivos de Colombia (R-02). MVP: LISTA DE CONFIG para los años del piloto
 * (2026–2027), evaluada por fecha calendario en Bogotá. No incluye domingos.
 *
 * TODO(EV1): reemplazar la lista por CÁLCULO ALGORÍTMICO (Ley 51 de 1983, "Ley
 *   Emiliani"): festivos fijos + los "corridos" trasladados al lunes siguiente +
 *   los móviles derivados de la Pascua (Jueves/Viernes Santo, Ascensión +43,
 *   Corpus Christi +64, Sagrado Corazón +71). Así deja de depender de una tabla anual.
 */
@Injectable()
export class FestivosColombiaService implements FestivosProvider {
  private readonly festivos: ReadonlySet<string> = new Set<string>([
    // --- 2026 (Pascua: 2026-04-05) ---
    '2026-01-01', // Año Nuevo
    '2026-01-12', // Reyes Magos (trasladado)
    '2026-03-23', // San José (trasladado)
    '2026-04-02', // Jueves Santo
    '2026-04-03', // Viernes Santo
    '2026-05-01', // Día del Trabajo
    '2026-05-18', // Ascensión (trasladado)
    '2026-06-08', // Corpus Christi (trasladado)
    '2026-06-15', // Sagrado Corazón (trasladado)
    '2026-06-29', // San Pedro y San Pablo
    '2026-07-20', // Independencia
    '2026-08-07', // Batalla de Boyacá
    '2026-08-17', // Asunción (trasladado)
    '2026-10-12', // Día de la Raza
    '2026-11-02', // Todos los Santos (trasladado)
    '2026-11-16', // Independencia de Cartagena (trasladado)
    '2026-12-08', // Inmaculada Concepción
    '2026-12-25', // Navidad
    // --- 2027 (Pascua: 2027-03-28) ---
    '2027-01-01', // Año Nuevo
    '2027-01-11', // Reyes Magos (trasladado)
    '2027-03-22', // San José (trasladado)
    '2027-03-25', // Jueves Santo
    '2027-03-26', // Viernes Santo
    '2027-05-01', // Día del Trabajo
    '2027-05-10', // Ascensión (trasladado)
    '2027-05-31', // Corpus Christi (trasladado)
    '2027-06-07', // Sagrado Corazón (trasladado)
    '2027-07-05', // San Pedro y San Pablo (trasladado)
    '2027-07-20', // Independencia
    '2027-08-07', // Batalla de Boyacá
    '2027-08-16', // Asunción (trasladado)
    '2027-10-18', // Día de la Raza (trasladado)
    '2027-11-01', // Todos los Santos
    '2027-11-15', // Independencia de Cartagena (trasladado)
    '2027-12-08', // Inmaculada Concepción
    '2027-12-25', // Navidad
  ]);

  esFestivo(fecha: Date): boolean {
    return this.festivos.has(fechaBogotaISO(fecha));
  }
}
