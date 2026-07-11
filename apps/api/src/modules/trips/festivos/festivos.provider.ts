/** Token de inyección del proveedor de festivos (DIP). */
export const FESTIVOS_PROVIDER = Symbol('FESTIVOS_PROVIDER');

/**
 * Puerto de festivos. El cálculo de tarifa lo consume por esta interfaz, no por una
 * implementación concreta (intercambiable: lista de config hoy, algoritmo mañana).
 * NO incluye domingos (eso lo evalúa la máquina de fecha en Bogotá aparte).
 */
export interface FestivosProvider {
  /** ¿La fecha (evaluada en Bogotá) es festivo de CALENDARIO en Colombia? */
  esFestivo(fecha: Date): boolean;
}
