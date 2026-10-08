import type { PrismaClient } from '@prisma/client';
import { LOCATION_NOTICE_VERSION, type NoticeAudience } from '@voyyaa/shared';

export async function grantLocationConsent(
  prisma: Pick<PrismaClient, 'consentRecord'>,
  userId: number,
  audience: NoticeAudience = 'driver',
): Promise<void> {
  await prisma.consentRecord.create({
    data: {
      userId,
      purpose: 'location',
      noticeVersion: LOCATION_NOTICE_VERSION,
      audience,
      action: 'granted',
    },
  });
}
