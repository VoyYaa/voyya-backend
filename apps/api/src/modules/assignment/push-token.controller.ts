import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RegisterPushTokenDTO, RevokePushTokenDTO } from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PushTokenRepository } from './push-token.repository';

@Controller('push-tokens')
export class PushTokenController {
  constructor(private readonly pushTokens: PushTokenRepository) {}

  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(
    @Body(new ZodValidationPipe(RegisterPushTokenDTO)) dto: RegisterPushTokenDTO,
    @CurrentUserId() userId: number,
  ): Promise<void> {
    await this.pushTokens.register(userId, dto.token, dto.platform);
  }

  @Post('revoke')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async revoke(
    @Body(new ZodValidationPipe(RevokePushTokenDTO)) dto: RevokePushTokenDTO,
    @CurrentUserId() userId: number,
  ): Promise<void> {
    await this.pushTokens.revoke(userId, dto.token);
  }
}
