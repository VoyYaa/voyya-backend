import { Injectable } from '@nestjs/common';
import type {
  ConfigHistoryQuery,
  MunicipalityFare,
  MunicipalityFareHistory,
  ServiceType,
  UpdateMunicipalityFareDTO,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isDeadlock } from '../../shared/deadlock';
import { MunicipalityFareRepository } from './municipality-fare.repository';
import { PlatformConfigQueryRepository } from './platform-config-query.repository';
import { ServiceCatalog } from './service-catalog';
import {
  fareNotFound,
  municipalityNotFound,
  settingsConflict,
} from './service-config.errors';
import { toFareDto } from './service-config.mappers';
import { pageVersions } from './version-history';

@Injectable()
export class PlatformFareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MunicipalityFareRepository,
    private readonly targets: PlatformConfigQueryRepository,
    private readonly catalog: ServiceCatalog,
  ) {}

  async history(
    municipalityId: number,
    serviceType: ServiceType,
    query: ConfigHistoryQuery,
  ): Promise<MunicipalityFareHistory> {
    this.catalog.assertActive(serviceType);
    if (!(await this.targets.municipalityExists(this.prisma, municipalityId))) throw municipalityNotFound();

    const [current, rows] = await Promise.all([
      this.repo.findCurrent(this.prisma, municipalityId, serviceType),
      this.repo.listVersions(this.prisma, municipalityId, serviceType, query.before ?? null, query.limit + 1),
    ]);
    const page = pageVersions(rows, query.limit, (row) => row.municipalityFareId);
    return {
      server_time: new Date().toISOString(),
      current: current ? toFareDto(current) : null,
      versions: page.versions.map(toFareDto),
      next_before: page.nextBefore,
    };
  }

  async update(
    municipalityId: number,
    serviceType: ServiceType,
    dto: UpdateMunicipalityFareDTO,
    userId: number,
  ): Promise<MunicipalityFare> {
    this.catalog.assertActive(serviceType);
    try {
      return await this.prisma.runAsPlatform(async (tx) => {
        if (!(await this.targets.municipalityExists(tx, municipalityId))) throw municipalityNotFound();
        const current = await this.repo.findCurrent(tx, municipalityId, serviceType);
        if (!current) throw fareNotFound();

        const newId = await this.repo.replaceOpenVersion(tx, dto.version, {
          municipalityId,
          serviceType,
          baseFare: dto.base_fare,
          nightSurchargePct: dto.night_surcharge_pct,
          holidaySurchargePct: dto.holiday_surcharge_pct,
          isOfficial: dto.is_official,
          officialReference: dto.is_official ? (dto.official_reference ?? null) : null,
          origin: 'platform_edit',
          originCompanyId: null,
          createdBy: userId,
        });
        if (newId === null) {
          const latest = await this.repo.findCurrent(tx, municipalityId, serviceType);
          throw settingsConflict({
            currentVersion: latest?.municipalityFareId ?? null,
            currentAuthorName: latest?.createdBy?.name ?? null,
          });
        }
        const created = await this.repo.findById(tx, newId);
        if (!created) throw new Error('The new municipality fare version could not be read back');
        return toFareDto(created);
      });
    } catch (error) {
      if (isDeadlock(error)) throw settingsConflict();
      throw error;
    }
  }
}
