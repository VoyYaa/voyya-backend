import type { EstimatedEta } from '@voyyaa/shared';

export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = degToRad(b.lat - a.lat);
  const dLng = degToRad(b.lng - a.lng);
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function calculateEta(distanceKm: number, avgSpeedKmh: number): EstimatedEta {
  const minutes = (distanceKm / avgSpeedKmh) * 60;
  const min = Math.max(1, Math.floor(minutes * 0.85));
  const max = Math.max(min + 1, Math.ceil(minutes * 1.25));
  return { min_minutes: min, max_minutes: max, is_estimate: true };
}
