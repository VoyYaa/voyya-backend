import * as shared from '@voyyaa/shared';
import { ZodObject, type ZodRawShape } from 'zod';

const FORBIDDEN_KEYS = ['start_code', 'startCode', 'driver_tracking', 'position', 'current_lat', 'current_lng'];

function eventSchemas(): Array<[string, ZodRawShape]> {
  return Object.entries(shared as Record<string, unknown>)
    .filter(([name, value]) => name.endsWith('Event') && value instanceof ZodObject)
    .map(([name, value]) => [name, (value as ZodObject<ZodRawShape>).shape]);
}

describe('event contracts never carry the start code or the driver position (ADR-033 section 1.5)', () => {
  it('finds the event schemas of the contract', () => {
    expect(eventSchemas().length).toBeGreaterThanOrEqual(10);
  });

  it.each(eventSchemas().map(([name, shape]) => [name, Object.keys(shape)] as const))(
    '%s has no sensitive key',
    (_name, keys) => {
      for (const forbidden of FORBIDDEN_KEYS) expect(keys).not.toContain(forbidden);
    },
  );

  it('the only coordinates an event may carry are the pickup origin of the created trip', () => {
    const withCoordinates = eventSchemas()
      .filter(([, shape]) => Object.keys(shape).some((key) => ['lat', 'lng', 'origin', 'destination'].includes(key)))
      .map(([name]) => name);

    expect(withCoordinates).toEqual(['TripRequestCreatedEvent']);
  });
});
