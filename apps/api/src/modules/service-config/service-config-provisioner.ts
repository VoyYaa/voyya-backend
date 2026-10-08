import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ServiceType } from '@voyyaa/shared';
import { CompanyCommissionRepository } from './company-commission.repository';
import { MunicipalityFareRepository } from './municipality-fare.repository';
import { OperationalParamsRepository } from './operational-params.repository';
import { municipalityFareRequired } from './service-config.errors';
import type { NullableOperationalValues } from './service-config.types';

export const DEFAULT_NIGHT_SURCHARGE_PCT = 20;
export const DEFAULT_HOLIDAY_SURCHARGE_PCT = 15;

const PLATFORM_DEFAULT_PARAMS: NullableOperationalValues = {
  search_radius_km: null,
  expansion_radius_km: null,
  acceptance_timeout_sec: null,
  max_auto_retries: null,
  tiebreak_window_hours: null,
  location_stale_min: null,
  avg_speed_kmh: null,
  cancellation_window_min: null,
  no_show_grace_min: null,
};

export interface InitialMunicipalityFare {
  baseFare: number;
  nightSurchargePct?: number;
  holidaySurchargePct?: number;
}

export interface EnsureForApprovalInput {
  companyId: number;
  municipalityId: number;
  serviceTypes: readonly ServiceType[];
  initialFare: InitialMunicipalityFare | null;
  commissionPct: number;
  createdBy: number | null;
}

export interface ProvisionedMunicipalityFare {
  serviceType: ServiceType;
  municipalityFareId: number;
  created: boolean;
}

export interface ProvisionedServiceConfig {
  municipalityFares: ProvisionedMunicipalityFare[];
  companyCommissionId: number;
}

@Injectable()
export class ServiceConfigProvisioner {
  constructor(
    private readonly fares: MunicipalityFareRepository,
    private readonly params: OperationalParamsRepository,
    private readonly commissions: CompanyCommissionRepository,
  ) {}

  async ensureForApproval(
    tx: Prisma.TransactionClient,
    input: EnsureForApprovalInput,
  ): Promise<ProvisionedServiceConfig> {
    const municipalityFares: ProvisionedMunicipalityFare[] = [];
    for (const serviceType of [...input.serviceTypes].sort()) {
      municipalityFares.push(await this.ensureFare(tx, input, serviceType));
      await this.ensureParams(tx, input, serviceType);
    }
    const companyCommissionId = await this.ensureCommission(tx, input);
    return { municipalityFares, companyCommissionId };
  }

  private async ensureFare(
    tx: Prisma.TransactionClient,
    input: EnsureForApprovalInput,
    serviceType: ServiceType,
  ): Promise<ProvisionedMunicipalityFare> {
    const existing = await this.fares.findCurrent(tx, input.municipalityId, serviceType);
    if (existing) return { serviceType, municipalityFareId: existing.municipalityFareId, created: false };
    if (!input.initialFare) throw municipalityFareRequired();

    const insertedId = await this.fares.insertIfNoOpenVersion(tx, {
      municipalityId: input.municipalityId,
      serviceType,
      baseFare: input.initialFare.baseFare,
      nightSurchargePct: input.initialFare.nightSurchargePct ?? DEFAULT_NIGHT_SURCHARGE_PCT,
      holidaySurchargePct: input.initialFare.holidaySurchargePct ?? DEFAULT_HOLIDAY_SURCHARGE_PCT,
      isOfficial: false,
      officialReference: null,
      origin: 'company_approval',
      originCompanyId: input.companyId,
      createdBy: input.createdBy,
    });
    if (insertedId !== null) return { serviceType, municipalityFareId: insertedId, created: true };

    const winner = await this.fares.findCurrent(tx, input.municipalityId, serviceType);
    if (!winner) throw municipalityFareRequired();
    return { serviceType, municipalityFareId: winner.municipalityFareId, created: false };
  }

  private async ensureParams(
    tx: Prisma.TransactionClient,
    input: EnsureForApprovalInput,
    serviceType: ServiceType,
  ): Promise<void> {
    await this.params.insertIfNoOpenVersion(tx, {
      municipalityId: input.municipalityId,
      serviceType,
      values: PLATFORM_DEFAULT_PARAMS,
      origin: 'company_approval',
      originCompanyId: input.companyId,
      createdBy: input.createdBy,
    });
  }

  private async ensureCommission(tx: Prisma.TransactionClient, input: EnsureForApprovalInput): Promise<number> {
    const next = {
      companyId: input.companyId,
      commissionPct: input.commissionPct,
      origin: 'company_approval' as const,
      createdBy: input.createdBy,
    };
    const current = await this.commissions.findCurrent(tx, input.companyId);
    const id = current
      ? await this.commissions.replaceOpenVersion(tx, current.companyCommissionId, next)
      : await this.commissions.insertIfNoOpenVersion(tx, next);
    if (id === null) throw new Error('The company commission could not be written during approval');
    return id;
  }
}
