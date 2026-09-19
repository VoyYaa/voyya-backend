import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type {
  CompanyDecisionResponse,
  PlatformCompanyDetail,
  PlatformCompanyListResponse,
  ResendCompanyNotificationResponse,
} from '@voyyaa/shared';
import {
  ApproveCompanyDTO,
  PlatformCompanyQuery,
  RejectCompanyDTO,
  RequestCompanyDocumentsDTO,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUserId } from '../tenancy/identity.decorators';
import { PlatformCompanyService } from './platform-company.service';

@Controller('platform/companies')
@Roles('platform_admin')
export class PlatformCompanyController {
  constructor(private readonly service: PlatformCompanyService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(PlatformCompanyQuery)) query: PlatformCompanyQuery,
  ): Promise<PlatformCompanyListResponse> {
    return this.service.list(query);
  }

  @Get(':companyId')
  detail(
    @Param('companyId', ParseIntPipe) companyId: number,
    @CurrentUserId() platformAdminUserId: number,
  ): Promise<PlatformCompanyDetail> {
    return this.service.detail(companyId, platformAdminUserId);
  }

  @Post(':companyId/approve')
  @HttpCode(200)
  approve(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body(new ZodValidationPipe(ApproveCompanyDTO)) dto: ApproveCompanyDTO,
    @CurrentUserId() platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    return this.service.approve(companyId, dto, platformAdminUserId);
  }

  @Post(':companyId/request-documents')
  @HttpCode(200)
  requestDocuments(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body(new ZodValidationPipe(RequestCompanyDocumentsDTO)) dto: RequestCompanyDocumentsDTO,
    @CurrentUserId() platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    return this.service.requestDocuments(companyId, dto, platformAdminUserId);
  }

  @Post(':companyId/reject')
  @HttpCode(200)
  reject(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body(new ZodValidationPipe(RejectCompanyDTO)) dto: RejectCompanyDTO,
    @CurrentUserId() platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    return this.service.reject(companyId, dto, platformAdminUserId);
  }

  @Post(':companyId/notifications/resend')
  @HttpCode(200)
  resendNotification(
    @Param('companyId', ParseIntPipe) companyId: number,
    @CurrentUserId() platformAdminUserId: number,
  ): Promise<ResendCompanyNotificationResponse> {
    return this.service.resendNotification(companyId, platformAdminUserId);
  }
}
