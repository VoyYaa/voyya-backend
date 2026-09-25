import { Injectable } from '@nestjs/common';
import type { PushTokenPlatform } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export const MAX_PUSH_TOKENS_PER_USER = 5;

@Injectable()
export class PushTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: number, token: string, platform: PushTokenPlatform): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO auth.push_token (user_id, token, platform, created_at, last_seen_at)
      VALUES (${userId}, ${token}, ${platform}::auth."PushTokenPlatform", (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
      ON CONFLICT (token)
      DO UPDATE SET user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    last_seen_at = EXCLUDED.last_seen_at
    `;

    await this.prisma.$executeRaw`
      DELETE FROM auth.push_token
       WHERE user_id = ${userId}
         AND push_token_id NOT IN (
           SELECT push_token_id FROM auth.push_token
            WHERE user_id = ${userId}
            ORDER BY last_seen_at DESC
            LIMIT ${MAX_PUSH_TOKENS_PER_USER}
         )
    `;
  }

  async listByUser(userId: number): Promise<string[]> {
    const rows = await this.prisma.pushToken.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: { token: true },
    });
    return rows.map((r) => r.token);
  }

  async revoke(userId: number, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
  }

  async drop(token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { token } });
  }

  async purgeStale(ttlDays: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ push_token_id: number }>>`
      DELETE FROM auth.push_token
       WHERE last_seen_at < (now() AT TIME ZONE 'UTC') - (${ttlDays} * interval '1 day')
      RETURNING push_token_id
    `;
    return rows.length;
  }
}
