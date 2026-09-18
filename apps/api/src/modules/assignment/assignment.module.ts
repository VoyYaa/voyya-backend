import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentService } from './assignment.service';
import { CandidateRepository } from './candidate.repository';
import { DriverController } from './driver.controller';
import { DriverRepository } from './driver.repository';
import { DriverLocationPurgeService } from './driver-location-purge.service';
import { DriverShiftService } from './driver-shift.service';
import { OperationalParamsService } from './operational-params.service';
import { PUSH_PROVIDER } from './ports/push-provider.port';
import { SMS_PROVIDER } from './ports/sms-provider.port';
import { NoopPushProvider } from './providers/noop-push.provider';
import { createSmsProvider } from './providers/sms.factory';
import { TripClosingService } from './trip-closing.service';

@Module({
  controllers: [AssignmentController, DriverController],
  providers: [
    AssignmentService,
    AssignmentRepository,
    CandidateRepository,
    OperationalParamsService,
    TripClosingService,
    DriverShiftService,
    DriverRepository,
    DriverLocationPurgeService,
    { provide: PUSH_PROVIDER, useClass: NoopPushProvider },
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
  exports: [AssignmentService, TripClosingService, OperationalParamsService],
})
export class AssignmentModule {}
