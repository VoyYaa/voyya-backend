import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { captureError, Sentry } from './sentry';
import { requestContext } from './request-context.service';

const logger = new Logger('Cron');

export async function runMonitoredJob(slug: string, fn: () => Promise<void>): Promise<void> {
  await requestContext.run({ requestId: `cron-${slug}-${randomUUID()}`, job: slug }, async () => {
    const start = process.hrtime.bigint();
    logger.log({ msg: 'job.start', job: slug });

    try {
      if (Sentry.getClient()) {
        await Sentry.withMonitor(slug, () => fn());
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
