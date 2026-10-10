import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { EnvService } from '../../config/env.service';
import { summarizeError } from '../observability/safe-error';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly env: EnvService) {
    super({ omit: { tripRequest: { startCode: true } } });
  }

  async onModuleInit(): Promise<void> {
    const maxAttempts = this.env.get('DB_CONNECT_MAX_ATTEMPTS');
    const baseDelayMs = this.env.get('DB_CONNECT_RETRY_BASE_MS');

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.$connect();
        this.logger.log(`Prisma connected (attempt ${attempt}/${maxAttempts})`);
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          this.logger.fatal(
            `Prisma could not connect after ${maxAttempts} attempts to ` +
              `${describeTarget(this.env.get('DATABASE_URL'))}: ${summarizeError(error)}`,
          );
          throw error;
        }
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `Prisma connect attempt ${attempt}/${maxAttempts} failed (${summarizeError(error)}), retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async runInTenant<T>(
    companyId: number,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  async runAsPlatform<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_session', 'on', true)`;
      return fn(tx);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, '') || '(unknown)';
    return `host=${url.hostname} port=${url.port || '5432'} database=${database}`;
  } catch {
    return 'host=(unparseable) port=(unparseable) database=(unparseable)';
  }
}

