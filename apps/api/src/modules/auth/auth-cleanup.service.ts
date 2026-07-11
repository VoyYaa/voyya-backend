import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const LOCK_KEY = 91_001;

@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
        `;
        if (rows[0]?.locked !== true) return;

        const otp = await tx.$executeRaw`
          DELETE FROM auth.otp_code WHERE expires_at < now() OR consumed = true
        `;
        const refresh = await tx.$executeRaw`
          DELETE FROM auth.refresh_token WHERE expires_at < now() OR revoked = true
        `;
        this.logger.log(`Auth cleanup: otp=${otp} refresh=${refresh}`);
      });
    } catch (e) {
      this.logger.error(`Auth cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
