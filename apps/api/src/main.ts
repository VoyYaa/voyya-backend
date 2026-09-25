import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { validateEnv } from './config/env';
import { EnvService } from './config/env.service';
import { buildLogger } from './infrastructure/observability/logger.factory';
import { PinoLoggerService } from './infrastructure/observability/pino-logger.service';
import { createRequestContextMiddleware } from './infrastructure/observability/request-context.middleware';
import { RequestContextService } from './infrastructure/observability/request-context.service';
import { captureError, initSentry, Sentry } from './infrastructure/observability/sentry';
import { AllExceptionsFilter } from './shared/all-exceptions.filter';

export function configureApp(
  app: NestExpressApplication,
  env: EnvService,
  requestContext: RequestContextService,
): void {
  app.use(createRequestContextMiddleware(requestContext));
  app.set('trust proxy', 1);
  app.use(helmet());
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');

  const origins = env
    .get('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({ origin: origins.length > 0 ? origins : false, credentials: true });

  app.useGlobalFilters(new AllExceptionsFilter());
}

function registerProcessHandlers(): void {
  process.on('uncaughtException', (error) => {
    new Logger('Bootstrap').fatal(`uncaughtException: ${error.stack ?? error.message}`);
    captureError(error);
    void Sentry.flush(2000).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    new Logger('Bootstrap').fatal(`unhandledRejection: ${error.stack ?? error.message}`);
    captureError(error);
  });
}

async function bootstrap(): Promise<void> {
  const bootEnv = validateEnv(process.env);

  initSentry({
    dsn: bootEnv.SENTRY_DSN,
    environment: bootEnv.SENTRY_ENVIRONMENT,
    nodeEnv: bootEnv.NODE_ENV,
    release: bootEnv.SENTRY_RELEASE,
  });
  registerProcessHandlers();

  const pinoLogger = buildLogger({
    level: bootEnv.LOG_LEVEL,
    service: 'voyya-api',
    env: bootEnv.SENTRY_ENVIRONMENT ?? bootEnv.NODE_ENV,
    release: bootEnv.SENTRY_RELEASE,
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useLogger(new PinoLoggerService(pinoLogger));
  app.enableShutdownHooks();
  const env = app.get(EnvService);
  const requestContext = app.get(RequestContextService);

  configureApp(app, env, requestContext);

  const port = process.env.PORT ? Number(process.env.PORT) : env.get('API_PORT');
  await app.listen(port, '::');
  new Logger('Bootstrap').log(`VoyYa API listening on :${port} (${env.get('NODE_ENV')})`);
}

if (require.main === module) {
  void bootstrap();
}
