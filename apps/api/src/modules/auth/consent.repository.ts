import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ConsentPurpose, NoticeVersion } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ConsentRecordRow {
  purpose: ConsentPurpose;
  noticeVersion: string;
  grantedAt: Date;
}

type RawConsentRow = {
  purpose: ConsentPurpose;
  notice_version: string;
  granted_at: Date;
};

function toRow(row: RawConsentRow): ConsentRecordRow {
  return { purpose: row.purpose, noticeVersion: row.notice_version, grantedAt: row.granted_at };
}

@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async grant(
    userId: number,
    purpose: ConsentPurpose,
    noticeVersion: NoticeVersion,
  ): Promise<ConsentRecordRow> {
    const rows = await this.prisma.$queryRaw<RawConsentRow[]>`
      INSERT INTO auth.consent_record (user_id, purpose, notice_version, granted_at)
      VALUES (${userId}, ${purpose}::auth."ConsentPurpose", ${noticeVersion}, (now() AT TIME ZONE 'UTC'))
      ON CONFLICT (user_id, purpose, notice_version)
      DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING purpose, notice_version, granted_at
    `;
    const row = rows[0];
    if (!row) throw new InternalServerErrorException('Consent insert returned no row');
    return toRow(row);
  }

  async list(userId: number): Promise<ConsentRecordRow[]> {
    const rows = await this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { grantedAt: 'asc' },
      select: { purpose: true, noticeVersion: true, grantedAt: true },
    });
    return rows.map((r) => ({
      purpose: r.purpose,
      noticeVersion: r.noticeVersion,
      grantedAt: r.grantedAt,
    }));
  }
}
