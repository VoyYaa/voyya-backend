import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PushTokenRepository } from './push-token.repository';

const LOCK_KEY = 91_003;

@Injectable()
export class PushTokenPurgeService {
  private readonly logger = new Logger(PushTokenPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PushTokenRepository,
    private readonly env: EnvService,
  ) {}

  @Cron(SCHEDULED_JOBS.pushTokenPurge.cron, cronOptions(SCHEDULED_JOBS.pushTokenPurge))
  async purge(): Promise<void> {
    await runMonitoredJob(SCHEDULED_JOBS.pushTokenPurge, () => this.run());
  }

  private async run(): Promise<void> {
    const ttlDays = this.env.get('PUSH_TOKEN_TTL_DAYS');
    if (ttlDays === 0) return;

    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async (tx) => {
      const purged = await this.tokens.purgeStale(tx, ttlDays);
      this.logger.log(`Push token purge: purged=${purged}`);
    });
  }
}
