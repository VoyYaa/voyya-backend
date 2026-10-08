import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ConsoleSettings } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CompanyCommissionReader } from '../service-config/company-commission.reader';
import { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import { OperationalParamsService } from '../service-config/operational-params.service';
import { SERVICE_CONFIG_MESSAGES } from '../service-config/service-config.messages';
import { CompanyMunicipalityResolver } from './company-municipality.resolver';

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: CompanyMunicipalityResolver,
    private readonly fares: MunicipalityFareReader,
    private readonly params: OperationalParamsService,
    private readonly commissions: CompanyCommissionReader,
  ) {}

  async get(companyId: number): Promise<ConsoleSettings> {
    const { municipalityId, serviceType } = await this.scopes.resolve(companyId);
    return this.prisma.runInTenant(companyId, async (tx) => {
      const fare = await this.fares.getCurrent(municipalityId, serviceType, tx);
      if (!fare) {
        throw new NotFoundException({
          code: 'FARE_CONFIG_NOT_FOUND',
          message: 'No hay tarifa vigente configurada para este municipio',
        });
      }
      const snapshot = await this.params.snapshot(municipalityId, serviceType, tx);
      const commission = await this.commissions.getCurrent(tx, companyId);
      const paramsRow = snapshot.row;
      const lastChange = Math.max(fare.validFrom.getTime(), paramsRow?.validFrom.getTime() ?? 0);
      const values = snapshot.values;

      return {
        version: `mf:${fare.municipalityFareId}|op:${paramsRow?.operationalParamsId ?? 0}`,
        base_fare: fare.baseFare,
        night_surcharge_pct: fare.nightSurchargePct,
        holiday_surcharge_pct: fare.holidaySurchargePct,
        commission_pct: commission?.commissionPct ?? 0,
        search_radius_km: values.search_radius_km,
        expansion_radius_km: values.expansion_radius_km,
        acceptance_timeout_sec: values.acceptance_timeout_sec,
        updated_at: new Date(lastChange).toISOString(),
        read_only: true,
        service_type: serviceType,
        fare_is_official: fare.isOfficial,
        fare_official_reference: fare.officialReference,
        fare_valid_from: fare.validFrom.toISOString(),
        max_auto_retries: values.max_auto_retries,
        tiebreak_window_hours: values.tiebreak_window_hours,
        location_stale_min: values.location_stale_min,
        avg_speed_kmh: values.avg_speed_kmh,
        cancellation_window_min: values.cancellation_window_min,
        no_show_grace_min: values.no_show_grace_min,
      };
    });
  }

  rejectUpdate(): never {
    throw new ForbiddenException({
      code: 'SETTINGS_MANAGED_BY_PLATFORM',
      message: SERVICE_CONFIG_MESSAGES.managedByPlatform,
    });
  }
}
