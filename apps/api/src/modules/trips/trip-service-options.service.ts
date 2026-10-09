import { Injectable } from '@nestjs/common';
import type {
  ActivatableServiceType,
  TripServiceOption,
  TripServiceOptionsQuery,
  TripServiceOptionsResponse,
} from '@voyyaa/shared';
import { DriverAvailabilityService } from '../assignment/driver-availability.service';
import { OperationalParamsService } from '../service-config/operational-params.service';
import { ServiceCatalog } from '../service-config/service-catalog';
import { CompanyDirectory } from '../tenancy/company-directory';
import { TripsRepository } from './trips.repository';

@Injectable()
export class TripServiceOptionsService {
  constructor(
    private readonly repo: TripsRepository,
    private readonly catalog: ServiceCatalog,
    private readonly directory: CompanyDirectory,
    private readonly availability: DriverAvailabilityService,
    private readonly params: OperationalParamsService,
  ) {}

  async getOptions(query: TripServiceOptionsQuery): Promise<TripServiceOptionsResponse> {
    const municipality = await this.repo.findMunicipalityAtPoint(query.lng, query.lat);
    if (!municipality) return { municipality: null, services: [] };

    const services: TripServiceOption[] = [];
    for (const serviceType of this.catalog.activeServiceTypes()) {
      const option = await this.optionFor(municipality.municipalityId, serviceType);
      if (option) services.push(option);
    }
    return {
      municipality: { municipality_id: municipality.municipalityId, name: municipality.name },
      services,
    };
  }

  private async optionFor(
    municipalityId: number,
    serviceType: ActivatableServiceType,
  ): Promise<TripServiceOption | null> {
    const companies = await this.directory.listActive(municipalityId, serviceType);
    if (companies.length === 0) return null;

    const { locationStaleMin } = await this.params.get(municipalityId, serviceType);
    const options = await Promise.all(
      companies.map(async (company) => ({
        ...company,
        has_available_drivers: await this.availability.hasAvailableDrivers(
          company.company_id,
          locationStaleMin,
        ),
      })),
    );
    return {
      service_type: serviceType,
      selection_required: options.length >= 2,
      companies: options,
    };
  }
}
