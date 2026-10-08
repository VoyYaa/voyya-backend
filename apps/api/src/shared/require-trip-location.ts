export function requireTripLocation<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Trip location was purged on a trip that still needs it');
  }
  return value;
}
