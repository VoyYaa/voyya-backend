import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RegisterPushTokenDTO, RevokePushTokenDTO } from '@voyyaa/shared';
import { PerUserLimit } from '../../shared/user-throttler.guard';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AllowPendingPinChange } from '../auth/decorators/allow-pending-pin-change.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PushTokenRepository } from './push-token.repository';

export const PUSH_TOKEN_LIMIT = { limit: 10, ttl: 60_000 } as const;

@Controller('push-tokens')
@Roles('passenger', 'driver')
export class PushTokenController {
  constructor(private readonly pushTokens: PushTokenRepository) {}

  @Post()
  @HttpCode(204)
  @PerUserLimit(PUSH_TOKEN_LIMIT)
  async register(
    @Body(new ZodValidationPipe(RegisterPushTokenDTO)) dto: RegisterPushTokenDTO,
    @CurrentUserId() userId: number,
  ): Promise<void> {
    await this.pushTokens.register(userId, dto.token, dto.platform);
  }

  @Post('revoke')
  @AllowPendingPinChange()
  @HttpCode(204)
  @PerUserLimit(PUSH_TOKEN_LIMIT)
  async revoke(
    @Body(new ZodValidationPipe(RevokePushTokenDTO)) dto: RevokePushTokenDTO,
    @CurrentUserId() userId: number,
  ): Promise<void> {
    await this.pushTokens.revoke(userId, dto.token);
  }
}
