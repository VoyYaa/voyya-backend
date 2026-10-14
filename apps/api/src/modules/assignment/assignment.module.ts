import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssignmentController } from './assignment.controller';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentService } from './assignment.service';
import { CandidateRepository } from './candidate.repository';
import { DriverAvailabilityService } from './driver-availability.service';
import { DriverController } from './driver.controller';
import { DriverRepository } from './driver.repository';
import { ConsentRevokedListener } from './consent-revoked.listener';
import { DriverLocationPurgeService } from './driver-location-purge.service';
import { DriverShiftService } from './driver-shift.service';
import { DriverTrackingService } from './driver-tracking.service';
import { PUSH_PROVIDER } from './ports/push-provider.port';
import { SMS_PROVIDER } from './ports/sms-provider.port';
import { AssignmentPushProvider } from './providers/assignment-push.provider';
import { createSmsProvider } from './providers/sms.factory';
import { TripClosingService } from './trip-closing.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AssignmentController, DriverController],
  providers: [
    AssignmentService,
    AssignmentRepository,
    CandidateRepository,
    TripClosingService,
    DriverShiftService,
    DriverTrackingService,
    DriverAvailabilityService,
    DriverRepository,
    DriverLocationPurgeService,
    ConsentRevokedListener,
    { provide: PUSH_PROVIDER, useClass: AssignmentPushProvider },
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
  exports: [AssignmentService, TripClosingService, DriverAvailabilityService, DriverTrackingService],
})
export class AssignmentModule {}
