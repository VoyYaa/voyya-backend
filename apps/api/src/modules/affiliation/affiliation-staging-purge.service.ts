import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';

const LOCK_KEY = 91_004;

@Injectable()
export class AffiliationStagingPurgeService {
  private readonly logger = new Logger(AffiliationStagingPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
  ) {}

  @Cron(
    SCHEDULED_JOBS.affiliationStagingPurge.cron,
    cronOptions(SCHEDULED_JOBS.affiliationStagingPurge),
  )
  async purge(): Promise<void> {
    await runMonitoredJob(SCHEDULED_JOBS.affiliationStagingPurge, () => this.run());
  }

  private async run(): Promise<void> {
    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async () => {
      const ttlHours = this.env.get('DOCUMENT_STAGING_TTL_HOURS');
      const olderThan = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
      const stale = await this.storage.listOlderThan('staging', olderThan);
      if (stale.length > 0) {
        await this.storage.remove(stale);
      }
      this.logger.log(`Affiliation staging purge: removed=${stale.length}`);
    });
  }
}
