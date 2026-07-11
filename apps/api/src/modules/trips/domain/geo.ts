import type { EtaEstimado } from '@voyya/shared';

/** Coordenada mínima para cálculos geométricos locales. */
export interface Punto {
  lat: number;
  lng: number;
}

const RADIO_TIERRA_KM = 6371;
const gradosARadianes = (g: number): number => (g * Math.PI) / 180;

/**
 * Distancia haversine en km entre dos puntos (misma fórmula que reusa el motor
 * nearest-first vía PostGIS — ADR-003). Pura y testeable.
 */
export function haversineKm(a: Punto, b: Punto): number {
  const dLat = gradosARadianes(b.lat - a.lat);
  const dLng = gradosARadianes(b.lng - a.lng);
  const lat1 = gradosARadianes(a.lat);
  const lat2 = gradosARadianes(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * ETA ESTÁTICO como RANGO (ADR-003), nunca valor exacto. `es_estimado: true`
 * obliga al front a no presentarlo como precisión de GPS.
 */
export function calcularEta(distanciaKm: number, velocidadPromedioKmh: number): EtaEstimado {
  const minutos = (distanciaKm / velocidadPromedioKmh) * 60;
  const min = Math.max(1, Math.floor(minutos * 0.85));
  const max = Math.max(min + 1, Math.ceil(minutos * 1.25));
  return { min_minutos: min, max_minutos: max, es_estimado: true };
}
