import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { EnvService } from './config/env.service';
import { HealthController } from './health.controller';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AdminModule } from './modules/admin/admin.module';
import { AffiliationModule } from './modules/affiliation/affiliation.module';
import { AssignmentModule } from './modules/assignment/assignment.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TripsModule } from './modules/trips/trips.module';

@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => [
        { name: 'default', ttl: env.get('THROTTLE_TTL_SECONDS') * 1000, limit: env.get('THROTTLE_LIMIT') },
        { name: 'affiliation_docs_hour', ttl: 3_600_000, limit: 30 },
      ],
    }),
    PrismaModule,
    TenancyModule,
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
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
