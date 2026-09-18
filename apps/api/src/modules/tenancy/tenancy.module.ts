import { Global, Module } from '@nestjs/common';
import { ActiveCompanyResolver } from './active-company.resolver';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [TenantGuard, ActiveCompanyResolver],
  exports: [TenantGuard, ActiveCompanyResolver],
})
export class TenancyModule {}
