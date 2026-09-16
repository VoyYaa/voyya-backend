import { Injectable } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface OperationalParams {
  searchRadiusKm: number;
  expansionRadiusKm: number;
  acceptanceTimeoutSec: number;
  maxAutoRetries: number;
  tiebreakWindowHours: number;
  avgSpeedKmh: number;
  noShowGraceMin: number;
  locationStaleMin: number;
}

@Injectable()
export class OperationalParamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async get(municipalityId: number): Promise<OperationalParams> {
    const rows = await this.prisma.systemParameter.findMany({
      where: { OR: [{ municipalityId }, { municipalityId: null }] },
    });

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.municipalityId === null && map.has(row.key)) continue;
      map.set(row.key, row.value);
    }

    const num = (key: string, fallback: number): number => {
      const v = map.get(key);
      if (v === undefined) return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    return {
      searchRadiusKm: num('search_radius_km', this.env.get('SEARCH_RADIUS_KM')),
      expansionRadiusKm: num('expansion_radius_km', this.env.get('EXPANSION_RADIUS_KM')),
      acceptanceTimeoutSec: num('acceptance_timeout_sec', this.env.get('ACCEPTANCE_TIMEOUT_SEC')),
      maxAutoRetries: num('max_auto_retries', this.env.get('MAX_AUTO_RETRIES')),
      tiebreakWindowHours: num('tiebreak_window_hours', this.env.get('TIEBREAK_WINDOW_HOURS')),
      avgSpeedKmh: num('avg_speed_kmh', this.env.get('AVG_SPEED_KMH')),
      noShowGraceMin: num('no_show_grace_min', this.env.get('NO_SHOW_GRACE_MIN')),
      locationStaleMin: num('location_stale_min', this.env.get('LOCATION_STALE_MIN')),
    };
  }
}
