import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { EnvService } from './config/env.service';
import { HealthController } from './health.controller';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AssignmentModule } from './modules/assignment/assignment.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TripsModule } from './modules/trips/trips.module';

/**
 * Módulo raíz. Monolito modular: cada dominio es un módulo con frontera propia; la
 * comunicación inter-módulo es por eventos in-process (EventEmitter, sin broker).
 *
 * Guards GLOBALES en ORDEN (ADR-005 §7): Throttler → Auth → Roles (los tres en este
 * array para garantizar el orden). El TenantGuard corre después, por controlador.
 * ScheduleModule habilita el barrido de OTP/refresh vencidos (AuthCleanupService).
 */
@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => [
        { ttl: env.get('THROTTLE_TTL_SECONDS') * 1000, limit: env.get('THROTTLE_LIMIT') },
      ],
    }),
    PrismaModule,
    TenancyModule,
    AuthModule,
    TripsModule,
    AssignmentModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
