import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import {
  type OpsDriverDetail,
  type OpsDriverListResponse,
  OpsDriverQuery,
  type OpsQueueResponse,
  OpsQueueQuery,
  type OpsTripDetail,
} from '@voyyaa/shared';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { OpsConsoleService } from './ops-console.service';

@Controller('ops')
@Roles('admin', 'operator')
@UseGuards(TenantGuard)
export class OpsConsoleController {
  constructor(private readonly service: OpsConsoleService) {}

  @Get('trip-requests')
  listTripRequests(
    @Query(new ZodValidationPipe(OpsQueueQuery)) query: OpsQueueQuery,
    @CurrentTenant() companyId: number,
  ): Promise<OpsQueueResponse> {
    return this.service.listTripRequests(companyId, query);
  }

  @Get('trip-requests/:id')
  getTripRequest(
    @Param('id', ParseIntPipe) id: number,
    @CurrentTenant() companyId: number,
  ): Promise<OpsTripDetail> {
    return this.service.getTripRequest(companyId, id);
  }

  @Get('drivers')
  listDrivers(
    @Query(new ZodValidationPipe(OpsDriverQuery)) query: OpsDriverQuery,
    @CurrentTenant() companyId: number,
  ): Promise<OpsDriverListResponse> {
    return this.service.listDrivers(companyId, query);
  }

  @Get('drivers/:id')
  getDriver(
    @Param('id', ParseIntPipe) id: number,
    @CurrentTenant() companyId: number,
  ): Promise<OpsDriverDetail> {
    return this.service.getDriver(companyId, id);
  }
}
