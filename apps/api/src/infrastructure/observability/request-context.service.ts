import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { LogContext } from './log-context';

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<LogContext>();

  run<T>(context: LogContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  get(): LogContext | undefined {
    return this.storage.getStore();
  }

  set(partial: Partial<LogContext>): void {
    const current = this.storage.getStore();
    if (!current) return;
    Object.assign(current, partial);
  }
}

export const requestContext = new RequestContextService();
