import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { withSavepoint } from '../../infrastructure/prisma/savepoint';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';
import { DriverRepository } from './driver.repository';

const LOCK_KEY = 91_002;

@Injectable()
export class DriverLocationPurgeService implements OnModuleInit {
  private readonly logger = new Logger(DriverLocationPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drivers: DriverRepository,
    private readonly env: EnvService,
  ) {}

  onModuleInit(): void {
    if (this.env.get('LOCATION_PURGE_HOURS') === 0) {
      this.logger.warn(
        'LOCATION_PURGE_HOURS=0: la purga de ubicación del conductor está desactivada; ' +
          'el aviso promete borrarla en 13 horas como máximo',
      );
    }
  }

  @Cron(
    SCHEDULED_JOBS.driverLocationPurge.cron,
    cronOptions(SCHEDULED_JOBS.driverLocationPurge),
  )
  async purge(): Promise<void> {
    await runMonitoredJob(SCHEDULED_JOBS.driverLocationPurge, () => this.run());
  }

  private async run(): Promise<void> {
    const purgeHours = this.env.get('LOCATION_PURGE_HOURS');
    if (purgeHours === 0) return;

    const failedCompanyIds: number[] = [];
    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async (tx) => {
      const companyIds = await this.drivers.listCompanyIds();
      let purged = 0;
      for (const companyId of companyIds) {
        try {
          purged += await withSavepoint(tx, `purge_company_${companyId}`, async () => {
            await setTenantSession(tx, companyId);
            return this.drivers.purgeStaleLocations(tx, companyId, purgeHours);
          });
        } catch (error) {
          failedCompanyIds.push(companyId);
          this.logger.error(
            `Location purge failed for company ${companyId}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
      this.logger.log(
        `Location purge: companies=${companyIds.length} purged=${purged} failed=${failedCompanyIds.length}`,
      );
    });
    if (failedCompanyIds.length > 0) {
      throw new Error(`Location purge failed for ${failedCompanyIds.length} company(ies)`);
    }
  }
}
