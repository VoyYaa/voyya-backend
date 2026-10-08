import { Controller, Get, Query } from '@nestjs/common';
import type { PlatformServiceConfigListResponse } from '@voyyaa/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformServiceConfigService } from './platform-service-config.service';

const PlatformServiceConfigQuery = z.object({
  municipality_id: z.coerce.number().int().positive().optional(),
});
type PlatformServiceConfigQuery = z.infer<typeof PlatformServiceConfigQuery>;

@Controller('platform/service-configs')
@Roles('platform_admin')
export class PlatformServiceConfigController {
  constructor(private readonly service: PlatformServiceConfigService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(PlatformServiceConfigQuery)) query: PlatformServiceConfigQuery,
  ): Promise<PlatformServiceConfigListResponse> {
    return this.service.list(query.municipality_id ?? null);
  }
}
