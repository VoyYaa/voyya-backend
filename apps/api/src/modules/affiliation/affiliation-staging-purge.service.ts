import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';

const LOCK_KEY = 91_003;

@Injectable()
export class AffiliationStagingPurgeService {
  private readonly logger = new Logger(AffiliationStagingPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purge(): Promise<void> {
    await runMonitoredJob('affiliation-staging-purge', () => this.run());
  }

  private async run(): Promise<void> {
    try {
      if (!(await this.acquireLock())) return;

      const ttlHours = this.env.get('DOCUMENT_STAGING_TTL_HOURS');
      const olderThan = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
      const stale = await this.storage.listOlderThan('staging', olderThan);
      if (stale.length > 0) {
        await this.storage.remove(stale);
      }
      this.logger.log(`Affiliation staging purge: removed=${stale.length}`);
    } catch (e) {
      this.logger.error(
        `Affiliation staging purge failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async acquireLock(): Promise<boolean> {
    const rows = await this.prisma.$transaction(
      (tx) => tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `,
    );
    return rows[0]?.locked === true;
  }
}
