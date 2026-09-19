import { Controller, Get, UseGuards } from '@nestjs/common';
import type { CompanyProfile } from '@voyyaa/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../tenancy/identity.decorators';
import { TenantGuard } from '../tenancy/tenant.guard';
import { AdminCompanyProfileService } from './admin-company-profile.service';

@Controller('admin/company-profile')
@Roles('admin', 'operator')
@UseGuards(TenantGuard)
export class AdminCompanyProfileController {
  constructor(private readonly service: AdminCompanyProfileService) {}

  @Get()
  get(@CurrentTenant() companyId: number): Promise<CompanyProfile> {
    return this.service.get(companyId);
  }
}
