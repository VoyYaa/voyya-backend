import { Injectable } from '@nestjs/common';
import type { PlatformServiceConfigListResponse, PlatformServiceConfigRow, ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MunicipalityFareRepository } from './municipality-fare.repository';
import { OperationalParamsRepository } from './operational-params.repository';
import { OperationalParamsService } from './operational-params.service';
import { type ActiveCompanyRef, PlatformConfigQueryRepository } from './platform-config-query.repository';
import { ServiceCatalog } from './service-catalog';
import { toFareDto, toOperationalParamsDto } from './service-config.mappers';

interface ConfigTarget {
  company: ActiveCompanyRef;
  serviceType: ServiceType;
  companyCount: number;
}

@Injectable()
export class PlatformServiceConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fares: MunicipalityFareRepository,
    private readonly params: OperationalParamsRepository,
    private readonly resolver: OperationalParamsService,
    private readonly targets: PlatformConfigQueryRepository,
    private readonly catalog: ServiceCatalog,
  ) {}

  async list(municipalityId: number | null): Promise<PlatformServiceConfigListResponse> {
    const companies = await this.targets.listActiveCompanies(this.prisma, municipalityId);
    const configTargets = this.configTargets(companies);
    const municipalityIds = [...new Set(configTargets.map((target) => target.company.municipality.municipalityId))];
    const [fares, params] = await Promise.all([
      this.fares.listCurrentForMunicipalities(this.prisma, municipalityIds),
      this.params.listCurrentForMunicipalities(this.prisma, municipalityIds),
    ]);
    const fareByKey = new Map(fares.map((fare) => [`${fare.municipalityId}:${fare.serviceType}`, fare]));
    const paramsByKey = new Map(params.map((row) => [`${row.municipalityId}:${row.serviceType}`, row]));

    const rows = configTargets.map((target): PlatformServiceConfigRow => {
      const { municipality } = target.company;
      const key = `${municipality.municipalityId}:${target.serviceType}`;
      const fare = fareByKey.get(key);
      return {
        municipality_id: municipality.municipalityId,
        municipality_name: municipality.name,
        department: municipality.department,
        dane_code: municipality.daneCode,
        coverage_active: municipality.coverageActive,
        service_type: target.serviceType,
        active_company_count: target.companyCount,
        fare: fare ? toFareDto(fare) : null,
        operational_params: toOperationalParamsDto(
          this.resolver.resolve(paramsByKey.get(key) ?? null),
          municipality.municipalityId,
          target.serviceType,
        ),
      };
    });
    return { server_time: new Date().toISOString(), rows };
  }

  private configTargets(companies: readonly ActiveCompanyRef[]): ConfigTarget[] {
    const grouped = new Map<string, ConfigTarget>();
    for (const company of companies) {
      for (const serviceType of this.catalog.activeServiceTypes()) {
        if (!company.serviceTypes.includes(serviceType)) continue;
        const key = `${company.municipality.municipalityId}:${serviceType}`;
        const existing = grouped.get(key);
        if (existing) existing.companyCount += 1;
        else grouped.set(key, { company, serviceType, companyCount: 1 });
      }
    }
    const collator = new Intl.Collator('es-CO', { sensitivity: 'base' });
    return [...grouped.values()].sort(
      (a, b) =>
        collator.compare(a.company.municipality.department, b.company.municipality.department) ||
        collator.compare(a.company.municipality.name, b.company.municipality.name) ||
        a.serviceType.localeCompare(b.serviceType),
    );
  }
}
