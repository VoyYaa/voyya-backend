import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
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

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const purgeHours = this.env.get('LOCATION_PURGE_HOURS');
    if (purgeHours === 0) return;

    try {
      if (!(await this.acquireLock())) return;

      const companyIds = await this.drivers.listCompanyIds();
      let purged = 0;
      for (const companyId of companyIds) {
        purged += await this.prisma.runInTenant(companyId, (tx) =>
          this.drivers.purgeStaleLocations(tx, companyId, purgeHours),
        );
      }
      this.logger.log(`Location purge: companies=${companyIds.length} purged=${purged}`);
    } catch (e) {
      this.logger.error(`Location purge failed: ${e instanceof Error ? e.message : String(e)}`);
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
