import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type ConsentListResponse, type ConsentRecord, GrantConsentDTO } from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { ConsentRepository, type ConsentRecordRow } from './consent.repository';

function toConsentRecord(row: ConsentRecordRow): ConsentRecord {
  return {
    purpose: row.purpose,
    notice_version: row.noticeVersion,
    granted_at: row.grantedAt.toISOString(),
  };
}

@Controller('consents')
export class ConsentController {
  constructor(private readonly consents: ConsentRepository) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async grant(
    @Body(new ZodValidationPipe(GrantConsentDTO)) dto: GrantConsentDTO,
    @CurrentUserId() userId: number,
  ): Promise<ConsentRecord> {
    const row = await this.consents.grant(userId, dto.purpose, dto.notice_version);
    return toConsentRecord(row);
  }

  @Get()
  async list(@CurrentUserId() userId: number): Promise<ConsentListResponse> {
    const rows = await this.consents.list(userId);
    return rows.map(toConsentRecord);
  }
}
