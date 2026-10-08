import { requireTripLocation } from './require-trip-location';

describe('requireTripLocation', () => {
  it('returns the value, including falsy ones', () => {
    expect(requireTripLocation('Calle 1')).toBe('Calle 1');
    expect(requireTripLocation(0)).toBe(0);
  });

  it('throws when the location was purged', () => {
    expect(() => requireTripLocation(null)).toThrow('purged');
  });
});
