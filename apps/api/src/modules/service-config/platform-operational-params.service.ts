import { Injectable } from '@nestjs/common';
import {
  OPERATIONAL_PARAM_KEYS,
  type ConfigHistoryQuery,
  type MunicipalityOperationalParams,
  type MunicipalityOperationalParamsHistory,
  type ServiceType,
  type UpdateMunicipalityOperationalParamsDTO,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isDeadlock } from '../../shared/deadlock';
import { OperationalParamsRepository } from './operational-params.repository';
import { OperationalParamsService } from './operational-params.service';
import { PlatformConfigQueryRepository } from './platform-config-query.repository';
import { ServiceCatalog } from './service-catalog';
import { municipalityNotFound, settingsConflict } from './service-config.errors';
import { toOperationalParamsDto } from './service-config.mappers';
import type { NullableOperationalValues } from './service-config.types';
import { pageVersions } from './version-history';

@Injectable()
export class PlatformOperationalParamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OperationalParamsRepository,
    private readonly resolver: OperationalParamsService,
    private readonly targets: PlatformConfigQueryRepository,
    private readonly catalog: ServiceCatalog,
  ) {}

  async history(
    municipalityId: number,
    serviceType: ServiceType,
    query: ConfigHistoryQuery,
  ): Promise<MunicipalityOperationalParamsHistory> {
    this.catalog.assertActive(serviceType);
    if (!(await this.targets.municipalityExists(this.prisma, municipalityId))) throw municipalityNotFound();

    const [current, rows] = await Promise.all([
      this.repo.findCurrent(this.prisma, municipalityId, serviceType),
      this.repo.listVersions(this.prisma, municipalityId, serviceType, query.before ?? null, query.limit + 1),
    ]);
    const page = pageVersions(rows, query.limit, (row) => row.operationalParamsId);
    return {
      server_time: new Date().toISOString(),
      current: toOperationalParamsDto(this.resolver.resolve(current), municipalityId, serviceType),
      versions: page.versions.map((row) =>
        toOperationalParamsDto(this.resolver.resolve(row), municipalityId, serviceType),
      ),
      next_before: page.nextBefore,
    };
  }

  async update(
    municipalityId: number,
    serviceType: ServiceType,
    dto: UpdateMunicipalityOperationalParamsDTO,
    userId: number,
  ): Promise<MunicipalityOperationalParams> {
    this.catalog.assertActive(serviceType);
    const next = {
      municipalityId,
      serviceType,
      values: pickValues(dto),
      origin: 'platform_edit' as const,
      originCompanyId: null,
      createdBy: userId,
    };
    try {
      return await this.prisma.runAsPlatform(async (tx) => {
        if (!(await this.targets.municipalityExists(tx, municipalityId))) throw municipalityNotFound();

        const newId =
          dto.version === null
            ? await this.repo.insertIfNoOpenVersion(tx, next)
            : await this.repo.replaceOpenVersion(tx, dto.version, next);
        if (newId === null) {
          const latest = await this.repo.findCurrent(tx, municipalityId, serviceType);
          throw settingsConflict({
            currentVersion: latest?.operationalParamsId ?? null,
            currentAuthorName: latest?.createdBy?.name ?? null,
          });
        }
        const snapshot = await this.resolver.snapshot(municipalityId, serviceType, tx);
        return toOperationalParamsDto(snapshot, municipalityId, serviceType);
      });
    } catch (error) {
      if (isDeadlock(error)) throw settingsConflict();
      throw error;
    }
  }
}

function pickValues(dto: UpdateMunicipalityOperationalParamsDTO): NullableOperationalValues {
  return Object.fromEntries(
    OPERATIONAL_PARAM_KEYS.map((key) => [key, dto[key]]),
  ) as NullableOperationalValues;
}
