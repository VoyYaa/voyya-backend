import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithTenant } from '../modules/tenancy/tenant-request';

export const SERVICE_OPTIONS_PER_USER = 'service_options_user';

export const SERVICE_OPTIONS_PER_USER_LIMIT = { limit: 20, ttl: 60_000 } as const;

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers
      .filter((throttler) => throttler.name === SERVICE_OPTIONS_PER_USER)
      .map((throttler) => ({ ...throttler, skipIf: undefined }));
  }

  protected override async getTracker(req: RequestWithTenant): Promise<string> {
    const userId = req.user?.userId;
    return userId !== undefined ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
  }
}
