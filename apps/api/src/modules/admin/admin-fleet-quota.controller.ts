import { Controller, Get, UseGuards } from '@nestjs/common';
import type { FleetQuota } from '@voyyaa/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AdminDriverService } from './admin-driver.service';

@Controller('admin/fleet-quota')
@Roles('admin')
@UseGuards(TenantGuard)
export class AdminFleetQuotaController {
  constructor(private readonly service: AdminDriverService) {}

  @Get()
  get(@CurrentTenant() companyId: number): Promise<FleetQuota> {
    return this.service.getFleetQuota(companyId);
  }
}
