import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ConfigOrigin } from '@voyyaa/shared';
import type { CompanyCommissionRow, NewCompanyCommissionVersion } from './service-config.types';
import { authorName } from './version-history';

const COMMISSION_INCLUDE = {
  createdByUser: { select: { firstName: true, lastName: true } },
} as const;

type CommissionRecord = Prisma.CompanyCommissionGetPayload<{ include: typeof COMMISSION_INCLUDE }>;

@Injectable()
export class CompanyCommissionRepository {
  async findCurrent(tx: Prisma.TransactionClient, companyId: number): Promise<CompanyCommissionRow | null> {
    const row = await tx.companyCommission.findFirst({
      where: { companyId, validTo: null },
      include: COMMISSION_INCLUDE,
    });
    return row ? toCommissionRow(row) : null;
  }

  async listVersions(
    tx: Prisma.TransactionClient,
    companyId: number,
    before: number | null,
    take: number,
  ): Promise<CompanyCommissionRow[]> {
    const rows = await tx.companyCommission.findMany({
      where: {
        companyId,
        ...(before !== null ? { companyCommissionId: { lt: before } } : {}),
      },
      orderBy: { companyCommissionId: 'desc' },
      take,
      include: COMMISSION_INCLUDE,
    });
    return rows.map(toCommissionRow);
  }

  async listCurrentForCompanies(
    tx: Prisma.TransactionClient,
    companyIds: readonly number[],
  ): Promise<CompanyCommissionRow[]> {
    const rows = await tx.companyCommission.findMany({
      where: { companyId: { in: [...companyIds] }, validTo: null },
      include: COMMISSION_INCLUDE,
    });
    return rows.map(toCommissionRow);
  }

  async replaceOpenVersion(
    tx: Prisma.TransactionClient,
    expectedVersion: number,
    next: NewCompanyCommissionVersion,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      WITH closed AS (
        UPDATE tenancy.company_commission
           SET valid_to = GREATEST(valid_from, now() AT TIME ZONE 'UTC')
         WHERE company_commission_id = ${expectedVersion}
           AND company_id = ${next.companyId}
           AND valid_to IS NULL
        RETURNING valid_to
      )
      INSERT INTO tenancy.company_commission
        (company_id, commission_pct, origin, valid_from, created_by)
      SELECT ${next.companyId}, ${next.commissionPct}, ${next.origin}, closed.valid_to, ${next.createdBy}
        FROM closed
      RETURNING company_commission_id AS id`;
    return rows[0]?.id ?? null;
  }

  async insertIfNoOpenVersion(
    tx: Prisma.TransactionClient,
    next: NewCompanyCommissionVersion,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO tenancy.company_commission
        (company_id, commission_pct, origin, valid_from, created_by)
      VALUES (${next.companyId}, ${next.commissionPct}, ${next.origin}, now() AT TIME ZONE 'UTC', ${next.createdBy})
      ON CONFLICT (company_id) WHERE valid_to IS NULL DO NOTHING
      RETURNING company_commission_id AS id`;
    return rows[0]?.id ?? null;
  }
}

function toCommissionRow(row: CommissionRecord): CompanyCommissionRow {
  return {
    companyCommissionId: row.companyCommissionId,
    companyId: row.companyId,
    commissionPct: Number(row.commissionPct),
    origin: row.origin as ConfigOrigin,
    originCompanyName: null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    createdBy:
      row.createdBy !== null && row.createdByUser !== null
        ? { userId: row.createdBy, name: authorName(row.createdByUser) }
        : null,
  };
}
