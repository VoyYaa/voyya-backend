import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OPERATIONAL_PARAM_KEYS, type ServiceType } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OperationalParamsRepository } from './operational-params.repository';
import type {
  NullableOperationalValues,
  OperationalParamKey,
  OperationalParamsRow,
} from './service-config.types';

export interface OperationalParams {
  searchRadiusKm: number;
  expansionRadiusKm: number;
  acceptanceTimeoutSec: number;
  maxAutoRetries: number;
  tiebreakWindowHours: number;
  avgSpeedKmh: number;
  noShowGraceMin: number;
  locationStaleMin: number;
  cancellationWindowMin: number;
}

export interface OperationalParamsSnapshot {
  params: OperationalParams;
  values: Record<OperationalParamKey, number>;
  platformDefaultKeys: OperationalParamKey[];
  row: OperationalParamsRow | null;
}

@Injectable()
export class OperationalParamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OperationalParamsRepository,
    private readonly env: EnvService,
  ) {}

  async get(
    municipalityId: number,
    serviceType: ServiceType = 'taxi',
    tx?: Prisma.TransactionClient,
  ): Promise<OperationalParams> {
    return (await this.snapshot(municipalityId, serviceType, tx)).params;
  }

  async snapshot(
    municipalityId: number,
    serviceType: ServiceType,
    tx?: Prisma.TransactionClient,
  ): Promise<OperationalParamsSnapshot> {
    const row = await this.repo.findCurrent(tx ?? this.prisma, municipalityId, serviceType);
    return this.resolve(row);
  }

  resolve(row: OperationalParamsRow | null): OperationalParamsSnapshot {
    const stored: Partial<NullableOperationalValues> = row?.values ?? {};
    const defaults = this.platformDefaults();
    const platformDefaultKeys = OPERATIONAL_PARAM_KEYS.filter((key) => stored[key] == null);
    const values = Object.fromEntries(
      OPERATIONAL_PARAM_KEYS.map((key) => [key, stored[key] ?? defaults[key]]),
    ) as Record<OperationalParamKey, number>;
    return { params: toParams(values), values, platformDefaultKeys, row };
  }

  private platformDefaults(): Record<OperationalParamKey, number> {
    return {
      search_radius_km: this.env.get('SEARCH_RADIUS_KM'),
      expansion_radius_km: this.env.get('EXPANSION_RADIUS_KM'),
      acceptance_timeout_sec: this.env.get('ACCEPTANCE_TIMEOUT_SEC'),
      max_auto_retries: this.env.get('MAX_AUTO_RETRIES'),
      tiebreak_window_hours: this.env.get('TIEBREAK_WINDOW_HOURS'),
      location_stale_min: this.env.get('LOCATION_STALE_MIN'),
      avg_speed_kmh: this.env.get('AVG_SPEED_KMH'),
      cancellation_window_min: this.env.get('CANCELLATION_WINDOW_MIN'),
      no_show_grace_min: this.env.get('NO_SHOW_GRACE_MIN'),
    };
  }
}

function toParams(values: Record<OperationalParamKey, number>): OperationalParams {
  return {
    searchRadiusKm: values.search_radius_km,
    expansionRadiusKm: values.expansion_radius_km,
    acceptanceTimeoutSec: values.acceptance_timeout_sec,
    maxAutoRetries: values.max_auto_retries,
    tiebreakWindowHours: values.tiebreak_window_hours,
    avgSpeedKmh: values.avg_speed_kmh,
    noShowGraceMin: values.no_show_grace_min,
    locationStaleMin: values.location_stale_min,
    cancellationWindowMin: values.cancellation_window_min,
  };
}
