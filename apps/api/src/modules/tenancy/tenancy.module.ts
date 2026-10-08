import { Global, Module } from '@nestjs/common';
import { CompanyDirectory } from './company-directory';
import { DispatchCompaniesResolver } from './dispatch-companies.resolver';
import { CompanyProvisioningService } from './company-provisioning.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [TenantGuard, DispatchCompaniesResolver, CompanyDirectory, CompanyProvisioningService],
  exports: [TenantGuard, DispatchCompaniesResolver, CompanyDirectory, CompanyProvisioningService],
})
export class TenancyModule {}
