import { applyDecorators, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Throttle } from '@nestjs/throttler';

interface ThrottleOptions {
  limit: number;
  ttl: number;
}

const OPT_IN_PREFIX = 'voyya:throttle-opt-in:';

export function OptInThrottle(name: string, options: ThrottleOptions): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(OPT_IN_PREFIX + name, true), Throttle({ [name]: options }));
}

export function skipUnlessOptedIn(name: string): (context: ExecutionContext) => boolean {
  const reflector = new Reflector();
  return (context) =>
    reflector.getAllAndOverride<boolean | undefined>(OPT_IN_PREFIX + name, [
      context.getHandler(),
      context.getClass(),
    ]) !== true;
}
