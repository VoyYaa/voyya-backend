import { Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { ConsoleSettings } from '@voyyaa/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AdminSettingsService } from './admin-settings.service';

@Controller('admin/settings')
@Roles('admin')
@UseGuards(TenantGuard)
export class AdminSettingsController {
  constructor(private readonly service: AdminSettingsService) {}

  @Get()
  get(@CurrentTenant() companyId: number): Promise<ConsoleSettings> {
    return this.service.get(companyId);
  }

  @Put()
  update(): never {
    return this.service.rejectUpdate();
  }
}
