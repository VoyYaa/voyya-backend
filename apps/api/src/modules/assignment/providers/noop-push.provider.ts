import { Injectable, Logger } from '@nestjs/common';
import type { AssignmentNotification } from '@voyyaa/shared';
import { EnvService } from '../../../config/env.service';
import type { PushProvider } from '../ports/push-provider.port';

@Injectable()
export class NoopPushProvider implements PushProvider {
  private readonly logger = new Logger(NoopPushProvider.name);

  constructor(private readonly env: EnvService) {}

  async sendAssignment(
    target: { driverId: number },
    notification: AssignmentNotification,
  ): Promise<void> {
    if (this.env.get('NODE_ENV') !== 'production') {
      this.logger.log(
        `[push:noop] driver=${target.driverId} assignment=${notification.assignment_id} ` +
          `tripRequest=${notification.trip_request_id} expiresAt=${notification.expires_at}`,
      );
    }
  }
}
