import { Global, Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

/** Tenancy: contexto de tenant y guard reutilizables por los módulos de dominio. */
@Global()
@Module({
  providers: [TenantGuard],
  exports: [TenantGuard],
})
export class TenancyModule {}
