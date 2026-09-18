import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ConsoleSettings, UpdateConsoleSettingsDTO } from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  AdminSettingsRepository,
  type ActiveFareConfigRow,
  type SystemParameterRow,
} from './admin-settings.repository';

const SEARCH_RADIUS_KEY = 'search_radius_km';
const ACCEPTANCE_TIMEOUT_KEY = 'acceptance_timeout_sec';
const EXPANSION_RADIUS_KEY = 'expansion_radius_km';
const ALL_KEYS = [SEARCH_RADIUS_KEY, ACCEPTANCE_TIMEOUT_KEY, EXPANSION_RADIUS_KEY] as const;

interface ResolvedParam {
  value: number;
  updatedAt: Date;
}

interface ResolvedParams {
  searchRadiusKm: ResolvedParam;
  acceptanceTimeoutSec: ResolvedParam;
  expansionRadiusKm: ResolvedParam;
}

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AdminSettingsRepository,
    private readonly env: EnvService,
  ) {}

  async get(companyId: number): Promise<ConsoleSettings> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      const fareConfig = await this.repo.getActiveFareConfig(tx, companyId);
      if (!fareConfig) throw this.fareConfigNotFound();
      const rows = await this.repo.getParameters(tx, companyId, ALL_KEYS);
      return this.compose(fareConfig, this.resolveParams(rows));
    });
  }

  async update(
    companyId: number,
    userId: number,
    dto: UpdateConsoleSettingsDTO,
  ): Promise<ConsoleSettings> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      const fareConfig = await this.repo.getActiveFareConfig(tx, companyId);
      if (!fareConfig) throw this.fareConfigNotFound();

      const rows = await this.repo.getParameters(tx, companyId, ALL_KEYS);
      const resolved = this.resolveParams(rows);

      const currentVersion = this.buildVersion(fareConfig.fareConfigId, resolved);
      if (currentVersion !== dto.version) {
        throw this.settingsConflict();
      }

      if (dto.search_radius_km > resolved.expansionRadiusKm.value) {
        throw new UnprocessableEntityException({
          code: 'SETTINGS_OUT_OF_RANGE',
          message: 'El radio de búsqueda no puede superar el radio de expansión vigente',
          field: 'search_radius_km',
        });
      }

      const fareChanged =
        dto.base_fare !== fareConfig.baseFare ||
        dto.night_surcharge_pct !== fareConfig.nightSurchargePct ||
        dto.holiday_surcharge_pct !== fareConfig.holidaySurchargePct;

      const newFareConfig = fareChanged
        ? await this.insertFareConfigVersion(tx, companyId, fareConfig, dto, userId)
        : fareConfig;

      await this.repo.upsertParameters(
        tx,
        companyId,
        [
          { key: SEARCH_RADIUS_KEY, value: String(dto.search_radius_km) },
          { key: ACCEPTANCE_TIMEOUT_KEY, value: String(dto.acceptance_timeout_sec) },
        ],
        userId,
      );

      const updatedRows = await this.repo.getParameters(tx, companyId, ALL_KEYS);
      return this.compose(newFareConfig, this.resolveParams(updatedRows));
    });
  }

  private async insertFareConfigVersion(
    tx: Prisma.TransactionClient,
    companyId: number,
    fareConfig: ActiveFareConfigRow,
    dto: UpdateConsoleSettingsDTO,
    userId: number,
  ): Promise<ActiveFareConfigRow> {
    let inserted: ActiveFareConfigRow | null;
    try {
      inserted = await this.repo.closeAndInsertFareConfig(
        tx,
        companyId,
        fareConfig.fareConfigId,
        {
          baseFare: dto.base_fare,
          nightSurchargePct: dto.night_surcharge_pct,
          holidaySurchargePct: dto.holiday_surcharge_pct,
          commissionPct: fareConfig.commissionPct,
        },
        userId,
      );
    } catch (error) {
      if (isUniqueOpenFareConfigViolation(error)) {
        throw this.settingsConflict();
      }
      throw error;
    }
    if (!inserted) {
      throw this.settingsConflict();
    }
    return inserted;
  }

  private fareConfigNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'FARE_CONFIG_NOT_FOUND',
      message: 'No hay tarifa vigente configurada para este municipio',
    });
  }

  private settingsConflict(): ConflictException {
    return new ConflictException({
      code: 'SETTINGS_CONFLICT',
      message: 'Alguien más actualizó los parámetros mientras editabas',
    });
  }

  private resolveParams(rows: SystemParameterRow[]): ResolvedParams {
    return {
      searchRadiusKm: this.resolveParam(rows, SEARCH_RADIUS_KEY, this.env.get('SEARCH_RADIUS_KM')),
      acceptanceTimeoutSec: this.resolveParam(
        rows,
        ACCEPTANCE_TIMEOUT_KEY,
        this.env.get('ACCEPTANCE_TIMEOUT_SEC'),
      ),
      expansionRadiusKm: this.resolveParam(
        rows,
        EXPANSION_RADIUS_KEY,
        this.env.get('EXPANSION_RADIUS_KM'),
      ),
    };
  }

  private resolveParam(
    rows: SystemParameterRow[],
    key: string,
    fallback: number,
  ): ResolvedParam {
    const row = rows.find((r) => r.key === key);
    if (!row) return { value: fallback, updatedAt: new Date(0) };
    const n = Number(row.value);
    return { value: Number.isFinite(n) ? n : fallback, updatedAt: row.updatedAt };
  }

  private buildVersion(fareConfigId: number, resolved: ResolvedParams): string {
    const ms = Math.max(
      resolved.searchRadiusKm.updatedAt.getTime(),
      resolved.acceptanceTimeoutSec.updatedAt.getTime(),
    );
    return `fc:${fareConfigId}|sp:${ms}`;
  }

  private compose(fareConfig: ActiveFareConfigRow, resolved: ResolvedParams): ConsoleSettings {
    const lastChangeMs = Math.max(
      resolved.searchRadiusKm.updatedAt.getTime(),
      resolved.acceptanceTimeoutSec.updatedAt.getTime(),
      fareConfig.createdAt.getTime(),
    );
    return {
      version: this.buildVersion(fareConfig.fareConfigId, resolved),
      base_fare: fareConfig.baseFare,
      night_surcharge_pct: fareConfig.nightSurchargePct,
      holiday_surcharge_pct: fareConfig.holidaySurchargePct,
      commission_pct: fareConfig.commissionPct,
      search_radius_km: resolved.searchRadiusKm.value,
      expansion_radius_km: resolved.expansionRadiusKm.value,
      acceptance_timeout_sec: resolved.acceptanceTimeoutSec.value,
      updated_at: lastChangeMs === 0 ? null : new Date(lastChangeMs).toISOString(),
    };
  }
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

function isUniqueOpenFareConfigViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    (error.meta as { code?: string } | undefined)?.code === POSTGRES_UNIQUE_VIOLATION
  );
}
