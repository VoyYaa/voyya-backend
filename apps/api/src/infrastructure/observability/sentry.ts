import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { requestContext } from './request-context.service';
import { scrubEvent } from './scrub-event';

const logger = new Logger('Sentry');

const DISABLED_DEFAULT_INTEGRATIONS = new Set([
  'Console',
  'OnUncaughtException',
  'OnUnhandledRejection',
]);

export interface SentryBootConfig {
  dsn: string | undefined;
  environment: string | undefined;
  nodeEnv: string;
  release: string | undefined;
}

export function initSentry(config: SentryBootConfig): void {
  if (!config.dsn) {
    logger.warn('SENTRY_DSN no configurado: Sentry desactivado');
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment ?? config.nodeEnv,
    release: config.release,
    sendDefaultPii: false,
    includeLocalVariables: false,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    autoSessionTracking: true,
    maxValueLength: 2048,
    normalizeDepth: 3,
    integrations: (defaults) =>
      defaults.filter((integration) => !DISABLED_DEFAULT_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'console') return null;
      if (typeof breadcrumb.data?.url === 'string') {
        breadcrumb.data.url = breadcrumb.data.url.split('?')[0];
      }
      return breadcrumb;
    },
    beforeSend: scrubEvent,
  });
}

export function captureError(error: unknown): void {
  const ctx = requestContext.get();
  Sentry.withScope((scope) => {
    scope.setTags({
      request_id: ctx?.requestId,
      company_id: ctx?.companyId,
      job: ctx?.job,
    });
    if (ctx?.userId !== undefined) scope.setUser({ id: String(ctx.userId) });
    if (ctx?.tripRequestId !== undefined) scope.setExtra('trip_request_id', ctx.tripRequestId);
    Sentry.captureException(error);
  });
}

export { Sentry };
