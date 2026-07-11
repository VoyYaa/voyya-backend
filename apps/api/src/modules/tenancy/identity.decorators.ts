import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithTenant } from './tenant-request';

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();
    const companyId = req.tenant?.companyId;
    if (companyId === undefined) {
      throw new InternalServerErrorException('TenantGuard did not run before @CurrentTenant');
    }
    return companyId;
  },
);

function authenticatedUserId(ctx: ExecutionContext): number {
  const req = ctx.switchToHttp().getRequest<RequestWithTenant>();
  const id = req.user?.userId;
  if (id === undefined) {
    throw new UnauthorizedException({ code: 'SESSION_REQUIRED', message: 'Sesión requerida' });
  }
  return id;
}

export const CurrentPassenger = createParamDecorator((_d: unknown, ctx: ExecutionContext): number =>
  authenticatedUserId(ctx),
);

export const CurrentDriver = createParamDecorator((_d: unknown, ctx: ExecutionContext): number =>
  authenticatedUserId(ctx),
);
