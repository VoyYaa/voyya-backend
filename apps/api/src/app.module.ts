import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { EnvService } from './config/env.service';
import { HealthController } from './health.controller';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AdminModule } from './modules/admin/admin.module';
import { AffiliationModule } from './modules/affiliation/affiliation.module';
import { AssignmentModule } from './modules/assignment/assignment.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PinChangeGuard } from './modules/auth/guards/pin-change.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { ServiceConfigModule } from './modules/service-config/service-config.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TripsModule } from './modules/trips/trips.module';
import { buildThrottlers } from './shared/throttlers';

@Module({
  imports: [
    AppConfigModule,
    ObservabilityModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        buildThrottlers({ ttlMs: env.get('THROTTLE_TTL_SECONDS') * 1000, limit: env.get('THROTTLE_LIMIT') }),
    }),
    PrismaModule,
    TenancyModule,
    ServiceConfigModule,
    AuthModule,
    TripsModule,
    AssignmentModule,
    AffiliationModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PinChangeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
