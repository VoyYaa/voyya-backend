import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { EnvService } from './config/env.service';
import { AllExceptionsFilter } from './shared/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  // ConfigModule valida el entorno con Zod al crear la app → FALLA EL ARRANQUE
  // si falta/está mal una variable.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  const env = app.get(EnvService);

  // --- C-4: endurecimiento HTTP -------------------------------------------
  app.use(helmet());
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');

  // CORS por allowlist (env). Vacío = sin cross-origin (móvil no lo requiere; la
  // PWA admin define CORS_ORIGINS).
  const origins = env
    .get('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({ origin: origins.length > 0 ? origins : false, credentials: true });

  // ValidationPipe global (red de seguridad; la validación de dominio es Zod por endpoint).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Filtro global: no filtra stack/detalle interno al cliente.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Railway (y otros PaaS) inyectan el puerto por `PORT`; si no está, cae a API_PORT
  // (default 3000). Escucha en 0.0.0.0 para ser accesible dentro del contenedor.
  const port = process.env.PORT ? Number(process.env.PORT) : env.get('API_PORT');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`VoyYa API escuchando en :${port} (${env.get('NODE_ENV')})`);
}

void bootstrap();
