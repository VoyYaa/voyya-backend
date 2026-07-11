import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { RequestWithTenant } from './tenant-request';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithTenant>();
    const companyId = req.user?.companyId;

    if (companyId === undefined || !Number.isInteger(companyId) || companyId <= 0) {
      throw new ForbiddenException({
        code: 'OUT_OF_TENANT',
        message: 'Tenant (company_id) ausente o inválido',
      });
    }

    req.tenant = { companyId };
    return true;
  }
}
