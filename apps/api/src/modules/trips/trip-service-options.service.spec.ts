import type { DriverAvailabilityService } from '../assignment/driver-availability.service';
import type { OperationalParamsService } from '../service-config/operational-params.service';
import type { ServiceCatalog } from '../service-config/service-catalog';
import type { CompanyDirectory } from '../tenancy/company-directory';
import { TripServiceOptionsService } from './trip-service-options.service';
import type { TripsRepository } from './trips.repository';

interface Setup {
  municipality?: { municipalityId: number; name: string } | null;
  companies?: Array<{ company_id: number; display_name: string }>;
  available?: Record<number, boolean>;
  active?: Array<'taxi'>;
}

function build(setup: Setup) {
  const availability = jest.fn(async (companyId: number) => setup.available?.[companyId] ?? false);
  const listActive = jest.fn(async () => setup.companies ?? []);
  const service = new TripServiceOptionsService(
    { findMunicipalityAtPoint: async () => setup.municipality ?? null } as unknown as TripsRepository,
    { activeServiceTypes: () => setup.active ?? ['taxi'] } as unknown as ServiceCatalog,
    { listActive } as unknown as CompanyDirectory,
    { hasAvailableDrivers: availability } as unknown as DriverAvailabilityService,
    { get: async () => ({ locationStaleMin: 15 }) } as unknown as OperationalParamsService,
  );
  return { service, availability, listActive };
}

const POINT = { lat: 6.96, lng: -75.42 };

describe('TripServiceOptionsService', () => {
  it('a point outside any active coverage -> municipality null and no services', async () => {
    const { service, listActive } = build({ municipality: null });

    await expect(service.getOptions(POINT)).resolves.toEqual({ municipality: null, services: [] });
    expect(listActive).not.toHaveBeenCalled();
  });

  it('a municipality with no company offering the service -> no services yet', async () => {
    const { service } = build({ municipality: { municipalityId: 3, name: 'Yarumal' }, companies: [] });

    await expect(service.getOptions(POINT)).resolves.toEqual({
      municipality: { municipality_id: 3, name: 'Yarumal' },
      services: [],
    });
  });

  it('one company -> selection not required', async () => {
    const { service } = build({
      municipality: { municipalityId: 3, name: 'Yarumal' },
      companies: [{ company_id: 1, display_name: 'Cootrayal' }],
      available: { 1: true },
    });

    const result = await service.getOptions(POINT);

    expect(result.services).toEqual([
      {
        service_type: 'taxi',
        selection_required: false,
        companies: [{ company_id: 1, display_name: 'Cootrayal', has_available_drivers: true }],
      },
    ]);
  });

  it('two or more companies -> selection required and availability per company, keeping the directory order', async () => {
    const { service, availability } = build({
      municipality: { municipalityId: 3, name: 'Yarumal' },
      companies: [
        { company_id: 7, display_name: 'Alfa' },
        { company_id: 2, display_name: 'Beta' },
      ],
      available: { 7: false, 2: true },
    });

    const [taxi] = (await service.getOptions(POINT)).services;

    expect(taxi?.selection_required).toBe(true);
    expect(taxi?.companies.map((company) => [company.company_id, company.has_available_drivers])).toEqual([
      [7, false],
      [2, true],
    ]);
    expect(availability).toHaveBeenCalledWith(7, 15);
    expect(availability).toHaveBeenCalledWith(2, 15);
  });
});
