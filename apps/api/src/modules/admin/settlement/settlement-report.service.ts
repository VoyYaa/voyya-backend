import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SettlementReportQuery, SettlementReportResponse } from '@voyyaa/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { buildSettlementReport, weekStartOfRange } from './settlement-report.builder';
import { buildSettlementCsv, settlementCsvFilename } from './settlement-csv.writer';
import { SettlementRepository } from './settlement.repository';

export interface SettlementCsvFile {
  filename: string;
  content: string;
}

@Injectable()
export class SettlementReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SettlementRepository,
  ) {}

  getReport(companyId: number, query: SettlementReportQuery): Promise<SettlementReportResponse> {
    return this.prisma.runInTenant(companyId, (tx) => this.generate(tx, companyId, query));
  }

  exportCsv(
    companyId: number,
    userId: number,
    query: SettlementReportQuery,
  ): Promise<SettlementCsvFile> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      const report = await this.generate(tx, companyId, query);
      const companyName = await this.repo.getCompanyName(tx, companyId);
      await this.repo.insertExport(tx, {
        companyId,
        exportedBy: userId,
        from: query.from,
        to: query.to,
        driverId: query.driver_id ?? null,
        rowCount: report.rows.length,
      });
      return {
        filename: settlementCsvFilename(companyName, query.from, query.to),
        content: buildSettlementCsv(companyName, report),
      };
    });
  }

  private async generate(
    tx: Prisma.TransactionClient,
    companyId: number,
    query: SettlementReportQuery,
  ): Promise<SettlementReportResponse> {
    const aggregates = await this.repo.aggregateByDriver(
      tx,
      companyId,
      query.from,
      query.to,
      query.driver_id ?? null,
    );
    const driverIds = aggregates.map((a) => a.driverId);
    const identities = await this.repo.findDriverIdentities(tx, companyId, driverIds);
    const weekStart = weekStartOfRange(query);
    const ledger = weekStart ? await this.repo.listLedger(tx, companyId, weekStart, driverIds) : [];
    return buildSettlementReport({ query, now: new Date(), aggregates, identities, ledger });
  }
}
