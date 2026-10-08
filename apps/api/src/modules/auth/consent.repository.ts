import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ConsentPurpose,
  type ConsentStatus,
  type NoticeVersion,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { buildConsentStatus, type ConsentLedgerEntry } from './consent-status';

const CONSENT_LOCK_NAMESPACE = 91_100;

const ledgerSelect = { action: true, noticeVersion: true, recordedAt: true } as const;

@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async grant(
    userId: number,
    purpose: ConsentPurpose,
    noticeVersion: NoticeVersion,
  ): Promise<ConsentStatus> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONSENT_LOCK_NAMESPACE}::int, ${userId}::int)`;
      const latest = await this.latestEntry(tx, userId, purpose);
      const alreadyGranted =
        latest !== null && latest.action === 'granted' && latest.noticeVersion === noticeVersion;
      if (!alreadyGranted) {
        await tx.consentRecord.create({
          data: { userId, purpose, noticeVersion, action: 'granted' },
        });
      }
      return this.statusFor(tx, userId, purpose);
    });
  }

  async list(userId: number): Promise<ConsentStatus[]> {
    return this.prisma.$transaction((tx) =>
      Promise.all(ConsentPurpose.options.map((purpose) => this.statusFor(tx, userId, purpose))),
    );
  }

  private async statusFor(
    tx: Prisma.TransactionClient,
    userId: number,
    purpose: ConsentPurpose,
  ): Promise<ConsentStatus> {
    const [latest, latestGranted] = await Promise.all([
      this.latestEntry(tx, userId, purpose),
      this.latestEntry(tx, userId, purpose, 'granted'),
    ]);
    return buildConsentStatus(purpose, latest, latestGranted);
  }

  private async latestEntry(
    tx: Prisma.TransactionClient,
    userId: number,
    purpose: ConsentPurpose,
    action?: 'granted' | 'revoked',
  ): Promise<ConsentLedgerEntry | null> {
    return tx.consentRecord.findFirst({
      where: { userId, purpose, ...(action ? { action } : {}) },
      orderBy: [{ recordedAt: 'desc' }, { consentRecordId: 'desc' }],
      select: ledgerSelect,
    });
  }
}
