import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';
import { DriverRepository } from './driver.repository';

const LOCK_KEY = 91_002;

@Injectable()
export class DriverLocationPurgeService {
  private readonly logger = new Logger(DriverLocationPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drivers: DriverRepository,
    private readonly env: EnvService,
  ) {}

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

    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async (tx) => {
      const companyIds = await this.drivers.listCompanyIds();
      let purged = 0;
      for (const companyId of companyIds) {
        await setTenantSession(tx, companyId);
        purged += await this.drivers.purgeStaleLocations(tx, companyId, purgeHours);
      }
      this.logger.log(`Location purge: companies=${companyIds.length} purged=${purged}`);
    });
  }
}
