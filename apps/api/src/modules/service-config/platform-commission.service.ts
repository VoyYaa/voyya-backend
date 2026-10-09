import { Injectable } from '@nestjs/common';
import type {
  CompanyCommission,
  CompanyCommissionHistory,
  ConfigHistoryQuery,
  PlatformCommissionListResponse,
  UpdateCompanyCommissionDTO,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isDeadlock } from '../../shared/deadlock';
import { CompanyCommissionRepository } from './company-commission.repository';
import { PlatformConfigQueryRepository } from './platform-config-query.repository';
import { companyNotFound, settingsConflict } from './service-config.errors';
import { toCommissionDto } from './service-config.mappers';
import { pageVersions } from './version-history';

@Injectable()
export class PlatformCommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: CompanyCommissionRepository,
    private readonly targets: PlatformConfigQueryRepository,
  ) {}

  async list(): Promise<PlatformCommissionListResponse> {
    return this.prisma.runAsPlatform(async (tx) => {
      const companies = await this.targets.listActiveCompanies(tx, null);
      const commissions = await this.repo.listCurrentForCompanies(
        tx,
        companies.map((company) => company.companyId),
      );
      const byCompany = new Map(commissions.map((commission) => [commission.companyId, commission]));
      return {
        server_time: new Date().toISOString(),
        rows: companies.map((company) => {
          const commission = byCompany.get(company.companyId);
          return {
            company_id: company.companyId,
            legal_name: company.legalName,
            display_name: company.publicName ?? company.legalName,
            municipality_id: company.municipality.municipalityId,
            municipality_name: company.municipality.name,
            commission: commission ? toCommissionDto(commission) : null,
          };
        }),
      };
    });
  }

  async history(companyId: number, query: ConfigHistoryQuery): Promise<CompanyCommissionHistory> {
    return this.prisma.runAsPlatform(async (tx) => {
      if (!(await this.targets.companyExists(tx, companyId))) throw companyNotFound();
      const [current, rows] = await Promise.all([
        this.repo.findCurrent(tx, companyId),
        this.repo.listVersions(tx, companyId, query.before ?? null, query.limit + 1),
      ]);
      const page = pageVersions(rows, query.limit, (row) => row.companyCommissionId);
      return {
        server_time: new Date().toISOString(),
        current: current ? toCommissionDto(current) : null,
        versions: page.versions.map(toCommissionDto),
        next_before: page.nextBefore,
      };
    });
  }

  async update(
    companyId: number,
    dto: UpdateCompanyCommissionDTO,
    userId: number,
  ): Promise<CompanyCommission> {
    const next = {
      companyId,
      commissionPct: dto.commission_pct,
      origin: 'platform_edit' as const,
      createdBy: userId,
    };
    try {
      return await this.prisma.runAsPlatform(async (tx) => {
        if (!(await this.targets.companyExists(tx, companyId))) throw companyNotFound();

        const newId =
          dto.version === null
            ? await this.repo.insertIfNoOpenVersion(tx, next)
            : await this.repo.replaceOpenVersion(tx, dto.version, next);
        const latest = await this.repo.findCurrent(tx, companyId);
        if (newId === null || !latest) {
          throw settingsConflict({
            currentVersion: latest?.companyCommissionId ?? null,
            currentAuthorName: latest?.createdBy?.name ?? null,
          });
        }
        return toCommissionDto(latest);
      });
    } catch (error) {
      if (isDeadlock(error)) throw settingsConflict();
      throw error;
    }
  }
}
