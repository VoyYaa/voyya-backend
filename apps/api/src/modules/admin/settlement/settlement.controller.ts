import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  RecordRemittanceDTO,
  RemittanceHistoryQuery,
  type RemittanceHistoryResponse,
  type RemittanceResult,
  SETTLEMENT_CSV_CONTENT_TYPE,
  SettlementReportQuery,
  type SettlementReportResponse,
} from '@voyyaa/shared';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../../shared/zod-validation.pipe';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentTenant, CurrentUserId } from '../../tenancy/identity.decorators';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { SettlementRemittanceService } from './settlement-remittance.service';
import { SettlementReportService } from './settlement-report.service';

const EXPORT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('admin/reports/settlement')
@Roles('admin')
@UseGuards(TenantGuard)
export class SettlementController {
  constructor(
    private readonly reports: SettlementReportService,
    private readonly remittances: SettlementRemittanceService,
  ) {}

  @Get()
  report(
    @Query(new ZodValidationPipe(SettlementReportQuery)) query: SettlementReportQuery,
    @CurrentTenant() companyId: number,
  ): Promise<SettlementReportResponse> {
    return this.reports.getReport(companyId, query);
  }

  @Get('export')
  @Throttle(EXPORT_THROTTLE)
  @Header('Content-Type', SETTLEMENT_CSV_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  async export(
    @Query(new ZodValidationPipe(SettlementReportQuery)) query: SettlementReportQuery,
    @CurrentTenant() companyId: number,
    @CurrentUserId() userId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.reports.exportCsv(companyId, userId, query);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(Buffer.from(file.content, 'utf8'));
  }

  @Get('remittances')
  history(
    @Query(new ZodValidationPipe(RemittanceHistoryQuery)) query: RemittanceHistoryQuery,
    @CurrentTenant() companyId: number,
  ): Promise<RemittanceHistoryResponse> {
    return this.remittances.history(companyId, query);
  }

  @Post('remittances')
  @HttpCode(200)
  record(
    @Body(new ZodValidationPipe(RecordRemittanceDTO)) dto: RecordRemittanceDTO,
    @CurrentTenant() companyId: number,
    @CurrentUserId() userId: number,
  ): Promise<RemittanceResult> {
    return this.remittances.record(companyId, userId, dto);
  }

  @Post('remittances/:remittanceId/reversal')
  @HttpCode(200)
  reverse(
    @Param('remittanceId', ParseIntPipe) remittanceId: number,
    @CurrentTenant() companyId: number,
    @CurrentUserId() userId: number,
  ): Promise<RemittanceResult> {
    return this.remittances.reverse(companyId, userId, remittanceId);
  }
}
