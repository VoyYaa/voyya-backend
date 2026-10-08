import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const LOCK_KEY = 91_001;

@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(SCHEDULED_JOBS.authCleanup.cron, cronOptions(SCHEDULED_JOBS.authCleanup))
  async cleanup(): Promise<void> {
    await runMonitoredJob(SCHEDULED_JOBS.authCleanup, () => this.run());
  }

  private async run(): Promise<void> {
    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async (tx) => {
      const otp = await tx.$executeRaw`
        DELETE FROM auth.otp_code WHERE expires_at < now() OR consumed = true
      `;
      const refresh = await tx.$executeRaw`
        DELETE FROM auth.refresh_token WHERE expires_at < now() OR revoked = true
      `;
      this.logger.log(`Auth cleanup: otp=${otp} refresh=${refresh}`);
    });
  }
}
