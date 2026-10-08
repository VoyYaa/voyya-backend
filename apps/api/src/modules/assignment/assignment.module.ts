import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AuthModule } from '../auth/auth.module';
import { AssignmentController } from './assignment.controller';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentService } from './assignment.service';
import { CandidateRepository } from './candidate.repository';
import { DriverController } from './driver.controller';
import { DriverRepository } from './driver.repository';
import { ConsentRevokedListener } from './consent-revoked.listener';
import { DriverLocationPurgeService } from './driver-location-purge.service';
import { DriverShiftService } from './driver-shift.service';
import { PUSH_PROVIDER } from './ports/push-provider.port';
import { SMS_PROVIDER } from './ports/sms-provider.port';
import { createPushProvider } from './providers/push.factory';
import { createSmsProvider } from './providers/sms.factory';
import { PushTokenController } from './push-token.controller';
import { PushTokenPurgeService } from './push-token-purge.service';
import { PushTokenRepository } from './push-token.repository';
import { TripClosingService } from './trip-closing.service';

@Module({
  imports: [AuthModule],
  controllers: [AssignmentController, DriverController, PushTokenController],
  providers: [
    AssignmentService,
    AssignmentRepository,
    CandidateRepository,
    TripClosingService,
    DriverShiftService,
    DriverRepository,
    DriverLocationPurgeService,
    ConsentRevokedListener,
    PushTokenRepository,
    PushTokenPurgeService,
    { provide: PUSH_PROVIDER, useFactory: createPushProvider, inject: [EnvService, PushTokenRepository] },
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
  exports: [AssignmentService, TripClosingService],
})
export class AssignmentModule {}
