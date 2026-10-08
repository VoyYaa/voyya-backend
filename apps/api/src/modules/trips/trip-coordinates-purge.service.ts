import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from '../../config/env.service';
import { runMonitoredJob } from '../../infrastructure/observability/run-monitored-job';
import { cronOptions, SCHEDULED_JOBS } from '../../infrastructure/observability/scheduled-jobs';
import { runWithAdvisoryLock } from '../../infrastructure/prisma/advisory-lock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { withSavepoint } from '../../infrastructure/prisma/savepoint';
import { TripsRepository } from './trips.repository';

const LOCK_KEY = 91_005;
const BATCH_SIZE = 500;
const MAX_BATCHES = 40;

@Injectable()
export class TripCoordinatesPurgeService {
  private readonly logger = new Logger(TripCoordinatesPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsRepository,
    private readonly env: EnvService,
  ) {}

  @Cron(
    SCHEDULED_JOBS.tripCoordinatesPurge.cron,
    cronOptions(SCHEDULED_JOBS.tripCoordinatesPurge),
  )
  async purge(): Promise<void> {
    await runMonitoredJob(SCHEDULED_JOBS.tripCoordinatesPurge, () => this.run());
  }

  private async run(): Promise<void> {
    const retentionDays = this.env.get('TRIP_COORDINATES_RETENTION_DAYS');
    let failure: Error | null = null;

    await runWithAdvisoryLock(this.prisma, LOCK_KEY, async (tx) => {
      let purged = 0;
      let batches = 0;
      while (batches < MAX_BATCHES) {
        let batchPurged: number;
        try {
          batchPurged = await withSavepoint(tx, `purge_trip_batch_${batches}`, () =>
            this.trips.purgeCoordinatesBatch(tx, retentionDays, BATCH_SIZE),
          );
        } catch (error) {
          failure = error instanceof Error ? error : new Error('Trip coordinates purge batch failed');
          break;
        }
        if (batchPurged === 0) break;
        purged += batchPurged;
        batches += 1;
      }
      this.logger.log(`Trip coordinates purge: purged=${purged} batches=${batches}`);
    });

    if (failure !== null) throw failure;
  }
}
