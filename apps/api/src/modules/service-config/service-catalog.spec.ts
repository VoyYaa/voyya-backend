import { ConflictException } from '@nestjs/common';
import type { EnvService } from '../../config/env.service';
import { ServiceCatalog } from './service-catalog';

function create(active: string[]): ServiceCatalog {
  return new ServiceCatalog({ get: () => active } as unknown as EnvService);
}

describe('ServiceCatalog', () => {
  it('lists the services of ACTIVE_SERVICE_TYPES', () => {
    expect(create(['taxi', 'comfort']).activeServiceTypes()).toEqual(['taxi', 'comfort']);
  });

  it('only taxi is active by default and the others are not', () => {
    const catalog = create(['taxi']);

    expect(catalog.isActive('taxi')).toBe(true);
    expect(catalog.isActive('comfort')).toBe(false);
    expect(catalog.isActive('delivery')).toBe(false);
    expect(catalog.isActive('motorcycle')).toBe(false);
  });

  it('assertActive answers 409 SERVICE_NOT_AVAILABLE for an inactive service', () => {
    let thrown: unknown;
    try {
      create(['taxi']).assertActive('comfort');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });
  });

  it('assertAllActive fails on the first inactive service and accepts a subset of the active ones', () => {
    const catalog = create(['taxi', 'comfort']);

    expect(() => catalog.assertAllActive(['taxi', 'comfort'])).not.toThrow();
    expect(() => catalog.assertAllActive(['taxi', 'delivery'])).toThrow(ConflictException);
  });

  it('motorcycle is never active even if it reached the list', () => {
    expect(() => create(['taxi']).assertAllActive(['motorcycle'])).toThrow(ConflictException);
  });
});
