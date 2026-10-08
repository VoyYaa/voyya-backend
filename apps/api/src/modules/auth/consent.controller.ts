import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type ConsentStatus,
  type ConsentStatusListResponse,
  GrantConsentDTO,
  RevokeConsentDTO,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentUser } from '../tenancy/identity.decorators';
import type { AuthenticatedUser } from '../tenancy/tenant-request';
import { ConsentService } from './consent.service';

const WRITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('consents')
export class ConsentController {
  constructor(private readonly consents: ConsentService) {}

  @Post()
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  grant(
    @Body(new ZodValidationPipe(GrantConsentDTO)) dto: GrantConsentDTO,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ConsentStatus> {
    return this.consents.grant(user, dto);
  }

  @Post('revoke')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  revoke(
    @Body(new ZodValidationPipe(RevokeConsentDTO)) dto: RevokeConsentDTO,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ConsentStatus> {
    return this.consents.revoke(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ConsentStatusListResponse> {
    return this.consents.list(user);
  }
}
