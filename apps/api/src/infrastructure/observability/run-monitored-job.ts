import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { captureError, Sentry } from './sentry';
import { requestContext } from './request-context.service';
import { JOB_TIMEZONE, type ScheduledJob } from './scheduled-jobs';

const logger = new Logger('Cron');

type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>;

function monitorConfig(job: ScheduledJob): MonitorConfig {
  return {
    schedule: { type: 'crontab', value: job.cron },
    checkinMargin: job.checkinMarginMin,
    maxRuntime: job.maxRuntimeMin,
    timezone: JOB_TIMEZONE,
  };
}

export async function runMonitoredJob(job: ScheduledJob, fn: () => Promise<void>): Promise<void> {
  const { slug } = job;
  await requestContext.run({ requestId: `cron-${slug}-${randomUUID()}`, job: slug }, async () => {
    const start = process.hrtime.bigint();
    logger.log({ msg: 'job.start', job: slug });

    try {
      if (Sentry.getClient()) {
        await Sentry.withMonitor(slug, () => fn(), monitorConfig(job));
      } else {
        await fn();
      }
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logger.log({ msg: 'job.finish', job: slug, duration_ms: Math.round(durationMs) });
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logger.error({ msg: 'job.failed', job: slug, duration_ms: Math.round(durationMs) });
      captureError(error);
    }
  });
}
