import { applyDecorators, type ExecutionContext, Injectable, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';
import type { RequestWithTenant } from '../modules/tenancy/tenant-request';

export const PER_USER = 'per_user';

export const PER_USER_DEFAULT_LIMIT = { limit: 20, ttl: 60_000 } as const;

export const PER_USER_LIMITS = {
  tripStatus: { limit: 30, ttl: 60_000 },
  driverHome: { limit: 30, ttl: 60_000 },
  driverLocation: { limit: 12, ttl: 60_000 },
  tripStart: { limit: 10, ttl: 60_000 },
} as const;

interface PerUserLimit {
  limit: number;
  ttl: number;
}

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers
      .filter((throttler) => throttler.name === PER_USER)
      .map((throttler) => ({ ...throttler, skipIf: undefined }));
  }

  protected override async getTracker(req: RequestWithTenant): Promise<string> {
    const userId = req.user?.userId;
    return userId !== undefined ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context.switchToHttp().getResponse<Response>().header('Retry-After', String(detail.timeToBlockExpire));
    return super.throwThrottlingException(context, detail);
  }
}

export function PerUserLimit(limit: PerUserLimit): MethodDecorator {
  return applyDecorators(
    UseGuards(UserThrottlerGuard),
    SkipThrottle({ default: true }),
    Throttle({ [PER_USER]: limit }),
  );
}
