import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestWithTenant } from '../../tenancy/tenant-request';
import { ALLOW_PENDING_PIN_CHANGE_KEY } from '../decorators/allow-pending-pin-change.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class PinChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest<RequestWithTenant>().user;
    if (user?.role !== 'driver' || user.pinChangeRequired !== true) return true;

    if (this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PIN_CHANGE_KEY, targets)) {
      return true;
    }
    throw new ForbiddenException({
      code: 'PIN_CHANGE_REQUIRED',
      message: 'Crea tu PIN para continuar.',
    });
  }
}
