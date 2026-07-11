import { calculateEta, haversineKm, type GeoPoint } from './geo';

const YARUMAL: GeoPoint = { lat: 6.9639, lng: -75.4186 };

describe('haversineKm', () => {
  it('same point -> 0 km', () => {
    expect(haversineKm(YARUMAL, YARUMAL)).toBeCloseTo(0, 5);
  });

  it('~1 km north (0.009 deg latitude)', () => {
    const north: GeoPoint = { lat: YARUMAL.lat + 0.009, lng: YARUMAL.lng };
    expect(haversineKm(YARUMAL, north)).toBeGreaterThan(0.9);
    expect(haversineKm(YARUMAL, north)).toBeLessThan(1.1);
  });

  it('is symmetric', () => {
    const b: GeoPoint = { lat: 6.97, lng: -75.42 };
    expect(haversineKm(YARUMAL, b)).toBeCloseTo(haversineKm(b, YARUMAL), 9);
  });
});

describe('calculateEta (range, is_estimate)', () => {
  it('2 km at 20 km/h -> range with is_estimate true and min<=max', () => {
    const eta = calculateEta(2, 20);
    expect(eta.is_estimate).toBe(true);
    expect(eta.min_minutes).toBeLessThanOrEqual(eta.max_minutes);
    expect(eta.min_minutes).toBeGreaterThanOrEqual(1);
  });

  it('distance 0 -> minimum 1 minute (never 0)', () => {
    const eta = calculateEta(0, 20);
    expect(eta.min_minutes).toBeGreaterThanOrEqual(1);
    expect(eta.max_minutes).toBeGreaterThan(eta.min_minutes);
  });
});
