import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { EnvService } from './config/env.service';
import { AllExceptionsFilter } from './shared/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  const env = app.get(EnvService);

  app.use(helmet());
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');

  const origins = env
    .get('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({ origin: origins.length > 0 ? origins : false, credentials: true });

  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ? Number(process.env.PORT) : env.get('API_PORT');
  await app.listen(port, '::');
  new Logger('Bootstrap').log(`VoyYa API listening on :${port} (${env.get('NODE_ENV')})`);
}

void bootstrap();
