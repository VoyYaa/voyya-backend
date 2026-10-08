import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  addDays,
  type RecordRemittanceDTO,
  type RemittanceHistoryQuery,
  type RemittanceHistoryResponse,
  type RemittanceResult,
  type SettlementRemittanceEntry,
  type SettlementRemittanceSummary,
} from '@voyyaa/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { summarizeLedger, toRemittanceSummary } from './remittance-ledger';
import { SETTLEMENT_MESSAGES } from './settlement.messages';
import { type LedgerRow, SettlementRepository } from './settlement.repository';

export function toRemittanceEntry(row: LedgerRow): SettlementRemittanceEntry {
  return {
    remittance_id: row.remittanceId,
    driver_id: row.driverId,
    week_start: row.weekStart,
    kind: row.kind,
    amount: row.amount,
    recorded_by: { user_id: row.recordedBy.userId, name: row.recordedBy.name },
    recorded_at: row.recordedAt.toISOString(),
    reverses_remittance_id: row.reversesRemittanceId,
    reversed: row.reversed,
  };
}

@Injectable()
export class SettlementRemittanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SettlementRepository,
  ) {}

  record(companyId: number, userId: number, dto: RecordRemittanceDTO): Promise<RemittanceResult> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      await this.lockOwnedDriver(tx, companyId, dto.driver_id);
      const amountToRemit = await this.amountToRemit(tx, companyId, dto.driver_id, dto.week_start);
      const ledger = await this.repo.listLedger(tx, companyId, dto.week_start, [dto.driver_id]);
      const state = summarizeLedger(ledger);
      const balance = amountToRemit - state.remitted;

      if (balance <= 0) {
        const active = ledger.find((e) => e.remittanceId === state.lastActiveRemittanceId);
        if (!active) throw this.conflict('NOTHING_TO_REMIT', SETTLEMENT_MESSAGES.nothingToRemit);
        return this.result(active, true, toRemittanceSummary(state, amountToRemit));
      }
      if (dto.expected_amount !== balance) {
        throw this.conflict('SETTLEMENT_BALANCE_CHANGED', SETTLEMENT_MESSAGES.balanceChanged);
      }

      const entry = await this.repo.insertEntry(tx, {
        companyId,
        driverId: dto.driver_id,
        weekStart: dto.week_start,
        kind: 'remittance',
        amount: balance,
        reversesRemittanceId: null,
        recordedBy: userId,
      });
      const after = summarizeLedger([...ledger, entry]);
      return this.result(entry, false, toRemittanceSummary(after, amountToRemit));
    });
  }

  reverse(companyId: number, userId: number, remittanceId: number): Promise<RemittanceResult> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      const target = await this.repo.findEntry(tx, companyId, remittanceId);
      if (!target) {
        throw new NotFoundException({
          code: 'REMITTANCE_NOT_FOUND',
          message: SETTLEMENT_MESSAGES.remittanceNotFound,
        });
      }
      await this.lockOwnedDriver(tx, companyId, target.driverId);
      if (target.kind === 'reversal') {
        throw this.conflict('REMITTANCE_NOT_REVERSIBLE', SETTLEMENT_MESSAGES.remittanceNotReversible);
      }

      const existing = await this.repo.findReversalOf(tx, companyId, remittanceId);
      const reversal =
        existing ??
        (await this.repo.insertEntry(tx, {
          companyId,
          driverId: target.driverId,
          weekStart: target.weekStart,
          kind: 'reversal',
          amount: target.amount,
          reversesRemittanceId: target.remittanceId,
          recordedBy: userId,
        }));
      const summary = await this.summaryOf(tx, companyId, target);
      return this.result(reversal, existing !== null, summary);
    });
  }

  history(companyId: number, query: RemittanceHistoryQuery): Promise<RemittanceHistoryResponse> {
    return this.prisma.runInTenant(companyId, async (tx) => {
      const rows = await this.repo.listHistory(tx, companyId, query.driver_id, query.week_start);
      return { rows: rows.map(toRemittanceEntry) };
    });
  }

  private async summaryOf(
    tx: Prisma.TransactionClient,
    companyId: number,
    target: LedgerRow,
  ): Promise<SettlementRemittanceSummary> {
    const amountToRemit = await this.amountToRemit(tx, companyId, target.driverId, target.weekStart);
    const ledger = await this.repo.listLedger(tx, companyId, target.weekStart, [target.driverId]);
    return toRemittanceSummary(summarizeLedger(ledger), amountToRemit);
  }

  private async lockOwnedDriver(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverId: number,
  ): Promise<void> {
    if (!(await this.repo.lockDriver(tx, companyId, driverId))) {
      throw new NotFoundException({
        code: 'DRIVER_NOT_FOUND',
        message: SETTLEMENT_MESSAGES.driverNotFound,
      });
    }
  }

  private async amountToRemit(
    tx: Prisma.TransactionClient,
    companyId: number,
    driverId: number,
    weekStart: string,
  ): Promise<number> {
    const rows = await this.repo.aggregateByDriver(
      tx,
      companyId,
      weekStart,
      addDays(weekStart, 6),
      driverId,
    );
    return rows[0]?.commission ?? 0;
  }

  private result(
    row: LedgerRow,
    idempotent: boolean,
    summary: SettlementRemittanceSummary,
  ): RemittanceResult {
    return { entry: toRemittanceEntry(row), idempotent, summary };
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ code, message });
  }
}
