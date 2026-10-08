import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';
import {
  ConfigHistoryQuery,
  UpdateCompanyCommissionDTO,
  type CompanyCommission,
  type CompanyCommissionHistory,
  type PlatformCommissionListResponse,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PlatformCommissionService } from './platform-commission.service';
import { ServiceConfigBodyPipe } from './service-config-body.pipe';

@Controller('platform')
@Roles('platform_admin')
export class PlatformCommissionController {
  constructor(private readonly service: PlatformCommissionService) {}

  @Get('commissions')
  list(): Promise<PlatformCommissionListResponse> {
    return this.service.list();
  }

  @Get('companies/:companyId/commission')
  history(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Query(new ZodValidationPipe(ConfigHistoryQuery)) query: ConfigHistoryQuery,
  ): Promise<CompanyCommissionHistory> {
    return this.service.history(companyId, query);
  }

  @Put('companies/:companyId/commission')
  update(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body(new ServiceConfigBodyPipe(UpdateCompanyCommissionDTO)) dto: UpdateCompanyCommissionDTO,
    @CurrentUserId() userId: number,
  ): Promise<CompanyCommission> {
    return this.service.update(companyId, dto, userId);
  }
}
