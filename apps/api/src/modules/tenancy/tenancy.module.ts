import { Global, Module } from '@nestjs/common';
import { ActiveCompanyResolver } from './active-company.resolver';
import { CompanyProvisioningService } from './company-provisioning.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [TenantGuard, ActiveCompanyResolver, CompanyProvisioningService],
  exports: [TenantGuard, ActiveCompanyResolver, CompanyProvisioningService],
})
export class TenancyModule {}
