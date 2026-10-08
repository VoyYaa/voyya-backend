import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type ConsentStatus,
  type ConsentStatusListResponse,
  GrantConsentDTO,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { ConsentRepository } from './consent.repository';

@Controller('consents')
export class ConsentController {
  constructor(private readonly consents: ConsentRepository) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async grant(
    @Body(new ZodValidationPipe(GrantConsentDTO)) dto: GrantConsentDTO,
    @CurrentUserId() userId: number,
  ): Promise<ConsentStatus> {
    return this.consents.grant(userId, dto.purpose, dto.notice_version);
  }

  @Get()
  async list(@CurrentUserId() userId: number): Promise<ConsentStatusListResponse> {
    return this.consents.list(userId);
  }
}
