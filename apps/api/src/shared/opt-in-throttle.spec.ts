import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { OptInThrottle, skipUnlessOptedIn } from './opt-in-throttle';

@Controller('probe')
class ProbeController {
  @Get('plain')
  plain(): string {
    return 'plain';
  }

  @Get('limited')
  @OptInThrottle('hourly', { limit: 30, ttl: 3_600_000 })
  limited(): string {
    return 'limited';
  }
}

@OptInThrottle('hourly', { limit: 1, ttl: 1000 })
@Controller('class-limited')
class ClassLimitedController {
  @Get()
  any(): string {
    return 'any';
  }
}

function contextOf(
  controller: new () => object,
  handler: (...args: never[]) => unknown,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

describe('skipUnlessOptedIn', () => {
  const skip = skipUnlessOptedIn('hourly');

  it('skips a route that did not opt in', () => {
    expect(skip(contextOf(ProbeController, ProbeController.prototype.plain))).toBe(true);
  });

  it('applies to a route that opted in', () => {
    expect(skip(contextOf(ProbeController, ProbeController.prototype.limited))).toBe(false);
  });

  it('applies to every route of a class that opted in', () => {
    expect(skip(contextOf(ClassLimitedController, ClassLimitedController.prototype.any))).toBe(false);
  });

  it('is scoped by throttler name', () => {
    const other = skipUnlessOptedIn('another');
    expect(other(contextOf(ProbeController, ProbeController.prototype.limited))).toBe(true);
  });
});
