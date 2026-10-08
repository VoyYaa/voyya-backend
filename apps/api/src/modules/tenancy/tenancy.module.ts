import { Global, Module } from '@nestjs/common';
import { DispatchCompaniesResolver } from './dispatch-companies.resolver';
import { CompanyProvisioningService } from './company-provisioning.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [TenantGuard, DispatchCompaniesResolver, CompanyProvisioningService],
  exports: [TenantGuard, DispatchCompaniesResolver, CompanyProvisioningService],
})
export class TenancyModule {}
