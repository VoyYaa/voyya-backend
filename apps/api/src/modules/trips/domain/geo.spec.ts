import { calcularEta, haversineKm, type Punto } from './geo';

const YARUMAL: Punto = { lat: 6.9639, lng: -75.4186 };

describe('haversineKm', () => {
  it('mismo punto → 0 km', () => {
    expect(haversineKm(YARUMAL, YARUMAL)).toBeCloseTo(0, 5);
  });

  it('~1 km al norte (0.009° de latitud)', () => {
    const norte: Punto = { lat: YARUMAL.lat + 0.009, lng: YARUMAL.lng };
    expect(haversineKm(YARUMAL, norte)).toBeGreaterThan(0.9);
    expect(haversineKm(YARUMAL, norte)).toBeLessThan(1.1);
  });

  it('es simétrica', () => {
    const b: Punto = { lat: 6.97, lng: -75.42 };
    expect(haversineKm(YARUMAL, b)).toBeCloseTo(haversineKm(b, YARUMAL), 9);
  });
});

describe('calcularEta (ADR-003: rango, es_estimado)', () => {
  it('2 km a 20 km/h → rango con es_estimado true y min<=max', () => {
    const eta = calcularEta(2, 20); // 6 min base
    expect(eta.es_estimado).toBe(true);
    expect(eta.min_minutos).toBeLessThanOrEqual(eta.max_minutos);
    expect(eta.min_minutos).toBeGreaterThanOrEqual(1);
  });

  it('distancia 0 → mínimo 1 minuto (nunca 0)', () => {
    const eta = calcularEta(0, 20);
    expect(eta.min_minutos).toBeGreaterThanOrEqual(1);
    expect(eta.max_minutos).toBeGreaterThan(eta.min_minutos);
  });
});
