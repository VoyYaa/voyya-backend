import { Module } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentParamsService } from './assignment-params.service';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentService } from './assignment.service';
import { CandidateRepository } from './candidate.repository';
import { PUSH_PROVIDER } from './ports/push-provider.port';
import { SMS_PROVIDER } from './ports/sms-provider.port';
import { NoopPushProvider } from './providers/noop-push.provider';
import { createSmsProvider } from './providers/sms.factory';

@Module({
  controllers: [AssignmentController],
  providers: [
    AssignmentService,
    AssignmentRepository,
    CandidateRepository,
    AssignmentParamsService,
    { provide: PUSH_PROVIDER, useClass: NoopPushProvider },
    { provide: SMS_PROVIDER, useFactory: createSmsProvider, inject: [EnvService] },
  ],
  exports: [AssignmentService],
})
export class AssignmentModule {}
