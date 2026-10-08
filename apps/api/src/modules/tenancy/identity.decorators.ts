import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser, RequestWithTenant } from './tenant-request';

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

export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();
    const id = req.user?.userId;
    if (id === undefined) {
      throw new UnauthorizedException({ code: 'SESSION_REQUIRED', message: 'Sesión requerida' });
    }
    return id;
  },
);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const user = ctx.switchToHttp().getRequest<RequestWithTenant>().user;
    if (user === undefined) {
      throw new UnauthorizedException({ code: 'SESSION_REQUIRED', message: 'Sesión requerida' });
    }
    return user;
  },
);
