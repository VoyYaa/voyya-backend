import type { LoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';

type Level = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal';

export class PinoLoggerService implements LoggerService {
  constructor(private readonly pino: PinoLogger) {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  private write(level: Level, message: unknown, context?: string, stack?: string): void {
    const base = {
      ...(context ? { context } : {}),
      ...(stack ? { stack } : {}),
    };

    if (typeof message === 'object' && message !== null) {
      this.pino[level]({ ...base, ...(message as Record<string, unknown>) });
      return;
    }

    this.pino[level](base, String(message));
  }
}
