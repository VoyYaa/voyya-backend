import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ConsentPurpose,
  type ConsentStatus,
  type NoticeAudience,
  type NoticeVersion,
} from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { buildConsentStatus, type ConsentLedgerEntry } from './consent-status';

const CONSENT_LOCK_NAMESPACE = 91_100;

const ledgerSelect = {
  action: true,
  noticeVersion: true,
  audience: true,
  recordedAt: true,
} as const;

type LedgerRow = ConsentLedgerEntry & { audience: NoticeAudience | null };

@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async grant(
    userId: number,
    purpose: ConsentPurpose,
    noticeVersion: NoticeVersion,
    audience: NoticeAudience,
  ): Promise<ConsentStatus> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockLedger(tx, userId);
      const latest = await this.latestEntry(tx, userId, purpose);
      const alreadyGranted =
        latest !== null && latest.action === 'granted' && latest.noticeVersion === noticeVersion;
      if (!alreadyGranted) {
        await tx.consentRecord.create({
          data: { userId, purpose, noticeVersion, audience, action: 'granted' },
        });
      }
      return this.statusFor(tx, userId, purpose);
    });
  }

  async revoke(userId: number, purpose: ConsentPurpose): Promise<ConsentStatus> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockLedger(tx, userId);
      const latest = await this.latestEntry(tx, userId, purpose);
      if (latest !== null && latest.action === 'granted') {
        await tx.consentRecord.create({
          data: {
            userId,
            purpose,
            noticeVersion: latest.noticeVersion,
            audience: latest.audience,
            action: 'revoked',
          },
        });
      }
      return this.statusFor(tx, userId, purpose);
    });
  }

  async current(userId: number, purpose: ConsentPurpose): Promise<ConsentStatus> {
    return this.prisma.$transaction((tx) => this.statusFor(tx, userId, purpose));
  }

  async list(userId: number): Promise<ConsentStatus[]> {
    return this.prisma.$transaction(async (tx) => {
      const statuses: ConsentStatus[] = [];
      for (const purpose of ConsentPurpose.options) {
        statuses.push(await this.statusFor(tx, userId, purpose));
      }
      return statuses;
    });
  }

  private async lockLedger(tx: Prisma.TransactionClient, userId: number): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CONSENT_LOCK_NAMESPACE}::int, ${userId}::int)`;
  }

  private async statusFor(
    tx: Prisma.TransactionClient,
    userId: number,
    purpose: ConsentPurpose,
  ): Promise<ConsentStatus> {
    const latest = await this.latestEntry(tx, userId, purpose);
    const latestGranted =
      latest !== null && latest.action === 'granted'
        ? latest
        : await this.latestEntry(tx, userId, purpose, 'granted');
    return buildConsentStatus(purpose, latest, latestGranted);
  }

  private async latestEntry(
    tx: Prisma.TransactionClient,
    userId: number,
    purpose: ConsentPurpose,
    action?: 'granted' | 'revoked',
  ): Promise<LedgerRow | null> {
    return tx.consentRecord.findFirst({
      where: { userId, purpose, ...(action ? { action } : {}) },
      orderBy: [{ recordedAt: 'desc' }, { consentRecordId: 'desc' }],
      select: ledgerSelect,
    });
  }
}
